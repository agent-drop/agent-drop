---
chain_id: webhooks-20260815-115712-c042
plan_file: /Users/jonas/projects/agent-drop/docs/WEBHOOKS-PLAN.md
plan_version: 10
status: completed
current_phase: 6
last_updated: 2026-08-15T15:10:00Z
link_count: 6
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
- [x] 4. The pull queue -- lease/remove/return/delete/put/peek + completeness gate (link 4)
  - [x] 4a. `hook-lease.ts` -- the UPDATE...RETURNING, get/remove/return/extend/requeue
  - [x] 4b. `hook-queue-write.ts` -- put through the real receive path, delete, stats
  - [x] 4c. `hook-rotate` -- new slug, grace window, history intact
  - [x] 4d. Router: ten routes, everything mutating under `keyedWriter`
  - [x] 4e. CLI: the ten `queue-*` verbs + `hook-rotate`
  - [x] 4f. Section 10's completeness matrix walked cell by cell -- no cell needs a curl
  - [x] 4g. `?receiver=` resolves through the receiver row, so rotation costs no history
  - [x] 4h. **Bug found at runtime + fixed**: a rejected row deduped against its own
        valid retry (card `bug-rejected-row-blocks-its-own-retry`)
  - [x] 4i. Tests: every claim in the phase-4 verify block, mutation-checked six ways
  - [x] 4j. RUNTIME check on `bun run dev` against the 17 real events (log below)
  - [x] 49 new tests; full suite 634 pass / 0 fail; `bun run verify` exit 0
  - [x] 4k. integrated into `main` at `d8e61b3`
- [x] 5. Onward delivery -- RuleSubject, hook channel, passthrough, replay (link 5)
  - [x] 5a. `fireRules` narrowed from `Drop` to `RuleSubject` -- both suites pass UNCHANGED
  - [x] 5b. `hook` channel in `findMatchingRules`/`fireRules`; `scopes: all` covers it
  - [x] 5c. `{slug}`, `{event_type}` and `{routing_key}` template variables
  - [x] 5d. `payload_mode` (migration `0010`), `envelope` default, `passthrough` verbatim
  - [x] 5e. ONE stored-body reader (`webhook-load.ts`) and ONE header filter
        (`webhook-headers.ts`), shared by `queue-body`, passthrough and `queue-replay`
  - [x] 5f. The seam in `webhook-receive.ts`: accepted, non-duplicate events only
  - [x] 5g. `hook-replay` (server side, queued + logged) beside `queue-replay` (client
        side, one shot); both `--help` texts say which is which
  - [x] 5h. `mirror_to_drops`, off by default, does not re-fire rules
  - [x] 5i. Self-delivery loop refused on the `hook` channel and logged, never queued
  - [x] 5j. **Bug found at runtime + fixed**: the retry backoff never escalated
        (card `bug-webhook-backoff-never-escalates`)
  - [x] 5k. **Second bug found + fixed**: `rule-test` reported forwards as firing on
        non-email channels; prediction extracted to `tools/lib/rule-preview.ts`
  - [x] 5l. **Third bug found by the new tests**: a rule header differing only in CASE
        from a stored one was appended, not overridden (`User-Agent: Stripe/1.0, mine`)
  - [x] 5m. Mutation-checked seven ways before trusting a clean run
  - [x] 5n. RUNTIME check on `bun run dev`: envelope, passthrough, escalating backoff,
        replay, loop refusal, mirror (log below)
  - [x] 36 new tests; full suite 670 pass / 0 fail; `bun run verify` exit 0
  - [x] 5o. integrated into `main` at `e462dd0`
- [x] 6. Retention, provisioning, deploy, docs (link 6)
  - [x] 6a. `hook-reaper.ts` -- expired events, 500/run, R2 bodies before rows
  - [x] 6b. `runSweeps` -- both sweeps settled, neither can cancel the other
  - [x] 6c. Every existing test in `test/reaper.test.ts` passes UNCHANGED (file untouched)
  - [x] 6d. `HOOK_RATE_LIMIT` binding, keyed by receiver id, fails open
  - [x] 6e. `daily_cap` enforced in D1 -- rolling 24h, after the handshake, never before
  - [x] 6f. 30 new tests; full suite 700 pass / 0 fail; `bun run verify` exit 0
  - [x] 6g. Mutation-checked six ways before trusting the clean run
  - [x] 6h. Local cron tick on `bun run dev` -- expired event + R2 body gone (log below)
  - [x] 6i. Remote migrations `0009` + `0010` applied, THEN `bun run deploy`
  - [x] 6j. R2 lifecycle `hooks-130d` added and verified
  - [x] 6k. LIVE smoke test on `https://frst.dev/h/...` (log below)
  - [x] 6l. Docs: `CLAUDE.md`, `README.md`, the `agent-drop` skill
  - [x] 6m. integrated into `main` at `37013cc`

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

Phase 4 (link 4):

| File | What |
|---|---|
| `src/api/hook-lease.ts` | the one `UPDATE ... RETURNING` with the subselect, plus remove / return / extend / requeue |
| `src/api/hook-queue-write.ts` | `put` through the real receive path, single + bulk `delete`, `stats` |
| `src/api/hook-rotate.ts` | new slug on the same row, `previous_slug` + grace window |
| `tools/lib/queue-emit.ts` | the `--delete-on-success` loop, extracted so its ORDERING is testable |
| `test/webhook-queue.test.ts` | 23 tests: leasing, concurrency, expiry, peek-inertness, the ack |
| `test/webhook-queue-admin.test.ts` | 24 tests: put, delete, stats, rotate, the emit loop |

