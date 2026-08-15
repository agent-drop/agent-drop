---
version: 8
created: 2026-08-15
---

# Agent Drop -- generic webhook receiver

## GOAL

Turn frst.dev into a **webhook sink**: a third party POSTs to a URL we own, we
answer its setup handshake, verify the sender, store the request faithfully for
120 days, and hand it to an agent over a real pull-queue in the CLI. Optionally
re-deliver it onward using the retry machinery the rules engine already has.
This is agent-drop's fourth ingest channel, beside email, web upload and API
push -- and unlike those three it is a channel agent-drop does not control the
producer of, so faithful preservation of what arrived is the whole product.

## Context a link cannot get anywhere else

**Read this before touching anything.** No link ever sees the conversation that
produced this plan, so everything material is written down here.

- Repo: `/Users/jonas/projects/agent-drop`. Cloudflare Worker + D1 + R2 +
  Queues, Vite/React SPA in `web/`, Bun CLI in `tools/agent-drop.ts`.
- `CLAUDE.md` at the repo root is the authoritative description of the system
  as it stands today. It is also a **deliverable**: phase 6 updates it.
- The immediately-preceding chain (`docs/MODERNIZE-PLAN.md`, completed
  2026-08-01) built the things this plan leans on: the two-tier router with
  named gates in `src/api/gates.ts`, the real-D1 test harness in
  `test/helpers/`, `[[ratelimits]]`, and the hourly reaper. Read
  "How the router dispatches" in `CLAUDE.md` before adding a route.
- The green gate is `bun run verify` (= `bun run check` + `vite build` +
  deploy dry-run). `bun run format` before committing.
- Deploys go through `bun run deploy`, never bare `wrangler deploy` -- the
  committed `wrangler.toml` carries placeholders on purpose.
- **This plan is not speculative design.** Sections 1-11 were written against
  the actual source and settle the mechanism; sections 13-14 record the first
  consumer's constraints and the four decisions Jonas locked. Build what is
  written; do not redesign it mid-chain. If something here turns out to be
  factually wrong about the codebase, that is a version bump + changelog entry
  (Hard Rule 1b), not a silent improvisation.

## SPEC & ACCEPTANCE CRITERIA

**Hard requirements, in the user's words** (from the originating conversation,
2026-08-15):

- "create a webhook receiver that, one, can match a URL"
- "two, possibly answer a initial authorization. Some webhooks require initial
  authorization"
- "three, be configured with some authentication, basically, HMAC or whatever
  is popular these days"
- "after that, all webhooks just ends up in the drop database"
- "a way for the drop CLI to pull, pull at the queue and then possibly delete
  items from the queue"
- "possibly a way to delegate those webhooks into new things using some kind of
  mapping... we store it, and we retry delivery of that"
- "Should obviously have some expiration. Let's call it hundred and twenty days
  from now."

**Settled decisions** (§14 -- all four confirmed, none open):

- URL shape is `/h/{box}/{slug}`. NOT `/api/hook/*`.
- Webhook events are a **separate surface** from drops, with their own table and
  CLI verbs. `mirror_to_drops` is an off-by-default phase-5 convenience.
- Queue default is **at-least-once with leases**; `--ack` on pull collapses it.
- Execution is this six-phase chain.

**References:**

- Standard Webhooks spec --
  <https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md>
- The first consumer's constraints, and the 17TRACK behaviour that drives
  several requirements: §13 of this document.

**Acceptance criteria (observable):**

- A real third-party provider can be pointed at a frst.dev URL, complete its
  own dashboard verification, and have its pushes land -- verified end to end
  against a live provider, not only against fixtures.
- `drop hook-pull` hands an agent an event; two concurrent pulls never hand out
  the same one; a crashed consumer's lease expires and the event is re-served.
- The stored body is **byte-identical** to what was sent, and a consumer holding
  the provider's secret can verify the signature from what agent-drop stored --
  this is the criterion the header-redaction policy was corrected for (§4).
- An event older than its retention is gone after one cron tick, R2 body too.
- `bun run verify` green at every phase.

**Explicit non-negotiables / out of scope:**

- Do NOT change the existing drops/email/upload behaviour. This is additive.
  The one sanctioned edit to existing behaviour is narrowing `fireRules`'
  parameter to a `RuleSubject` (phase 5), which must leave every existing rules
  test passing unchanged.
- Do NOT add a `*.frst.dev` wildcard worker route (it would shadow the Caddy
  subdomains -- see `CLAUDE.md`).
