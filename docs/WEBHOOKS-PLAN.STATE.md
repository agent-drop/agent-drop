---
chain_id: webhooks-20260815-115712-c042
plan_file: /Users/jonas/projects/agent-drop/docs/WEBHOOKS-PLAN.md
plan_version: 7
status: in_progress
current_phase: 4
last_updated: 2026-08-15T08:55:00Z
link_count: 3
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
- [x] 2. Verification -- all presets, hook-test (link 2)
  - [x] 2a. `SUPPORTED_AUTH_MODES` now DERIVED from the verifier's dispatch table
  - [x] 2b. `constantTimeEqual` lifted to `src/lib/compare.ts`, one copy
  - [x] 2c. `webhook-crypto.ts` -- byte-level signed message, hex/base64, matchesAny
  - [x] 2d. `webhook-schemes.ts` -- the 7 signed schemes' header/template trivia
  - [x] 2e. `webhook-verify.ts` -- dispatch, replay windows, 4 shared-secret modes
  - [x] 2f. Seam wired in `webhook-receive.ts`: verified 1 / 0 / NULL, verified
        against `bytes`, reason to the logs and never to the caller
  - [x] 2g. `hook-test` CLI + the `--auth-*` flags that make hmac/digest usable
  - [x] 2h. 17TRACK vector, case-insensitive compare, leading-zero signature
  - [x] 2i. **Bug found at runtime + fixed**: signature header was stored
        `<redacted>` (card `bug-signature-header-redacted`)
  - [x] 2j. RUNTIME check: verified=1 round trip, one-byte tamper -> 401 (log below)
  - [x] 77 new tests; full suite 543 pass / 0 fail; `bun run verify` exit 0
- [x] 3. Handshakes -- meta/slack/zoom/echo/static (link 3)
  - [x] 3a. `SUPPORTED_HANDSHAKE_MODES` DERIVED from the handshake dispatch table
  - [x] 3b. Zoom CRC re-verified against the live docs (plus Meta and Slack)
  - [x] 3c. `webhook-handshake.ts` -- all five modes, one dispatch table
  - [x] 3d. The seam in `webhook-receive.ts`, BEFORE verify, never falling through
  - [x] 3e. Handshakes stored `status='handshake'`, never deduped, never counted
  - [x] 3f. Config refused at registration when it could not answer; `meta` gets GET
  - [x] 3g. **Bug found + fixed**: a query-string secret was stored in plaintext
        (card `bug-query-secret-stored-plaintext`)
  - [x] 3h. CLI `--handshake-*` flags, shared by hook-create and hook-update
  - [x] 3i. Mutation-checked, three ways, before trusting a clean first run
  - [x] 3j. RUNTIME check: all five modes on `bun run dev` (log below)
  - [x] 42 new tests; full suite 585 pass / 0 fail; `bun run verify` exit 0
  - [x] 3k. integrated into `main` at `dc26ee0`
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

Phase 2 (link 2):

| File | What |
|---|---|
| `src/lib/compare.ts` | `constantTimeEqual`, lifted out of `auth.ts` -- one copy, two callers |
| `src/lib/webhook-crypto.ts` | hmac/digest, hex/base64, `buildSignedBytes` (bytes, not strings), `matchesAny` |
| `src/lib/webhook-schemes.ts` | the 7 signed schemes: header name, signature parsing, template, window |
| `src/lib/webhook-verify.ts` | dispatch, `checkSignature`, the replay window, the 4 shared-secret modes |
| `tools/lib/hook-sign.ts` | the producing half of the schemes, for `hook-test` |
| `test/helpers/verify.ts` | `fakeReceiver`, `verify()`, `flipOneByte` |
| `test/webhook-verify.test.ts` | 46 tests: the per-preset matrix + the digest encoding traps |
| `test/webhook-verify-shared.test.ts` | 19 tests: bearer / basic / header / query |

Modified: `src/lib/auth.ts` (imports the shared compare), `src/lib/webhook-defs.ts`
(`SUPPORTED_AUTH_MODES` derived), `src/lib/webhook-receive.ts` (the seam),
`src/lib/webhook-body.ts` (`secretHeaders` -- the redaction fix),
`tools/agent-drop.ts` (`hook-test`, the `--auth-*` flags on create+update,
`verdictLabel` so peek shows all three verdicts), `test/webhook-receive.test.ts`
(+8), `test/webhook-api.test.ts` (+1).

Phase 3 (link 3):