Modified: `src/api/router.ts` (ten routes; `stats` deliberately BEFORE `:id`),
`src/api/hook-queue.ts` (`detail` exported, `resolveReceiverId`),
`src/api/hooks.ts` (the `rotate` sub-route),
`src/lib/webhook-receive.ts` (`ReceiveOutcome`, an out-param so `queue-put`
learns the id without changing what a provider sees),
`src/lib/webhook-store.ts` (the dedupe fix),
`tools/agent-drop.ts` (ten verbs), `test/webhook-receive.test.ts` (+2).

Phase 5 (link 5):

| File | What |
|---|---|
| `migrations/0010_rule_payload_mode.sql` | `payload_mode` on `drop_rules`, default `envelope` |
| `src/lib/rule-match.ts` | pattern matching + scope filtering, split out of `rules.ts` |
| `src/lib/rule-payload.ts` | the two wire formats, `mergeHeaders`, `buildDelivery` |
| `src/lib/rule-deliver.ts` | the retrying queue consumer (now on `Message.attempts`) |
| `src/lib/webhook-headers.ts` | `replayableHeaders` -- the ONE redaction + hop-by-hop filter |
| `src/lib/webhook-load.ts` | `loadStoredBody` -- the ONE inline-vs-R2 reader |
| `src/lib/hook-fanout.ts` | fire rules + mirror, for an accepted event only |
| `src/api/hook-replay.ts` | `POST .../:id/replay` -- server-side, through the queue |
| `tools/lib/rule-preview.ts` | `rule-test`'s prediction, extracted so it is testable |
| `test/webhook-rules.test.ts` | 36 tests: the channel, the envelopes, passthrough, replay, mirror |

Modified: `src/types.ts` (`RuleSubject`, `RuleChannel`, the passthrough fields on
`WebhookQueueMessage`, `attempt` deprecated), `src/lib/rules.ts` (firing only --
matching, payload and delivery moved out), `src/lib/webhook-receive.ts` (the
fan-out seam), `src/lib/webhook-store.ts` (`storeEvent` returns the row it wrote,
bound from the same object it returns), `src/api/hook-queue.ts` (uses the shared
body reader), `src/api/rules.ts` (`payloadMode` in + out), `src/api/hooks.ts` +
`hook-config.ts` (`mirrorToDrops` at create), `src/api/router.ts` (the replay
route), `tools/agent-drop.ts` (`hook-replay`, `--payload-mode`, `--mirror`,
`--scope hook`, `rule-test --channel hook`), `test/webhook-receive.test.ts` (one
count: two deferred tasks now, not one).

`rules.ts` was 279 lines and would have been 526; it is 195 after the split, and
every existing import of `lib/rules` still resolves through re-exports.

Phase 6 (link 6):

| File | What |
|---|---|
| `src/lib/hook-reaper.ts` | the retention sweep: 500/run, oldest expiry first, R2 bodies before rows |
| `src/lib/webhook-throttle.ts` | `HOOK_RATE_LIMIT` (fails open) + the D1 daily cap (does not) |
| `test/hook-reaper.test.ts` | 14 tests: what the cron destroys, what it must not, and both sweeps in one tick |
| `test/webhook-throttle.test.ts` | 16 tests: the burst shed, the cap, and the handshake that outranks it |

Modified: `src/lib/reaper.ts` (`runSweeps` -- both sweeps settled; `runScheduled`
untouched), `src/index.ts` (the cron calls `runSweeps`), `src/lib/webhook-receive.ts`
(two seams: burst before the body read, cap after the handshake), `src/types.ts`
(`HOOK_RATE_LIMIT`), `wrangler.toml` (the third `[[ratelimits]]`),
`tools/agent-drop.ts` (two `--daily-cap` help strings that described a calendar
day), `test/helpers/env.ts` (`dailyCap` on `seedReceiver`, the binding on `makeEnv`),
`CLAUDE.md`, `README.md`.

**`test/reaper.test.ts` was not opened.** The phase's own gate: the stale-`pending`
sweep is unchanged, so its 12 tests pass with the file byte-identical.

Outside the repo (not committed): `~/.claude/skills/agent-drop/SKILL.md` -- the
webhook section, the four ingest channels, and a corrected Storage & TTL block
(it claimed R2 blobs expire at 30 days; `drops/` is 90).

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

Phase 4 (link 4) -- all recorded in PLAN v8's changelog:

- **A refusal is not a queue member, and it must not behave like one.** A
  `rejected` row carried a `dedupe_key`, so the exact sequence you most want to
  survive lost the message silently: wrong secret -> 401 stored `rejected` ->
  operator fixes the secret -> provider retries the same bytes -> `200
  {"duplicate":true}`, nothing stored, provider stops. The only row left was one
  no lease will ever hand out. Card
  `bug-rejected-row-blocks-its-own-retry`. **Phase 5 note: `payload_mode:
  passthrough` re-delivers stored rows, so it inherits this -- a rejected row is
  not a delivery.**
- **The dedupe fix had to go one layer down.** Skipping the *lookup* for rejected
  rows was not enough: the partial unique index `(receiver_id, dedupe_key)` has
  no status column, so the valid retry became a 503 instead of a lost event.
  Still wrong, just louder. A refusal now carries NO dedupe key, which also means
  `queue-requeue` on a rejected row can never collide with the accepted copy.
- **Peek is inert, and that is asserted on a LEASED row.** The whole row is
  compared before and after list / peek / one / body / stats. A read that
  disturbed a hold would be the worst kind of bug here, because it only shows up
  when someone is mid-work.
- **`queue-extend` will not resurrect an expired lease**, and takes an optional
  `--lease-id` so it refuses to extend one that is not yours. An expired lease is
  back in the pool and may already belong to someone else; taking it back
  silently is worse than making the caller pull again.
- **`?receiver=` resolves through the receiver ROW, not the events' denormalized
  slug.** Otherwise a rotation would cost history: every message stored under the
  old slug would vanish from `--receiver <new-slug>`, and §7 promises the
  opposite.
