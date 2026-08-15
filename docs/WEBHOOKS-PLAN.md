# Agent Drop -- Generic Webhook Receiver

Turn frst.dev into a **webhook sink**: a third party POSTs to a URL we own, we
verify it, store it forever-ish (120 days), answer fast, and let an agent pull
it off a queue over the CLI. Optionally re-deliver it onward with the retry
machinery the rules engine already has.

Status: PLAN v1, not started.

---

## 1. What this is

Five capabilities, in the order they matter:

1. **Match a URL.** A configurable public endpoint per receiver, so the URL you
   paste into Stripe/GitHub/Zoom's console is one we control and can route.
2. **Answer the setup handshake.** Most providers won't accept a URL until it
   echoes a challenge back. Meta, Slack and Zoom all do this differently.
3. **Verify the sender.** HMAC signatures (the near-universal scheme), plus the
   dumber shared-secret variants that still exist in the wild.
4. **Store it.** Raw body + headers + verification verdict, in D1 (small) or R2
   (large), with a 120-day expiry.
5. **Hand it to an agent.** A real pull-queue over the CLI -- lease, read, ack,
   delete -- not just "list rows".

Plus, riding the existing rules engine: **onward delivery with retries**.

### What it is NOT

Not a replacement for `drops`. A webhook event is not an email: no subject, no
attachments, no reader UI. It gets its own table and its own CLI verbs. The one
bridge is an opt-in per-receiver `mirror_to_drops` flag (Phase 5).

---

## 2. URL shape

```
https://frst.dev/h/{box}/{slug}
https://frst.dev/h/{box}/{slug}/anything/after   <- captured as `subpath`, same receiver
```

`/h/` sits beside `/f/` (hosting) as a worker-first prefix and needs adding to
`run_worker_first` in `wrangler.toml`: `["/api/*", "/f/*", "/h/*"]`.

**Why not `/api/hook/{box}/{slug}`** (which would need zero wrangler config):
because `src/api/router.ts` earns its Tier-1/Tier-2 story by making `/api/*`
mean "credential required, unknown path answers 401 not 404". A fully public,
unauthenticated, body-swallowing endpoint inside that namespace muddies the one
invariant the router is careful about. `/h/` keeps it clean, and short URLs are
better in a third-party console anyway.

**Slug secrecy.** For a receiver with `auth_mode = none`, the URL *is* the
credential. `hook-create` therefore appends a random suffix by default
(`stripe-prod-k7f2q9`) unless `--slug` is given explicitly. With a real
signature configured, a clean slug is fine.

---

## 3. Schema -- migration `0009_webhook_receivers.sql`

Both tables in one migration; they are one feature.

### `webhook_receivers`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | uuid |
| `inbox` | TEXT NOT NULL | the box; ties into `inbox_scope` and rule patterns |
| `slug` | TEXT NOT NULL | path segment, normalized `[a-z0-9-]` |
| `label` | TEXT | human note |
| `auth_mode` | TEXT NOT NULL DEFAULT 'none' | see §5 |
| `auth_config` | TEXT | JSON: secret, header name, encoding, tolerance |
| `handshake_mode` | TEXT NOT NULL DEFAULT 'none' | see §6 |
| `handshake_config` | TEXT | JSON: verify token, static response |
| `response_status` | INTEGER DEFAULT 200 | what we answer the provider with |
| `response_body` | TEXT | |
| `response_content_type` | TEXT | |
| `allowed_methods` | TEXT DEFAULT 'POST' | comma-separated |
| `max_body_bytes` | INTEGER DEFAULT 1048576 | hard cap, enforced before the read |
| `retention_days` | INTEGER DEFAULT 120 | |
| `mirror_to_drops` | INTEGER DEFAULT 0 | Phase 5 |
| `enabled` | INTEGER DEFAULT 1 | |
| `created_at` | INTEGER NOT NULL | |
| `last_event_at` | INTEGER | |
| `event_count` | INTEGER DEFAULT 0 | |

```sql
CREATE UNIQUE INDEX idx_hook_receivers_slug ON webhook_receivers(inbox, slug);
```

