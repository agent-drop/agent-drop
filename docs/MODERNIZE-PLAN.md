---
version: 3
created: 2026-08-01
---

# Agent Drop modernization plan

## GOAL

Bring the agent-drop worker from "works, but drifting" to current: close the five
security gaps found in the 2026-08-01 audit, put a real safety net under the
codebase (typechecked frontend, linter, CI, tests on the pure functions that
silently misroute mail), then adopt the Cloudflare platform features that let us
delete hand-rolled infrastructure -- `EmailMessageBuilder` instead of a bespoke
MIME assembler, `@cloudflare/vite-plugin` instead of a two-step build plus a dev
proxy hack, R2 event notifications instead of a client-driven upload handshake,
and the D1 Sessions API on read paths. Finish with the structural cleanup that
those changes make cheap.

The dependency and compatibility-date sweep that motivated this plan is ALREADY
DONE and merged (local `main`, commit `1ba9671`). This plan starts from there.

## Context a link cannot get anywhere else

**Read this before touching anything.** No link ever sees the conversation that
produced this plan, so everything material is written down here.

- Repo: `/Users/jonas/projects/agent-drop`. Cloudflare Worker + D1 + R2 + Queues,
  Vite/React SPA in `web/`, Bun CLI in `tools/agent-drop.ts`.
- `CLAUDE.md` at the repo root is the authoritative description of the system
  (endpoints, auth methods, rules engine, relay, hosting). Read it first.
- **`origin` is a PUBLIC GitHub repo** (`agent-drop/agent-drop`, visibility
  PUBLIC). Local `main` is currently 4 commits ahead of `origin/main`.
- **DO NOT `git push` to `origin` at any point in this chain.** Not in any phase,
  not at completion. Integration is to **LOCAL `main`** only. Jonas pushes when he
  chooses. Two reasons: pushing to a public repo is a publication event nobody
  authorized, and this plan documents live unpatched security holes -- it must not
  become public before phase 1 lands. If a phase's work feels like it needs to be
  on origin, it does not; stop and leave it local.
- No git worktree is used. Chain links work directly in the primary tree on a
  per-phase branch and merge into local `main`. Rationale: a worktree cannot merge
  into a `main` that is checked out in the primary dir, and the protocol's usual
  escape hatch (`git push origin HEAD:main`) is forbidden here. Sequential phases
  in one tree is the correct shape for this chain.
- Task board: `.rclaude/project/` (use `mcp__rclaude__project_list` /
  `mcp__rclaude__project_set_status`). All status folders exist and are empty.

### Green gate (the verify command every phase must pass)

```bash
bun run verify
```

which is defined in `package.json` as:

```
bun run check && bunx vite build && bun scripts/deploy.ts --dry-run --outdir .claude/temp/dryrun
```

`bun run check` is `bun run types && bun run typecheck && bun test`, where `types`
regenerates `worker-configuration.d.ts` from `wrangler.toml`. A phase is NOT done
until `bun run verify` exits clean. Clean up `.claude/temp/dryrun` afterwards.

### Baseline established by the pre-chain sweep (commit `1ba9671`)

Do not redo any of this; it is already merged:

- TypeScript 6 -> 7.0.2, wrangler 4.95 -> 4.118, vite 8.0 -> 8.2, chalk 5 -> 6,
  `@types/node` 25 -> 26, react/react-dom 19.2.8, react-router-dom 7.18.2,
  tailwind 4.3.3, postal-mime 2.7.5. `bun outdated` is empty.
- `@cloudflare/workers-types` removed; runtime types now come from
  `wrangler types --include-env false ./worker-configuration.d.ts`. `src/types.ts`
  remains the hand-maintained `Env` source of truth.
- `compatibility_date` 2026-03-15 -> 2026-07-30, and `[observability]` added to
  `wrangler.toml` (it was missing entirely, so Workers Logs retained nothing).
