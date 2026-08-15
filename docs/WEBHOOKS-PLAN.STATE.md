---
chain_id: webhooks-20260815-115712-c042
plan_file: /Users/jonas/projects/agent-drop/docs/WEBHOOKS-PLAN.md
plan_version: 5
status: in_progress
current_phase: 2
last_updated: 2026-08-15T05:52:00Z
link_count: 1
---

# Agent Drop webhook-receiver chain state

## Phases

- [x] 1. Schema, receiver CRUD, and the public endpoint (link 1)
  - [x] 1a. Migration `0009_webhook_receivers.sql` -- both tables, all indexes
  - [x] 1b. `/h/*` branch in `src/index.ts` + `run_worker_first`
  - [x] 1c. `src/lib/webhook-receive.ts` -- raw-bytes ordering per section 4
  - [x] 1d. Status codes: 404 unregistered / 403 disabled / 410 expired
  - [x] 1e. `src/api/hooks.ts` -- receiver CRUD (asAdmin) + queue reads (keyedReader)
  - [x] 1f. CLI: hook-create/list/get/url/update/delete, queue-list/peek/body
  - [x] 1g. RUNTIME check: byte-identical round trip on `bun run dev` (log below)
  - [x] 53 new tests green; full suite 466 pass / 0 fail; `bun run verify` exit 0
- [ ] 2. Verification -- all presets, hook-test
- [ ] 3. Handshakes -- meta/slack/zoom/echo/static
- [ ] 4. The pull queue -- lease/remove/return/delete/put/peek + completeness gate
- [ ] 5. Onward delivery -- RuleSubject, hook channel, passthrough, replay
- [ ] 6. Retention, provisioning, deploy, docs

## Artifacts produced

Phase 1 (link 1):

| File | What |
|---|---|
| `migrations/0009_webhook_receivers.sql` | `webhook_receivers` + `webhook_events`, all indexes |
| `src/lib/webhook-receive.ts` | the `/h/` flow: resolve -> method -> cap -> bytes -> store -> respond |
| `src/lib/webhook-store.ts` | header collection + redaction, dedupe lookup, the insert |
| `src/lib/webhook-body.ts` | sha256, strict UTF-8 decode, parse-for-extraction-only |
| `src/lib/webhook-extract.ts` | presets, dotted-path reader, dedupe key derivation |
| `src/lib/webhook-defs.ts` | `HOOK_PREFIX`, supported modes, `hookUrl`, `slugSuffix` |
| `src/api/hooks.ts` | receiver CRUD, `asAdmin`, prefix-routed |
| `src/api/hook-config.ts` | receiver config validation + the secret-free public view |
| `src/api/hook-queue.ts` | queue reads (list / peek / one / body), `keyedReader` |
| `test/webhook-receive.test.ts` | 33 tests: byte fidelity, headers, status table, dedupe |
| `test/webhook-api.test.ts` | 20 tests: CRUD gates, scope enforcement, peek-mutates-nothing |

Modified: `src/index.ts` (the `/h/` branch), `src/api/router.ts` (one Tier-1 +
four Tier-2 routes), `src/types.ts`, `src/lib/normalize.ts` (`normalizeSlug`),
`wrangler.toml` (`run_worker_first`), `tools/agent-drop.ts` (9 verbs),
`test/helpers/env.ts` (`seedReceiver`, byte-preserving `makeBucket`).

Files split to stay under the 200-line rule: `webhook-receive` ->
`+ webhook-body` `+ webhook-defs`; `hooks` -> `+ hook-config`; queue reads went
to `hook-queue` rather than into `hooks`.

## Decisions

- 2026-08-15: URL shape `/h/{box}/{slug}`, not `/api/hook/*` -- keeps the
  router's "unknown /api/ path = 401, not 404" invariant intact.
- 2026-08-15: webhook events are a separate surface from drops; `mirror_to_drops`
  is an off-by-default phase-5 convenience.
