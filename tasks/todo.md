# Issue #3: Trusted Inbound Sender Authentication

## Plan

- [x] Confirm the live issue, closed PR #4, upstream base, and Cloudflare's current trust contract.
- [x] Record the current typecheck, lint, and test baseline.
- [x] Parse only the first `Authentication-Results` field.
- [x] Accept verdicts only when the parsed authentication service identifier is exactly `mx.cloudflare.net`.
- [x] Store trusted SPF, DKIM, and DMARC verdicts under `metadata.sender_auth` without changing delivery behavior.
- [x] Add parser tests for trusted, missing, malformed, and forged headers.
- [x] Add ingest tests proving trusted results reach D1 and untrusted results are stored as `null`.
- [x] Run focused tests, typecheck, lint, the full suite, build, and deployment dry run.
- [x] Review the final diff for secrets and unrelated changes.

## Design Decision

Cloudflare Email Routing prepends its own `Authentication-Results` field before invoking the Worker. The result is trusted only when that first field names `mx.cloudflare.net` as its authentication service. A missing, malformed, later, or differently sourced result fails closed to `null`; it is never promoted into trusted sender-authentication metadata.

The change records evidence for consumers but does not reject, quarantine, or otherwise change delivery. Consumers can decide which combination of SPF, DKIM, and DMARC results their workflow requires.

## Review

Baseline: typecheck passes; lint has only the existing `useTemplate` information and unused `NOW` warning; 734 tests pass with 4,460 assertions and no failures across 34 files.

Implemented on a fresh branch from `origin/main` at `f84f4ae`:

- The first physical field is selected from PostalMime's ordered header list; the Fetch `Headers.get()` path is not used because it combines repeated fields.
- The parser requires the exact, case-sensitive authentication service identifier `mx.cloudflare.net` and fails malformed, untrusted, or oversized input closed to `null`.
- SPF, DKIM, and DMARC results are stored as ordered arrays so repeated method results are not silently discarded.
- The RFC 5322 `From` header is recorded separately from the SMTP envelope sender already stored in `from_addr`.
- Delivery, rejection, routing, and storage behavior are otherwise unchanged. Existing metadata consumers gain two additive fields; strict consumers that reject unknown JSON fields should allow `from_header` and `sender_auth` before rollout.

Verification:

- Focused sender-auth tests: 20 passed, 26 assertions, 0 failed.
- Full suite: 754 passed, 4,486 assertions, 0 failed across 35 files.
- TypeScript: `bun run typecheck` passed.
- Lint: `bun run lint` passed with only the two baseline findings.
- Production build: passed with synthetic deployment identity.
- Wrangler deployment dry run: passed with synthetic deployment identity; no deployment occurred.
- Staged diff check: passed.
- Targeted credential and private-key scan: no matches.

## Publication Gate

Public release remains subject to showing the exact branch, commits, and pull-request text to the user and receiving explicit approval before the branch is pushed or the pull request is opened. The pull request must include `Closes #3`.
# Security Hardening Plan

## Status

- [x] Inventory routes, bindings, storage namespaces, and trust boundaries.
- [x] Run the existing typecheck, lint, and test baseline.
- [x] Audit authentication, authorization, uploads, hosting, webhooks, relay, browser storage, CI, and dependencies.
- [x] Confirm high-impact findings with source evidence and focused probes.
- [x] Reconcile the initial assessment with the counter-assessment and reduce scope.
- [x] Document every finding, correction, fix, and compatibility implication.
- [x] Obtain approval for the revised three-PR plan before implementation.
- [x] Implement PR 1: API boundaries and bounded input.
- [x] Implement PR 2: hosted-content origin isolation.
- [x] Implement PR 3: authenticated relay reply routes and retry correctness.
- [x] Run focused regressions and the full verification suite on every branch.
- [x] Show exact commits and PR text for explicit approval.
- [ ] Only after approval, push branches and create public PRs.

## Baseline

- TypeScript passes after the frozen Bun install restored declared packages.
- Biome passes with one pre-existing warning and one informational finding.
- Tests: 734 pass, 0 fail.
- Dependency audit: 33 advisories in development/build tooling; not deployed Worker-runtime findings.
- Pre-existing untracked `.claude/` files remain untouched.
- `.env` and Google client-secret JSON are ignored and untracked.

## Approved Scope

### PR 1: Close API Boundaries and Bound Input

- [x] Restrict outbound R2 reads and cleanup to `outbound/temp/{inbox}/`.
- [x] Filter `/api/drops` and `/api/boxes` for scoped admin keys.
- [x] Validate multipart `fileSize` before R2 initialization or signing.
- [x] Cap webhook bodies while streaming.
- [x] Preserve direct multipart and URL attachments with explicit memory budgets.
- [x] Mark private hosted responses `private, no-store`.
- [x] Increase generated webhook suffix entropy without banning exact slugs.
- [x] Scope `inReplyTo` lookup to the sending inbox.
- [x] Validate API-key permission values and scopes.
- [x] Fail malformed Google tokens closed.
- [x] Reject control characters in header-derived fields.
- [x] Add focused regression tests.