- `bun.lock` is now committed (it was gitignored, so builds were not reproducible).
- `src/lib/id.ts` entropy bug fixed: `generateId()` drew 16 random chars from a
  10-byte pool via `rand[i % 10]`, so tail chars 11-16 were byte-for-byte copies of
  chars 1-6 in every id. Regression test in `test/id.test.ts`.
- `src/lib/ses.ts` deleted (zero callers).
- `react`/`react-dom`/`react-router-dom` moved to `dependencies`.

## SPEC & ACCEPTANCE CRITERIA

### References

- Cloudflare Email Service, Workers API (`EmailMessageBuilder`):
  https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
  There is also an installed skill `cloudflare-email-service` -- use it.
- Cloudflare Vite plugin: https://developers.cloudflare.com/workers/vite-plugin/
  `@cloudflare/vite-plugin@1.50.0`, peer-deps `vite ^8` + `wrangler ^4.118`.
- Workers Rate Limiting binding (GA since 2025-09-19, `[[ratelimits]]` key,
  requires wrangler >= 4.36):
  https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- R2 event notifications:
  https://developers.cloudflare.com/r2/buckets/event-notifications/
- D1 global read replication / Sessions API:
  https://developers.cloudflare.com/d1/best-practices/read-replication/
- Biome (the project's chosen linter/formatter per the user's global stack).
- There is an installed skill `cloudflare` for general CF platform questions.

### Hard requirements, in the user's words

- "run full sweep package updates, outdated things, etc. etc." -- DONE pre-chain.
- "run a heuristic and see where we are with the cues the API's things that we can
  upgrade new features available. Basically how do we modernize the currents set
  up?" -- this plan is the answer; the chain executes it.
- "FULL PLAN DELIVERY!" + "use chain protocol to get everything done" -- every
  phase below ships, not just the cheap ones. Partial delivery is failure.

### Acceptance criteria

- Every phase ends with `bun run verify` green and the work merged into local
  `main`.
- Every code change ships with tests in the SAME phase. Tests deferred to a later
  phase is not acceptable.
- Security fixes (phase 1) are backed by regression tests that FAIL before the fix
  and PASS after. Demonstrate the RED explicitly in the phase log.
- Outbound email must be provably unbroken after phase 3. The CLI's existing
  `send-email --dry-run` is the comparison harness: assemble the same input under
  old and new code paths and diff the result. Do not mark phase 3 done on "it
  compiles".
- No phase may leave `main` red.

### Explicit non-negotiables / out-of-scope

- **NO `git push origin`.** See Context above. Local `main` only.
- **Do not delete the SES fallback** (`sendRawEmail` in `src/lib/relay.ts:297`)
  without an explicit user decision. It is dead code but deliberately kept as a
  revert path, and removing it also retires an AWS IAM user, two secrets, the DKIM
  CNAMEs, the MAIL FROM MX record and the SPF include. Phase 6 raises the question;
  it does not answer it unilaterally.
- `aws4fetch` stays regardless -- R2 presigning needs it.
- Do not change the public API surface (endpoint paths, request/response shapes)
  except where a phase explicitly says so. Agents and the CLI depend on it.
- Do not touch `.claude/` in commits (project-local tooling, never tracked).
- No `Co-Authored-By` or attribution trailers in any commit.
- Do not commit `client_secret_*.json` (already gitignored).

## PHASES

### Phase 1 -- Close the security holes

Five findings from the audit. Each gets a regression test that is RED before the
fix.

1. **`/api/upload/complete` and `/api/upload/confirm` are unauthenticated.**
   `src/api/upload.ts` `handleMultipartComplete` (line ~178) and `handleConfirm`
   (line ~247). `src/api/router.ts` dispatches both with the comment "Complete
   doesn't need inbox-level auth - the dropId was already authenticated at
   presign", which is false: nothing re-checks the caller. Fix: look up the drop
   row, recover its `inbox`, and re-run the router's existing
   `authenticateWrite(inbox)` helper. No new DB column; the client already holds
   whatever credential it used at presign.