- **`--delete-on-success` destroys after the write RETURNED**, which down a pipe
  means the OS accepted the bytes, not that the reader processed them. Proven at
  runtime: piping into `head -1` destroyed two and left the rest LEASED. The
  guarantee is the remainder, not per-byte delivery -- stated in `queue-get
  --help` rather than left for someone to discover.
- **`queue-put` is the same code path, including the parts that say no.** An
  unsigned injection into a signed receiver answers 401 and stores `rejected`,
  exactly as a real delivery would. There is no flag that writes `verified=1` for
  a signature nothing checked.

Phase 5 (link 5) -- all recorded in PLAN v9's changelog:

- **A counter that has to grow between retries cannot live in the message body.**
  `retry()` re-enqueues the body unchanged, so `wh.attempt` read 0 forever: the
  documented 2s/4s/8s ladder was 2 seconds flat (~43,200 requests at a dead
  target over 24h instead of ~80) and `delivery_log.attempts` said 1 throughout.
  `Message.attempts` is the platform's own and is what it is for. Card
  `bug-webhook-backoff-never-escalates`. **Phase 6 note: `CLAUDE.md` describes
  the ladder as if it worked -- it does now, so the text stands, but do not
  copy the old `wh.attempt` shape into the reaper or anything else.**
- **The first version of that test hid the bug.** It bumped `attempt` in the body
  by hand between drains, which is exactly what the platform cannot do, and went
  green against broken code. The harness now models `Message.attempts` instead.
  A test that fakes the thing under test is worse than no test.
- **A `RuleSubject` with mostly-optional fields is the honest shape.** An email
  has a `from_addr` and no `slug`; a webhook event has a `slug` and no `subject`.
  Making them optional is what lets both satisfy the interface structurally, so
  no call site changed and both existing rule suites pass untouched.
- **Case-insensitive header merging is not a nicety.** `{"User-Agent": x}` and
  `{"user-agent": y}` are two keys to JavaScript and one header to HTTP: a plain
  spread keeps both and `fetch` sends `User-Agent: x, y`. Nothing errors and the
  target sees a header nobody wrote. Caught by a test written for the override
  promise, not by the code review that wrote the promise.
- **A mutation that bites nothing is a finding.** Removing `fanOutEvent`'s own
  status guard broke no test, because the receive path returns first -- so the
  guard was untested defence. It is tested directly now rather than deleted: it
  is exported, and `hook-replay` proves a second caller shows up.
- **The dry run has to model the engine's refusals, not just its matches.**
  `rule-test` said a forward would fire on `web`/`api`; it never does. You check a
  dry run precisely when you are unsure, and it answered with confidence either
  way.

Phase 6 (link 6) -- all recorded in PLAN v10's changelog:

- **A fail-open throttle and a D1 cap are not alternatives, and neither is the
  other's fallback.** The limiter sheds a burst per colo and lets everything
  through when it is down; the cap is counted in D1 over a rolling 24h and cannot
  fail open. §11 says as much; the code now says it too, in two different places
  in the request path.
- **The cap does not refuse a handshake.** It bounds rows; a handshake does not
  need one. Refusing a Zoom CRC over a cap costs the endpoint registration (six
  failures and Zoom disables it) to save a single row -- and phase 3 already
  settled the general form of this when it made a storage failure not fail a
  handshake. Proven live: same receiver, same instant, CRC answered 200 while an
  ordinary delivery got 429.
- **A body that will not delete keeps its row.** The row is the only record of
  which object belonged to it. This is the mirror image of `queue-delete`'s
  bodies-before-rows rule, and the reason both exist: an orphaned object is
  invisible and bills forever.
- **Settle the sweeps, do not chain them.** A drop-sweep failure that silently
  stopped webhook retention is the shape of bug nobody notices for a month.
  Tested directly, with the drop sweep throwing.
- **`wrangler d1 migrations apply --remote` does not work from this repo.** The
  placeholder ids in the committed `wrangler.toml` make it die naming
  `your-cloudflare-account-id`. `bun run db:migrate` is the working form and was
  already in `package.json`; both `CLAUDE.md` and `README.md` documented the
  broken one. **Nothing was wrong with the code** -- this is the one "phase 6
  found no bug" phase, and this was a doc bug the phase walked into on its first
  command.

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

## Phase 4 runtime log -- the queue, proven on `bun run dev`

Not tests: the real worker in workerd, real local D1, real local R2, driven by
the real CLI against the 17 events link 3 left behind. Row state below is read
straight out of the miniflare D1 file, not from what a handler claimed.

```
$ drop queue-stats
  BOX          TOTAL  QUEUED  LEASED  ACKED  REJECTED  HANDSHAKE  SIZE   LAST
  lisa            17       7       0      0         4          6  1KB    18m ago

$ drop queue-get lisa --limit 50 --lease 300      # asked for FIFTY, out of 17 rows
  leased 7                                        <- the 7 queued ones, and only those
  6 handshake  4 rejected  left exactly where they were

  01m01zjz3jn…  track-17-0qjqda   leased  lease=27bcb1a3  n=1
  …
```

Peek is inert, and the row that matters is a leased one:

```
$ ID=01m01zjz3jnfebvvvzrsj4p8hy                   # currently LEASED
$ sqlite  SELECT * FROM webhook_events WHERE id=$ID   > before.json
$ drop queue-peek lisa $ID ; drop --format json queue-peek lisa $ID
$ drop queue-body lisa $ID -o /dev/null ; drop queue-list lisa ; drop queue-stats lisa
$ sqlite  SELECT * …                                  > after.json
$ diff before.json after.json && echo IDENTICAL
IDENTICAL -- every column, on a leased row
0bdbc8d2e937cff1203bc8b316b16ed29d0f3baae8ed4a73cd35f9faa765f8b1  before.json
0bdbc8d2e937cff1203bc8b316b16ed29d0f3baae8ed4a73cd35f9faa765f8b1  after.json
```

