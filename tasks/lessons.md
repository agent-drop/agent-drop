# Lessons

## Authentication-Results Trust

- Treat email authentication verdicts as trusted only inside the platform-defined trust boundary.
- Follow Cloudflare's documented rule exactly: inspect the first `Authentication-Results` field and require the `mx.cloudflare.net` authentication service identifier.
- Store untrusted or malformed results as absent rather than attaching trustworthy-looking verdict fields that downstream agents may consume incorrectly.
# Lessons

## Security Audit Scoping

- Separate exploitable authorization or trust-boundary defects from hardening, correctness bugs, test assurance, and maintenance work.
- Verify platform retry ceilings and documented API semantics before projecting worst-case impact.
- Prefer the smallest mitigation that closes the demonstrated exploit while preserving documented features.
- State prerequisites and practical impact when assigning severity; do not rate a chained worst case as the default case.
- Inspect open issues and pull requests before replacing a public security fix. Use `Closes` only when the proposed PR fully resolves that issue; use non-closing cross-references for partial or superseding work.