2. **`handleMultipartComplete` trusts a client-supplied `objectKey`.** It accepts
   `dropId` AND `objectKey` in the body and never checks they belong to the same
   row, so a caller holding any valid drop id can complete a multipart upload
   against an arbitrary R2 key and flip an unrelated drop to `completed`. Fix:
   stop accepting `objectKey` from the client; derive it from the row's
   `r2_prefix`. If the stored row does not carry enough to reconstruct the key,
   persist the key at presign time (migration `0008`) rather than trusting input.
3. **`isAdmin()` is a variable-time compare on the master credential.**
   `src/lib/auth.ts` (line ~48) does
   `auth === \`Bearer ${env.ADMIN_API_KEY}\``. Fix: SHA-256 both sides and compare
   digests. `hashKey()` already exists in that file.
4. **No rate limiting anywhere.** Add the `[[ratelimits]]` binding to
   `wrangler.toml` and apply it to (a) failed authentication attempts, keyed by
   `CF-Connecting-IP`, and (b) the drop-token upload endpoints. NOTE IN CODE AND
   IN THE PR: the binding is per-colo, not global -- it throttles abuse, it is not
   a hard quota. Do not describe it as one.
5. **`Access-Control-Allow-Origin: *` on every response, including admin routes.**
   `src/api/router.ts` `corsHeaders` (line ~25). Admin routes are CLI-driven and
   need no CORS headers at all. Web-reachable routes (`/api/config`,
   `/api/drop/*`, `/api/upload/*`) get the real origin from `env.DOMAIN`, not `*`.

**verify:** `bun run verify`, plus the new regression tests must exist and pass,
and the phase log must record that each was RED first.

**artifacts:** `src/api/upload.ts`, `src/lib/auth.ts`, `src/api/router.ts`,
`wrangler.toml`, possibly `migrations/0008_*.sql`, new tests under `test/`.

### Phase 2 -- Safety net: typecheck the frontend, lint, CI, tests

Blocks phases 3 and 4 -- do not refactor the mail path without this in place.

1. **`web/` has never been typechecked.** Root `tsconfig.json` excludes it, and
   while `web/tsconfig.json` DOES exist (since the initial commit), no script
   ever invokes it -- so the entire React frontend is unchecked in practice and
   `vite build` will happily ship type errors. Wire it into `bun run typecheck`.
   UNKNOWN QUANTITY: this may surface anywhere from 0 to dozens of errors. Fix
   them all; that is part of this phase, not a follow-up. Fold `test/` in too
   (see the phase-1 handover note on the ticket).
2. **Add Biome** (format + lint) with a config matching the existing style: tabs,
   double quotes. Run it, fix what it flags, add `bun run lint` and fold it into
   `bun run check`.
3. **Add CI** (`.github/workflows/ci.yml`): `bun install --frozen-lockfile`,
   `wrangler types --check`, typecheck, biome, `bun test`, `vite build`,
   `wrangler deploy --dry-run`. The `types --check` step is what catches
   wrangler.toml/type drift.
4. **Test the pure functions that silently misroute mail**, in priority order:
   - `src/lib/rules.ts` -- pattern matching (`*`, `lisa`, `shop-*`, `*-invoices`)
     and template-variable substitution (`{inbox}`, `{name}`, `{topic}`, `{from}`,
     `{subject}`, `{drop_id}`, `{channel}`). A bug here forwards mail to the wrong
     address and nothing errors. Cascading (ALL matching rules fire) must be
     covered.
   - `src/lib/relay.ts` -- `encodeEmail` / `decodeEmail` / `buildRelayAddress` /
     `parseRelayAddress` / `isRelayReply`. A bug here breaks mask reply routing or
     leaks the real address. Round-trip properties are the obvious test.
   - `src/lib/normalize.ts` -- `normalizeInbox` (dots stripped, underscores to
     hyphens, must start with a letter, max 64) and `slugifyFilename` (unicode
     romanization: `Z Profile.jpg` -> `z-profile.jpg`, `résumé.docx` ->
     `resume.docx`, `Ärende Ö.pdf` -> `arende-o.pdf`).
   - `src/lib/hosting.ts` -- `normalizeSite` and path-traversal safety.

