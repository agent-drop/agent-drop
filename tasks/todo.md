# Security Hardening Plan

## Status

- [x] Inventory routes, bindings, storage namespaces, and trust boundaries.
- [x] Run the existing typecheck, lint, and test baseline.
- [x] Audit authentication, authorization, uploads, hosting, webhooks, relay, browser storage, CI, and dependencies.
- [x] Confirm high-impact findings with source evidence and focused probes.
- [x] Reconcile the initial assessment with the counter-assessment and reduce scope.
- [x] Document every finding, correction, fix, and compatibility implication.
- [x] Obtain approval for the revised three-PR plan before implementation.
- [ ] Implement PR 1: API boundaries and bounded input.
- [ ] Implement PR 2: hosted-content origin isolation.
- [ ] Implement PR 3: authenticated relay reply routes and retry correctness.
- [ ] Run focused regressions and the full verification suite on every branch.
- [ ] Show exact commits and PR text for explicit approval.
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

- [ ] Restrict outbound R2 reads and cleanup to `outbound/temp/{inbox}/`.
- [ ] Filter `/api/drops` and `/api/boxes` for scoped admin keys.
- [ ] Validate multipart `fileSize` before R2 initialization or signing.
- [ ] Cap webhook bodies while streaming.
- [ ] Preserve direct multipart and URL attachments with explicit memory budgets.
- [ ] Mark private hosted responses `private, no-store`.
- [ ] Increase generated webhook suffix entropy without banning exact slugs.
- [ ] Scope `inReplyTo` lookup to the sending inbox.
- [ ] Validate API-key permission values and scopes.
- [ ] Fail malformed Google tokens closed.
- [ ] Reject control characters in header-derived fields.
- [ ] Add focused regression tests.

### PR 2: Isolate Hosted Content

- [ ] Add and document `HOST_DOMAIN`.
- [ ] Generate hosted URLs on the dedicated host.
- [ ] Redirect legacy application-origin `/f/*` URLs with path and query preserved.
- [ ] Serve active hosted content only on `HOST_DOMAIN`.
- [ ] Add routing and origin-isolation tests.

### PR 3: Authenticate Relay Reply Routes

- [ ] Add a versioned relay-address HMAC and dedicated secret.
- [ ] Test RFC local-part limits; use a non-expiring opaque token table only if needed.
- [ ] Define a bounded transition for unsigned legacy reply addresses.
- [ ] Use `msg.attempts` for relay logs and exponential backoff.
- [ ] Align queue retry count with the documented retry window.
- [ ] Add forgery, compatibility, and retry-ladder tests.

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

- [ ] Focused regressions demonstrate that each changed exploit or failure mode is closed.
- [ ] `bun run typecheck` passes.
- [ ] `bun run lint` introduces no new findings.
- [ ] `bun test` passes.
- [ ] Production build succeeds.
- [ ] Deployment dry run succeeds using placeholder configuration.
- [ ] Final diffs contain no secrets, local files, or unrelated changes.

## Review

The initial seven-PR proposal was too broad. The revised plan preserves documented behavior, limits compatibility changes to real trust-boundary corrections, and separates security work from maintenance and assurance improvements.
