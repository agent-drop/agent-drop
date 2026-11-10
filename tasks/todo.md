# Issue #3: Trusted Inbound Sender Authentication

## Plan

- [x] Confirm the live issue, closed PR #4, upstream base, and Cloudflare's current trust contract.
- [x] Record the current typecheck, lint, and test baseline.
- [ ] Parse only the first `Authentication-Results` field.
- [ ] Accept verdicts only when the parsed authentication service identifier is exactly `mx.cloudflare.net`.
- [ ] Store trusted SPF, DKIM, and DMARC verdicts under `metadata.sender_auth` without changing delivery behavior.
- [ ] Add parser tests for trusted, missing, malformed, and forged headers.
- [ ] Add ingest tests proving trusted results reach D1 and untrusted results are stored as `null`.
- [ ] Run focused tests, typecheck, lint, the full suite, build, and deployment dry run.
- [ ] Review the final diff for secrets and unrelated changes.
- [ ] Show the exact branch, commit, and pull-request text for explicit approval.
- [ ] Only after approval, push the branch and open the pull request with `Closes #3`.

## Design Decision

Cloudflare Email Routing prepends its own `Authentication-Results` field before invoking the Worker. The result is trusted only when that first field names `mx.cloudflare.net` as its authentication service. A missing, malformed, later, or differently sourced result fails closed to `null`; it is never promoted into trusted sender-authentication metadata.

The change records evidence for consumers but does not reject, quarantine, or otherwise change delivery. Consumers can decide which combination of SPF, DKIM, and DMARC results their workflow requires.

## Review

Baseline: typecheck passes; lint has only the existing `useTemplate` information and unused `NOW` warning; 734 tests pass with 4,460 assertions and no failures across 34 files.