**verify:** `bun run verify` (now including web typecheck + lint), CI workflow
present and its steps runnable locally.

**artifacts:** `web/tsconfig.json`, `biome.json`, `.github/workflows/ci.yml`,
tests under `test/`, updated `package.json` scripts.

### Phase 3 -- Migrate outbound mail to `EmailMessageBuilder`

The largest code deletion available, and the fiddliest correctness risk. Do not
start this before phase 2 is merged.

`env.EMAIL.send()` now accepts a structured builder:
`{to, cc, bcc, replyTo, subject, text, html, attachments, headers}`, where
`to`/`cc`/`bcc` take arrays (max 50 combined) and attachments support base64
content plus `contentId` for inline images. This replaces the hand-rolled MIME
assembler in `src/lib/relay.ts`: `b64` (line ~78), `wrap76` (~83),
`encodeHeaderWord` (~88), `renderPart` (~98), `leafText` (~102),
`leafAttachment` (~110), `multipart` (~125), `buildRawEmail` (~136),
`bytesToBase64` (~207) -- roughly 130 lines.

**CORRECTION (v3, found while executing the phase): none of those ~130 lines can
actually be deleted, and the "attachments support base64 content" line above is
wrong for the Workers binding.** `enqueueRelay` calls `buildRawEmail` to assemble
the message it puts on the queue, and `processRelayMessage` -- which this same
phase mandates STAYS ON RAW -- replays it, so the whole assembler tree keeps a
live caller regardless of what the send path does. Phase 3's win is therefore not
deletion; it is that the assembler stops being on the *send* path. Relocate it to
`src/lib/mime.ts` so the boundary between "the platform assembles this" and "we
still assemble this" is legible in the file layout, and so `relay.ts` drops back
under the 200-line hygiene limit. On attachments: `EmailAttachment.content` takes
`string | ArrayBuffer | ArrayBufferView`, and a **string is RAW content, not
base64** -- handing it base64 attaches the base64 text.

**This is NOT a clean sweep of all three call sites. Get this right:**

- `src/api/send.ts:172` (compose / `POST /api/send/:name`) -> migrates cleanly to
  the builder. This is the main win: multi-recipient becomes ONE send instead of
  the current N-sends loop in `sendRawViaBinding` (`src/lib/relay.ts:273`).
- `src/lib/relay.ts:248` (`forwardViaBinding`) -> constructs a NEW message
  wrapping the original body and re-attaches the original attachments, so it
  *probably* migrates. VERIFY that attachment re-encoding survives the builder
  before committing to it. If it does not, leave this call site on raw and say so
  in STATE.
- `src/lib/relay.ts:395` (`processRelayMessage`, the relay queue consumer) ->
  **STAYS ON RAW.** It replays a stored raw MIME string (`relay.rawEmail`); that is
  exactly what the legacy raw `EmailMessage` API is for. `sendRawViaBinding`
  survives in reduced form for this path.

Constraints to respect and to encode as validation: 50 combined recipients, 16KB
total headers, max 20 non-`X-` headers.

Also update the stale comment at `src/lib/relay.ts:269` which claims "the legacy
EmailMessage envelope is single-recipient" -- that is no longer true of the
builder API.

**verify:** `bun run verify`, PLUS a differential check: use the CLI's existing
`drop send-email --dry-run` to assemble a representative set of messages (plain
text; text+html; html with an inline `cid:` image; a regular attachment; multiple
to/cc/bcc; `+addressing` topic; `--in-reply-to` threading) under the old and new
code paths and diff. Record the diff summary in STATE. Do not mark done on "it
compiles".

**artifacts:** `src/lib/relay.ts`, `src/api/send.ts`, tests under `test/`.

### Phase 4 -- Dev loop: `@cloudflare/vite-plugin`