Secrets live in `auth_config` as plaintext -- same posture as `drop_tokens`. The
list API returns `secret_set: true`, never the value. Rotation is
`hook-update --secret`.

### `webhook_events`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | ULID via `generateId()` -- sortable, so cursor pulls are free |
| `receiver_id` | TEXT NOT NULL | |
| `inbox` | TEXT NOT NULL | denormalized: scope checks and pulls never join |
| `slug` | TEXT NOT NULL | |
| `subpath` | TEXT | anything after `/h/{box}/{slug}` |
| `method` | TEXT NOT NULL | |
| `event_type` | TEXT | extracted per §4 |
| `dedupe_key` | TEXT | provider's own message id |
| `headers` | TEXT | JSON, signature/auth headers replaced with `<redacted>` |
| `query` | TEXT | JSON |
| `content_type` | TEXT | |
| `body_text` | TEXT | inline when <= 64 KiB |
| `body_r2_key` | TEXT | else `hooks/{box}/{slug}/{id}` |
| `body_bytes` | INTEGER | |
| `body_sha256` | TEXT | |
| `verified` | INTEGER | 1 pass, 0 fail, NULL not applicable |
| `remote_ip` / `country` / `user_agent` | TEXT | from CF headers |
| `status` | TEXT NOT NULL DEFAULT 'queued' | `queued`\|`leased`\|`acked`\|`rejected`\|`handshake` |
| `lease_id` | TEXT | |
| `leased_until` | INTEGER | |
| `lease_count` | INTEGER DEFAULT 0 | how many times it has been handed out |
| `acked_at` | INTEGER | |
| `created_at` | INTEGER NOT NULL | |
| `expires_at` | INTEGER NOT NULL | `created_at + retention_days` |

```sql
CREATE INDEX idx_hook_events_pull    ON webhook_events(inbox, status, created_at);
CREATE INDEX idx_hook_events_recv    ON webhook_events(receiver_id, created_at DESC);
CREATE INDEX idx_hook_events_expiry  ON webhook_events(expires_at);
CREATE UNIQUE INDEX idx_hook_events_dedupe
    ON webhook_events(receiver_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
```

**The dedupe index is the point, not decoration.** Every provider on the list
retries on a slow response, and a retry carries the same message id. Without it
one flaky 3-second Zoom response becomes four copies in the agent's queue. On
conflict the endpoint answers `200 {"duplicate": true}` and stores nothing.

---

## 4. Request handling -- `src/lib/webhook-receive.ts`

Order matters and is not negotiable:

1. Resolve `{box}/{slug}` -> receiver row. Unknown or disabled -> `404`, with no
   hint about which of the two it was.
2. Method check against `allowed_methods` -> `405`.
3. `Content-Length` vs `max_body_bytes` -> `413` before reading a byte.
4. **Read the raw body once, as text.** Everything downstream uses this exact
   string. HMAC over a re-serialized JSON object is the classic way to ship a
   verifier that rejects every real request.
5. Handshake detection (§6). If it matches, answer the challenge, store the
   event with `status='handshake'`, return. Never falls through to verification.
6. Verify (§5). Fail -> `401`, store with `verified=0, status='rejected'`, and
   burn a token from `AUTH_RATE_LIMIT` -- a bad signature *is* a credential
   failure.
7. Extract `event_type` and `dedupe_key` via the receiver's `auth_config`
   preset defaults (below), overridable per receiver.
8. Persist. Body inline if <= 64 KiB, else `BUCKET.put("hooks/...")` first.
9. **Respond immediately.** Rule firing goes on `ctx.waitUntil`. Zoom allows 3
   seconds total; anything synchronous after the insert is a bug waiting for a
   slow day.

### `event_type` / `dedupe_key` extraction defaults

