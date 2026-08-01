---
chain_id: modernize-20260801-161212-5998
plan_file: /Users/jonas/projects/agent-drop/docs/MODERNIZE-PLAN.md
plan_version: 4
status: in_progress
current_phase: 6
last_updated: 2026-08-01T17:20:00Z
link_count: 5
---

# Agent Drop modernization chain state

## Phases

- [x] 1. Close the security holes (link 1, local `main` `2c171b2`)
  - [x] 1a. Authenticate `/api/upload/complete` + `/api/upload/confirm`
  - [x] 1b. Derive `objectKey` from the drop row instead of trusting the client
  - [x] 1c. Constant-time `isAdmin()`
  - [x] 1d. `[[ratelimits]]` binding on failed auth + drop-token uploads
  - [x] 1e. Scope CORS (none on admin routes, real origin on web routes)
  - [x] 1f. BONUS (found in-phase): enforce `inbox_scope` on write paths
  - [x] Test harness: D1-over-`bun:sqlite`, `cloudflare:email` virtual module
- [x] 2. Safety net: web typecheck, Biome, CI, tests on pure functions
  (link 2, local `main` `47583b3`)
  - [x] 2a. `web/` + `test/` typechecked and wired into `bun run typecheck`
  - [x] 2b. Biome config (`biome.jsonc`) + fixes, folded into `bun run check`
  - [x] 2c. `.github/workflows/ci.yml`, every step verified in a clean clone
  - [x] 2d. Tests: rules.ts, relay.ts addressing, normalize.ts, hosting.ts
  - [x] 2e. BONUS (found in-phase): `slugifyFilename` extension left unsanitized
  - [x] 2f. BONUS (found in-phase): hosted subdir + trailing slash always 404'd
- [x] 3. Migrate outbound mail to `EmailMessageBuilder` (link 3, local `main`
  `3619269`)
  - [x] 3a. `api/send.ts` compose + send path -> builder, one send for the list
  - [x] 3b. `forwardViaBinding` -> builder; attachment re-encoding VERIFIED to
    survive (and improve: no base64 round-trip)
  - [x] 3c. `processRelayMessage` stays on raw; `sendRawViaBinding` reduced to it
  - [x] 3d. Differential `send-email --dry-run` old vs new: 11 cases, 10 byte-
    identical, 1 intended difference
  - [x] 3e. Constraints encoded as validation (50 recipients / 16KB / 20 non-X)
  - [x] 3f. MIME assembler relocated to `src/lib/mime.ts` (PLAN v3 correction:
    it cannot be deleted, the relay replay path needs it)
  - [x] 3g. BONUS (found in-phase): forwarded inline images had `<<cid>>`
  - [x] 3h. BONUS (found in-phase): Message-ID domain read from the display name
- [x] 4. Dev loop: `@cloudflare/vite-plugin` (link 4, local `main` `dc6a90e`)
  - [x] 4a. Plugin wired in; `vite dev` runs the Worker with real bindings
  - [x] 4b. `/api` dev proxy hack removed
  - [x] 4c. `brand-html` + `__BRAND__`/`__DOMAIN__` define still work
  - [x] 4d. `.env` placeholder rendering preserved -- moved from a temp toml into
    the plugin's `config` hook; committed `wrangler.toml` still placeholders-only
  - [x] 4e. `scripts/deploy.ts` deploys the generated config and REFUSES a
    config that does not match `.env`
  - [x] 4f. BONUS (found in-phase): `vite.config.ts` + `scripts/` were in no
    tsconfig; folded into `bun run typecheck`
  - [x] 4g. BONUS (found in-phase): `db:migrate` was pinned to `0001_initial.sql`
- [x] 5. Platform optimizations (link 5, local `main` `8cbf743`)
  - [x] 5a. `ctx.waitUntil` on `last_used_at`
  - [x] 5b. R2 event notifications -> confirm handshake now optional + idempotent
  - [x] 5c. Cron reaper for stale `pending` drops
  - [x] 5d. D1 Sessions API on read paths
  - [x] 5e. `scheduled` exercised against the live local runtime, both branches;
    the R2-notification queue consumer could NOT be (see log)
  - [x] 5f. `wrangler r2 bucket notification` + `queues create` documented in
    `CLAUDE.md` (LOCAL ONLY -- the file is untracked)
- [x] 6. Structural cleanup + final docs (link 6, local `main` `PENDING`)
  - [x] 6a. Router rewrite (tests FIRST, behavior-identical)
    - [x] 6a-i. Route-level tests GREEN against the CURRENT router
      (`test/router-routes.test.ts`, 78 + 6 quirk pins, commits `43519ab`,
      `5040634`)
    - [x] 6a-ii. Rewrite, made to pass them unchanged (`71f315c`)
    - [x] 6a-iii. Mutation-checked; the one surviving mutation got a test
      (`a34c500`)
    - [x] 6a-iv. BONUS (found in-phase): the mail routes never checked
      `inbox_scope` -- RED first, fixed (`00db531`)
  - [x] 6b. Real XML parse in upload.ts (`src/lib/xml.ts` + `s3-xml.ts`,
    commit `ee83fe9`)
  - [x] 6c. `client_secret_*.json` moved to `~/.secrets.d/agent-drop/`
    (`73aa5b6`)
  - [x] 6d. SES-fallback decision surfaced in the review ticket (not answered)
  - [x] 6e. `CLAUDE.md` updated (LOCAL ONLY -- the file is untracked)
  - [x] 6f. (adjacent) `resolveObjectKey` + `FinalizeDrop` -> `src/lib/drops.ts`

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
- `web/tsconfig.json` -- gained `types: ["vite/client"]`; it already existed but
  was never invoked by any script (phase 2)
- `test/tsconfig.json` -- new; root project + bun-types/node (phase 2)
- `package.json` -- `typecheck` now covers src/web/test/tools; new `lint` and
  `format` scripts; `lint` folded into `check` (phase 2)
- `biome.jsonc` -- Biome 2.5.6, tabs / double quotes / 100 cols (phase 2)
- `.github/workflows/ci.yml` -- install, `wrangler types --check`, typecheck,
  lint, test, build, deploy dry-run (phase 2)
- `src/lib/normalize.ts` -- `slugifyFilename` now sanitizes the extension
  (phase 2 bugfix)
- `src/lib/hosting.ts` -- `key += "/index.html"` separator fix (phase 2 bugfix)
- `test/helpers/env.ts` -- `makeCtx()` records + settles `waitUntil` promises;
  new `makeBucket()` R2 read stub (phase 2)
- `test/rules.test.ts`, `test/relay-address.test.ts`, `test/normalize.test.ts`,
  `test/hosting.test.ts` (phase 2)