| File | What |
|---|---|
| `src/lib/webhook-handshake.ts` | the five modes in one dispatch table; `HANDSHAKE_MODES` is its keys |
| `test/webhook-handshake.test.ts` | 32 tests: per-mode challenges, the ordering guarantee, what a handshake is not |

Modified: `src/lib/webhook-defs.ts` (`SUPPORTED_HANDSHAKE_MODES` derived),
`src/lib/webhook-receive.ts` (the seam + a shared store envelope),
`src/lib/webhook-body.ts` (`secretParams`, and `static` predicate headers),
`src/lib/webhook-store.ts` (`collectQuery` takes a redaction list),
`src/api/hook-config.ts` (`handshakeConfigError`, `methodsForHandshake`),
`src/api/hooks.ts` (both gates, on create and on patch),
`tools/agent-drop.ts` (`withHandshakeOptions` on create + update, `hook-get`),
`test/helpers/env.ts` (`handshakeConfig` on `seedReceiver`),
`test/webhook-receive.test.ts` (+3), `test/webhook-api.test.ts` (+7).

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

Phase 2 (link 2) -- all recorded in PLAN v6's changelog:

- **`auth_config.header` means two different things, and getting it backwards is
  SILENT.** Shared secret under `header` mode; the signature under `hmac` and
  `digest`. Redacting a signature destroys consumer-side verification -- the one
  thing the whole receiver exists to enable -- and nothing reports a problem:
  the event stores, the status is 200, the body is perfect. Rule: **default
  redact, `hmac`/`digest` are the only exception.** Phase 3 touches the same
  file.
- **`SUPPORTED_AUTH_MODES` is derived from `VERIFIER_MODES`, not typed out.**
  The two halves of a fail-closed gate cannot drift if only one of them exists.
  Phase 3 should do the same for handshakes.
- **The signed message is assembled as BYTES.** `buildSignedBytes` splices the
  raw body in unmodified; building the string first would have reintroduced the
  UTF-8 round trip one layer below the one §4 avoids.
- **A signature list is never just its first entry.** `standard` and `stripe`
  both send several mid-rotation, and every candidate is compared even after one
  matches, so the timing does not say WHICH matched.
- **Hex is compared case-insensitively and zero-padded up to width.** 17TRACK's
  BigInteger encoding drops leading zeros, so ~1 in 256 signatures is 63 chars.
  Pinned by a real fixture whose digest starts with `0`.
- **The 401 body says nothing about why.** The reason goes to
  `console.warn` for the operator; a caller probing for a working secret learns
  only that it failed.

Phase 3 (link 3) -- all recorded in PLAN v7's changelog:

- **`collectQuery` had no redaction list and `collectHeaders` always did.** The
  asymmetry was free until something named a query parameter as a credential;
  `auth_mode: query` did that in phase 2 and `meta` would have again in phase 3.
  A shared secret is no less a credential for arriving in a `?token=`. Card
  `bug-query-secret-stored-plaintext`. **Phase 4 note: any new surface that
  copies a request into a row wants both lists, not one.**
- **A failed handshake is still a handshake.** A wrong Meta verify token answers
  403 instead of falling through, because the fall-through path answers
  `{"ok":true}` -- which is not the challenge, so Meta fails the validation while
  our logs show an ordinary event and the queue fills with probes.
- **Detection is on SHAPE, and every handler may decline.** A `meta`/`slack`/
  `zoom` receiver takes ordinary deliveries on the same URL; the handler returns
  null and the normal verify-and-store path has it. That is why `echo` and
  `static` are bounded (short non-JSON only; empty predicate matches nothing) --
  an unbounded one would silently divert a live queue into `handshake`.
- **A handshake is never deduped.** Zoom re-runs its CRC every 72 hours with a
  fresh token, but a receiver on body-hash dedupe would have swallowed a repeat.
  It is also never counted: `event_count` describes the queue, and a handshake
  never joins it.
- **A storage failure does not fail a handshake.** The one place where a write we
  could not complete is NOT a 503. There is no event to keep -- the answer is the
  whole product.
- **Zoom, Meta and Slack were all re-verified against live docs**, not memory.
  Zoom's field names are unchanged since the plan was written; `204` is
  acceptable as well as `200`, and six consecutive failures disable the endpoint.

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

## Phase 2 runtime log -- verification, proven on `bun run dev`

