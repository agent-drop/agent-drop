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