- 2026-08-15: at-least-once with leases is the queue default.
- 2026-08-15: full header map stored, only true credentials redacted. Signature
  headers verbatim -- consumer-side verification depends on them.
- 2026-08-15: 404 unregistered / 403 disabled / 410 expired. Not collapsed, and
  not 403-for-unknown (that confirms a slug is real to an enumerator).
- 2026-08-15: verb vocabulary `hook-*` (receiver) and `queue-*` (messages),
  peek = get with no lease.

Phase 1 (link 1) -- all recorded in PLAN v5's changelog:

- **Unsupported modes fail closed, at BOTH ends.** `SUPPORTED_AUTH_MODES` /
  `SUPPORTED_HANDSHAKE_MODES` live in `src/lib/webhook-defs.ts` and are `["none"]`
  until phases 2 and 3 extend them. The CRUD refuses to register a mode nothing
  implements, and if one ever reaches the receive path it stores the event with
  `verified=0, status='rejected'` and answers 401. Writing `verified=1` for a
  signature no code checked would be a lie in the database. **Phase 2's first
  edit is adding its presets to that array** -- the verifier is dead code until
  it does.
- **Body-hash dedupe keys are bucketed** (`{sha}.{floor(now/window)}`) with the
  previous bucket checked as an alternate. A bare hash could not expire, because
  the unique index has no time component.
- **A duplicate does not bump `event_count`.** It stored nothing, and a counter
  that disagrees with its own queue is worse than no counter. Caught at runtime,
  not by a test -- the test came after.
- **`?since=` orders by arrival MILLISECOND.** Two events in the same millisecond
  sort by their random ULID tail, either way. Found by a test that passed alone
  and failed in the full suite. Documented at the query in `hook-queue.ts`.
- Queue reads filter by `inbox` AND id, never id alone -- the inbox is what the
  gate approved, so an id by itself must never reach another box's event.

## Open questions / blockers

- (none blocking)

**RESOLVED 2026-08-15 (plan v4).** 17TRACK's signature scheme is CONFIRMED
first-hand against the v2.4 docs: plain SHA-256 over `{body}/{secret}`, header
`sign`, lowercase hex, NOT HMAC. Test vector pinned in PLAN §5 and recomputed
independently in the planning conversation before being trusted. Phase 2 needs
no doc round trip -- just pin the vector, plus a case-mismatch test and a
leading-zero test (their Java sample's `BigInteger` encoding drops leading
zeros, so ~1 in 256 signatures is 63 chars without the pad).

**STILL UNVERIFIED -- a known limit, not a blocker.** The *wire format*. No real
17TRACK push has ever fired at us, and the docs' example body is abridged (no
`track_info`). The algorithm is confirmed; the bytes on the wire are not. If a
live push fails verification, suspect the bytes before the template -- which is
exactly why §4 hashes `arrayBuffer()` and never a re-encode. Phase 6's live
smoke test and the first real push are where this gets settled.

## Standing authorizations

- Jonas gave an explicit green light to deploy (2026-08-15). Phase 6 ships:
  remote migration, `bun run deploy`, R2 lifecycle rule, live smoke test. Do
  not halt to ask.

## Consumers waiting

- `track-parcel` (project `scratch-temp`, conversation
  `scratch-temp:inter-express-cheese-tra`) is holding its 17TRACK registration
  until this is live, and is the first real consumer. When phase 6 completes,
  message that conversation with the receiver URL, the box name, and
  confirmation that firing 17TRACK's dashboard "WebHook test" button is safe.

## Phase 1 runtime log -- byte fidelity, proven on `bun run dev`

Not tests: the real worker in workerd, real local D1, real local R2, driven by
the real CLI. `bun run db:migrate:local` applied `0009` first.