Extend keeps ownership; a stranger's lease id does not:

```
before  leased  lease=27bcb1a3  until=1786776518625  n=2
$ drop queue-extend lisa $ID --lease 1800 --lease-id 27bcb1a3-…
  Extended 1 of 1 until 2026-08-15 07:03:44
after   leased  lease=27bcb1a3  until=1786777424162  n=2   <- only leased_until moved

$ drop queue-extend lisa $ID --lease 3600 --lease-id 00000000-0000-4000-8000-…
  Extended 0 of 1
  Not extended: already expired, or not your lease.
after   leased  lease=27bcb1a3  until=1786777424162  n=2   <- untouched
```

Two consumers pulling the whole queue at the same instant:

```
$ curl … /queue/lisa/get -d '{"limit":10}' &  curl … /queue/lisa/get -d '{"limit":10}' &
  consumer A got 0  lease f4412d2b
  consumer B got 7  lease 3c99e676
  overlap: NONE
  union  : 7 distinct events
```

The ack, and the two statuses that are not work:

```
$ drop queue-remove lisa $ID
  Removed 1                    -> acked  n=3  acked=1786775642334
$ drop queue-remove lisa $ID   # again, a second later
  Removed 0  (1 already removed)
                               -> acked=1786775642334   <- NOT restamped

$ drop queue-remove lisa <handshake-id> <id-from-another-box>
  Removed 0  (1 handshake, kept, 1 not in lisa)

$ drop queue-requeue lisa <acked> <rejected> <handshake>
  Requeued 2 of 3
  Only removed and rejected events requeue. Handshakes never do.
```

**The bug this phase found.** `queue-put` injects through the same path a
provider would, which is exactly how it surfaced -- a real 17TRACK retry hits it
identically:

```
$ drop queue-put lisa --receiver track-17-0qjqda --body @put2.json --header 'sign:deadbeef'
  Receiver rejected it: 401
  stored as 01m0226wq10eb1mj0d1ztj1c3k (rejected)

# the operator fixes the secret; the provider retries THE SAME BYTES
$ SIGN=$(cat put2.json <(printf '%s' '/123456ABCDEF') | shasum -a 256 | cut -d' ' -f1)
$ drop queue-put lisa --receiver track-17-0qjqda --body @put2.json --header "sign:$SIGN"
  Injected 01m0226wtq8vehdsdx4st7v0x3          <- BEFORE the fix: "duplicate", nothing
  receiver answered 200                            stored, provider stops, event gone

$ drop queue-put … --header "sign:$SIGN"       # and a GENUINE duplicate still is one
  Injected 01m0226wtq8vehdsdx4st7v0x3 (duplicate -- nothing stored)
```

Delete takes the R2 body with it:

```
$ printf '\x00\xff\xc3\x28\x89PNG\r\n\x1a\n\xfe\xed' | curl --data-binary @- …
  body_text: null   body_r2_key: hooks/lisa/echo-box-wyc5nt/01m02276q8…   14 bytes
  body endpoint -> 200 14B
$ drop queue-delete lisa 01m02276q8…
  Destroyed 1 event(s), R2 bodies included
  body endpoint -> 404      row -> null
```

Rotation, with the grace window:

```
$ drop queue-list lisa --receiver track-17-0qjqda   ->  8 events
$ drop hook-rotate lisa/track-17-0qjqda --grace 1h
  Rotated to lisa/track-17-fnrq5n
  track-17-0qjqda keeps answering until 2026-08-15 07:37:28

  old slug -> 401      <- reached the receiver (bad signature), NOT 404
  new slug -> 401      <- same receiver, same verdict, new address
$ drop queue-list lisa --receiver track-17-fnrq5n   -> 10 events
$ drop queue-list lisa --receiver track-17-0qjqda   -> 10 events
                                                       ^ the same rows under either
                                                         name: events key on the id
```

`--delete-on-success` when the output dies partway, and the bulk deletes:

```
$ drop --format json queue-get lisa --limit 4 --lease 900 --delete-on-success | head -1
  {"id":"01m01zjz3jn…"                       <- head closes the pipe
  rows 22 -> 20                              <- two destroyed (the write RETURNED for
                                                both; a pipe accepts before a reader
                                                reads -- documented in --help)
  01m01zqjpjvm…  leased  n=4                 <- the remainder is LEASED, not destroyed
  01m01zr2ebnf…  leased  n=3

$ drop queue-delete lisa --removed
  About to DESTROY 2 event(s) in lisa:
    01m020vncjxra…  acked  25m ago
    01m01zr9pdvvd…  acked  44m ago
  Re-run with --yes to destroy them.
  rows still there: 20                       <- a preview destroys nothing
$ drop queue-delete lisa --removed --yes
  Destroyed 2 event(s)                       -> 18
```

`queue-replay` to a real listener, proving what a consumer gets:

```
$ drop queue-replay lisa 01m01zqjpjvm… --to http://localhost:4931/ingest
  POST http://localhost:4931/ingest  95B
  200 sink ok

SINK got POST 95 bytes
  sign: 99d58000af5855efe1091678c3b3fdc277e218eaf7fa85bebd9ed6b734b96d18
  authorization: (none -- a redacted header is not replayed)
  sha256: 3e4a3eb469916ed9748a4b8eb9aca621c00ee67d16cb6067796287a16bcbe68d
          ^ the stored body_sha256, byte for byte. a consumer holding 17TRACK's
            key can verify this replay, which is the whole acceptance criterion
```

Left behind in the LOCAL dev D1 for phase 5: 11 events across `queued` /
`handshake` / `rejected` on `lisa`, the rotated receiver `lisa/track-17-fnrq5n`
(old slug `track-17-0qjqda` still answering until its grace expires), and the six
other receivers. Admin API key named `p4-runtime` (value not recorded; make your
own with `drop key-create`). `AGENT_DROP_URL=http://localhost:5173`, exported
AFTER `source ~/.secrets`.

