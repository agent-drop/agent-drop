---
chain_id: modernize-20260801-161212-5998
plan_file: /Users/jonas/projects/agent-drop/docs/MODERNIZE-PLAN.md
plan_version: 1
status: in_progress
current_phase: 1
last_updated: 2026-08-01T09:12:12Z
link_count: 1
---

# Agent Drop modernization chain state

## Phases

- [ ] 1. Close the security holes
  - [ ] 1a. Authenticate `/api/upload/complete` + `/api/upload/confirm`
  - [ ] 1b. Derive `objectKey` from the drop row instead of trusting the client
  - [ ] 1c. Constant-time `isAdmin()`
  - [ ] 1d. `[[ratelimits]]` binding on failed auth + drop-token uploads
  - [ ] 1e. Scope CORS (none on admin routes, real origin on web routes)
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

## Decisions

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