Not tests: the real worker in workerd, real local D1, real local R2. Every
signature below was computed with `shasum` OUTSIDE the codebase, so a pass is
agreement with an external tool rather than the code agreeing with itself.

```
$ drop hook-create lisa track-17 --auth digest --secret 123456ABCDEF \
    --auth-header sign --preset generic --routing-key data.tag \
    --dedupe body-hash --dedupe-window 65m
  Receiver created: lisa/track-17-0qjqda
  id e835b2c1-7699-49ab-b1b0-97fbfc581d0e  POST  keeps 120d
                                     <- no "URL IS the credential" warning now:
                                        a secret is set, so the URL is not it

$ shasum -a 256 fresh.json
3e4a3eb469916ed9748a4b8eb9aca621c00ee67d16cb6067796287a16bcbe68d  fresh.json
$ SIGN=$(cat fresh.json <(printf '%s' '/123456ABCDEF') | shasum -a 256 | cut -d' ' -f1)
  99d58000af5855efe1091678c3b3fdc277e218eaf7fa85bebd9ed6b734b96d18

$ curl -X POST localhost:5173/h/lisa/track-17-0qjqda \
    -H "sign: $SIGN" -H 'Authorization: Bearer should-be-redacted' \
    --data-binary @fresh.json
{"ok":true,"id":"01m01zqjpjvmqjnvhw90ybmk3s"}   HTTP 200

$ drop queue-peek lisa 01m01zqjpjvmqjnvhw90ybmk3s
  POST lisa/track-17-0qjqda  queued  verified      <- verified=1, not NULL
  type/key parcel-77
  95B  sha256 3e4a3eb469916ed9748a4b8eb9aca621c00ee67d16cb6067796287a16bcbe68d
                                                   ^ MATCHES the sent file
  headers:
    authorization: <redacted>                      <- a credential in its own right
    sign: 99d58000af5855efe1091678c3b3fdc277e218eaf7fa85bebd9ed6b734b96d18
                                                   ^ VERBATIM. this is the bug
                                                     fixed this phase; a consumer
                                                     re-verifies from exactly this
```

One byte, and only one byte, different -- the same signature:

```
$ cmp -l body.json tampered.json | wc -l
       1
$ curl -X POST ... -H "sign: $SIGN" --data-binary @tampered.json
{"error":"signature verification failed"}   HTTP 401

$ drop queue-peek lisa 01m01zqbmt7fg962cxzeztagyd
  POST lisa/track-17-0qjqda  rejected  SIGNATURE FAILED   <- stored, verified=0
  95B  sha256 22a42191ae993e95a51adf37a7734fd30ab68553318950cc285dfb1fb21318b2
```

`hook-test`, and an HMAC preset as well as the digest one, so the round trip is
not just proving the one simplest scheme:

```
$ drop hook-test lisa/track-17-0qjqda --secret 123456ABCDEF --url http://localhost:5173
  POST http://localhost:5173/h/lisa/track-17-0qjqda
  auth digest  113 bytes
  200 {"ok":true,"id":"01m01zr2ebnf55ankx51thzkry"}

$ drop hook-test lisa/track-17-0qjqda --secret wrong-key --url http://localhost:5173
  401 {"error":"signature verification failed"}
  Receiver did not accept it.                            <- exit 4

$ drop hook-create lisa stripe-live --auth stripe --secret whsec_live_test --preset stripe
$ drop hook-test lisa/stripe-live-jaekt0 --secret whsec_live_test --url http://localhost:5173
  200 {"ok":true,"id":"01m01zr9pdvvd2ng3bgh7kwj2y"}
$ drop hook-test lisa/stripe-live-jaekt0 --secret whsec_nope --url http://localhost:5173
  401 {"error":"signature verification failed"}
```

Left behind in the LOCAL dev D1 for phase 3 to reuse: receivers
`lisa/track-17-0qjqda` (digest) and `lisa/stripe-live-jaekt0` (stripe), and an
admin API key named `p2-runtime`.

## Phase 3 runtime log -- handshakes, proven on `bun run dev`

Not tests: the real worker in workerd, real local D1, real local R2. Zoom's
expected hash was computed with `openssl` OUTSIDE the codebase, so a match is
agreement with an external tool rather than the code agreeing with itself.