## Phase 5 runtime log -- onward delivery, proven on `bun run dev`

Not tests: the real worker in workerd, the real local queue consumer, real local
D1 and R2, driven by the real CLI against the receivers link 4 left. The target
is a two-line `Bun.serve` sink on 4931 that prints what it actually received and
hashes it, so "byte-identical" is checked at the far end rather than asserted at
the near one.

```
$ drop rule-add "lisa" --webhook "http://localhost:4931/ingest" --scope hook
  Rule created: lisa -> webhook -> http://localhost:4931/ingest

$ SIGN=$(cat p5a.json <(printf '%s' '/123456ABCDEF') | shasum -a 256 | cut -d' ' -f1)
$ curl -X POST localhost:5173/h/lisa/track-17-fnrq5n -H "sign: $SIGN" \
    -H 'Authorization: Bearer must-not-travel' --data-binary @p5a.json
{"ok":true,"id":"01m0248gsax2e84p7tm4rjaz6c"}

SINK POST /ingest  1122 bytes
  user-agent: AgentDrop/1.0
  x-drop-id: 01m0248gsax2e84p7tm4rjaz6c
  x-webhook-attempt: 1
  body: {"event":"hook.received","hook":{"id":"01m0248gsax...","slug":"track-17-fnrq5n",
         "event_type":null,"routing_key":"parcel-99","method":"POST",...
                                          ^ extracted, and the envelope is a HOOK
$ drop deliveries        -> webhook  success  http://localhost:4931/ingest
```

Passthrough, against a body chosen so a re-serialized copy could not survive it
-- odd key order, an interior newline, and both a `é` escape and a literal
`é`:

```
$ drop rule-update RULE --payload-mode passthrough --target http://localhost:4931/relay
$ shasum -a 256 p5b.json
24c197d2d365e5731da42af279de66d634160f1b28d8d8e9b7fb19a240e934fd  p5b.json

SINK POST /relay  37 bytes
  sign: 9f11a64921933357b07740ecc288f32a8c6bdb1f1f5a86787c5708f6155a8170
                                       ^ VERBATIM -- the target verifies with it
  user-agent: curl/8.7.1               <- the PROVIDER's, not AgentDrop/1.0
  x-forwarded-weird: keep-me
  content-type: application/json
  sha256: 24c197d2d365e5731da42af279de66d634160f1b28d8d8e9b7fb19a240e934fd
          ^ MATCHES the sent file, byte for byte
  body: {"b":2,
 "a":1,"u":"café café"}           <- key order, newline, both escapes intact

  authorization:        (absent -- a redacted credential is not replayed)
  x-drop-id:            (absent)
  x-webhook-attempt:    (absent)       <- none of ours. that IS the mode
```

A refusal fires nothing, and the loop guard, live:

```
$ curl -X POST .../h/lisa/track-17-fnrq5n -H "sign: deadbeef" -d '{"x":1}'
{"error":"signature verification failed"}   HTTP 401
  delivery rows before=2 after=2            <- a rejected event is not a delivery

$ drop rule-add "lisa" --webhook "https://frst.dev/h/lisa/track-17-fnrq5n" --scope hook
$ curl -X POST .../h/lisa/track-17-fnrq5n -H "sign: $SIGN" --data-binary @p5e.json
{"ok":true,"id":"01m024k77p4e1a9exjgqcb84mg"}
$ drop deliveries --status failed
  just now  webhook  failed  https://frst.dev/h/lisa/track-17-fnrq5n
     refused: target is this instance's own webhook receiver (delivery loop)
```

**The bug this phase found**, and the reason it needed a live worker rather than
a test: the backoff ladder, watched against a sink told to answer 503 for 45
seconds. Before the fix `attempts` sat at 1 forever and every gap was 2s.

```
$ curl "http://localhost:4931/fail-for?s=45"
$ curl -X POST .../h/lisa/track-17-fnrq5n -H "sign: $SIGN" --data-binary @p5d.json

  t+6s    queued     attempts 0
  t+12s   retrying   attempts 1        <- 2s
  t+24s   retrying   attempts 2        <- 4s
  t+36s   retrying   attempts 3        <- 8s
  t+54s   success    attempts 4        <- 16s, then the sink recovered
                              ^ climbs. before the fix: 1, 1, 1, 1, ...
```

`hook-replay`, the server-side sibling, and the mirror:

```
$ drop hook-replay lisa 01m024gwvdwb5k14j6zsxcr0ee --to http://localhost:4931/replayed \
    --mode passthrough
  Queued 01m024gwvdwb5k14j6zsxcr0ee -> http://localhost:4931/replayed
  mode passthrough  delivery 01m024k44c8wkf99a1xtc7x7at

SINK POST /replayed  73 bytes
  sign: 080943eb45c9d4c25b8547c621cc32328cab7d8845e8ac0bec1360aeb1c8e12c
        ^ through the QUEUE, with retries and a delivery_log row --
          `queue-replay` POSTs the same bytes from the client with neither

$ drop hook-replay lisa EVENT_ID            # no --to: re-fire what matches NOW
  success   http://localhost:4931/relay
  failed    https://frst.dev/h/lisa/track-17-fnrq5n

$ drop hook-create lisa mirror-demo --mirror
$ curl -X POST .../h/lisa/mirror-demo-t12115 -d '{"type":"demo.event","id":"m-1"}'
$ drop inbox lisa --limit 2
  * just now   hook  mirror-demo-t12115 <mirror-demo-t12115@webhook>
  * 2026-08-01 web   confirm-probe.pdf [1 files]
      ^ a fourth channel in `drops`, and only because --mirror asked for it
```

`rule-test` on the hook channel, including the forward bug fixed this phase:

```
$ drop rule-test lisa --channel hook
  > lisa -> webhook -> http://localhost:4931/relay [passthrough]
  > lisa -> webhook -> https://frst.dev/h/lisa/track-17-fnrq5n
  ~ lisa -> pattern matches but forwards only fire on the email channel
                                 ^ before the fix this said it would fire
$ drop rule-test lisa --channel email
  ~ lisa -> pattern matches but scope "hook" excludes "email"   (x2)
  > lisa -> forward -> jonas+p5@duplo.org
```

Left behind in the LOCAL dev D1 for phase 6: 21 events on `lisa` across
`queued` / `rejected` / `handshake`, eight receivers (the seven from link 4 plus
`lisa/mirror-demo-t12115`, which has `mirror_to_drops = 1`), one mirrored drop,
and **no rules** -- every demo rule was removed, so phase 6 starts from a clean
rules table. Migration `0010` is applied locally, NOT remotely. Admin API key
named `p5-runtime` (value not recorded; make your own with `drop key-create`).
`AGENT_DROP_URL=http://localhost:5173`, exported AFTER `source ~/.secrets`, and
note `drop key-create` needs the real `AGENT_DROP_ADMIN_KEY` from `~/.secrets`
-- the `ad_` key it hands back is for the keyed routes only.

## Phase 6 runtime log -- retention and the limits, proven on `bun run dev`

Not tests: the real worker in workerd, the real cron entrypoint, real local D1 and
R2, driven by the real CLI. Row state is read straight out of the miniflare D1
file; the R2 body is checked through the API, which is what a consumer sees.

```
$ drop hook-create lisa p6-retention
  https://frst.dev/h/lisa/p6-retention-svz9k9
  id 3072072e-3a57-486f-a172-e573e09f7075  POST  keeps 120d

# 70 KB, so it lands in R2 rather than inline -- the sweep needs a body to destroy
$ curl -X POST .../h/lisa/p6-retention-svz9k9 --data-binary @big.json
{"ok":true,"id":"01m025fa7smhcgka6t6xttx3d9"}
$ curl -X POST .../h/lisa/p6-retention-svz9k9 -d '{"event":"small.one"}'
{"ok":true,"id":"01m025fa8zabsz3gxhs151x58z"}

  01m025fa7sm…  70032B  hooks/lisa/p6-retention-svz9k9/01m025fa7sm…   <- R2
  01m025fa8za…     21B  (inline)                                      <- D1

$ sqlite  UPDATE webhook_events SET expires_at = <now-1s> WHERE id='01m025fa7sm…'
  body endpoint BEFORE: HTTP 200  70032 bytes

$ curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=17+*+*+*+*"
ok   HTTP 200

  hook reaper: scanned 1 expired events -- deleted 1, bodies 1, kept 0
  events 23 -> 22                      <- exactly one row, not a table
  01m025fa8za…  queued                 <- the unexpired one, untouched
  body endpoint AFTER: HTTP 404        <- the R2 body went with it
```

The daily cap, live. The receiver already had one row in the window:

```
$ drop hook-update lisa/p6-retention-svz9k9 --daily-cap 2
  POST #2 -> HTTP/1.1 200 OK           {"ok":true,"id":"01m025gjt9grmnqg5pfxydde08"}
  POST #3 -> HTTP/1.1 429  retry-after: 86359
                                       {"error":"daily event cap reached"}
  rows after: 2                        <- refused means STORED NOTHING
```

`retry-after: 86359` is 24h minus the ~41 seconds the oldest row had already
served -- the earliest moment the answer could change, not a fixed guess.

The handshake carve-out, on one receiver at 5 rows against a cap of 1:

```
$ drop hook-update lisa/zoom-crc-s7rw1m --daily-cap 1

# Zoom's CRC, at a receiver well past its cap:
{"plainToken":"qgg8vlvZRS6UYooatFL8Aw",
 "encryptedToken":"3ee215dfbe53223d6ab24ea678f99d586ea8dc959ce3f737482a1a702f29ac2f"}
  HTTP 200                             <- answered. six failures and Zoom disables
                                          the endpoint; the cap is not worth that

# an ORDINARY delivery to the same receiver, the same instant:
{"error":"daily event cap reached"}    HTTP 429   <- the control
```

## Phase 6 live log -- the deployed worker at `https://frst.dev`

Not localhost. Against production, after `bun run db:migrate` and `bun run deploy`.

```
$ drop hook-create lisa p6-smoke --auth digest --secret p6-smoke-secret \
    --auth-header sign --preset generic --routing-key data.tag
  https://frst.dev/h/lisa/p6-smoke-yzyh9v
  id ad4796a3-f0a0-4430-acc0-2ca69da4baa2  POST  keeps 120d

$ shasum -a 256 p6live.json           # 104B: odd key order, interior newline,
b1712d2870cef616…f93f81876  p6live.json    # a é escape AND a literal é
$ SIGN=$(cat p6live.json <(printf '%s' '/p6-smoke-secret') | shasum -a 256 | cut -d' ' -f1)
  4db7bd7b6733ba5b34bc02f9409d84663502f6e55e51f7a4b00d6e5136597d83

$ curl -X POST https://frst.dev/h/lisa/p6-smoke-yzyh9v -H "sign: $SIGN" \
    -H 'Authorization: Bearer must-be-redacted' --data-binary @p6live.json
{"ok":true,"id":"01m025m0f58syq3w6w7kkq7n84"}   HTTP 200

$ drop queue-peek lisa 01m025m0f58syq3w6w7kkq7n84
  POST lisa/p6-smoke-yzyh9v  queued  verified      <- verified in PRODUCTION
  type/key p6-live                                 <- routing key off data.tag
  104B  sha256 b1712d2870cef616…f93f81876          <- MATCHES the sent file
  headers:
    authorization: <redacted>
    sign: 4db7bd7b6733ba5b34bc02f9409d84663502f6e55e51f7a4b00d6e5136597d83
    cf-connecting-ip: 49.0.79.228   cf-ipcountry: TH   <- real CF metadata

$ drop queue-body lisa 01m025m0f5… -o roundtrip.bin
  Wrote 104B
$ cmp p6live.json roundtrip.bin && echo IDENTICAL
IDENTICAL
b1712d2870cef616…f93f81876  p6live.json
b1712d2870cef616…f93f81876  roundtrip.bin

$ drop queue-get lisa --receiver p6-smoke-yzyh9v --limit 5 --lease 120
  POST lisa/p6-smoke-yzyh9v  leased  verified
    {"event":"TRACKING_UPDATED",
    "data":{"number":"RR123456789CN","tag":"p6-live","note":"café café"}}
                                                   ^ newline, key order, both
                                                     escapes -- all intact
```