| Preset | `event_type` | `dedupe_key` |
|---|---|---|
| `github` | header `X-GitHub-Event` | header `X-GitHub-Delivery` |
| `stripe` | JSON `$.type` | JSON `$.id` |
| `standard`/`svix` | JSON `$.type` | header `webhook-id` |
| `slack` | JSON `$.event.type` | header `X-Slack-Request-Timestamp` + body hash |
| `shopify` | header `X-Shopify-Topic` | header `X-Shopify-Webhook-Id` |
| generic | configurable JSON path | configurable header/path |

A tiny dotted-path reader over the parsed body -- not a JSONPath dependency.
Parse failures are non-fatal: the event still stores, `event_type` is NULL.

---

## 5. Verification -- `src/lib/webhook-verify.ts`

All comparisons via `constantTimeEqual`, which today is private in
`src/lib/auth.ts` -- export it, or lift it into a shared `src/lib/compare.ts`.

| `auth_mode` | Header | Signed string | Encoding | Replay window |
|---|---|---|---|---|
| `none` | -- | -- | -- | -- |
| `standard` | `webhook-signature` (`v1,<b64>`; space-separated list, any may match) | `{webhook-id}.{webhook-timestamp}.{body}` | base64 HMAC-SHA256; secret is base64 after stripping `whsec_` | 5 min |
| `github` | `X-Hub-Signature-256` (`sha256=<hex>`) | `{body}` | hex | none |
| `stripe` | `Stripe-Signature` (`t=<ts>,v1=<hex>`) | `{t}.{body}` | hex | 5 min |
| `slack` | `X-Slack-Signature` (`v0=<hex>`) + `X-Slack-Request-Timestamp` | `v0:{ts}:{body}` | hex | 5 min |
| `shopify` | `X-Shopify-Hmac-Sha256` | `{body}` | base64 | none |
| `hmac` | configurable | template over `{body}` `{ts}` `{id}` `{method}` `{path}` `{url}` | hex or base64, optional `sha256=` prefix | configurable |
| `bearer` | `Authorization: Bearer <t>` | -- | -- | -- |
| `basic` | `Authorization: Basic ...` | -- | -- | -- |
| `header` | any header equals a value | -- | -- | -- |
| `query` | `?token=` equals a value | -- | -- | -- |

The `standard` row is [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md),
which is what Svix and a growing pile of providers emit -- worth having as the
default recommendation for anything new.

Signature list handling: `standard` and `stripe` both send **multiple**
signatures during a secret rotation. Accept if *any* matches. A verifier that
only reads the first one breaks every rotation.

---

## 6. Handshakes -- `src/lib/webhook-handshake.ts`

| `handshake_mode` | Trigger | Response |
|---|---|---|
| `none` | -- | -- |
| `meta` | `GET` with `hub.mode=subscribe`, `hub.verify_token` == config | `hub.challenge` verbatim, `text/plain`, 200. Covers Facebook, WhatsApp, Instagram, Threads. |
| `slack` | `POST` body `{"type":"url_verification","challenge":"..."}` | `{"challenge":"..."}` as JSON |
| `zoom` | `POST` body `{"event":"endpoint.url_validation","payload":{"plainToken":"..."}}` | `{"plainToken":X,"encryptedToken":hex(HMAC-SHA256(X, secretToken))}`. Also re-fires every 72h -- it is not a one-time setup step. |
| `echo` | any request whose body is short and non-JSON | the raw body verbatim |
| `static` | any request matching a configured predicate | fixed status + body |

Handshake requests are **stored** (`status='handshake'`), because "the provider
says my URL failed validation" is the number-one thing you will need to debug,
and the request that failed is the only evidence.

Exact Zoom CRC field names to be re-verified against Zoom's live docs at
implementation time -- their validation rules changed once already.

---

## 7. Pull-queue API

```
GET    /api/hooks/receivers            list all (admin)
POST   /api/hooks/receivers            create
GET    /api/hooks/receivers/:box       list for a box
PATCH  /api/hooks/receivers/:id        update / enable / disable / rotate secret
DELETE /api/hooks/receivers/:id        delete (purges its events + R2 bodies)

GET    /api/hooks/events/:box          list (?receiver= ?status= ?since= ?limit=)
GET    /api/hooks/events/:box/:id      one event, full body inlined
GET    /api/hooks/events/:box/:id/body raw bytes, original content-type
POST   /api/hooks/pull/:box            lease N events and return them
POST   /api/hooks/ack/:box             {ids, delete?}
POST   /api/hooks/nack/:box            {ids} -- release the lease now
DELETE /api/hooks/events/:box/:id      hard delete
```