```
$ drop hook-create lisa stripe-prod --preset stripe --routing-key data.object.customer
  Receiver created: lisa/stripe-prod-h0d6rr
  https://frst.dev/h/lisa/stripe-prod-h0d6rr
  id 6c22e147-313a-4d52-8864-96021658ed78  POST  keeps 120d

  No signature configured: this URL IS the credential.

$ shasum -a 256 body.json          # 143 bytes: odd key order, interior newline,
573425f3b945...3b3fea8  body.json  # a é escape AND a literal é, 1.50

$ curl -X POST localhost:5173/h/lisa/stripe-prod-h0d6rr \
    -H 'Content-Type: application/json' \
    -H 'Stripe-Signature: t=1786771000,v1=abc123deadbeef' \
    -H 'Authorization: Bearer this-should-be-redacted' \
    --data-binary @body.json
{"ok":true,"id":"01m01xy01m54sfxcfj9123ahfh"}   HTTP 200

$ drop queue-peek lisa
  01m01xy01m54sfxcfj9123ahfh  2026-08-15 05:22:21
  POST lisa/stripe-prod-h0d6rr  queued
  type/key charge.succeeded / cus_42          <- stripe preset + routing-key path
  143B  sha256 573425f3b945...3b3fea8         <- MATCHES the sent file
  headers:
    authorization: <redacted>                 <- a credential in its own right
    stripe-signature: t=1786771000,v1=abc...  <- VERBATIM, consumers verify with it

$ drop queue-body lisa 01m01xy... -o roundtrip.bin
$ cmp body.json roundtrip.bin && echo IDENTICAL
IDENTICAL
573425f3b945...3b3fea8  body.json        <- identical hashes, both directions
573425f3b945...3b3fea8  roundtrip.bin
```

Non-UTF-8 body, the case a text-first read would have destroyed:

```
$ printf '\x00\xff\xc3\x28\x89PNG\r\n\x1a\n\xfe\xed' > binary.bin   # 0xC3 0x28 is invalid UTF-8
b89221d0056d...cea0d4  binary.bin
$ curl --data-binary @binary.bin ... -> {"ok":true,"id":"01m01y0symwnkcdh3ktfsgy6z1"}
$ drop queue-body lisa 01m01y0s... -o binary-back.bin
$ cmp binary.bin binary-back.bin && echo IDENTICAL
IDENTICAL
b89221d0056d...cea0d4  binary-back.bin
  body_text:   None                                        <- never decoded
  body_r2_key: hooks/lisa/stripe-prod-h0d6rr/01m01y0sym...  <- raw bytes in R2
```

Status table and dedupe, live:

```
retry, same $.id     -> {"ok":true,"id":"01m01xy...","duplicate":true}   queue still 1 row
unknown slug         -> 404
GET on a POST-only   -> 405  Allow=POST
disabled receiver    -> 403 {"error":"receiver disabled"}
hook-delete --purge  -> "Receiver deleted (2 event(s) destroyed)"
```

## Log

- 2026-08-15T04:57:12Z [link 1] chain started at plan v3, phase 1
- 2026-08-15T05:14:00Z [planning] plan v3 -> v4: 17TRACK signature scheme
  confirmed first-hand against the v2.4 docs, test vector pinned in §5 and
  independently recomputed, phase-2 blocker cleared. Wire format recorded as a
  known limit.
- 2026-08-15T05:52:00Z [link 1] **phase 1 complete.** Schema, the public `/h/`
  endpoint, receiver CRUD, the read side of the queue, 9 CLI verbs, 53 tests.
  `bun run verify` exit 0; full suite 466 pass / 0 fail. Byte-identical round
  trip proven on `bun run dev` for both a UTF-8 and a non-UTF-8 body (transcript
  above). Plan v4 -> v5: six schema columns §3 omitted but §4/§7/§11 require,
  plus two implementation facts (bucketed body-hash dedupe, millisecond-grained
  `?since=`).
- 2026-08-15T05:52:00Z [link 1] **off-mission bug found and fixed**, card
  `bug-biome-lints-design-assets`: biome linted `assets/` and failed on three
  icon SVGs, so `bun run check` -- and GitHub Actions -- was RED on main before
  this phase started (`f2ecc12` and `ffa2841` both failed, both docs-only).
  `!assets` added to `biome.jsonc`. Committed separately from the phase work.