- `src/lib/email-builder.ts` -- new; `EmailMessageBuilder` construction (address
  parsing, attachment shaping) + platform-limit validation (phase 3)
- `src/lib/mime.ts` -- new; the hand-rolled MIME assembler, moved out of
  `relay.ts`, plus `renderBuilderPreview()` for `/api/compose` (phase 3)
- `src/lib/relay.ts` -- `forwardViaBinding` on the builder; `sendRawViaBinding`
  reduced to the single-recipient relay replay; 423 -> 249 lines (phase 3)
- `src/api/send.ts` -- `prepareEmail` returns the builder payload; `handleSend`
  makes ONE send; `handleCompose` renders the preview from the builder (phase 3)
- `test/helpers/email.ts` -- new; `EMAIL` binding double recording builder vs
  raw sends, plus `onlyBuilder()` (phase 3)
- `test/send-email.test.ts`, `test/forward.test.ts`, `test/email-builder.test.ts`
  (phase 3)
- `CLAUDE.md` -- send-path description, the 40MB/25MiB limit, the `lib/` listing
  (which still claimed a deleted `ses.ts`) (phase 3)
- `web/public/styleguide.html`, `web/src/components/{DropZone,InboxView,
  GoogleSignIn}.tsx` -- duplicate-attribute and a11y fixes (phase 2)
- `scripts/deploy-identity.ts` -- new; the `.env` -> Worker-config bridge
  (`readDeployIdentity`, `applyDeployIdentity`, `checkDeployIdentity`,
  `renderBrandTokens`) (phase 4)
- `vite.config.ts` -- `cloudflare()` plugin, identity injected via its `config`
  hook, `server.proxy` deleted (phase 4)
- `scripts/deploy.ts` -- no longer renders a temp toml; finds the generated
  config, verifies it against `.env`, deploys it (phase 4)
- `scripts/tsconfig.json` -- new; typechecks `vite.config.ts` + `scripts/`
  (phase 4)
- `wrangler.toml` -- `[assets] directory` removed (the plugin populates it)
  (phase 4)
- `package.json` -- `preview` added, `dev:worker` removed, `typecheck` covers
  `scripts/`, `db:migrate` fixed + `db:migrate:local` added (phase 4)
- `test/deploy-identity.test.ts`, `test/toml.d.ts` -- new (phase 4)
- `CLAUDE.md` -- "Dev loop & Deployment" section rewritten (phase 4, LOCAL ONLY
  -- the file is untracked)
- `src/lib/r2-events.ts` -- new; R2 object-create notification consumer,
  `parseUploadKey`, `processR2Event`, `processR2EventBatch` (phase 5)
- `src/lib/reaper.ts` -- new; `reapPendingDrops` + `runScheduled`, the stale
  `pending` sweep (phase 5)
- `src/lib/auth.ts` -- `validateApiKey` takes an optional `ExecutionContext` and
  defers the `last_used_at` write through it (phase 5)
- `src/index.ts` -- `scheduled` export; `queue` dispatches on `batch.queue`
  (phase 5)
- `src/api/upload.ts` -- `handleConfirm` is idempotent; already-completed is a
  200, not a 404 (phase 5)
- `src/api/inbox.ts`, `src/api/router.ts`, `src/lib/hosting.ts` -- read paths run
  in a `first-unconstrained` D1 session (phase 5)
- `wrangler.toml` -- second `[[queues.consumers]]` (`agent-drop-r2-events`),
  `[triggers] crons = ["17 * * * *"]` (phase 5)
- `test/helpers/d1.ts` -- `withSession` on the fake D1, recording the constraint
  each caller asked for (phase 5)
- `test/helpers/env.ts` -- `gateStatement()` (holds a statement so deferral is
  observable), `makeBucket().head` + `heads` log, `seedPendingDrop({createdAt})`
  (phase 5)
- `test/last-used.test.ts`, `test/r2-events.test.ts`, `test/reaper.test.ts`,
  `test/d1-sessions.test.ts` (phase 5)
- `CLAUDE.md` -- Drop Lifecycle rewritten (three completion paths), R2 event
  notification + `queues create` + cron reproduction commands, `lib/` listing
  (phase 5, LOCAL ONLY -- the file is untracked)
- `test/router-routes.test.ts` -- new; the API's dispatch contract route by
  route, written GREEN against the OLD router before the rewrite (phase 6)
- `src/api/router.ts` -- two ordered route tables + dispatch; 487 -> 237 lines
  (phase 6)
- `src/api/match.ts` -- new; `exact` / `prefix` / `segments` /
  `segmentsThenRest` path matchers (phase 6)
- `src/api/gates.ts` -- new; the credential and scope gates plus the route
  wrappers the tables compose from (phase 6)
- `src/api/cors.ts` -- new; `isBrowserRoute` + the scoped CORS headers, lifted
  out of the dispatcher (phase 6)
- `src/api/admin-lists.ts` -- new; `GET /api/drops` and `GET /api/boxes`, whose
  SQL had been living inside the router (phase 6)
- `src/lib/drops.ts` -- new; `FinalizeDrop` + `resolveObjectKey`, so `lib/` no
  longer imports from `api/` (phase 6)
- `test/match.test.ts` -- new; matcher unit tests, written because a mutation
  survived the route suite (phase 6)
- `src/lib/xml.ts` -- new; small strict XML reader, rejects malformed input
  (phase 6)
- `src/lib/s3-xml.ts` -- new; `readUploadId`, `readListedParts`,
  `renderCompleteBody` (phase 6)
- `test/xml.test.ts` -- new; 45 tests over both (phase 6)
- `src/api/upload.ts` -- regex XML scraping replaced by the parser (phase 6)
- `test/send-scope.test.ts` -- new; the outbound-mail `inbox_scope` regression
  (phase 6)
- `src/lib/mime.ts` -- a `biome-ignore` that no longer suppressed anything
  (phase 6)
- `test/helpers/env.ts` -- `makeBucket()` gained `list`/`put`/`delete` and a
  `deletes` log (phase 6)
- `.env.example` -- notes where the OAuth client secret now lives (phase 6)
- `CLAUDE.md` -- auth model (permissions vs scope, rate limits, CORS), router
  dispatch, testing, the corrected upload endpoints, the out-of-band deploy
  steps (phase 6, LOCAL ONLY -- the file is untracked)

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
  `deploy --dry-run`). As of phase 2, `check` also runs `biome check .` and
  typechecks `web/` and `test/`.
- 2026-08-01 [link 2]: **Biome config lives in `biome.jsonc`, not `biome.json`.**
  Biome lints its own config, and a plain `.json` file rejects comments -- so the
  non-obvious exclusions (`*.css`, see below) could not carry their reason. The
  `.jsonc` name is fully supported by Biome and by editors.