Receiver CRUD -> `asAdmin` (Tier 1, prefix-matched, like `/api/rules`).
Event read -> `keyedReader`. Pull/ack/nack -> `keyedWriter`. Same gates as
everything else; no new auth concepts.

### Lease semantics

One statement, atomic under SQLite:

```sql
UPDATE webhook_events
   SET status = 'leased', lease_id = ?, leased_until = ?, lease_count = lease_count + 1
 WHERE id IN (
   SELECT id FROM webhook_events
    WHERE inbox = ?
      AND (status = 'queued' OR (status = 'leased' AND leased_until < ?))
      AND (? IS NULL OR receiver_id = ?)
    ORDER BY created_at ASC LIMIT ?
 )
RETURNING *;
```

An expired lease returns to the pool implicitly via the `OR` -- no sweeper. D1
supports `RETURNING` (SQLite 3.35+); the subselect is required because
`UPDATE ... LIMIT` is not compiled into SQLite by default.

**Default is at-least-once**: pull leases, agent works, agent acks. `--ack` on
pull collapses it to at-most-once for agents that don't want the bookkeeping.

Ack marks `acked_at` and keeps the row until `expires_at` -- audit and replay
both need it. `--delete` on ack hard-deletes (and drops the R2 body).

---

## 8. Onward delivery -- reusing the rules engine

`src/lib/rules.ts` already has the queue, exponential backoff to a 20-minute
cap, a 24-hour give-up, and `delivery_log`. Reuse it rather than build a second
retry loop.

- New channel `hook` in `findMatchingRules` / `fireRules` scopes.
- `fireRules` currently takes a `Drop`. Narrow its parameter to a small
  `RuleSubject` interface (`{id, inbox, topic, subject, from_addr, ...}`) that
  both `Drop` and a webhook event satisfy. Contained refactor, and it is the
  honest way to get this for free.
- New template variables `{slug}` and `{event_type}`.
- New rule option `payload_mode`:
  - `envelope` (default) -- agent-drop's JSON wrapper, same shape as today.
  - `passthrough` -- the provider's **original body and headers**, verbatim.
    This is what makes agent-drop a real relay: point Stripe at frst.dev, get
    retries and an audit log, and your own service still sees exactly what
    Stripe sent.
- `type='forward'` on scope `hook` emails a summary. Falls out for free.

---

## 9. Retention

- Per-receiver `retention_days`, default **120**. `expires_at` is stamped at
  insert, not computed at read -- changing a receiver's retention must not
  retroactively delete history.
- `rejected` events get a short retention (7 days, hardcoded). They exist to
  debug a rotated secret, not to be an archive.
- The existing cron (`17 * * * *`, `src/lib/reaper.ts`) gains a second sweep:
  delete `webhook_events WHERE expires_at < now`, 500 per run, R2 bodies first.
- R2 lifecycle rule on `hooks/` at **130 days** -- deliberately longer than D1,
  so D1 stays authoritative and the bucket is a backstop rather than a source
  of surprise 404s:

```bash
wrangler r2 bucket lifecycle add agent-drop-storage hooks-130d "hooks/" --expire-days 130
```

---

## 10. CLI

```bash
drop hooks                                    # all receivers (admin)
drop hooks lisa                               # receivers for a box
drop hook-create lisa stripe-prod --auth stripe --secret whsec_...
drop hook-create lisa meta --handshake meta --handshake-secret TOKEN
drop hook-url lisa stripe-prod                # the URL to paste into the provider
drop hook-update ID --disable | --enable | --secret ... | --retention 90
drop hook-remove ID

drop hook-events lisa [--receiver stripe-prod] [--status queued] [--limit 20]
drop hook-pull lisa [--receiver x] [--limit 10] [--lease 60] [--ack] [--json]
drop hook-ack ID...  [--delete]
drop hook-nack ID...
drop hook-body EVENT_ID [-o file]             # raw bytes to stdout or file
drop hook-replay EVENT_ID --to URL            # manual re-delivery
drop hook-test lisa stripe-prod               # send a correctly-signed synthetic
                                              # request at your own receiver
```