Adopt `@cloudflare/vite-plugin@1.50` (peer-deps `vite ^8` + `wrangler ^4.118`,
which the pre-chain sweep already satisfies). It collapses the
`vite build` -> separate `wrangler deploy` two-step and removes the
`server.proxy: { "/api": "http://localhost:8787" }` hack in `vite.config.ts`, so
`vite dev` runs the real Workers runtime with live D1/R2/Queue bindings.

**Two custom pieces in that build path MUST keep working:**

- The `brand-html` plugin in `vite.config.ts` -- a `transformIndexHtml` hook that
  substitutes `%BRAND%` / `%DOMAIN%` tokens, plus the `define` block injecting
  `__BRAND__` / `__DOMAIN__`. Both come from `.env` via `loadEnv`.
- `scripts/deploy.ts` -- renders the placeholder values in the committed
  `wrangler.toml` (`example.com`, `your-cloudflare-account-id`,
  `your-d1-database-id`, `your-google-client-id`) from `.env` into a gitignored
  temp config before invoking wrangler. The committed `wrangler.toml` must keep
  carrying only placeholders; the public repo leaks no real domain or account id.

Known upstream regression: the plugin does not work with Vite's `base` option for
SPAs. This project does not set `base`, so it does not apply -- but do not
introduce one.

If the plugin cannot be made to coexist with the `.env` placeholder-rendering
deploy flow, STOP, log why in STATE, notify, and leave the current build in place.
A working two-step build beats a broken one-step build.

**verify:** `bun run verify`, plus `vite dev` starts and serves the SPA with a
working `/api/health` against real bindings, plus `bun run deploy` still renders
placeholders correctly (check with `--dry-run` that `env.DOMAIN` resolves to the
real domain and the committed `wrangler.toml` is unchanged on disk afterwards).

**artifacts:** `vite.config.ts`, `package.json`, possibly `scripts/deploy.ts`.

### Phase 5 -- Platform optimizations

Four independent changes. Any that proves harder than expected can be logged and
deferred to phase 6 rather than blocking, but say so explicitly in STATE.

1. **`ctx.waitUntil` on the `last_used_at` write.** `src/lib/auth.ts`
   `validateApiKey` awaits `UPDATE api_keys SET last_used_at = ?` on EVERY request,
   putting a serialized D1 write in the critical path of every read. Thread the
   `ExecutionContext` (the router already has it) and defer the write. ~10 lines.
2. **R2 event notifications to retire the `/api/upload/confirm` handshake.**
   Configure a notification rule on the `agent-drop-storage` bucket for object
   creation under `drops/`, delivered to a queue; the consumer flips the drop from
   `pending` to `completed`. Keep `/api/upload/confirm` as a back-compat no-op
   (the SPA and CLI call it) but stop depending on it. Today a client that uploads
   and then crashes leaves the drop `pending` forever.
3. **Cron trigger to reap stale `pending` drops.** There is currently NO cron
   trigger and NO reaper anywhere in the codebase. Item 2 fixes uploads that land;
   this catches presigns that were never uploaded at all. Add `[triggers] crons`,
   a `scheduled` handler in `src/index.ts`, and a policy (suggested: `pending`
   older than 24h with no R2 object -> delete the row; log the count).
4. **D1 Sessions API on read paths.** Use `env.DB.withSession()` on the read-heavy
   handlers -- `GET /api/inbox/*` (`src/api/inbox.ts`), `GET /api/drops` and
   `GET /api/boxes` (`src/api/router.ts`), and the hosted-site lookup in
   `src/lib/hosting.ts`. Writes keep `withSession("first-primary")`. Free, no infra
   change, real latency win outside EU.

**verify:** `bun run verify`, plus tests for the reaper's selection policy and for
the queue consumer's status transition. The R2 notification rule itself is bucket
config, not code -- document the exact `wrangler r2 bucket notification` command in
`CLAUDE.md` alongside the existing lifecycle/CORS reproduction commands.