```
$ drop hook-create lisa fb-page --handshake meta --handshake-token verify-me-please
  https://frst.dev/h/lisa/fb-page-1125es
  id 3a0ecf58-506a-462f-a794-30759a511b0e  POST,GET  keeps 120d
  handshake meta, GET added for it        <- Meta verifies over GET; POST-only
                                             would have 405'd before the handshake

$ curl "…/h/lisa/fb-page-1125es?hub.mode=subscribe&hub.challenge=1158201444\
&hub.verify_token=verify-me-please"
HTTP 200  content-type=text/plain; charset=utf-8
body: [1158201444]                        <- bare, not JSON, not quoted

$ curl "…?hub.mode=subscribe&hub.challenge=999&hub.verify_token=nope"
{"error":"hub.verify_token mismatch"}  HTTP 403   <- never falls through

$ drop --format json queue-peek lisa 01m020t2q7ddnvyzbyt0qh0jqd
  query: {"hub.mode":"subscribe","hub.challenge":"999",
          "hub.verify_token":"<redacted>"}        <- the bug fixed this phase
```

The ordering guarantee, live -- the same receiver, the same invalid signature,
two different requests:

```
$ printf '%s' 'qgg8vlvZRS6UYooatFL8Aw' | openssl dgst -sha256 -hmac 'zoomSecret123' -hex
  3ee215dfbe53223d6ab24ea678f99d586ea8dc959ce3f737482a1a702f29ac2f   <- ground truth

$ drop hook-create lisa zoom-crc --handshake zoom --handshake-secret zoomSecret123 \
    --auth digest --secret signing-key --auth-header sign

# Zoom's real CRC shape, signature DELIBERATELY garbage:
$ curl -X POST …/h/lisa/zoom-crc-s7rw1m -H 'sign: deadbeef…deadbeef' \
    -d '{"payload":{"plainToken":"qgg8vlvZRS6UYooatFL8Aw"},"event_ts":1654503849680,
         "event":"endpoint.url_validation"}'
{"plainToken":"qgg8vlvZRS6UYooatFL8Aw",
 "encryptedToken":"3ee215dfbe53223d6ab24ea678f99d586ea8dc959ce3f737482a1a702f29ac2f"}
  HTTP 200                                 <- MATCHES openssl. never reached the verifier

# same receiver, same garbage signature, an ORDINARY delivery:
$ curl -X POST …/h/lisa/zoom-crc-s7rw1m -H 'sign: deadbeef…deadbeef' \
    -d '{"event":"meeting.started"}'
{"error":"signature verification failed"}   HTTP 401   <- the control
```

The other three modes, and the fall-through half of each:

```
slack url_verification  -> {"challenge":"3eZbrw1aBm2rZgRNFdxV…"}      200
slack event_callback    -> {"ok":true,"id":"01m020vncjxra3c25s4f5py8mj"}
echo  'challenge-abc123' -> challenge-abc123                          200
echo  {"real":"event"}   -> {"ok":true,"id":"01m020vne1k58pbrr1d58bmg0f"}
static GET /ping         -> PONG                                      200
static GET /elsewhere    -> {"ok":true,"id":"01m020vnf87w3gxy6tm629s984"}

$ drop hook-create lisa broken-zoom --handshake zoom
API 400: handshake_mode 'zoom' needs the webhook secret token -- its CRC
         answer is an HMAC keyed by it          <- refused, not left to fail live
```

Every mode stored, and nothing miscounted:

```
handshake  fb-page-1125es     meta.url_verification    verified=None
handshake  zoom-crc-s7rw1m    endpoint.url_validation  verified=None
handshake  slack-app-prcmjt   url_verification         verified=None
handshake  echo-box-wyc5nt    echo                     verified=None
handshake  setup-ping-jha5mj  static                   verified=None
rejected   zoom-crc-s7rw1m    (the control)            verified=0

  zoom-crc-s7rw1m   handshake=zoom   events=0    <- a handshake never joins the
  fb-page-1125es    handshake=meta   events=0       queue, so it is not counted
  slack-app-prcmjt  handshake=slack  events=1    <- the one real delivery
```

`verified=None` and not 0 throughout: 0 would mean the verifier ran and said no,
null means it was never asked. That distinction IS the phase.