`hook-test` is the one that saves the most time: it proves the secret, the
signing scheme and the URL agree, without waiting on the provider's console.

`--json` emits `{"events":[{..., "body": <parsed>}]}` so an agent pipes straight
into `jq`.

---

## 11. Security notes worth stating

- The receiver URL is **public and unauthenticated by design**. `auth_mode` is
  what makes it trustworthy; `none` means anyone who learns the URL can write
  to that box's queue. `hook-create` says so out loud when `--auth` is omitted.
- New rate-limit binding `HOOK_RATE_LIMIT`, keyed by receiver id. Fails open,
  same house rule as the other two -- but a per-receiver **daily event cap**
  enforced in D1 backs it up, because a fail-open throttle in front of a table
  that grows forever is not enough on its own.
- No CORS headers. These are server-to-server.
- Signature headers are redacted before the headers JSON is stored. Storing a
  valid Stripe signature next to the body it signs hands a replay to anyone who
  can read the row.
- Secrets are plaintext in D1, admin-read-only, never returned by any list API.

---

## 12. Phases

Each phase ends green: `bun run verify` (check + build + deploy dry-run), tests
against the real-D1 helper in `test/helpers/d1.ts`.

| # | Phase | Done when |
|---|---|---|
| 1 | Schema + receiver CRUD + public endpoint (auth `none`) + `/h/*` route + CLI create/list/url | curl your own receiver, `drop hook-events` shows the body |
| 2 | `webhook-verify.ts` + all presets + `hook-test` | signed GitHub/Stripe/Slack/Standard fixtures pass; a one-byte body edit rejects; rotation with two signatures passes |
| 3 | Handshakes (meta/slack/zoom/echo/static) | fixture requests get the exact challenge back; handshakes never reach the verifier |
| 4 | Pull queue: lease/ack/nack + CLI pull/ack/body | two concurrent pulls never hand out the same event; an expired lease is re-served exactly once |
| 5 | Rules integration: channel `hook`, `RuleSubject` refactor, `passthrough` mode, `{slug}`/`{event_type}`, replay, `mirror_to_drops` | an inbound webhook re-delivers to a second URL with the original body, and a failing target retries with backoff |
| 6 | Retention: reaper sweep, R2 lifecycle, per-receiver override. Docs: CLAUDE.md, README, the `agent-drop` skill | a 121-day-old event is gone after one cron tick, its R2 body with it |

### Files touched

New: `migrations/0009_webhook_receivers.sql`, `src/lib/webhook-receive.ts`,
`src/lib/webhook-verify.ts`, `src/lib/webhook-handshake.ts`,
`src/api/hooks.ts`, `test/webhook-verify.test.ts`,
`test/webhook-handshake.test.ts`, `test/webhook-queue.test.ts`,
`test/webhook-receive.test.ts`.

Modified: `src/index.ts` (the `/h/` branch), `src/api/router.ts`,
`src/types.ts`, `src/lib/rules.ts` (`RuleSubject` + `hook` channel),
`src/lib/reaper.ts`, `src/lib/auth.ts` (export `constantTimeEqual`),
`wrangler.toml` (`run_worker_first`, `HOOK_RATE_LIMIT`),
`tools/agent-drop.ts`, `CLAUDE.md`, `README.md`.

---

## 13. Open decisions

1. **URL shape** -- `/h/{box}/{slug}` (recommended) vs `/api/hook/{box}/{slug}`
   (zero wrangler config, muddies the router's tier invariant).
2. **Do webhook events appear in `drop inbox`?** Plan says no by default, with
   an opt-in `mirror_to_drops` per receiver in Phase 5.
3. **Queue default** -- at-least-once with leases (recommended) vs simple
   pull-and-delete.