One byte changed, the same signature, and an unregistered slug:

```
$ cmp -l p6live.json tampered.json | wc -l
       1
$ curl -X POST … -H "sign: $SIGN" --data-binary @tampered.json
{"error":"signature verification failed"}   HTTP 401
$ curl -X POST https://frst.dev/h/lisa/no-such-receiver-here -d '{}'
{"error":"no such receiver"}                HTTP 404
```

Ack, then clean up after ourselves:

```
$ drop queue-remove lisa 01m025m0f5…
  Removed 1
$ drop hook-delete lisa/p6-smoke-yzyh9v --purge
  Receiver deleted (3 event(s) destroyed)
$ curl -X POST https://frst.dev/h/lisa/p6-smoke-yzyh9v -d '{}'
{"error":"no such receiver"}                HTTP 404
$ drop hooks        -> No receivers
$ drop queue-stats  -> lisa  0 total
```

Production is live and clean: no receivers, no events, nothing left behind.

## Provisioning actually run (2026-08-15, in this order)

```bash
bun run db:migrate    # 0009_webhook_receivers.sql ✅ + 0010_rule_payload_mode.sql ✅
                      # NOT `wrangler d1 migrations apply --remote` -- see PLAN v10
bun run deploy        # Version 6823a107-20e0-4c81-a137-bc2edfe1bb2a
                      # bindings confirmed incl. HOOK_RATE_LIMIT (300 requests/60s)
                      # triggers: frst.dev/*, schedule 17 * * * *, both queue consumers
wrangler r2 bucket lifecycle add agent-drop-storage hooks-130d "hooks/" --expire-days 130
```

No `wrangler queues create` was needed: the webhook receivers reuse the existing
`agent-drop-webhooks` queue, and `wrangler queues list` confirmed both
`agent-drop-webhooks` and `agent-drop-r2-events` already exist. The R2 lifecycle
rule was verified by `lifecycle list` afterwards -- four rules now, `hooks/` at
130 days beside `drops/` at 90.

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
- 2026-08-15T11:45:00Z [link 4] **off-mission bug found and fixed**, card
  `bug-rejected-row-blocks-its-own-retry`: a `rejected` row carried a
  `dedupe_key`, so a provider's retry of the same bytes AFTER the secret was
  fixed answered `200 {"duplicate":true}` and stored nothing -- the provider
  stops, and the only row left is one no lease ever hands out. Found at runtime
  through `queue-put`, which is the same code path a real retry takes. The first
  fix (skip the lookup for rejected rows) was not enough: the partial unique
  index has no status column, so the retry became a 503 instead. A refusal now
  carries no dedupe key at all. RED first, mutation-checked both directions --
  restoring the key turns exactly the new test red, and dropping dedupe entirely
  turns seven red.
- 2026-08-15T12:05:00Z [link 4] mutation-checked the phase's own suites four ways
  before trusting a clean first run: a lease SELECT that forgets expired leases,
  a requeue that admits handshakes, an emit loop that finishes before it writes,
  and a delete that leaves the R2 body. Each turned exactly the tests it should.
- 2026-08-15T12:20:00Z [link 4] **phase 4 complete.** The full message
  vocabulary: `queue-get/remove/return/extend/requeue/delete/put/stats/replay`
  plus `hook-rotate`, on ten new routes -- everything that leases, mutates or
  destroys under `keyedWriter`, everything inert under `keyedReader`. Section
  10's completeness matrix walked cell by cell: no cell needs a raw curl or a D1
  query. 49 new tests, full suite 634 pass / 0 fail, `bun run verify` exit 0.
  Runtime round trip transcribed above against the 17 real events link 3 left.
  Plan v7 -> v8.
- 2026-08-15T13:05:00Z [link 5] **off-mission bug found and fixed**, card
  `bug-webhook-backoff-never-escalates`: the webhook retry backoff never
  escalated. `processWebhookBatch` took its attempt counter from the message
  BODY, which `retry()` re-enqueues unchanged, so it read 0 on every delivery --
  the documented `2s, 4s, 8s ... 20min` ladder was two seconds flat (~43,200
  requests at a dead target over the 24h window instead of ~80) and
  `delivery_log.attempts` reported 1 throughout, hiding it from the operator too.
  Pre-existing since the rules engine was written. Now reads `Message.attempts`,
  the platform's own 1-based counter. Found at runtime while proving phase 5's
  own "a failing target retries with backoff" claim; RED first, and the first
  version of the test HID the bug by hand-mutating the body between drains, which
  is precisely what the platform cannot do.
- 2026-08-15T12:55:00Z [link 5] **second bug found and fixed**: `rule-test`
  reported a `forward` rule as firing on `web`/`api` (and would have on `hook`),
  but `fireRules` skips a forward on anything but email. A dry run you consult
  when unsure, answering wrong with confidence. The prediction moved to
  `tools/lib/rule-preview.ts` -- testable, and it took the command's duplicated
  copy of `matchPattern` with it. RED proven by mutation.
