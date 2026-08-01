---
chain_id: modernize-20260801-161212-5998
plan_file: /Users/jonas/projects/agent-drop/docs/MODERNIZE-PLAN.md
plan_version: 1
status: in_progress
current_phase: 1
last_updated: 2026-08-01T10:34:00Z
link_count: 1
---

# Agent Drop modernization chain state

## Phases

- [>] 1. Close the security holes (link 1)
  - [x] 1a. Authenticate `/api/upload/complete` + `/api/upload/confirm`
  - [x] 1b. Derive `objectKey` from the drop row instead of trusting the client
  - [x] 1c. Constant-time `isAdmin()`
  - [x] 1d. `[[ratelimits]]` binding on failed auth + drop-token uploads
  - [x] 1e. Scope CORS (none on admin routes, real origin on web routes)
  - [x] 1f. BONUS (found in-phase): enforce `inbox_scope` on write paths
  - [x] Test harness: D1-over-`bun:sqlite`, `cloudflare:email` virtual module
- [ ] 2. Safety net: web typecheck, Biome, CI, tests on pure functions
  - [ ] 2a. `web/tsconfig.json` + fix whatever it surfaces
  - [ ] 2b. Biome config + fix flagged issues
  - [ ] 2c. `.github/workflows/ci.yml`
  - [ ] 2d. Tests: rules.ts, relay.ts addressing, normalize.ts, hosting.ts
- [ ] 3. Migrate outbound mail to `EmailMessageBuilder`
  - [ ] 3a. `api/send.ts:172` compose path -> builder
  - [ ] 3b. `relay.ts:248` forwardViaBinding -> builder IF attachments survive
  - [ ] 3c. Keep `relay.ts:395` relay-queue replay on raw
  - [ ] 3d. Differential `send-email --dry-run` old vs new
- [ ] 4. Dev loop: `@cloudflare/vite-plugin`
- [ ] 5. Platform optimizations
  - [ ] 5a. `ctx.waitUntil` on `last_used_at`
  - [ ] 5b. R2 event notifications -> retire confirm handshake
  - [ ] 5c. Cron reaper for stale `pending` drops
  - [ ] 5d. D1 Sessions API on read paths
- [ ] 6. Structural cleanup + final docs
  - [ ] 6a. Router rewrite (tests FIRST, behavior-identical)
  - [ ] 6b. Real XML parse in upload.ts
  - [ ] 6c. Move `client_secret_*.json` to `~/.secrets`
  - [ ] 6d. Surface SES-fallback decision in review ticket
  - [ ] 6e. Update `CLAUDE.md`

## Artifacts produced

- `docs/MODERNIZE-PLAN.md` (link 0)
- `docs/MODERNIZE-PLAN.STATE.md` (link 0)
- `package.json` -- added `verify` script (link 0)
- `migrations/0008_drop_object_key.sql` -- persists the presigned R2 key (phase 1)
- `src/lib/ratelimit.ts` -- Workers rate-limit helpers, fail-open (phase 1)
- `src/lib/auth.ts` -- digest-compare `isAdmin`, exported `hashKey` (phase 1)
- `src/api/upload.ts` -- `FinalizeDrop`, `resolveObjectKey`, reshaped finalize
  handlers (phase 1)
- `src/api/router.ts` -- scoped CORS, `denyCredential`, `authenticateFinalize`,
  `inbox_scope` enforcement on writes (phase 1)
- `src/types.ts`, `wrangler.toml` -- `[[ratelimits]]` bindings (phase 1)
- `web/src/components/DropZone.tsx` -- stops sending `objectKey` (phase 1)
- `bunfig.toml`, `test/setup.ts` -- `cloudflare:email` virtual module so worker
  code is importable under `bun test` (phase 1)
- `test/helpers/d1.ts`, `test/helpers/env.ts` -- D1 over `bun:sqlite` running the
  real migrations, plus Env/rate-limiter/fixture builders (phase 1)
- `test/upload-auth.test.ts`, `test/auth.test.ts`, `test/cors.test.ts`,
  `test/ratelimit.test.ts`, `test/write-scope.test.ts` (phase 1)

## Decisions

- 2026-08-01 [link 1]: **Test harness is a real D1.** `test/helpers/d1.ts` runs
  the actual `migrations/*.sql` against an in-memory `bun:sqlite` and exposes a
  `prepare/bind/first/run/all` shim. The upload regressions turn on "did this
  UPDATE really match a row", which a hand-mocked DB cannot answer honestly.
  `test/setup.ts` (preloaded via `bunfig.toml`) registers a virtual
  `cloudflare:email` module, without which importing the router explodes under
  `bun test`. Both are reusable by every later phase.
- 2026-08-01 [link 1]: **The rate limiter fails open.** A missing binding (local
  dev, tests) or an error from the service lets the request through. A throttle
  that converts its own outage into an API outage is worse than the abuse it
  prevents. It also counts only *credential* rejections, not authorization
  failures on a valid credential -- otherwise a misconfigured legitimate agent
  throttles itself.
