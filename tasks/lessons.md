# Lessons

## Security Audit Scoping

- Separate exploitable authorization or trust-boundary defects from hardening, correctness bugs, test assurance, and maintenance work.
- Verify platform retry ceilings and documented API semantics before projecting worst-case impact.
- Prefer the smallest mitigation that closes the demonstrated exploit while preserving documented features.
- State prerequisites and practical impact when assigning severity; do not rate a chained worst case as the default case.
- Inspect open issues and pull requests before replacing a public security fix. Use `Closes` only when the proposed PR fully resolves that issue; use non-closing cross-references for partial or superseding work.