- 2026-08-15T12:40:00Z [link 5] **third bug, found by a new test rather than at
  runtime**: a rule header differing only in CASE from a stored one was appended
  instead of overriding it -- `{"User-Agent": "Stripe/1.0"}` plus
  `{"user-agent": "mine"}` are two object keys and one HTTP header, so `fetch`
  sent `User-Agent: Stripe/1.0, mine`. Nothing errors and the target sees a value
  nobody wrote. Envelope mode had the same shape of bug pre-existing (a rule
  `content-type` would append to ours). One `mergeHeaders` now folds case for
  both.
- 2026-08-15T13:20:00Z [link 5] mutation-checked the phase's suites seven ways
  before trusting a clean run: `all` not covering hook (16 red, and
  `rules.test.ts` stayed green), passthrough dropping the stored headers, the
  fan-out status guard, a rejected event falling through to the fan-out, the
  self-delivery guard, the dry-run forward guard, mirror always on, and a
  permanent failure being retried. Each bit exactly what it should -- except the
  fan-out guard, which bit NOTHING and turned out to be untested defence; it has
  a direct test now rather than a deletion.
- 2026-08-15T13:40:00Z [link 5] **phase 5 complete.** `fireRules` narrowed from
  `Drop` to `RuleSubject` with **every existing test in `test/rules.test.ts` and
  `test/forward.test.ts` passing unchanged** -- the phase's own gate. The `hook`
  channel, `{slug}`/`{event_type}`/`{routing_key}`, `payload_mode`
  (`envelope`|`passthrough`), `hook-replay`, and `mirror_to_drops` off by
  default. 36 new tests, full suite 670 pass / 0 fail, `bun run verify` exit 0.
  Runtime round trip transcribed above: the sink's own sha256 of the passthrough
  body matches the sent file byte for byte, with the signature header verbatim
  and none of agent-drop's own headers added. Plan v8 -> v9.
- 2026-08-15T13:45:00Z [link 5] phase 5 integrated into `main` at `e462dd0`.
- 2026-08-15T14:20:00Z [link 6] mutation-checked the phase's suites six ways before
  trusting a clean first run: a sweep that deletes a row whose body failed to
  delete, an inclusive expiry boundary, a batch cap that is not applied, a burst
  limiter that fails CLOSED, a daily cap that counts every receiver's rows, and
  the two sweeps chained instead of settled. Each turned exactly the tests it
  should -- and unlike link 5, none of them bit nothing.
- 2026-08-15T14:35:00Z [link 6] **no code bug found this phase** -- the first of
  the six. One DOC bug, hit on the phase's first command: §12's
  `wrangler d1 migrations apply agent-drop-db --remote` cannot work from this
  repo, because the committed `wrangler.toml` carries placeholder ids by design,
  so it dies with "could not route ... your-cloudflare-account-id".
  `bun run db:migrate` was already in `package.json` and does it properly.
  Corrected in the PLAN, `CLAUDE.md` and `README.md`.
- 2026-08-15T14:40:00Z [link 6] **SHIPPED.** `bun run db:migrate` applied `0009`
  and `0010` remotely, then `bun run deploy` (version
  `6823a107-20e0-4c81-a137-bc2edfe1bb2a`), then the `hooks-130d` R2 lifecycle
  rule. Order per §12, and it matters: the receive path INSERTs into tables that
  would not have existed. No queue creation was needed -- the receivers reuse
  `agent-drop-webhooks`.
- 2026-08-15T14:50:00Z [link 6] **live smoke test passed on `https://frst.dev`**,
  not localhost: receiver created, a signed 104-byte body POSTed at the real URL
  and stored `verified`, `queue-body` round-tripped byte-identical (`cmp` clean,
  same sha256 both directions), leased back, a one-byte tamper answered 401, an
  unregistered slug 404, acked, then deleted with `--purge`. Production is clean.
  The signature was computed with `shasum` outside the codebase, so a pass is
  agreement with an external tool rather than the code agreeing with itself.
- 2026-08-15T15:00:00Z [link 6] **phase 6 complete.** Retention sweep (500/run,
  R2 bodies before rows, a stuck body keeps its row), `HOOK_RATE_LIMIT` +
  the D1 daily cap, both cron sweeps settled so neither can cancel the other.
  30 new tests, full suite **700 pass / 0 fail**, `bun run verify` exit 0, and
  **`test/reaper.test.ts` never opened** -- its 12 tests pass with the file
  byte-identical, which was the phase's own gate. Docs rewritten from the CODE:
  `CLAUDE.md` gained a full "Webhook Receivers" section plus the `hook.received`
  envelope, `payload_mode`, the `hook` channel and ~30 new files in the tree;
  `README.md` gained the fourth ingest channel; the `agent-drop` skill gained the
  webhook vocabulary. Plan v9 -> v10.
- 2026-08-15T15:10:00Z [link 6] phase 6 integrated into `main` at `37013cc`.
- 2026-08-15T15:10:00Z [link 6] **CHAIN COMPLETE.** All six phases done, status
  `completed`. The feature is deployed and answering on `https://frst.dev/h/`.
  Six phases, 700 tests, and six pre-existing bugs found and fixed along the way
  (biome linting assets, the deploy guard's silent exit, the redacted signature
  header, the plaintext query secret, the rejected row blocking its own retry,
  the retry backoff that never escalated, the dry run that lied about forwards,
  the case-folded header merge). One doc bug in phase 6.

### A note for whoever picks this up next

`CLAUDE.md` is updated on disk but is **NOT in git** -- Jonas's global
`~/.gitignore` excludes `CLAUDE.md` everywhere, and it has never been tracked in
this repo. `README.md` links to `./CLAUDE.md`, so that link is dangling for
anyone who clones. Pre-existing, not this chain's to decide, and flagged rather
than force-added.