### PR 2: Isolate Hosted Content

- [x] Add and document `HOST_DOMAIN`.
- [x] Generate hosted URLs on the dedicated host.
- [x] Redirect legacy application-origin `/f/*` URLs with path and query preserved.
- [x] Serve active hosted content only on `HOST_DOMAIN`.
- [x] Add routing and origin-isolation tests.

### PR 3: Authenticate Relay Reply Routes

- [x] Replace forgeable sender-bearing reply routes with 130-bit opaque route tokens.
- [x] Keep routes non-expiring and reusable so old messages remain replyable.
- [x] Define a bounded opt-in transition for unsigned legacy reply addresses.
- [x] Use `msg.attempts` for relay logs and exponential backoff.
- [x] Align queue retry count with the documented retry window.
- [x] Add forgery, compatibility, local-part, and retry-ladder tests.

## Explicitly Out of Security Scope

- Requiring lease IDs for queue mutation.
- Removing direct multipart upload or remote URL attachments.
- Refusing deliberate exact webhook slugs.
- Hashing private hosted-site tokens in this pass.
- Replacing the existing comparison helper.
- Broad SPA CSP and browser-header work.
- A new workerd integration suite.
- Worker binding type generation.
- Dependency and GitHub Action upgrades, which belong in maintenance PRs.

## Verification Gates

- [x] Focused regressions demonstrate that each changed exploit or failure mode is closed.
- [x] `bun run typecheck` passes.
- [x] `bun run lint` introduces no new findings.
- [x] `bun test` passes.
- [x] Production build succeeds.
- [x] Deployment dry run succeeds using placeholder configuration.
- [x] Final diffs contain no secrets, local files, or unrelated changes.

## Review

The initial seven-PR proposal was too broad. The revised plan preserves documented behavior, limits compatibility changes to real trust-boundary corrections, and separates security work from maintenance and assurance improvements.

### PR 1 Result

- Thirteen focused fix commits close the approved API-boundary and bounded-input findings without removing direct multipart uploads, drop-token uploads, remote URL attachments, exact webhook slugs, or private hosted links.
- Focused regressions and the full suite pass: 784 tests, 4,635 assertions, 0 failures across 38 files.
- Typecheck, production build, and deployment dry run pass.
- Lint reports only the pre-existing unused `NOW` warning and `useTemplate` informational finding.
- The final tracked diff contains no secrets, generated build output, local files, or unrelated changes. Pre-existing untracked `.claude/` files remain untouched.

### PR 2 Result

- Hosted content is served only from a required, distinct `HOST_DOMAIN`; application-origin `/f/*` requests return a permanent redirect with the full path and query preserved.
- The dedicated host runs the Worker before static assets and returns 404 for every non-hosting path, so uploaded HTML cannot read application-origin credentials while retaining its own storage, relative URLs, and same-origin requests.
- Existing hosted links continue through redirects. Deployment now requires a proxied DNS hostname, a matching Worker route, and `HOST_DOMAIN` configuration before release.
- Focused tests pass, followed by 746 tests, 4,497 assertions, and 0 failures across 35 files. Typecheck, build, and deployment dry run pass; lint has only the baseline findings.
- This branch fully resolves issue #2 and supersedes the hosted-content half of PR #4 without adopting its functionality-breaking CSP sandbox.

### PR 3 Result

- Relay replies use random opaque addresses whose digests, rather than usable tokens, are stored in D1. Guessed or sender-bearing reply routes can no longer relay DKIM-signed mail through the service.
- Non-expiring routes preserve replies to old messages and avoid the email local-part length problem. Existing unsigned reply addresses are rejected by default, with an explicit absolute cutoff available for a bounded transition.
- Queue retries use Cloudflare's immutable delivery-attempt counter, exponential backoff, and a retry budget that reaches the documented 24-hour window without exceeding the platform limit.
- Focused tests pass, followed by 751 tests, 4,518 assertions, and 0 failures across 36 files. Typecheck, build, and deployment dry run pass; lint has only the baseline findings.
- The migration must run before the Worker is deployed. The queue change affects only failed relay delivery timing and retry volume.

### Existing Issues and PR #4

- PR 2 will use `Closes #2`; no other branch fully resolves a currently open issue.
- Issue #3, recording inbound SPF/DKIM/DMARC results, is real but separate from this approved batch and remains open.
- PR #4 combines #2 with #3. Its CSP sandbox would break hosted pages' own storage and same-origin requests, while its email-auth parser needs a separate trust-provenance review. Neither half should be merged as a bundled replacement for these branches.