- No SPA/UI work in this chain. The surface is API + CLI only.
- Do NOT delete the dead SES fallback in `src/lib/relay.ts`; it is kept
  deliberately as a revert path.

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
| `preset` | TEXT | extraction preset: `github`/`stripe`/`standard`/... (§4) |
| `extract_config` | TEXT | JSON: per-receiver overrides of the preset (§4) |
| `response_status` | INTEGER DEFAULT 200 | what we answer the provider with |
| `response_body` | TEXT | |
| `response_content_type` | TEXT | |
| `allowed_methods` | TEXT DEFAULT 'POST' | comma-separated |
| `max_body_bytes` | INTEGER DEFAULT 1048576 | hard cap, enforced before the read |
| `retention_days` | INTEGER DEFAULT 120 | |
| `daily_cap` | INTEGER | per-receiver daily event cap (§11); null = none |
| `mirror_to_drops` | INTEGER DEFAULT 0 | Phase 5 |
| `enabled` | INTEGER DEFAULT 1 | |
| `previous_slug` | TEXT | the pre-rotation slug, still answering (§7) |
| `previous_slug_expires_at` | INTEGER | end of the `--grace` window |
| `expires_at` | INTEGER | unix ms; null = never. `410` past it (§4) |
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
| `routing_key` | TEXT | correlation handle, extracted per §4 |
| `dedupe_key` | TEXT | provider's message id, or the body hash -- see below |
| `headers` | TEXT | JSON, **complete**; only true credentials redacted (§4) |
| `query` | TEXT | JSON |
| `content_type` | TEXT | |
| `body_text` | TEXT | inline when <= 64 KiB **and** the body is valid UTF-8 |
| `body_r2_key` | TEXT | else `hooks/{box}/{slug}/{id}` -- raw bytes, unmodified |
| `body_bytes` | INTEGER | |
| `body_sha256` | TEXT | over the raw bytes, before any decode |
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
CREATE INDEX idx_hook_events_route   ON webhook_events(receiver_id, routing_key, created_at DESC);
CREATE INDEX idx_hook_events_expiry  ON webhook_events(expires_at);
CREATE UNIQUE INDEX idx_hook_events_dedupe
    ON webhook_events(receiver_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
```

**The dedupe index is the point, not decoration.** Every provider on the list
retries on a slow response, and a retry carries the same message id. Without it
one flaky 3-second Zoom response becomes four copies in the agent's queue. On
conflict the endpoint answers `200 {"duplicate": true}` and stores nothing.

**When the provider gives you no message id**, `dedupe_key` is NULL and the
unique index does nothing -- which is correct by default, because two byte-
identical bodies can be two real events. Per-receiver `--dedupe body-hash`
opts into `dedupe_key = body_sha256` scoped to a window (default 15 min, must
exceed the provider's retry spacing: 17TRACK retries at 600s/1800s/3600s, so
that receiver wants `--dedupe-window 65m`). Outside the window the same bytes
store again. Consumers must still tolerate duplicates -- this narrows the
window, it does not close it.

**`routing_key` is the correlation handle**, extracted by configured JSON path
and indexed, so `hook-events --key <value>` filters server-side. For a provider
that echoes a caller-supplied tag (17TRACK's `data.tag`, a parcel number in
`data.number`) this is the difference between filing events per-entity and
pulling every body to find the three you wanted.

---

## 4. Request handling -- `src/lib/webhook-receive.ts`

Order matters and is not negotiable:

1. Resolve `{box}/{slug}` -> receiver row. Unregistered, disabled and expired
   are three DIFFERENT answers -- see the status table below.
2. Method check against `allowed_methods` -> `405`.
3. `Content-Length` vs `max_body_bytes` -> `413` before reading a byte.
4. **Read the raw body once, as bytes** (`arrayBuffer()`), and hash those bytes.
   Decode to text only for storage convenience, and only when the bytes are
   valid UTF-8; otherwise the body lives in R2 unmodified and `body_text` is
   NULL. Nothing downstream ever re-serializes. Signing a re-serialized JSON
   object is the classic way to ship a verifier that rejects every real
   request -- key order, whitespace and unicode escaping all shift, and once
   you've stored the re-serialized form the evidence is gone permanently.
5. Handshake detection (§6). If it matches, answer the challenge, store the
   event with `status='handshake'`, return. Never falls through to verification.
6. Verify (§5), **if the receiver asked for it**. `auth_mode: none` is a
   first-class answer, not a misconfiguration -- see the note below. Fail ->
   `401`, store with `verified=0, status='rejected'`, burn a token from
   `AUTH_RATE_LIMIT`.
7. Extract `event_type`, `routing_key` and `dedupe_key` per the receiver's
   preset defaults (below), overridable per receiver.
8. Persist. Body inline if <= 64 KiB and UTF-8, else `BUCKET.put("hooks/...")`
   first.
9. **Respond immediately.** Rule firing goes on `ctx.waitUntil`. Zoom allows 3
   seconds; 17TRACK turns any non-200 into three more copies over 100 minutes.
   Anything synchronous after the insert is a bug waiting for a slow day.

**An unparseable or unrecognised body is a successful receive**, not an error.
Unknown event types, dashboard "test" pings and malformed JSON all store and
return 200. The receiver's job is to preserve, not to understand.

### Status codes -- the full table

Every one of these is a decision, because the provider on the other end reacts
to the number: a 2xx makes it stop, a 4xx usually makes it stop and show an
error in its dashboard, a 5xx makes it retry.

| Situation | Status | Body | Why |
|---|---|---|---|
| Stored (or handshake answered) | `200` | `{"ok":true,"id":...}` or the challenge | |
| Duplicate of a stored `dedupe_key` | `200` | `{"ok":true,"duplicate":true}` | Never 409 -- a 4xx makes the provider retry the thing we deliberately discarded |
| **Slug was never registered** | **`404`** | `{"error":"no such receiver"}` | see below |
| Receiver exists but is **disabled** | `403` | `{"error":"receiver disabled"}` | It IS registered; the operator turned it off |
| Receiver exists but is **expired** | `410` | `{"error":"receiver expired"}` | Gone permanently, stop sending |
| Receiver exists, old slug inside its `--grace` window | `200` | normal | Rotation must not drop traffic mid-cutover |
| Method not in `allowed_methods` | `405` | `{"error":...}` + `Allow:` header | |
| Body over `max_body_bytes` | `413` | | Checked on `Content-Length` first |
| Signature/secret wrong | `401` | `{"error":"signature verification failed"}` | Stored as `rejected`, burns a rate-limit token |
| Per-receiver rate limit or daily cap hit | `429` | + `Retry-After` | |
| Our own failure (D1/R2 down) | `503` | | The ONLY case that should make a provider retry. Never return 5xx for a caller mistake |

**Why unregistered stays `404` and not `403`.** They must be distinguishable --
collapsing them destroys the single most useful diagnostic when a provider
reports "your endpoint is failing", which is *did it reach a receiver at all*.
But the direction matters: `403` means "this exists, and you may not have it",
which **confirms the slug is real** to anyone probing. For a receiver whose URL
*is* its credential (§11), that hands an enumerator a yes/no oracle. `404` for
an unregistered slug leaks nothing; `403` for a disabled one leaks nothing
either, because the only way to see it is to already hold the exact URL. So:
`404` unknown, `403` disabled, `410` expired.

### Header storage: preserve, don't curate

Store the **complete** header map. An allowlist cannot work -- the signature is
`sign` for 17TRACK, `X-Hub-Signature-256` for GitHub, `Stripe-Signature` for
Stripe, and whatever the next provider invents.

Redaction is therefore narrowed to headers that are **credentials in their own
right**: `Authorization`, `Cookie`, `Proxy-Authorization`, and any header the
receiver's own `auth_config` names as a shared secret (`bearer`/`basic`/
`header` modes). Signature headers are **kept verbatim** -- an HMAC or digest
proves a specific body came from the signer and is worthless against any other
request, and a consumer doing its own verification needs it. (Earlier draft
redacted these. That was wrong: it would have made consumer-side verification
impossible, which is the exact thing a faithful receiver exists to enable.)

### `event_type` / `routing_key` / `dedupe_key` extraction defaults

| Preset | `event_type` | `dedupe_key` |
|---|---|---|
| `github` | header `X-GitHub-Event` | header `X-GitHub-Delivery` |
| `stripe` | JSON `$.type` | JSON `$.id` |
| `standard`/`svix` | JSON `$.type` | header `webhook-id` |
| `slack` | JSON `$.event.type` | header `X-Slack-Request-Timestamp` + body hash |
| `shopify` | header `X-Shopify-Topic` | header `X-Shopify-Webhook-Id` |
| generic | configurable JSON path | configurable header/path, or `body-hash` |

`routing_key` has no preset -- it is always a configured path, because only the
operator knows which field correlates (`data.tag`, `data.number`,
`$.data.object.customer`).

A tiny dotted-path reader over the parsed body -- not a JSONPath dependency.
Parse failures are non-fatal: the event still stores, the extracted fields are
NULL.

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
| `hmac` | configurable | template over `{body}` `{ts}` `{id}` `{method}` `{path}` `{url}` `{secret}` | hex or base64, optional `sha256=` prefix | configurable |
| `digest` | configurable | plain `SHA-256(template)`, **not** HMAC -- e.g. 17TRACK's `sign` = `SHA256_hex({body}/{secret})` | hex or base64 | configurable |
| `bearer` | `Authorization: Bearer <t>` | -- | -- | -- |
| `basic` | `Authorization: Basic ...` | -- | -- | -- |
| `header` | any header equals a value | -- | -- | -- |
| `query` | `?token=` equals a value | -- | -- | -- |

The `standard` row is [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md),
which is what Svix and a growing pile of providers emit -- worth having as the
default recommendation for anything new.

The `digest` row exists because a real family of providers does **not** use
HMAC -- they concatenate the secret into the string and take a plain SHA-256.
It is weaker (length-extension applies, though not exploitably here), but
refusing to support it just means those providers can't be verified at all.

#### 17TRACK -- CONFIRMED against the v2.4 docs, with a test vector

Quoted first-hand from `api.17track.net/en/doc` on 2026-08-15 by the
`track-parcel` conversation, which holds a working key on that account:

> Concatenate the original notification message and the API key with "/" […]
> Generate the signature by using SHA256 hex encoding. […] The info needed to
> create the signature **should not be changed**, or the result can be
> different, causing the verification to fail.

So: `auth_mode: digest`, header `sign`, template `{body}/{secret}`, plain
SHA-256, lowercase hex, 64 chars.

**Pin this test vector in `test/webhook-verify.test.ts`** -- it is derived from
the docs' own worked example (they publish the inputs but no expected hash) and
was recomputed independently in the planning conversation before being written
down here:

```
body   = {"event":"TRACKING_UPDATED","data":{"number":"RR123456789CN","carrier":3011,"tag":null}}
secret = 123456ABCDEF
input  = <body> + "/" + <secret>
sign   = 45acb4a6f4a194a6ac1f0f712182c4e314b1ae9399941ea086987408f3166994
```

**Encoding gotcha, and it is a real one.** 17TRACK's own Java sample is
`new BigInteger(1, hash).toString(16)` left-zero-padded to 64. `BigInteger`
drops leading zeros, so that padding loop is doing actual work -- without it
roughly 1 in 256 signatures comes out 63 characters. The net result is plain
lowercase hex identical to Python's `hexdigest()`, but **the verifier must not
assume a fixed length from the provider's side**, and must compare
case-insensitively (or lowercase both sides) because some implementations
upper-case. A test with a signature that would have lost a leading zero is
worth writing.

**What is still NOT verified:** the *algorithm* is confirmed; the *wire format*
is not. The docs' example body is a shortened one (no `track_info`), so real
whitespace and key ordering on the wire are unknown, and no 17TRACK push has
ever actually fired at us. This is precisely why section 4 hashes
`arrayBuffer()` rather than anything re-encoded -- hash what arrived. If a real
push fails verification, the bytes-vs-algorithm split is the first place to
look, not the template.

Signature list handling: `standard` and `stripe` both send **multiple**
signatures during a secret rotation. Accept if *any* matches. A verifier that
only reads the first one breaks every rotation.

### Verification is optional, preservation is not

`auth_mode: none` is a supported end state, not a half-configured one. A
consumer that would rather hold its own secret and verify the bytes itself
gets exactly that, provided §4's guarantees hold: raw bytes preserved, full
header map stored, signature headers unredacted. That consumer never has to
trust agent-drop with the provider's API key.

Built-in verification earns its keep for the presets above -- it rejects
garbage at the edge instead of filling the queue with it, and it means an
agent pulling events doesn't need crypto at all. Offer both; default to
`none` with a loud warning (§11) rather than to a scheme the operator hasn't
chosen.

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

**Zoom's CRC was re-verified against `developers.zoom.us/docs/api/webhooks/` on
2026-08-15**, as this section required. Every field name above is confirmed
unchanged: event `endpoint.url_validation`, request `payload.plainToken`,
response `{plainToken, encryptedToken}`, HMAC-SHA256 with the **secret token as
the key and the plainToken as the message**, hex out. Two details the docs add:
`200` **or** `204` is acceptable, and after **six** consecutive failed
revalidations Zoom disables the endpoint (notifying after the 2nd and 4th). The
72-hour cadence is confirmed. Meta's `hub.mode`/`hub.challenge`/`hub.verify_token`
and Slack's `url_verification` were re-checked the same day against
`developers.facebook.com` and `docs.slack.dev`; both match this table, and Slack
documents plain-text, form-encoded and JSON as equally acceptable answers.

**Detection is on SHAPE, and a failed handshake is still a handshake.** A `meta`
request carrying the wrong `hub.verify_token` answers `403` rather than falling
through to the delivery path -- see the v7 changelog for why. Everything else in
the trigger column is literal.

---

## 7. Pull-queue API

Endpoints mirror the CLI verbs one-for-one (§10), so there is never a question
of which does what.

```
                                       -- receivers --
POST   /api/hooks/receivers            create
GET    /api/hooks/receivers            list all (admin)
GET    /api/hooks/receivers/:box       list for a box
GET    /api/hooks/receivers/:id        get one: config, URL, counters
PATCH  /api/hooks/receivers/:id        update / enable / disable / rotate secret
POST   /api/hooks/receivers/:id/rotate rotate the SLUG, keep the row + history
DELETE /api/hooks/receivers/:id        delete (?purge=1 also destroys its messages)

                                       -- messages --
GET    /api/hooks/queue/:box           list  (?receiver= ?status= ?key= ?since= ?limit=)
GET    /api/hooks/queue/:box/:id       peek one -- NO lease taken
GET    /api/hooks/queue/:box/:id/body  raw bytes, original content-type, NO lease
POST   /api/hooks/queue/:box/peek      peek N -- NO lease taken
POST   /api/hooks/queue/:box/get       lease N and return them
POST   /api/hooks/queue/:box/put       inject a message as if a provider sent it
POST   /api/hooks/queue/:box/remove    {ids} -- off the queue, row kept
POST   /api/hooks/queue/:box/return    {ids} -- release the lease now
POST   /api/hooks/queue/:box/extend    {ids, leaseSeconds}
POST   /api/hooks/queue/:box/requeue   {ids} -- removed/rejected -> queued
POST   /api/hooks/queue/:box/delete    {ids} | {removed:true} | {before:<id>} -- bulk destroy
DELETE /api/hooks/queue/:box/:id       destroy one
GET    /api/hooks/queue/:box/stats     counts by status, bytes, last arrival
```

**Peek is a GET and takes no lease; get is a POST and does.** That is not
decoration -- it means a peek is safe to retry, cache, and hand to a read-only
credential, and it means you cannot consume a queue by accident with a browser
or a `curl` you meant as a look.

Receiver CRUD -> `asAdmin` (Tier 1, prefix-matched, like `/api/rules`).
`queue-list` / `peek` / `body` / `stats` -> `keyedReader`. Everything that
leases, mutates or destroys -> `keyedWriter`. Same gates as everything else;
no new auth concepts.

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

### Cursors, and what order means

`id` is a ULID, so `?since=<id>` is a monotonic **arrival** cursor and needs no
extra column. It is arrival order and nothing more: providers state outright
that delivery order is not guaranteed (17TRACK does), so a consumer that cares
about event order must sort by the provider's own timestamp inside the body.
The API will not pretend otherwise.

Note that the lease queue makes the cursor optional: `pull` -> work -> `ack`
holds no client-side state at all, which is strictly better than a cursor for
a stateless consumer. `?since=` stays for read-only browsing and replay.

### Slug rotation

Because the URL is the credential for a whole class of providers, rotating it
must not cost history. `POST /receivers/:id/rotate` issues a new slug on the
same receiver row; events reference `receiver_id`, so everything already
stored survives. Optional `--grace <duration>` keeps the old slug answering
for a window while you update the provider's dashboard.

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

Two nouns, one verb vocabulary each. `hook` is the receiver (the registered
URL); `queue` is the messages sitting in it. House style in this CLI is flat
`noun-verb` (`rule-add`, `mask-create`), so these follow it.

### Receivers -- `hook-*`

```bash
drop hook-create lisa stripe-prod --auth stripe --secret whsec_...
drop hook-create lisa meta --handshake meta --handshake-secret TOKEN
drop hook-list [lisa]                    # all receivers, or one box's. alias: `drop hooks`
drop hook-get ID|lisa/stripe-prod        # full config, URL, counters, last event
drop hook-update ID --disable | --enable | --secret ... | --retention 90 | --label ...
drop hook-rotate ID [--grace 24h]        # new slug, same row, history intact
drop hook-delete ID [--purge]            # --purge also destroys its queued messages
drop hook-url ID                         # just the URL, for piping into a clipboard
drop hook-test ID                        # fire a correctly-signed synthetic request at it
```

`hook-get` accepts either the id or the human `box/slug` pair, because the id
is what the API returns and the pair is what you remember.

### Messages -- `queue-*`

```bash
drop queue-list lisa [--receiver x] [--status queued] [--key TAG] [--since ID] [--limit 20]
drop queue-peek lisa [--limit 5]         # read WITHOUT leasing -- pure debugging
drop queue-peek EVENT_ID                 # one message, full detail + headers, no lease
drop queue-get lisa [--limit 10] [--lease 60] [--json]
                    [--remove | --delete-on-success]
drop queue-put lisa --receiver stripe-prod --body @file.json [--header k:v]
drop queue-remove ID...                  # off the queue, row kept (the ack)
drop queue-delete ID...                  # destroyed, R2 body too
drop queue-delete lisa --removed         # bulk: everything already removed
drop queue-delete lisa --before EVENT_ID # bulk: everything older than a cursor
drop queue-body EVENT_ID [-o file]       # raw bytes, unmodified, to stdout or file
drop queue-return ID...                  # release a lease immediately (the nack)
drop queue-extend ID... --lease 300      # hold a lease longer mid-work
drop queue-requeue ID...                 # removed/rejected -> queued again
drop queue-stats [lisa]                  # counts by status, bytes, last arrival
drop queue-replay EVENT_ID --to URL      # manual re-delivery to an arbitrary target
```

### `peek` vs `get` -- the distinction that matters

`queue-get` **takes a lease**: the message is handed to you and hidden from
every other consumer until you `queue-remove` it or the lease expires. That is
the consuming path.

`queue-peek` takes **no lease and changes nothing**. It is for looking: what is
in there, what does that body actually contain, why did that one get rejected.
Peeking a leased message shows it, and says who holds the lease and for how
long. You can peek the same message a hundred times and the queue is exactly as
it was -- which is the entire point when you are debugging a provider at 2am.

### `remove` vs `delete` -- also not the same

| Verb | Row after | Use |
|---|---|---|
| `queue-remove ID` | kept, `acked_at` set, out of the queue, still readable and replayable until `expires_at` | the default "I processed this" |
| `queue-get --remove` | same, but removed at handout | at-most-once; caller does not want lease bookkeeping |
| `queue-get --delete-on-success` | **destroyed**, R2 body too, per message as it is written out | the consumer is the archive; keep nothing here |
| `queue-delete ID` | **destroyed**, R2 body too | junk, test pings, a misconfigured provider's noise |

`--delete-on-success` destroys each message only after it has been written to
the caller's output without error; a pull that dies halfway leaves the
remainder leased, not destroyed.

`queue-delete` is a first-class verb, not a flag on remove, because destroying
something you never processed is a normal want and should not require
pretending to process it first. The bulk forms print what they will destroy and
need `--yes` to skip the confirmation.

### `queue-put`

Injects a message as if a provider had sent it -- the same code path, so it
exercises storage, extraction and rule firing. This is how you reproduce a
provider's payload from a saved body without waiting for them to send another,
and how the tests drive the queue without going through HTTP.

### Completeness gate

Before phase 4 closes, walk this matrix and confirm every cell has a verb. No
cell may require a raw `curl` or a D1 query.

| | create | list | inspect | modify | rotate | disable | remove | destroy |
|---|---|---|---|---|---|---|---|---|
| **hook** | `hook-create` | `hook-list` | `hook-get` | `hook-update` | `hook-rotate` | `hook-update --disable` | -- | `hook-delete` |
| **queue** | `queue-put` | `queue-list` | `queue-peek` / `queue-body` | `queue-extend`, `queue-requeue` | -- | `queue-return` | `queue-remove` | `queue-delete` |

`--json` on any read verb emits machine-shaped output (`{"events":[...]}`, body
parsed when it is JSON) so an agent pipes straight into `jq`.

## 11. Security notes worth stating

- The receiver URL is **public and unauthenticated by design**. `auth_mode` is
  what makes it trustworthy; `none` means anyone who learns the URL can write
  to that box's queue. `hook-create` says so out loud when `--auth` is omitted.
- New rate-limit binding `HOOK_RATE_LIMIT`, keyed by receiver id. Fails open,
  same house rule as the other two -- but a per-receiver **daily event cap**
  enforced in D1 backs it up, because a fail-open throttle in front of a table
  that grows forever is not enough on its own.
- No CORS headers. These are server-to-server.
- Only true credential headers are redacted (`Authorization`, `Cookie`,
  `Proxy-Authorization`, plus whatever `auth_config` names as a shared secret).
  Signature headers are stored verbatim on purpose -- see §4.
- Secrets are plaintext in D1, admin-read-only, never returned by any list API.
- Slug entropy: the default random suffix is 6 chars from a 32-char alphabet
  (~30 bits). That is fine behind the per-receiver rate limit, which is what
  actually stops enumeration; raise it with `--slug-entropy` if a receiver is
  the sole credential for something that matters.

---

## PHASES

Every phase: tests live with the code (never "tests in a later phase"), files
stay under ~200 lines, and the phase ends green on `bun run verify` and
integrated into `main`. Tests use the real-D1 harness in `test/helpers/d1.ts`.

### Phase 1 -- Schema, receiver CRUD, and the public endpoint

The skeleton, end to end, with verification stubbed out (`auth_mode: none`).

1. Migration `0009_webhook_receivers.sql`: both tables and all indexes exactly
   as specified in §3, including `routing_key` and the partial unique dedupe
   index.
2. `/h/*` branch in `src/index.ts`, beside the existing `/f/` hosting branch,
   plus `/h/*` added to `run_worker_first` in `wrangler.toml`.
3. `src/lib/webhook-receive.ts` implementing §4's ordering: resolve receiver ->
   method check -> size cap -> **read raw bytes and hash them** -> store ->
   respond. Handshake and verify are call-outs to stubs this phase.
4. `src/api/hooks.ts`: receiver CRUD under `asAdmin`, wired into the Tier-1
   table by `prefix("/api/hooks")` (it sub-routes itself, like `/api/rules`).
   Event *read* endpoints under `keyedReader`.
5. CLI, receiver side plus the read-only queue verbs: `hook-create`,
   `hook-list`, `hook-get`, `hook-url`, `hook-update`, `hook-delete`,
   `queue-list`, `queue-peek`, `queue-body`.

**verify:** `bun run verify` green. Plus a RUNTIME check, not just tests: start
`bun run dev`, create a receiver, `curl -X POST` a JSON body at
`http://localhost:5173/h/{box}/{slug}`, and confirm `drop hook-events` shows it
with the body byte-identical to what was sent. Record the round-trip in the
phase log.

**artifacts:** `migrations/0009_webhook_receivers.sql`,
`src/lib/webhook-receive.ts`, `src/api/hooks.ts`, `src/index.ts`,
`src/api/router.ts`, `src/types.ts`, `wrangler.toml`, `tools/agent-drop.ts`,
`test/webhook-receive.test.ts`.

### Phase 2 -- Verification

`src/lib/webhook-verify.ts` with every preset in §5: `standard`, `github`,
`stripe`, `slack`, `shopify`, `hmac`, `digest`, `bearer`, `basic`, `header`,
`query`. Export `constantTimeEqual` from `src/lib/auth.ts` (or lift it into
`src/lib/compare.ts`) rather than writing a second copy. Add the `hook-test`
CLI command that fires a correctly-signed synthetic request at your own
receiver.

**verify:** `bun run verify` green, and the test file must cover, per preset:
a known-good fixture passes; a **one-byte body change** rejects; a stale
timestamp rejects where a replay window applies; and for `standard`/`stripe`,
a header carrying **two** signatures (mid-rotation) passes on the second one.
The `digest` preset must be proven against the 17TRACK test vector pinned in
§5 (`45acb4a6...f3166994`), including a case-insensitive compare and a
signature that would have lost a leading zero under a naive BigInteger
encoding. That shape is CONFIRMED against the v2.4 docs -- the phase-2 blocker
is cleared, no doc round trip needed.

**artifacts:** `src/lib/webhook-verify.ts`, `src/lib/auth.ts`,
`test/webhook-verify.test.ts`, `tools/agent-drop.ts`.

### Phase 3 -- Handshakes

`src/lib/webhook-handshake.ts` with `meta`, `slack`, `zoom`, `echo`, `static`
per §6. Detection runs BEFORE verification and never falls through to it.

**verify:** `bun run verify` green. Per mode, a fixture request gets the exact
expected challenge back (Meta's `hub.challenge` as bare `text/plain`; Zoom's
`encryptedToken` as the correct HMAC hex). A test proves a handshake request
with a deliberately invalid signature still succeeds -- i.e. it never reached
the verifier. Handshake requests are stored with `status='handshake'`.

**artifacts:** `src/lib/webhook-handshake.ts`,
`test/webhook-handshake.test.ts`.

### Phase 4 -- The pull queue

The full message vocabulary per §7 and §10: the single `UPDATE ... RETURNING`
with the subselect for leasing, the `?since=` cursor, the `?key=` routing-key
filter, and CLI `queue-get`, `queue-remove`, `queue-return`, `queue-delete`,
`queue-put`, `queue-extend`, `queue-requeue`, `queue-stats`, plus
`hook-rotate`. **The completeness gate in §10 is a phase-4 exit condition** --
walk the matrix, every cell has a verb, nothing requires a raw curl.

**verify:** `bun run verify` green, and the test file must prove: two
concurrent `queue-get`s never return the same message; an expired lease is
re-served exactly once and bumps `lease_count`; `queue-remove` is idempotent;
`queue-delete` removes the R2 body too; `queue-return` frees the lease
immediately; `queue-extend` pushes `leased_until` out without changing
ownership; **`queue-peek` never mutates a single column** -- assert the whole
row is byte-identical before and after, including on a leased message;
`--delete-on-success` leaves the un-emitted remainder leased rather than
destroyed when the output fails partway; the `--removed` and `--before` bulk
deletes touch exactly the intended rows and nothing else; `queue-put` lands a
message through the same path a real provider would; `hook-rotate` changes the
slug while every existing message stays reachable.

**artifacts:** `src/api/hooks.ts`, `test/webhook-queue.test.ts`,
`tools/agent-drop.ts`.

### Phase 5 -- Onward delivery via the rules engine

Per §8. Narrow `fireRules`' parameter from `Drop` to a `RuleSubject` interface
both `Drop` and a webhook event satisfy; add the `hook` channel, the `{slug}`
and `{event_type}` template variables, and `payload_mode` (`envelope` |
`passthrough`). Add `hook-replay`, and the off-by-default `mirror_to_drops`.

**verify:** `bun run verify` green. **Every existing test in
`test/rules.test.ts` and `test/forward.test.ts` must pass unchanged** -- the
refactor is a type narrowing, not a behaviour change; if it needs a test edited
to stay green, stop and reconsider. New tests: an inbound webhook re-delivers
to a second URL; `passthrough` mode sends the provider's original bytes and
headers verbatim; a failing target retries with backoff and logs to
`delivery_log`.

**artifacts:** `src/lib/rules.ts`, `src/types.ts`, `src/api/hooks.ts`,
`test/rules.test.ts`, `test/webhook-rules.test.ts`, `tools/agent-drop.ts`.

### Phase 6 -- Retention, provisioning, and docs

1. Reaper sweep per §9: delete expired events (500/run), R2 bodies first,
   7-day retention for `rejected`. Extends `src/lib/reaper.ts`; must not
   disturb the existing stale-`pending` sweep.
2. `HOOK_RATE_LIMIT` binding + the per-receiver daily cap (§11).
3. Out-of-band provisioning documented AND run, in this order:
   ```bash
   wrangler d1 migrations apply agent-drop-db --remote      # 0009 -- BEFORE the deploy
   bun run deploy
   wrangler r2 bucket lifecycle add agent-drop-storage hooks-130d "hooks/" --expire-days 130
   ```
   **Jonas gave an explicit green light to deploy** (2026-08-15), so this phase
   ships it -- do not halt to ask. Migration first: the receive path INSERTs
   into tables that will not exist yet otherwise.
4. Docs: `CLAUDE.md` (new section in the house style, plus the CLI table, the
   endpoint list and the Project Structure tree), `README.md`, and the
   `agent-drop` skill at `~/.claude/skills/agent-drop/`.
5. **Live smoke test against the deployed worker**, not localhost: create a
   receiver, POST at its real `https://frst.dev/h/...` URL, pull it back, delete
   it. Paste the transcript into the phase log.

**verify:** `bun run verify` green; a test proves an event past `expires_at` is
deleted on a cron tick along with its R2 body, and that an unexpired one is
not. Fire the cron locally against `bun run dev`:
`curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=17+*+*+*+*"`.
`CLAUDE.md` must describe what was actually built, not what this plan proposed.
The phase is NOT done until the live round trip in step 5 is in the log.

**artifacts:** `src/lib/reaper.ts`, `wrangler.toml`, `test/reaper.test.ts`,
`CLAUDE.md`, `README.md`, the skill.

### Files touched (whole chain)

New: `migrations/0009_webhook_receivers.sql`, `src/lib/webhook-receive.ts`,
`src/lib/webhook-verify.ts`, `src/lib/webhook-handshake.ts`,
`src/api/hooks.ts`, `test/webhook-receive.test.ts`,
`test/webhook-verify.test.ts`, `test/webhook-handshake.test.ts`,
`test/webhook-queue.test.ts`, `test/webhook-rules.test.ts`.

Modified: `src/index.ts` (the `/h/` branch), `src/api/router.ts`,
`src/types.ts`, `src/lib/rules.ts` (`RuleSubject` + `hook` channel),
`src/lib/reaper.ts`, `src/lib/auth.ts` (export `constantTimeEqual`),
`wrangler.toml` (`run_worker_first`, `HOOK_RATE_LIMIT`),
`tools/agent-drop.ts`, `CLAUDE.md`, `README.md`.

---

## 13. First consumer: `track-parcel` / 17TRACK

The `track-parcel` project wants to consume 17TRACK push notifications through
this instead of running its own daemon. It is a good archetype to build
against, because it is the *hostile* case rather than the friendly one:

| 17TRACK does | Which forces |
|---|---|
| One webhook URL per account, set in their dashboard; no custom headers, no query params | The URL is the credential -- slug entropy (§11) and rotation (§7) are not optional |
| `sign` = `SHA256_hex(raw_body + "/" + api_key)` | The `digest` preset (§5); plain HMAC would not cover it |
| Non-200 -> retry 3x at 600s / 1800s / 3600s | Persist-and-respond, zero synchronous work (§4); `--dedupe-window 65m` (§3) |
| Order explicitly not guaranteed | Arrival cursor only, no ordering promise (§7) |
| Echoes a caller-supplied `tag` in every push | `routing_key` extraction on `data.tag` (§3) |
| A dashboard "test" button firing an unspecified ping | Unparseable/unknown bodies must store and return 200 (§4) |

Its stated preference is to hold its own API key and verify the bytes itself,
with agent-drop doing nothing but preserve faithfully. That works today under
`auth_mode: none` -- and it is precisely why the header-redaction policy had to
change. Configuring `digest` instead is a later, optional upgrade.

Consumption is `hook-pull` -> work -> `hook-ack`, which needs no cursor state
at all. Their sketch asked for `drop inbox <name> --format json` + a cursor;
that shape only exists if decision 2 below lands on mirroring. The queue verbs
give the same access with better crash semantics, so mirroring is a
convenience, not a requirement.

*(Requirements relayed by the `track-parcel` conversation; the two corrections
above came from it. The signature scheme was subsequently CONFIRMED first-hand
against the v2.4 docs, with a test vector that was recomputed independently
here before being trusted -- see §5. The remaining unknown is the wire format,
not the algorithm: no real 17TRACK push has ever fired at us, so "spec
confirmed" is not "observed". The first live push is the proof.)*

---

## 14. Decisions -- SETTLED 2026-08-15

All four confirmed by Jonas. Nothing in this plan is open; build it as written.

1. **URL shape: `/h/{box}/{slug}`.** Add `/h/*` to `run_worker_first`. The
   `/api/hook/*` alternative is rejected -- it would put a public,
   unauthenticated endpoint inside the namespace whose invariant is "unknown
   path answers 401, not 404".
2. **Webhook events stay a separate surface.** Own table, own CLI verbs. The
   opt-in per-receiver `mirror_to_drops` flag stays in Phase 5 as a
   convenience; it is off by default and nothing depends on it.
3. **At-least-once with leases.** `pull` -> lease -> work -> `ack` is the
   default. `--ack` on pull collapses to at-most-once for callers that do not
   want the bookkeeping.
4. **Execution: full chain, all six phases**, via the chain protocol, paired
   with `docs/WEBHOOKS-PLAN.STATE.md`.

---

## Changelog

### v8 -- 2026-08-15 -- author: link 4 (phase 4)

No GOAL change, nothing weakened. One pre-existing bug that this phase's own verb
surfaced, and four implementation facts -- three of them decisions §7 implies but
does not spell out.

- **A `rejected` event must not carry a dedupe key.** §3's dedupe index exists so
  a provider's retry does not become four copies; §9 gives `rejected` a 7-day
  retention because it is evidence for a rotated secret, not an archive. Those
  two together were wrong in the code: a rejected row deduped, so the sequence
  wrong-secret -> 401 -> operator fixes it -> provider retries the same bytes
  answered `200 {"duplicate":true}` and stored nothing. The provider stops, the
  only row is one no lease hands out, and we told the sender we had it. Skipping
  the *lookup* was not enough -- the partial unique index has no status column, so
  the retry became a 503 instead. A refusal now stores `dedupe_key = NULL`, which
  also means `queue-requeue` on a rejected row can never collide with the
  accepted copy. Card `bug-rejected-row-blocks-its-own-retry`, mutation-checked
  in both directions. §3's "the dedupe index is the point" is unchanged; this is
  the code catching up to what §9 already said a rejected row IS.
- **`?receiver=` resolves through the receiver ROW, not the event's slug column.**
  §7 promises rotation costs no history. Matching the events' denormalized `slug`
  would have broken exactly that: every message stored under the old slug would
  vanish from `--receiver <new-slug>`. Both the read filter and the lease filter
  resolve the reference (id, current slug, or pre-rotation slug) to `receiver_id`
  first, and fall back to the raw string so a deleted receiver's events stay
  findable.
- **`queue-extend` will not extend an expired lease, and takes an optional
  `--lease-id`.** §7 says extend "pushes `leased_until` out without changing
  ownership" and does not say what an expired lease does. An expired lease is
  back in the pool by §7's own `OR` and may already be someone else's, so
  extending it would be taking it back silently. It answers `extended: 0`.
- **`queue-remove` refuses a handshake row, as `queue-requeue` does.** §7's lease
  SELECT already excludes handshakes, so nothing hands one out -- but an id typed
  by hand could still ack one, and `acked` is a status with no way back for a row
  whose only purpose is to be evidence that a provider's validation failed.
- **`--delete-on-success` destroys after the write RETURNED.** Down a pipe that
  means the OS accepted the bytes, not that the reader processed them. §10's
  guarantee -- "a pull that dies halfway leaves the remainder leased, not
  destroyed" -- holds and is tested; the weaker per-message half is now stated in
  `queue-get --help` rather than left to be discovered. A consumer that needs
  stronger should lease and `queue-remove`, which is the default for this reason.

### v7 -- 2026-08-15 -- author: link 3 (phase 3)

No GOAL change, nothing weakened. One doc round trip §6 demanded, one refinement
to §6's trigger column, and three implementation facts -- one of which is a
pre-existing bug this phase would have widened.

- **§6's Zoom re-verification is done, and the field names are unchanged.**
  Recorded inline in §6 above, along with two details the plan did not carry
  (`204` is acceptable as well as `200`; six consecutive failures disable the
  endpoint). Meta and Slack were re-checked at the same time and also match.
- **A failed handshake does not fall through to the delivery path.** §6's trigger
  column read `hub.verify_token == config`, which literally means a wrong token is
  "not a handshake" and takes the normal path. That path answers `200 {"ok":true}`
  -- not the challenge -- so Meta reports a failure while our logs show a
  perfectly ordinary event, and an unauthenticated prober can fill the queue by
  guessing tokens. Detection is now on shape (`GET` + `hub.mode=subscribe` +
  `hub.challenge`) and a mismatched token answers `403`, stored as
  `status='handshake'`. This serves §6's own stated reason for storing handshakes
  at all: the request that failed is the only evidence.
- **A shared secret in the QUERY STRING was stored in plaintext.**
  `collectHeaders` has taken a redaction list since phase 1; `collectQuery` never
  did. Phase 2's `auth_mode: query` made `auth_config.param` a credential and the
  gap opened silently; phase 3's `meta` would have added `hub.verify_token` to it.
  Fixed with `secretParams()` beside `secretHeaders()`. §4's header policy is
  unchanged -- this extends the same rule to the other half of the request. The
  `hmac`/`digest` carve-out deliberately does NOT extend here: no provider on the
  list signs via the query string. Card `bug-query-secret-stored-plaintext`,
  mutation-checked in both directions.
- **A handshake config that could not answer is refused at registration.** `meta`
  without a verify token, `zoom` without a secret, `static` with an empty
  predicate. The failure they replace surfaces days later for Zoom, whose CRC
  re-runs every 72 hours, and only in our logs. Same fail-closed posture as the
  mode gate. An empty `static` predicate also matches nothing at request time, so
  it can never silently divert a live queue.
- **A `meta` receiver gets `GET` added to its method list automatically.** Meta
  verifies over GET, and the default `POST` would 405 before the handshake ever
  ran -- an error the operator sees only as "verification failed". Applied on
  create and on the patch that switches a live receiver to `meta`, and printed by
  the CLI so it does not look like the flag was ignored.
- **A storage failure does not fail a handshake.** Everywhere else a write we
  could not complete becomes the 503 of §4's status table, because the provider is
  trusting us to have kept its event. A handshake has no event to keep: the answer
  is the whole product and does not depend on the row.

### v6 -- 2026-08-15 -- author: link 2 (phase 2)

No GOAL change, nothing weakened. Four implementation facts, recorded because
three of them are traps the next links would otherwise walk into, and one is a
correction to a behaviour §4 already specified.

- **`auth_config.header` is overloaded, and getting it backwards is silent.**
  Under `header` mode it names the SHARED SECRET; under `hmac` and `digest` it
  names the SIGNATURE. `secretHeaders()` in `src/lib/webhook-body.ts` was written
  in phase 1 when only the first meaning existed, so adding the second made it
  redact every signature header -- storing `sign: <redacted>` and quietly voiding
  the acceptance criterion that "a consumer holding the provider's secret can
  verify the signature from what agent-drop stored". Found at runtime, not by a
  test. The rule is now: **default redact, and `hmac`/`digest` are the only
  exception.** Card `bug-signature-header-redacted`, regression-tested both
  directions. §4's header policy is unchanged -- this is the code catching up to
  it. Phase 3 touches the same file; the asymmetry is that a shared secret rides
  every request and replays forever, while a signature proves one body and is
  worthless against any other.
- **`SUPPORTED_AUTH_MODES` is now DERIVED, not a list.** It is
  `["none", ...VERIFIER_MODES]`, where `VERIFIER_MODES` comes from the verifier's
  own dispatch table. A mode in the array but not the verifier would be
  registerable and then reject every delivery; one in the verifier but not the
  array would be unreachable code. **Phase 3 should do the same for
  `SUPPORTED_HANDSHAKE_MODES`** rather than typing the list out again.
- **The signed message is assembled as BYTES, never as a string.** `{body}` is
  spliced in as the raw `arrayBuffer()` bytes (`buildSignedBytes` in
  `src/lib/webhook-crypto.ts`), so a non-UTF-8 body verifies against what
  actually arrived. Building the signed string first would have forced every body
  through a UTF-8 round trip -- the exact failure §4 reads `arrayBuffer()` to
  avoid, reintroduced one layer down.
- **§5's `hmac`/`digest`/`header`/`query` rows need config the CLI could not
  set.** `hook-create --secret` wrote `{secret}` alone, so a `digest` receiver was
  registerable and then failed every delivery on "auth_config.header is
  required". Added `--auth-header`, `--auth-template`, `--auth-param`,
  `--auth-encoding`, `--auth-timestamp-header` and `--auth-tolerance`, shared by
  `hook-create` and `hook-update` so the two cannot drift. §10's command list is
  unchanged; these are flags it always implied.

The 17TRACK test vector from v4 was recomputed a third time here, independently,
before being pinned: `shasum -a 256` over `{body}/{secret}` gives
`45acb4a6f4a194a6ac1f0f712182c4e314b1ae9399941ea086987408f3166994`. Agrees.

### v5 -- 2026-08-15 -- author: link 1 (phase 1)

Six columns §3's table did not list, but which §4, §7 and §11 require. Building
phase 1 exactly as written would have made three specified behaviours
unimplementable, so this is the "factually wrong about the codebase" case in the
Context section: a version bump, not a silent improvisation. No GOAL change,
nothing weakened -- every column serves a behaviour the plan already demanded.

- `webhook_receivers.expires_at` -- §4's status table promises `410` for a
  receiver that is "expired", and nothing in §3 could express expiry.
- `webhook_receivers.previous_slug` + `previous_slug_expires_at` -- §7's
  `hook-rotate --grace <duration>` keeps the old slug answering during a
  dashboard cutover. Rotation is phase 4; the columns ship in the one migration
  because §3 says both tables ship together and a second migration for one
  feature is worse.
- `webhook_receivers.preset` + `extract_config` -- §4's extraction table is
  "preset defaults, overridable per receiver", and §3 stored neither the preset
  nor the override. Without them `routing_key` (which §3 calls the correlation
  handle and indexes) can never be populated.
- `webhook_receivers.daily_cap` -- §11's per-receiver daily event cap, which
  backs the fail-open rate limiter. Phase 6 enforces it; the column is here so
  phase 6 needs no migration of its own.

Two implementation facts worth recording, neither a plan change:

- **Body-hash dedupe is bucketed.** §3 asks for a windowed body-hash dedupe, but
  the unique index is on `(receiver_id, dedupe_key)` with no time component, so a
  literal hash as the key would block the same bytes forever rather than for a
  window. The key is `{sha256}.{floor(now/window)}` and the previous bucket is
  checked as an alternate, so a retry landing just past a boundary is still
  caught. Behaviour matches what §3 specifies, including "this narrows the
  window, it does not close it".
- **`?since=` orders by arrival MILLISECOND, not arrival.** §7 calls the ULID
  cursor "monotonic"; within a single millisecond the random tail decides, so two
  events that landed together may sort either way and a cursor walk can miss the
  lower one. The lease queue is the crash-safe path and §7 already says the
  cursor is for browsing and replay -- this records the limit rather than
  overclaiming it. `src/api/hook-queue.ts` documents it at the query.

### v4 -- 2026-08-15 -- author: planning conversation

Clears the one open blocker the chain started with. No GOAL change, no
requirement change -- this converts an assumption into a verified fact.

- 17TRACK's signature scheme is CONFIRMED first-hand against the v2.4 docs
  (`api.17track.net/en/doc`) by the `track-parcel` conversation, which holds a
  working key: plain SHA-256 over `{body}/{secret}`, header `sign`, lowercase
  hex. Not HMAC. The `digest` preset was the right shape.
- A test vector is now pinned in §5 and required by phase 2. The docs publish
  worked inputs but no expected hash, so `track-parcel` computed it and this
  conversation **recomputed it independently before writing it down** rather
  than taking the number on trust. Both agree:
  `45acb4a6f4a194a6ac1f0f712182c4e314b1ae9399941ea086987408f3166994`.
- Encoding gotcha recorded: their Java sample zero-pads a `BigInteger` to 64
  chars, and that padding is doing real work -- without it ~1 in 256 signatures
  is 63 chars. The verifier must not assume a fixed length and must compare
  case-insensitively. Phase 2 gets a leading-zero test.
- Scope of the confirmation stated honestly in §5 and §13: the ALGORITHM is
  confirmed, the WIRE FORMAT is not. The docs' example body is abridged and no
  real push has ever fired at us. Spec-confirmed is not observed. This is the
  argument for section 4's `arrayBuffer()` hashing, and if a live push fails
  verification the bytes are the first suspect, not the template.

### v3 -- 2026-08-15 -- author: planning conversation

Jonas specified the verb vocabulary directly: `get/inspect/create/delete/update`
for a hook, `list/remove/put/delete/get/peek` for messages in its queue, with
"peek == get with no lease". Section 10 rewritten to it, and section 7's
endpoints re-cut to mirror the CLI one-for-one. No GOAL change; this is a
naming and completeness change, and it ADDS three capabilities the plan did not
have.

- Two nouns with their own flat `noun-verb` families, matching this CLI's
  existing house style (`rule-add`, `mask-create`): `hook-*` for the receiver,
  `queue-*` for the messages in it. The previous single `hook-*` family had
  been quietly doing both jobs.
- `queue-peek` added: read with **no lease**, changes nothing, safe to repeat.
  `queue-get` is the leasing/consuming path. Peek is a GET, get is a POST --
  so a peek is retry-safe, cacheable, servable to a read-only credential, and
  you cannot consume a queue by accident with a curl you meant as a look.
  Phase 4 must assert the row is byte-identical before and after a peek.
- `queue-put` added: inject a message through the same path a real provider
  would, for reproducing a saved payload without waiting on the provider.
- `remove` and `delete` are now distinct verbs rather than a verb and a flag,
  which is exactly the tombstone-vs-destroy split the plan already had:
  `queue-remove` = off the queue, row kept, replayable; `queue-delete` =
  destroyed with its R2 body. Renames `ack`/`nack` to `remove`/`return`.
- `queue-extend`, `queue-requeue`, `queue-stats`, `hook-get` fill the
  remaining empty cells; the completeness matrix in section 10 is now an
  explicit phase-4 exit condition.

### v2 -- 2026-08-15 -- author: planning conversation

Three additions from Jonas, before link 1 spawned. No GOAL change, nothing
weakened -- all three widen the surface.

- Queue exit paths split three ways instead of two: `hook-ack` (tombstone,
  default), `hook-pull --delete-on-success` (delete as each event is handed
  over, only after it is written out without error), and `hook-delete` as a
  first-class verb plus `--acked` / `--before` bulk forms. Deleting an event
  you never acked -- a junk ping, a misconfigured provider's noise -- is a
  normal want and should not require pretending to process it first.
- Management completeness is now an explicit phase-4 gate: a create/list/
  inspect/modify/rotate/disable/delete matrix over both objects (receiver and
  queued message), with `hook-stats`, `hook-show`, `hook-requeue` and
  `hook-extend` added to fill the empty cells. No cell may require a raw curl
  or a D1 query.
- Full status-code table added to section 4. Jonas asked for 403 on an
  unregistered hook; the plan splits it instead -- `404` unregistered, `403`
  disabled, `410` expired, `401` bad signature, `429` throttled, `503` reserved
  for OUR failures only (the sole case where a provider should retry). The
  three receiver-state cases must stay distinguishable because "did it reach a
  receiver at all" is the one diagnostic that matters when a provider reports
  a failing endpoint -- but `403` on an unregistered slug would confirm the
  slug is real, handing an enumerator a yes/no oracle against a URL that IS
  the credential. So unknown stays `404`.
- Recorded Jonas's explicit green light to deploy (2026-08-15) in phase 6, so
  the final link ships rather than halting to ask, and added a live smoke test
  against the deployed worker as a phase-6 completion condition.

### v1 -- 2026-08-15 -- author: planning conversation

Initial plan. Written against the actual source (`src/api/router.ts`,
`src/lib/rules.ts`, `src/api/gates.ts`, `migrations/0001`+`0005`), not from
memory. Two revisions folded in before the chain started, both from the
`track-parcel` conversation relaying 17TRACK's real behaviour:

- Header policy: "signature/auth headers replaced with `<redacted>`" ->
  "complete header map stored; only true credentials (`Authorization`,
  `Cookie`, `Proxy-Authorization`, and whatever `auth_config` names) redacted;
  signature headers verbatim". The original was justified by a replay argument
  that does not hold -- an HMAC proves one specific body came from the signer
  and is worthless against any other request -- and it would have made
  consumer-side verification impossible, which is the single thing a faithful
  receiver exists to enable.
- Body handling: "read the raw body once, as text" -> "read as bytes, hash the
  bytes, decode to text only when valid UTF-8". The text-first form would have
  mangled a non-UTF-8 body irrecoverably.
- Added: the `digest` auth preset (plain SHA-256 over a template, not HMAC),
  `routing_key` extraction + index + `--key` filter, body-hash dedupe with a
  window for providers that send no message id, and `hook-rotate`.
- Settled §14 from Jonas: `/h/{box}/{slug}`, separate surface from drops,
  at-least-once leases, full six-phase chain.

No GOAL change. No requirement was weakened.
