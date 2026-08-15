---
chain_id: webhooks-20260815-115712-c042
plan_file: /Users/jonas/projects/agent-drop/docs/WEBHOOKS-PLAN.md
plan_version: 3
status: in_progress
current_phase: 1
last_updated: 2026-08-15T04:57:12Z
link_count: 1
---

# Agent Drop webhook-receiver chain state

## Phases

- [>] 1. Schema, receiver CRUD, and the public endpoint (link 1, IN PROGRESS)
  - [ ] 1a. Migration `0009_webhook_receivers.sql` -- both tables, all indexes
  - [ ] 1b. `/h/*` branch in `src/index.ts` + `run_worker_first`
  - [ ] 1c. `src/lib/webhook-receive.ts` -- raw-bytes ordering per section 4
  - [ ] 1d. Status codes: 404 unregistered / 403 disabled / 410 expired
  - [ ] 1e. `src/api/hooks.ts` -- receiver CRUD (asAdmin) + queue reads (keyedReader)
  - [ ] 1f. CLI: hook-create/list/get/url/update/delete, queue-list/peek/body
  - [ ] 1g. RUNTIME check: curl a receiver on `bun run dev`, body byte-identical
- [ ] 2. Verification -- all presets, hook-test
- [ ] 3. Handshakes -- meta/slack/zoom/echo/static
- [ ] 4. The pull queue -- lease/remove/return/delete/put/peek + completeness gate
- [ ] 5. Onward delivery -- RuleSubject, hook channel, passthrough, replay
- [ ] 6. Retention, provisioning, deploy, docs

## Artifacts produced

- (none yet)

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

## Open questions / blockers

- 17TRACK's signature shape `SHA256_hex(body + "/" + api_key)` is relayed from
  the track-parcel conversation, NOT verified against 17TRACK's docs. Phase 2
  must confirm it before hardcoding the `digest` preset, and changelog the
  result.

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

## Log

- 2026-08-15T04:57:12Z [link 1] chain started at plan v3, phase 1