- 2026-08-01 [link 2]: **`*.css` is excluded from Biome.** Its CSS parser rejects
  Tailwind v4 at-rules (`@theme`, `@plugin`, `@custom-variant`) as syntax errors.
  Revisit if Biome adds Tailwind v4 support.
- 2026-08-01 [link 2]: **`test/` is a separate TS project, not folded into the
  root one.** The suite needs `bun-types` + `node`; the worker project sets
  `types: []` on purpose so its globals come from `worker-configuration.d.ts`.
  `test/tsconfig.json` extends the root and adds those two, which keeps Bun's
  globals out of `src/` while still typechecking the tests against the real
  worker types.
- 2026-08-01 [link 2]: **CI needs no secrets.** It copies `.env.example` to
  `.env`, so the build and deploy dry-run exercise the real placeholder-rendering
  path in `scripts/deploy.ts` with values that are already public -- and
  `.env.example` becomes self-checking (a var added to the code but forgotten
  there fails CI). Verified in a clean clone.
- 2026-08-01 [link 2]: **Biome's unsafe fix for unused variables was rejected.**
  It renames to `_name` rather than deleting, which preserves dead code under an
  uglier name. Every instance was deleted by hand instead. One (`merged` in the
  CLI's `invite` command) was still used further down -- caught by the newly
  wired typecheck, which is the phase justifying itself.

- 2026-08-01 [link 3]: **`/api/compose` renders its preview FROM the builder
  payload, not from the request body.** The dry-run is only worth having if it
  goes stale the moment the send path's field mapping does; deriving it from the
  same object makes that structural rather than a promise. The response shape is
  unchanged (`message/rfc822`), so the CLI contract holds.
- 2026-08-01 [link 3]: **The preview is an approximation of the wire format and
  is documented as one.** Message-ID and Date are platform-controlled on the
  builder path, and the exact MIME nesting and header quoting are Cloudflare's.
  What the preview guarantees is field parity, not byte parity. Rejected the
  alternative of returning the builder payload as JSON: it would break
  `--dry-run --out file.eml`, and the PLAN forbids changing the API surface.
- 2026-08-01 [link 3]: **The MIME assembler was moved, not deleted.** See PLAN
  v3. `enqueueRelay` still assembles a raw message for the queue, so the code has
  a live caller; putting it in `src/lib/mime.ts` makes the "platform assembles" /
  "we assemble" boundary legible and drops `relay.ts` from 423 to 249 lines.
- 2026-08-01 [link 3]: **Attachments travel as bytes, never base64.** The
  binding reads a string `content` as RAW content, so the old base64 pipeline
  would have attached base64 text. `resolveAttachment` now decodes once at the
  edge; the compose preview re-encodes only for display.

- 2026-08-01 [link 4]: **The `.env` injection moved from a temp file into the
  plugin's `config` hook.** The old flow rendered placeholders into
  `.wrangler.deploy.toml` and pointed wrangler at it. That cannot survive the
  plugin, which reads the Worker config itself at build AND dev time -- a file
  rendered later is simply never consulted. The plugin's programmatic `config`
  option takes a function over the parsed config, so the substitution is now
  structural (four named fields) rather than a whole-file `replaceAll`, which is
  also strictly more precise: a placeholder token appearing in an absolute path
  can no longer be mangled.
- 2026-08-01 [link 4]: **`scripts/deploy.ts` survives as a guard, not a
  renderer.** It resolves the generated config through the plugin's own
  `web/.wrangler/deploy/config.json` redirect, then refuses to deploy unless the
  config matches `.env` field by field. Rejected the alternative of scanning the
  built config for leftover placeholder text: CI legitimately builds from
  `.env.example`, whose values ARE the placeholders, so that check would have to
  be disabled exactly where it is cheapest to run.
- 2026-08-01 [link 4]: **Vite `root` stays `web/`.** The plugin's defaults assume
  root == project root, but `configPath: "../wrangler.toml"` is enough, and the
  alternative (moving `web/index.html` to the repo root so the plugin's paths
  line up) is a layout change with no payoff. Cost of the choice: build output
  lands under `web/dist/{client,agent_drop}` and the deploy redirect under
  `web/.wrangler/`, both already gitignored.
- 2026-08-01 [link 4]: **`[assets] directory` deleted from the committed
  `wrangler.toml`.** The plugin populates it from the client build output. The
  hardcoded `./web/dist` was not merely redundant, it had become dangerous: that
  directory now also holds the Worker bundle and a `.dev.vars`, so anything
  falling back to it would publish both as public assets.

- 2026-08-01 [link 5]: **The reaper rescues, it does not only delete.** The PLAN
  said "`pending` older than 24h with no R2 object -> delete the row". It is
  silent on the case where the object IS there, which is exactly what a lost
  notification looks like -- and deleting that row destroys a drop whose bytes
  are sitting in the bucket. The reaper therefore asks R2 first: object present
  -> `completed`, object absent -> deleted, key unresolvable -> left alone and
  counted as `skipped`. Superset of what the PLAN asked for, never less.
- 2026-08-01 [link 5]: **`/api/upload/confirm` had to become idempotent, and that
  is a (sanctioned) response-shape change.** It answered `404 {"error":"drop not
  found or already confirmed"}` when nothing changed. With R2 notifications
  running, the notification usually wins the race, so that 404 would have become
  the NORMAL outcome of a healthy upload and the SPA would have reported a
  failure on every successful drop. It now returns
  `200 {"confirmed":true,"dropId":...,"alreadyCompleted":boolean}`. The PLAN
  explicitly asked for "keep it as a back-compat no-op", so this is the ask, not
  drift. A genuinely unknown drop id is still a 404 (the router's row lookup),
  and a row in neither state is a 409.
- 2026-08-01 [link 5]: **The R2 event consumer matches on the recorded
  `object_key`, not just the drop id.** The key comes from R2 itself, so parsing
  `drops/{box}/{id}/uploads/{file}` out of it is server-side state coming home,
  not user input -- but pinning it to the row's own `object_key` (phase 1's
  migration 0008) means a stray object under a drop's prefix still cannot
  complete it. Pre-0008 rows carry no key and match on id + inbox alone.
- 2026-08-01 [link 5]: **No producer binding for `agent-drop-r2-events`.** R2 is
  the producer; the Worker only consumes. Adding a producer binding would have
  made the queue writable by our own code for no reason.
- 2026-08-01 [link 5]: **Read paths use `first-unconstrained`, not
  `first-primary`.** `first-primary` on a handler that runs ONE query is a
  session with no benefit -- the first query is the only query and it goes to the
  primary either way. The trade taken: an inbox listing can miss a drop written
  microseconds earlier by a *different* request, bounded by replica lag. D1's
  cross-request read-your-writes guarantee needs a bookmark the client would have
  to carry, which would change the public API surface the PLAN forbids changing.
  Write paths were left with no session at all rather than given
  `first-primary` -- same routing, less ceremony.
- 2026-08-01 [link 5]: **`last_used_at` failures are swallowed, deliberately.** A
  transient D1 error on a bookkeeping write must not fail an otherwise-valid
  request, and an unhandled rejection inside `waitUntil` is just noise. Cost of a
  lost one is a stale timestamp. Pinned by a test.

- 2026-08-01 [link 6]: **The router is TWO route tables, not one, and that is
  behavior rather than taste.** The old dispatcher validated an API key partway
  down its sequence of regex checks, so an anonymous caller got 401 on an
  unknown path while a credentialled one got 404. Flattening everything into a
  single table with per-route auth would have turned the first case into a 404
  and handed an anonymous prober a map of the API. Tier 1 (no key required, each
  route gated individually) -> mandatory key gate -> tier 2 reproduces it
  exactly, and says out loud why the order matters.
- 2026-08-01 [link 6]: **Not `URLPattern`, despite the PLAN offering it.** Two of
  the three shapes this API uses are not expressible in it: the admin routes
  match by `startsWith` (so `/api/keysfoo` reaches the keys handler -- a wart,
  preserved deliberately and pinned by a test, because this phase's contract is
  behavior-identical dispatch), and `/api/inbox/:inbox` needs the remainder of
  the path captured verbatim and possibly empty. Both need several URLPattern
  patterns plus a fallback, which is more code than the 75-line matcher and
  reads worse.
- 2026-08-01 [link 6]: **A hand-written XML reader rather than a dependency.**
  There is no `DOMParser` in workerd. `src/lib/xml.ts` is ~180 lines covering
  elements, attributes, text, CDATA, comments, PIs and entities -- enough for
  four fields across two flat S3 documents, and not worth a supply-chain
  addition. It REJECTS malformed input instead of guessing, and `s3-xml.ts`
  turns that into the same 500s the endpoints already returned, so a truncated
  or hostile response now fails closed.
- 2026-08-01 [link 6]: **ETags go back to R2 with literal quotes, not `&quot;`.**
  R2 sends them escaped; the reader decodes and the writer re-escapes only
  `& < >`, which is the required set for element content. Both forms parse to
  the same string, so this is a byte-level difference with no semantic one,
  pinned by a round-trip test rather than left to chance.
- 2026-08-01 [link 6]: **`~/.secrets` is a shell env file, not a directory**, so
  6c's literal instruction was impossible. The OAuth client JSON went to
  `~/.secrets.d/agent-drop/` (dir 700, file 600), copied and byte-compared
  before the original was removed. `client_secret_*.json` stays in `.gitignore`.

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
- **RESOLVED (phase 2):** the `web/tsconfig.json` unknown quantity came in cheap
  -- one error in `web/` (a missing ambient declaration for the CSS side-effect
  import), 14 in `test/`. The PLAN said no `web/tsconfig.json` existed; in fact
  it has existed since the initial commit and was simply never invoked by any
  script. Correction recorded in the PLAN changelog (v2).
- **CI never runs on push in this chain.** `.github/workflows/ci.yml` is
  committed but nothing is pushed to `origin`, so GitHub has never executed it.
  Every step was verified by running it in a clean local clone with only
  `.env.example` values. First real run happens whenever Jonas pushes.
- **RESOLVED (phase 3):** `forwardViaBinding`'s attachment re-encoding survives
  the builder, and improves. `EmailAttachment.content` accepts
  `ArrayBuffer | ArrayBufferView | string`, which is exactly postal-mime's output
  shape, so forwarded attachments are no longer base64'd on the way out at all.
  That call site migrated. Pinned by `test/forward.test.ts`.
- **NEW (phase 3), for whoever ships this:** an inline attachment with no
  Content-ID is not representable in the binding's `EmailAttachment` union
  (`disposition: "inline"` requires `contentId`). Such a part now degrades to a
  regular attachment instead of being sent as an unaddressable inline part.
  Behaviour change, deliberate, tested. Nothing in the CLI or SPA produces one.
- **NEW (phase 3):** `Message-ID` and `Date` are platform-controlled on the
  builder path -- Cloudflare rejects them as custom headers. Composed and
  forwarded mail no longer carries an id we minted. The relay path, which stays
  on raw, still mints its own.
- **NEW (phase 3):** the send path can now reject before sending
  (>50 recipients, oversized headers) with a 400 naming the limit. Previously
  such a payload was handed to the platform and came back as an opaque `E_*`.
- **NEW (phase 4), for whoever ships this:** `bunx wrangler deploy` from the
  repo root now silently deploys the PLACEHOLDER config. The real values only
  exist in the config the Vite build generates, and wrangler's auto-detection
  redirect lives at `web/.wrangler/deploy/config.json` (Vite root is `web/`), not
  at the repo root. Always deploy via `bun run deploy`. `scripts/deploy.ts` is
  the guard, and it exits 1 with a field-by-field diff if the built config does
  not match `.env` -- verified by building with `.env` absent and then deploying
  with it present.
- **NEW (phase 4):** `vite build` writes `web/dist/agent_drop/.dev.vars`
  containing **every secret in `.env` in plaintext** (the plugin's local-dev
  secret injection). It is inside a gitignored directory and `.assetsignore`
  keeps it out of the asset upload, but it is a real file on disk that did not
  exist before. Do not `cp -r` the build output anywhere public.
- **NEW (phase 4):** the local dev D1 is empty until seeded --
  `bun run db:migrate:local`. State persists under `web/.wrangler/state`.
- **DEPLOY GATE (phase 5), two new out-of-band steps.** The code is inert without
  them:
  1. `wrangler queues create agent-drop-r2-events` -- the consumer is declared in
     `wrangler.toml`, so a deploy before the queue exists will fail.
  2. `wrangler r2 bucket notification create agent-drop-storage --event-type
     object-create --queue agent-drop-r2-events --prefix "drops/"` -- bucket
     config, not `wrangler.toml`, and lost if the bucket is ever recreated.
     Documented in CLAUDE.md next to the lifecycle/CORS commands.
  The cron trigger needs nothing extra; `bun run deploy` registers it. Until step
  2 lands, `/api/upload/confirm` still completes drops exactly as before and the
  reaper is the backstop -- so a partial rollout degrades, it does not break.
- **The R2-event queue consumer was NOT exercised against the live local
  runtime**, and this is a real gap, not a formality. Miniflare does not emulate
  R2 bucket event notifications, and neither `wrangler dev` nor the Vite plugin
  exposes a queue-handler endpoint the way it exposes
  `/cdn-cgi/handler/scheduled` (probed: `/cdn-cgi/handler/queue` and
  `/cdn-cgi/handler/queues` both fail). The consumer's logic and the entry
  point's dispatch-by-queue-name are covered by unit tests, but the first real
  R2 -> queue -> worker delivery happens after deploy. Watch the first presigned
  upload after the notification rule is created.
- **NEW (phase 5), for whoever ships this:** the `drops/` notification prefix is
  as narrow as R2 filters go (prefix/suffix only), so the queue also carries
  every inbound email's `raw.eml` and `attachments/` writes. They are filtered
  out in code, not at the bucket, so the queue's message volume is higher than
  the upload rate. Harmless, but it is what the invoice will show.
- **RESOLVED (phase 6):** `src/lib/reaper.ts` no longer imports from `api/`.
  `resolveObjectKey` + `FinalizeDrop` moved to `src/lib/drops.ts`; three import
  sites updated.
- **NEW (phase 6), a security fix, not a refactor:** `POST /api/send/:inbox`,
  `/api/compose/:inbox` and `/api/send/presign/:inbox` checked the API key's
  write PERMISSION but never its `inbox_scope`. `:inbox` becomes the From
  address, so a key issued "write, scoped to bob" could send mail as `lisa@`,
  DKIM-signed by the domain. Same class as phase 1's finding 1f, which fixed
  the drop and upload paths and never reached these three. RED first
  (`test/send-scope.test.ts`, 8 failures, one of them proving mail really went
  out), then fixed by deleting the one-off gate that carried the short check.
  Filed as `done/bug-send-routes-ignore-inbox-scope`.
- **NEW (phase 6), documentation was wrong, not just stale:** CLAUDE.md's
  presigned-upload section documented the inbox in the request BODY, snake_case
  field names (`drop_id`, `file_name`, `content_type`), and a `parts` array on
  `/api/upload/complete`. None of that has ever been the API. Corrected against
  the code. Anyone who integrated from those docs could not have worked.
- **Phase 6d, unanswered on purpose:** deleting the SES fallback is a user
  decision. Carried into the review ticket with its full blast radius.
- **NEW (phase 6):** `~/.secrets` turned out to be a shell-sourced env file, so
  the OAuth client secret went to `~/.secrets.d/agent-drop/` instead. Flagged in
  the review ticket in case Jonas wants it somewhere else.
- Phase 6 doc sweep: CLAUDE.md's send-path and `lib/` sections were corrected in
  phase 3 because they became actively wrong the moment the send path changed.
  The broader sweep (CI, build, reaper, R2 notifications, upload security model)
  is still phase 6's.
- **`CLAUDE.md` IS NOT TRACKED IN THIS REPO.** `~/.gitignore:14` ignores it
  globally, so the file exists on disk but git has never seen it -- despite its
  own header calling itself "project instructions, checked into the codebase".
  Phase 3's corrections to it are therefore **local to this working copy and are
  in no commit**. Phase 6 item 5 ("update CLAUDE.md") should know this before it
  starts: either it is a local-only edit, or Jonas decides to force-add the file
  (`git add -f`). Not the chain's call to make -- the global ignore is
  deliberate.

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

  Merged into **local `main` as `2c171b2`** (merge commit; phase commit
  `3ad0137`), `bun run verify` re-run green on `main` after the merge, branch
  `chain/p1-security` deleted, tree clean. **Nothing pushed to `origin`** -- local
  `main` is 7 commits ahead, as the plan requires. Spawning link 2 for phase 2.
- 2026-08-01T12:20:00Z [link 2] phase 2 complete. Branch `chain/p2-safety-net`,
  three commits, merged to **local `main` as `47583b3`**.

  **2a -- typecheck.** The PLAN's premise was wrong in a useful way:
  `web/tsconfig.json` has existed since the initial commit, it was just never
  referenced by any script, so nothing ever ran it. Wiring it in surfaced exactly
  **one** error (no ambient declaration for `import "./styles/globals.css"`),
  fixed with `types: ["vite/client"]`. Folding `test/` in via a new
  `test/tsconfig.json` surfaced **14**, all in the phase-1 helpers, all fixed.
  `bun run typecheck` now covers src, web, test and tools.

  **2b -- Biome 2.5.6.** Tabs, double quotes, 100 columns (measured: p95 line
  length is 92). 32 files reformatted, 55 lint errors driven to zero. Fixed
  rather than suppressed, except two control-character regexes that are
  deliberate (an ASCII range bound in `romanize`, ANSI SGR stripping in the CLI's
  column padding) and now carry `biome-ignore` comments saying why. `bun run
  lint` is part of `bun run check`, so the green gate covers it.

  Three real defects came out of that pass, beyond formatting:
  `styleguide.html` had `class="name" class="glow-pink"` on two swatches (second
  attribute silently dropped by every browser); `DropZone`'s drop target had
  click/drop handlers on a bare `div` with no keyboard path at all; and
  `handleDrop` was a `useCallback` whose dep array omitted the two upload
  functions it closes over -- those are redefined every render and nothing
  consuming it is memoized, so the memo bought nothing and hid a stale-closure
  hazard. Now a plain function.

  **2c -- CI.** `.github/workflows/ci.yml`: frozen-lockfile install,
  `wrangler types --check` (the wrangler.toml/type drift catcher), typecheck,
  lint, test, build, deploy dry-run. No secrets -- it copies `.env.example` to
  `.env`. Every step verified by running it in a clean `git clone` of the branch
  with only `.env.example` present. Note: the first run showed a real Google
  client id because this shell's profile exports one, overriding the file; re-run
  with those vars stripped to prove the placeholder-only path works. **CI has
  never actually run on GitHub, because this chain does not push.**

  **2d -- tests.** 92 new tests (47 -> **139 pass, 0 fail**) across `rules.ts`,
  relay addressing, `normalize.ts` and `hosting.ts`. The rules suite was
  mutation-checked: turning the exact pattern into a prefix match, breaking out
  of the cascade after the first hit, and no-op'ing `substitute()` fails 9 of its
  25 tests, so the suite has teeth rather than just passing.

  **Two bugs found mid-phase, both flagged inline, both RED before the fix:**

  | Bug | RED test | What it did |
  |---|---|---|
  | `slugifyFilename` copied the extension verbatim | 3 | `"../../etc/passwd"` -> `"file./etc/passwd"`; separators after the last dot went straight into the R2 key, and inbound-email filenames come from a remote MIME part. Downward path injection, not traversal (`..` cannot occur in a slice starting at the last dot) -- but that safety rested on an invariant nobody had written down. |
  | `serveHostedSite` built `…/docsindex.html` | 1 | Every hosted site with a subdirectory index 404'd at its canonical trailing-slash URL while the no-slash form worked. Missing `/` before `index.html`. |

  Both filed on the board and moved to `done/`:
  `bug-slugify-extension-unsanitized`, `bug-hosting-dir-index-missing-slash`.

  **Honest note on three hosting tests I wrote and then had to rewrite:** I
  asserted that `..` and `%2e%2e` in a hosted path would be caught by
  `serveHostedSite`'s own segment filter. They are not -- WHATWG `URL` collapses
  dot segments, encoded ones included, before the worker sees the path. The
  worker's filter is real defense in depth but cannot be triggered through a
  `Request`. The tests now pin that normalization explicitly and assert what
  actually holds: the R2 key is always rebuilt as `sites/{box}/{site}/...`, and
  the registry (not the path shape) is the gate. `sanitizeSitePath` is unit
  tested directly, which is where that filter's logic genuinely lives.

  `bun run verify` exits 0 on `main` after the merge. Branch deleted, tree clean.
  **Nothing pushed to `origin`** -- local `main` is 12 commits ahead. Spawning
  link 3 for phase 3.
- 2026-08-01T14:05:00Z [link 3] phase 3 complete. Branch
  `chain/p3-email-builder`, merged to **local `main` as `3619269`**.
  Tests 139 -> **202 pass, 0 fail**. `bun run verify` exits 0.

  **What migrated, and what deliberately did not.**

  | Call site | Outcome |
  |---|---|
  | `api/send.ts` compose + send | Builder. ONE send for the whole to/cc/bcc list, replacing the loop that sent a separate raw message per envelope recipient. |
  | `relay.ts` `forwardViaBinding` | Builder. The PLAN said VERIFY before committing -- see below. |
  | `relay.ts` `processRelayMessage` | **Stays on raw**, per PLAN. `sendRawViaBinding` reduced from an N-recipient loop to the single recipient this path actually has. |

  **3b, the PLAN's open question, answered empirically.** Attachment re-encoding
  does not merely survive the builder, it gets simpler:
  `EmailAttachment.content` takes `ArrayBuffer | ArrayBufferView | string`, which
  is exactly what postal-mime hands back, so forwarded attachments are no longer
  base64-encoded on the way out. The catch found in the same pass: a **string
  `content` is RAW content, not base64** -- the old pipeline's base64 strings
  would have been attached as literal base64 text. `resolveAttachment` now
  decodes once at the edge and everything downstream carries bytes.

  **3d -- the differential check.** A harness under `.claude/temp/p3-diff/`
  (gitignored, so it survived the branch switch) stands up a local server
  mounting the tree's own `handleCompose` and drives the **real CLI** --
  `bun tools/agent-drop.ts send-email --dry-run` -- across 11 cases: plain text;
  text+html; html with an inline `cid:` image; a regular attachment; a remote
  URL attachment; multi to/cc/bcc; `+addressing` topic; `--in-reply-to` by raw
  message-id; `--in-reply-to` by drop id; display-name recipients + `--from-name`
  + `--reply-to`; and a unicode subject and body. Run on `main`, then on the
  branch. Message-ID, Date and MIME boundaries are random by construction and
  were normalised before diffing.

  **Result: 10 of 11 byte-identical. One intended difference, case 09:**

  ```
  - Cc: Team Lead <lead@example.com>
  + Cc: "Team Lead" <lead@example.com>
  ```

  The old path passed a recipient string straight into the header; the new one
  parses it into the binding's `{name, email}` object, and the preview renderer
  re-quotes the display name. Both are valid RFC 5322, and quoting is the safer
  of the two -- an unquoted display name containing specials (`.`, `,`, `:`) is
  malformed, a quoted one never is. Note what this difference is NOT evidence
  about: on the real send path Cloudflare does its own header encoding, so the
  quoting here is our preview renderer's choice. What the case proves is that the
  name/address pair survives the new parsing intact.

  Worth stating plainly: the inline-`cid` and attachment cases coming back
  byte-identical means the base64 -> bytes -> base64 round-trip introduced by the
  migration is lossless.

  **Test suite mutation-checked**, so "202 pass" is not decoration. Seeding three
  defects in the new code, one at a time: dropping `References` from the
  threading headers fails 3; skipping address parsing on `To` fails 1; leaving
  Content-IDs unnormalised fails 2.

  **Two bugs found mid-phase, both flagged inline, both RED before the fix:**

  | Bug | What it did |
  |---|---|
  | Forwarded inline `Content-ID` double-wrapped | postal-mime returns the raw header value *with* brackets, and `leafAttachment` wrapped it again -> `Content-ID: <<logo123>>`. No client matches that against `cid:logo123`, so inline images silently failed to render in **every** forwarded email. RED output captured before the fix. |
  | Message-ID domain taken from the display name | `buildRawEmail` matched the first `@` in the From header. A forward's From is `"sender@example.com (via lisa@frst.dev)" <lisa@frst.dev>`, so every forwarded message announced a Message-ID from a domain we do not sign -- exactly the mismatch spam filters weight. The RED is in the first bug's failure dump: `Message-ID: <...@example.com>`. |

  Filed as `done/bug-forward-inline-cid-double-brackets` (both findings on the
  one ticket -- same file, same fix commit).

  **PLAN corrected to v3.** Its "~130 lines of MIME assembler get deleted" was
  wrong: `enqueueRelay` builds the queued message with `buildRawEmail`, and the
  consumer that replays it is the path this very phase mandates stays on raw. The
  assembler therefore always keeps a live caller. It was **moved** to
  `src/lib/mime.ts` instead, which makes the "platform assembles this" / "we
  still assemble this" boundary legible and takes `relay.ts` from 423 to 249
  lines. No GOAL or requirement changed.

  **Honest limitation.** Nothing here exercises the real
  `env.EMAIL.send(builder)`. The binding is a test double, and the differential
  compares our own preview rendering on both sides -- it proves the field mapping
  end to end, it does not prove Cloudflare assembles those fields the way we
  expect. Verifying that needs one real send from a deployed worker, which this
  chain does not do (nothing is deployed, and the DEPLOY GATE above still
  stands). First real send after deploy is the remaining unknown.

  **Nothing pushed to `origin`.** Spawning link 4 for phase 4.
- 2026-08-01T15:40:00Z [link 4] phase 4 complete. Branch `chain/p4-vite-plugin`,
  two commits, merged to **local `main` as `dc6a90e`**. Tests 202 -> **221 pass,
  0 fail**. `bun run verify` exits 0 on `main`.

  **The abort clause did not fire.** The PLAN's escape hatch was "if the plugin
  cannot coexist with the `.env` placeholder-rendering deploy flow, stop". It
  can, but not by keeping the old mechanism: `scripts/deploy.ts` rendered a temp
  `.wrangler.deploy.toml` *after* the build, and the plugin reads the Worker
  config *itself*, at build and dev time, so a file rendered afterwards is never
  consulted. The plugin's programmatic `config` option is the seam --
  `vite.config.ts` hands it a function that injects the real identity from
  `.env` into the parsed config, and the generated
  `web/dist/agent_drop/wrangler.json` comes out with real values while the
  committed `wrangler.toml` is never written to.

  | Requirement | Outcome |
  |---|---|
  | `brand-html` `%BRAND%`/`%DOMAIN%` + `__BRAND__`/`__DOMAIN__` define | Intact. Extracted to `renderBrandTokens()` so it is unit-tested rather than trusted; dev server serves `<title>FRST - Agent Drop</title>`. |
  | Committed `wrangler.toml` carries only placeholders | Intact, and now pinned by a test that parses the real file. |
  | No `base` option introduced | None. The known SPA regression does not apply. |
  | Two-step build collapsed | `vite build` emits worker + client + deployable config in one pass. |

  **The dev loop is real, verified against live bindings, not asserted.** With
  `bunx vite dev` (single process, no `wrangler dev`, `server.proxy` deleted):
  `GET /` served the SPA with brand tokens substituted; `GET /api/health` came
  back `{"ok":true,...}` from workerd with `access-control-allow-origin:
  https://frst.dev` (phase 1's scoped CORS resolving `env.DOMAIN` at runtime);
  `POST /api/keys` minted a real key into local D1; `POST /api/drop/devprobe`
  then `GET /api/inbox/devprobe/latest` round-tripped a drop through D1. The
  R2 and email bindings instantiate locally (`web/.wrangler/state/v3/r2`,
  `.wrangler/tmp/email`).

  **The deploy guard, proven negatively.** `scripts/deploy.ts` no longer renders
  anything; it resolves the generated config via the plugin's
  `web/.wrangler/deploy/config.json` redirect and refuses to deploy one that
  disagrees with `.env`. Built with `.env` absent, then deployed with real vars
  present: exit 1, six field-by-field mismatches listed, wrangler never invoked.
  Built normally: `--dry-run` reports `env.DOMAIN ("frst.dev")` and the real
  account id, all seven bindings registering.

  **CI re-verified in a clean clone** with `.env.example` only and the shell's
  own `DOMAIN`/`GOOGLE_CLIENT_ID`/etc. stripped (the trap phase 2 hit): types
  check, typecheck, lint, 221 tests, build, and deploy dry-run all green on
  placeholder values -- so the guard does not fire on the legitimate
  placeholder-valued build.

  **Two things found mid-phase, both flagged inline, both fixed:**

  | Finding | What it was |
  |---|---|
  | `vite.config.ts` and `scripts/` were in NO tsconfig | The root project includes only `src/**`. So the two files that decide which account, domain and database the Worker deploys to were the only unchecked TypeScript in the repo -- and phase 4 was about to put more logic there. New `scripts/tsconfig.json`, folded into `bun run typecheck`. |
  | `db:migrate` was `d1 execute --file=migrations/0001_initial.sql` | Flagged in STATE by link 1 as a phase-1 deploy-gate footnote. It re-ran the initial migration and applied nothing else, so the documented way to migrate could never have applied `0008`. Now `d1 migrations apply --remote` against the generated config, plus a `db:migrate:local` for the new dev loop. |

  **New tests are mutation-checked**, so "221 pass" is not decoration: skipping
  route substitution in the injector fails 6, dropping the BRAND assignment
  fails 7, blinding `checkDeployIdentity` to the database id fails 2. The
  strongest of them parses the committed `wrangler.toml` and asserts no
  placeholder token survives injection -- so a placeholder added later to a
  field the injector does not visit fails the suite instead of shipping a
  half-rendered config.

  **Honest limitations.** (1) Nothing was deployed, so the generated
  `wrangler.json` has only ever been through `--dry-run`; wrangler validated and
  bundled it, but no Worker was updated. The phase-1 DEPLOY GATE (migration
  `0008`) still stands. (2) `vite preview` was added as a script but only
  smoke-checked by the plugin's presence, not exercised. (3) The dev-loop
  verification was HTTP-level; I did not test HMR or worker hot-reload
  behaviour.

  **Nothing pushed to `origin`** -- local `main` is 21 commits ahead. Spawning
  link 5 for phase 5.
- 2026-08-01T16:00:00Z [link 5] phase 5 started on branch
  `chain/p5-platform-opt` from `main` `95f55af`. Tree clean, `bun run verify`
  green on `main` at 221 tests. Working the four PLAN items in order, plus a
  live-runtime exercise of the two new handlers (`scheduled`, the R2-event queue
  consumer) as the phase-4 handover asks.
- 2026-08-01T17:20:00Z [link 5] phase 5 complete. Branch `chain/p5-platform-opt`,
  merged to **local `main` as `8cbf743`**. Tests 221 -> **267 pass, 0 fail**.
  `bun run verify` exits 0. All four PLAN items shipped; nothing deferred to
  phase 6.

  | Item | Outcome |
  |---|---|
  | 5a `ctx.waitUntil` on `last_used_at` | Every authenticated request used to carry a serialized D1 write before it could answer. Deferred, and the failure swallowed on purpose. |
  | 5b R2 event notifications | New `agent-drop-r2-events` consumer flips `pending` -> `completed` when the bucket reports the object. `/api/upload/confirm` survives as an idempotent no-op. |
  | 5c Cron reaper | `[triggers] crons = ["17 * * * *"]`, `scheduled` handler, `src/lib/reaper.ts`. |
  | 5d D1 Sessions | `first-unconstrained` on `/api/inbox/*`, `/api/drops`, `/api/boxes`, hosted-site lookup. |

  **The dev loop earned its keep, exactly as the phase-4 handover predicted.**
  With `bun run dev` (one process, workerd, live D1/R2 bindings) and
  `curl "localhost:5173/cdn-cgi/handler/scheduled?cron=17+*+*+*+*"`, both reaper
  branches were driven against real bindings, not doubles:

  - Presigned a drop through the real API, backdated `created_at` in the local
    D1, triggered the cron. Worker logged
    `reaper: scanned 1 stale pending drops -- completed 0, deleted 1, skipped 0`
    and the row was gone. The unrelated `completed` drop was untouched.
  - Presigned a second drop, put its object into local R2 with
    `wrangler r2 object put --local`, backdated, triggered. Worker logged
    `completed 1, deleted 0` and the row came back as `completed`. The rescue
    branch is not theory.

  Three more things were checked live because a failure in any of them would
  only have shown up in production:

  - **`withSession` works on miniflare's D1.** `/api/inbox/lisa`, `/api/boxes`
    and `/api/drops` all 200 against workerd. Had it been unimplemented locally,
    every read path would 500 in dev and the unit tests (which stub D1) would
    never have said so.
  - **`/api/upload/confirm` is idempotent on the real runtime**: first call
    `{"confirmed":true,"alreadyCompleted":false}`, second call the same with
    `alreadyCompleted:true`, both 200. Under the old code the second was a 404.
  - **The deferred `last_used_at` write really lands** in workerd's `waitUntil`,
    not just in the test's `settle()`.

  **What could NOT be exercised live, stated plainly:** the R2 -> queue ->
  consumer delivery itself. Miniflare does not emulate bucket event
  notifications, and there is no local queue-handler endpoint (`/cdn-cgi/handler/
  queue` and `/queues` were both probed and both fail). The consumer's logic and
  the entry point's dispatch-by-queue-name are unit-tested; the first genuine
  delivery happens after deploy, once the notification rule exists. Logged as an
  open item above.

  **Tests are mutation-checked**, so "267 pass" is not decoration. Four seeded
  defects, one at a time: dropping the `object_key` guard from `processR2Event`
  fails 1; inverting the reaper's object-present branch fails 5; switching the
  read paths from `first-unconstrained` to `first-primary` fails 5; making the
  entry point ignore `batch.queue` fails 1.

  One test-harness finding worth recording: the FakeD1 runs SQLite
  *synchronously* inside an `async` method, so its writes land before the
  returned promise ever yields -- which makes an inline `await` look deferred.
  "The response came back before the write landed" was untestable until
  `gateStatement()` was added to hold a statement open. The first version of the
  5a tests passed against the unfixed code for that reason; they were rewritten,
  not relaxed.

  **PLAN not amended.** Nothing in phase 5 turned out to be factually wrong the
  way phases 3 and 4 did. The two places the implementation goes beyond the
  written item -- the reaper rescuing an object that exists instead of deleting
  its row, and `/api/upload/confirm` returning 200 where it used to 404 -- are a
  superset of the ask and the PLAN's own words respectively, recorded under
  Decisions rather than as changes to the contract. Still `plan_version: 4`.

  **Nothing pushed to `origin`.** Spawning link 6 for phase 6.
- 2026-08-01T18:40:00Z [link 6] phase 6 complete -- **and the chain with it.**
  Branch `chain/p6-cleanup`, seven commits, merged to **local `main`**.
  Tests 267 -> **413 pass, 0 fail**. `bun run verify` exits 0.

  **6a, the riskiest item in the chain, done in the order the PLAN demanded.**
  The tests came first and the git history proves it: `43519ab` and `5040634`
  are 84 route-level tests written and run GREEN against the untouched
  340-line router; `71f315c` is the rewrite, which passed them unchanged.

  They drive the REAL handlers rather than recording doubles, deliberately: a
  double answers "was this handler called" while quietly passing "was it called
  with the right inbox, the right sub-path, the right URL", which is exactly
  what a dispatch rewrite gets wrong.

  | Was | Is |
  |---|---|
  | 487 lines, sequential `path.match(/regex/)` | 237 lines, two ordered route tables |
  | write-permission-plus-scope pasted inline 4x | one `requireWriteScope`, named per route |
  | `addHeaders(res, corsHeaders)` at ~20 returns | stamped once on the way out |
  | ~50 lines of listing SQL inside the dispatcher | `src/api/admin-lists.ts` |

  New files: `api/match.ts` (75), `api/gates.ts` (247), `api/cors.ts` (27),
  `api/admin-lists.ts` (73), `lib/drops.ts` (41). Nothing over 250 lines.

  **The quirks were pinned, not silently corrected.** Method-blind
  `/api/health` and `/api/config`; admin routes matching by `startsWith` so
  `/api/keysfoo` reaches the keys handler; OPTIONS short-circuiting every path;
  and the 401-not-404 ordering. Each has a test whose comment says "this is
  what shipped, not what is right".

  **Mutation-checked, and the check earned its keep.** Seven seeded defects:
  ignoring the HTTP method 6 failures, dropping the scope check 7, skipping the
  CORS stamp 1, not burning a rate-limit token 2, never consulting the tier-2
  table 25, dropping the inbox sub-path 2 -- and **one survivor**: removing the
  empty-capture guard from `segments()` broke nothing any test could see, while
  really changing `POST /api/drop/` from 404 to 400. Closed with
  `test/match.test.ts` plus a route-level pin (`a34c500`), both verified against
  the PRE-rewrite router as well, so they pin shipped behavior rather than the
  rewrite's opinion.

  **A real security hole came out of the consolidation** and is fixed:
  `/api/send/:inbox`, `/api/compose/:inbox` and `/api/send/presign/:inbox`
  checked write permission but never `inbox_scope`. `:inbox` becomes the From
  address, so a key scoped to `bob` could send DKIM-signed mail as `lisa@`.
  Phase 1's finding 1f fixed this class for the drop and upload paths and never
  reached these three. RED first: 8 failures, including one asserting no mail
  was sent -- it was. The fix is a deletion: the one-off gate carrying the short
  check is gone, so there is no longer a variant that can drift (`00db531`).

  **6b -- the regexes were worse than untidy.**
  `<Part>\s*<PartNumber>(\d+)</PartNumber>\s*.*?<ETag>(.+?)</ETag>\s*.*?</Part>`
  required `PartNumber` before `ETag` (S3 promises no order -- the other order
  returned zero parts and failed the whole completion), walked through
  `</Part>` under the `s` flag (a part missing its ETag borrowed its
  neighbour's, completing an upload against bytes that were not there), and
  matched nothing if written `<Part >`. `<UploadId>(.+?)</UploadId>` would read
  an id out of an `<Error>` body. `src/lib/xml.ts` + `s3-xml.ts` replace both
  with a strict reader that fails closed; 45 tests, mutation-checked five ways.

  **6c** -- the OAuth client JSON is out of the working directory. **6d** --
  raised in the review ticket, not answered. **6e** -- CLAUDE.md updated, and
  the update turned up docs that were not merely stale: the presigned-upload
  section had the inbox in the request body, snake_case field names and a
  `parts` array on `/api/upload/complete`, none of which the API has ever
  accepted.

  **Honest limitations.** (1) Nothing is deployed and nothing was verified
  against the live platform; all three DEPLOY GATE items still stand and are
  collected in the review ticket. (2) The R2 -> queue -> consumer delivery has
  still never run for real (phase 5's note stands unchanged). (3) The route
  suite exercises the real handlers but stubs `fetch`, R2 and the EMAIL
  binding, so it proves dispatch and authorization, not R2's or Cloudflare's
  side of any contract. (4) CLAUDE.md remains **untracked**, so every doc
  change from phases 3-6 lives only in this working copy.

  **Nothing pushed to `origin`.** Chain complete -- no link 7.