**artifacts:** `src/lib/auth.ts`, `src/index.ts`, `wrangler.toml`,
`src/api/inbox.ts`, `src/api/router.ts`, `src/lib/hosting.ts`, `CLAUDE.md`, tests.

### Phase 6 -- Structural cleanup + final docs

1. **Router.** `src/api/router.ts` is 340 lines of sequential `path.match(/regex/)`
   with the write-scope check duplicated inline four times. Rewrite using
   `URLPattern` (now in the Workers runtime) or a small table-driven dispatch.
   Behavior must be identical -- this is the phase most at risk of silently
   changing the API surface, so it needs route-level tests written FIRST against
   the current behavior, then the rewrite made to pass them.
2. **Replace regex XML parsing in `src/api/upload.ts`** -- it scrapes `<UploadId>`
   and part/ETag pairs out of S3 responses with regexes. Use a real parse.
3. **Move `client_secret_*.json` out of the repo root** to `~/.secrets`. It is
   gitignored so nothing leaked, but a live OAuth client secret should not sit in a
   working directory. Update `.env.example` / `CLAUDE.md` if they reference it.
4. **Raise the SES-fallback question with the user, do not answer it.**
   `sendRawEmail` in `src/lib/relay.ts:297` is dead but deliberately kept as a
   revert path. Deleting it also retires the AWS IAM user, `AWS_ACCESS_KEY_ID` /
   `AWS_SECRET_ACCESS_KEY`, the DKIM CNAMEs, the MAIL FROM MX and the SPF include.
   Surface it in the final review ticket as a decision for Jonas.
5. **Update `CLAUDE.md`** to match everything this chain changed: the new scripts,
   the CI workflow, the email send path, the build setup, the reaper, the R2
   notification config, and the security model of the upload endpoints.

**verify:** `bun run verify`, plus route-level tests proving the router rewrite is
behavior-identical.

**artifacts:** `src/api/router.ts`, `src/api/upload.ts`, `CLAUDE.md`, tests.

## Changelog

### v3 -- 2026-08-01 -- author: link 3

- Phase 3: "this replaces the hand-rolled MIME assembler ... roughly 130 lines"
  -> "none of those ~130 lines can be deleted; the win is that the assembler
  leaves the SEND path". Factual correction found while executing the phase:
  `enqueueRelay` builds the queued message with `buildRawEmail`, and
  `processRelayMessage` -- which this very phase mandates stays on raw -- replays
  it, so the assembler always keeps a live caller. Added the relocation to
  `src/lib/mime.ts` as the concrete deliverable in place of the deletion.
- Phase 3: "attachments support base64 content" -> corrected. The Workers
  binding's `EmailAttachment.content` treats a **string as RAW content**, so
  base64 would be attached verbatim as text. Attachments now travel as bytes.
- No GOAL, requirement, or acceptance-criterion change. The phase's success
  criteria and its differential-check gate are untouched.

### v2 -- 2026-08-01 -- author: link 2

- Phase 2 item 1: "there is no `web/tsconfig.json`" -> "`web/tsconfig.json` DOES
  exist (since the initial commit) but no script invokes it". Factual
  correction, found while executing the phase. Nothing about the required work
  changes -- the frontend was still effectively unchecked, and wiring it into
  `bun run typecheck` was and is the deliverable. Also made explicit that `test/`
  is folded in alongside it, which was only recorded on the phase ticket before.
- No GOAL, requirement, or acceptance-criterion change.

### v1 -- 2026-08-01 -- author: user + link 0

- Initial plan, drafted from the 2026-08-01 dependency sweep and modernization
  audit and approved by the user ("FULL PLAN DELIVERY! ... GO!").
- Records the pre-chain baseline (commit `1ba9671`) so no phase redoes it.
- Two decisions locked at drafting time and written into SPEC as non-negotiable:
  no `git push origin` anywhere in this chain (public repo, unpatched holes
  documented here), and no git worktree (a worktree cannot merge into a
  checked-out `main`, and the usual `push origin HEAD:main` escape hatch is
  forbidden).