Left behind in the LOCAL dev D1 for phase 4 to reuse: receivers
`lisa/track-17-0qjqda` (digest), `lisa/stripe-live-jaekt0` (stripe),
`lisa/zoom-crc-s7rw1m` (zoom + digest), `lisa/fb-page-1125es` (meta),
`lisa/slack-app-prcmjt`, `lisa/echo-box-wyc5nt`, `lisa/setup-ping-jha5mj`, and
17 events across `queued` / `handshake` / `rejected` -- a decent queue to lease
against. Admin API key named `p3-runtime` (value not recorded; make your own with
`drop key-create`). The CLI reaches local dev via `AGENT_DROP_URL=http://localhost:5173`
-- export it AFTER `source ~/.secrets`, which sets the production key.

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
- 2026-08-15T06:10:00Z [link 1] **second off-mission bug**, card
  `bug-deploy-guard-fails-silently`: fixing the lint failure unmasked it, since
  the job had never reached the step. `bun scripts/deploy.ts --dry-run` exited 1
  with NO output when wrangler was off PATH (devDependency + bare `spawnSync` +
  `stdio: "inherit"` + `?? 1`). CI is the only caller that invokes it directly,
  so its deploy dry-run could never have worked. Now spawns via `bunx` and
  prints `describeSpawnFailure()`. RED test first.
- 2026-08-15T06:12:00Z [link 1] **CI green on main** (`dd470d6`) -- first green
  run of this chain. Commits: `233edde` biome, `4c877b7` phase 1, `dd470d6`
  deploy guard.
- 2026-08-15T07:35:00Z [link 2] **phase 2 complete.** All 11 auth modes verify:
  `standard`, `github`, `stripe`, `slack`, `shopify`, `hmac`, `digest`,
  `bearer`, `basic`, `header`, `query`. 77 new tests, full suite 543 pass / 0
  fail, `bun run verify` exit 0. Every signed-preset fixture was computed
  outside the codebase with `openssl dgst` / `shasum`, and the `github` and
  `standard` rows are the providers' own published vectors -- so a pass means
  agreement with the provider, not with ourselves. The 17TRACK vector was
  recomputed a third time and agrees. Runtime round trip transcribed above.
  Plan v5 -> v6.
- 2026-08-15T07:20:00Z [link 2] **off-mission bug found and fixed**, card
  `bug-signature-header-redacted`: `secretHeaders()` redacted
  `auth_config.header` for every mode, but `hmac` and `digest` use that key to
  name the SIGNATURE rather than a secret -- so every signature header was
  stored as `<redacted>`, silently voiding the plan's "a consumer holding the
  provider's secret can verify what we stored" criterion. Found during the
  runtime round trip, not by a test. RED first, both directions; phase 1's
  existing redaction test passes unchanged and caught an over-correction on the
  first attempt at the fix.
- 2026-08-15T07:10:00Z [link 2] mutation-checked the new suite rather than
  trusting 46 first-run passes: swapping `standard`'s template to
  `{ts}.{id}.{body}` turns 3 tests red, restoring it turns them green. The
  fixtures bite.
- 2026-08-15T08:20:00Z [link 3] Zoom CRC re-verified against
  `developers.zoom.us/docs/api/webhooks/` as PLAN §6 required -- field names
  unchanged, and two details added to §6 (`204` is acceptable too; six
  consecutive failures disable the endpoint). Meta and Slack re-checked the same
  way against `developers.facebook.com` and `docs.slack.dev`; both match.
- 2026-08-15T08:40:00Z [link 3] **off-mission bug found and fixed**, card
  `bug-query-secret-stored-plaintext`: `collectQuery` copied the whole query
  string into the row untouched while `collectHeaders` had taken a redaction list
  since phase 1. Phase 2's `auth_mode: query` turned `auth_config.param` into a
  credential and the gap opened silently; phase 3's `meta` (`hub.verify_token`)
  would have widened it. Mirror image of phase 2's bug -- that one destroyed
  evidence that should have been kept, this one kept a credential that should
  have been destroyed. Proven RED by mutation (3 tests) before the fix stood.
- 2026-08-15T08:55:00Z [link 3] **phase 3 complete.** All five handshake modes:
  `meta`, `slack`, `zoom`, `echo`, `static`. 42 new tests, full suite 585 pass /
  0 fail, `bun run verify` exit 0. Zoom's expected HMAC was computed with
  `openssl` and again with python's `hmac` outside the codebase, both agreeing,
  and one fixture pins a digest with a leading zero. Mutation-checked three ways
  before the clean run was trusted: swapping the HMAC key and message turns 4
  red; making a configured signature suppress the handshake turns exactly the
  PLAN's required test red; dropping the query redaction turns 3 red. Runtime
  round trip transcribed above, including the ordering guarantee against a live
  worker. Plan v6 -> v7.
