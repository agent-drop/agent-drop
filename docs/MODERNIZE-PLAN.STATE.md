---
chain_id: modernize-20260801-161212-5998
plan_file: /Users/jonas/projects/agent-drop/docs/MODERNIZE-PLAN.md
plan_version: 3
status: in_progress
current_phase: 4
last_updated: 2026-08-01T14:05:00Z
link_count: 3
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
- Phase 6d: deleting the SES fallback is a user decision, not the chain's.
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