- 2026-08-01 [link 1]: **Drop-token uploads are keyed by the token, not the IP.**
  A drop link leaks by design, so the cap has to follow the link. The token is
  SHA-256'd before it is handed to the rate-limit service.
- 2026-08-01: **No `git push origin` anywhere in this chain.** `origin` is a
  PUBLIC repo (`agent-drop/agent-drop`) and this plan documents live unpatched
  security holes. Integration is to LOCAL `main` only; Jonas pushes when he
  chooses.
- 2026-08-01: **No git worktree.** A worktree cannot merge into a `main` that is
  checked out in the primary dir, and the protocol's usual escape hatch
  (`git push origin HEAD:main`) is forbidden here. Phases run sequentially in the
  primary tree on per-phase branches, merged to local `main`.
- 2026-08-01: Green gate is `bun run verify` (= `check` + `vite build` +
  `deploy --dry-run`).

## Open questions / blockers

- **DEPLOY GATE (phase 1):** migration `0008_drop_object_key.sql` MUST be applied
  to the live D1 before this code is deployed. `handlePresign` /
  `handleMultipartInit` now INSERT `object_key`, so deploying without the column
  breaks every presigned upload. Nothing is deployed by this chain -- this is a
  note for whoever ships it. `package.json`'s `db:migrate` is still hardcoded to
  `0001`; use `wrangler d1 migrations apply agent-drop-db`.
- Phase 1 residual, considered and declined: a caller with legitimate write auth
  on a box can call `/api/upload/complete` against a non-`pending` drop of their
  own box. It fails at the S3 layer and crosses no boundary, so no guard was
  added. Noted so a later phase does not "discover" it as new.
- Phase 2a (`web/tsconfig.json`) is an unknown quantity -- the React frontend has
  never been typechecked. Could surface 0 errors or dozens. Fixing them is in
  scope for phase 2.
- Phase 3b: whether `forwardViaBinding`'s attachment re-encoding survives the
  `EmailMessageBuilder` API is unverified. If not, that call site stays on raw.
- Phase 6d: deleting the SES fallback is a user decision, not the chain's.

## Log

- 2026-08-01T09:12:12Z [link 0] chain created. PLAN v1 written to
  `docs/MODERNIZE-PLAN.md` from the ambient plan the user approved with
  "FULL PLAN DELIVERY! ... GO!". Baseline is commit `1ba9671` (dependency +
  compat-date sweep, already merged to local `main`). Spawning link 1 for phase 1.
- 2026-08-01T10:34:00Z [link 1] phase 1 complete. Branch `chain/p1-security`.

  **RED first, as required.** Tests were written against the unpatched code and
  run before any fix. Baseline: **24 failing** across the five findings --

  | Finding | RED tests | What the failure proved |
  |---|---|---|
  | 1a unauthenticated finalize | 6 | An anonymous `POST /api/upload/confirm` with only a drop id returned 200 and flipped the drop to `completed`. |
  | 1b client-supplied `objectKey` | 3 | With a key scoped to `lisa`, the worker signed `.../drops/bob/drop-theirs/uploads/secret.pdf` -- the body's key won outright. |
  | 1c `isAdmin` | 2 | With `ADMIN_API_KEY` unset, the literal header `Authorization: Bearer ` authenticated as admin on every admin route. |
  | 1d no rate limiting | 6 | No limiter was consulted on any rejected credential; an exhausted bucket changed nothing. |
  | 1e blanket CORS | 7 | `Access-Control-Allow-Origin: *` was present on `/api/keys`, `/api/users`, `/api/drops`, `/api/boxes` -- the whole admin surface. |

  Then **1f, found mid-phase and flagged inline:** `authenticateWrite` validated
  an API key's `write` permission but never its `inbox_scope`, while every read
  path did check it. A key issued as "write, scoped to `bob`" could drop into any
  box. Proven RED separately by stashing the fixes and running
  `test/write-scope.test.ts` against the original tree: 3 failing, and the
  multipart case took 98ms because it genuinely reached R2 for another box.

  **GREEN: 47 pass, 0 fail. `bun run verify` clean** (types, typecheck, tests,
  `vite build`, `wrangler deploy --dry-run`). The dry-run confirms both bindings
  register: `env.AUTH_RATE_LIMIT (20 requests/60s)`,
  `env.UPLOAD_RATE_LIMIT (60 requests/60s)`.

  **Honest limitation on 1c:** the constant-time property itself is not
  unit-testable -- a JS timing assertion over a 64-char digest compare would be
  pure flake. The committed tests cover the empty-secret hole (genuinely RED),
  full behavioural correctness, and that the function is now async (i.e. hashing
  rather than string-comparing). The non-early-exit compare in
  `constantTimeEqual` is verified by reading it, not by a test. Said plainly
  rather than dressed up as coverage.
