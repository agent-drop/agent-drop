# Agent Drop Security Assessment

Status: Revised remediation scope

Date: 2026-11-10

Scope: Worker API, browser application, R2 and D1 boundaries, uploads, hosted sites, webhooks, email relay, queues, dependencies, and CI

## Executive Summary

The counter-assessment is substantially correct: the first plan mixed exploitable security defects, small hardening improvements, correctness bugs, and general engineering hygiene. Treating all of them as security work produced an unnecessarily large seven-PR plan.

Four authorization and trust-boundary defects should be fixed first:

1. Hosted JavaScript runs on the application origin.
2. Caller-controlled outbound `r2Key` values bypass inbox boundaries.
3. Relay reply addresses can be forged into an open-relay primitive.
4. Scoped admin keys can read global listings.

There are also three credible availability defects worth fixing in the same compact pass: unvalidated multipart sizes, webhook bodies buffered before their configured cap, and unbounded outbound attachment buffering. The remaining confirmed issues are small validation or caching corrections.

The revised recommendation is three PRs, not seven:

1. API authorization, validation, and bounded-input fixes.
2. Hosted-content origin isolation with legacy redirects.
3. Relay-address authentication plus the related retry correctness fix.

This document separates confirmed vulnerabilities from hardening, reliability, and test-infrastructure work. It does not claim that any fix has been implemented.

## Fix Now

### 1. Hosted Content Shares the Application Origin

Severity: High; potentially critical when a persistent privileged API key is present

#### Vulnerability summary

Agent Drop serves user-controlled HTML, JavaScript, and SVG from `/f/{box}/{site}/` on the application origin. The SPA reads `agent-drop-key` from same-origin `localStorage` and stores the Google ID token there.

#### How it works

A scoped writer publishes a site containing JavaScript and convinces an authenticated user to visit it. The browser treats that script as application-origin code, so it can read the Google token and any API key stored under the supported key name. It can also make same-origin API requests with those credentials. CORS does not protect same-origin requests.

The default impact is lower than originally stated because the UI does not itself write `agent-drop-key`, and the Google token is short-lived and accepted only by write routes. The origin boundary is still broken.

Evidence: `src/lib/hosting.ts`, `src/index.ts:19-24`, and `web/src/components/InboxView.tsx:34-47`.

#### Fix

- Add a dedicated `HOST_DOMAIN` for hosted content.
- Serve active hosted content only on that host.
- Redirect legacy application-origin `/f/*` URLs to the equivalent hosted-domain URL, preserving path and query string. Use a non-cacheable temporary redirect during rollout and switch to a permanent redirect only after DNS and routing are verified.
- Generate new hosted-site URLs with `HOST_DOMAIN`.
- Do not add token hashing or a restrictive hosted-site CSP to this PR; neither is required to restore the origin boundary.

#### Implications

Existing links continue to work through redirects once DNS and the Worker route are configured. Hosted pages can no longer read application storage or make credentialed same-origin API calls. A hosted tool that intentionally depended on application-origin credentials must use an explicit API integration instead.

### 2. Outbound R2 Attachments Bypass Inbox Scope

Severity: High

#### Vulnerability summary

The send and compose paths accept an arbitrary caller-provided `r2Key` and read it directly from the shared bucket. The key is not restricted to the sending inbox.

#### How it works

A writer scoped to inbox A supplies a known key belonging to inbox B. `prepareEmail()` calls `BUCKET.get(a.r2Key)`, and `/api/compose/:inbox` returns the bytes in rendered MIME. This turns a write-scoped credential into a cross-inbox object reader.

The deletion claim needs narrowing: `deleteAfterSend` already restricts deletion to `outbound/temp/`, but not to the current inbox. It cannot delete arbitrary drops or hosted files, but it can delete another inbox's temporary outbound attachment if the key is known.

Evidence: `src/api/send.ts:60-67` and `src/api/send.ts:251-256`.

#### Fix

- Require every outbound R2 attachment key to start with the exact prefix `outbound/temp/{normalized-inbox}/` before any R2 read.
- Apply the same exact-prefix check before cleanup.
- Add cross-inbox read and deletion regression tests.
- Do not add a D1 upload-record system unless later requirements need one; prefix authorization is sufficient for the current presign design.

#### Implications

The documented presign-and-send flow is unchanged because it already creates keys under the correct prefix. Only arbitrary bucket-key access and cross-inbox temporary cleanup stop working.

### 3. Relay Reply Addresses Are Forgeable

Severity: High

#### Vulnerability summary

Relay reply addresses contain a reversible destination address and a mask ID but no authenticator proving that Agent Drop issued the route.

#### How it works

Anyone who knows an active mask can send to an address shaped like `victim_at_example.com+mask-id@domain`. The handler decodes the attacker-selected destination, confirms only that the mask is active, and queues mail to that destination from the trusted Agent Drop domain. The attacker can use their own legitimate sender address; sender spoofing is not required.

Evidence: `src/lib/relay.ts:8-42` and `src/email-handler.ts:76-100`.

#### Fix

The minimum security fix is a versioned HMAC tag over the destination and mask ID using a dedicated relay secret. The reply handler must verify the tag before decoding or relaying.

An opaque D1 token table is an alternative if the project also wants to fix the existing 64-octet email local-part limitation. It should not expire routes merely for cleanup, because that would break replies to old but legitimate messages. A table and reaper are not required solely to close the forgery.

Before implementation, test the HMAC address format against long valid sender addresses. If the authenticator creates unacceptable local-part regressions, use a short opaque token table without expiry.

#### Implications

New signed reply addresses can remain valid indefinitely. Existing unsigned reply addresses cannot be made cryptographically valid after the fact, so they need a documented transition window and must eventually fail closed. Public mask addresses do not change.

### 4. Scoped Admin Keys Can Read Global Listings

Severity: High

#### Vulnerability summary

An API key may carry `admin` permission and an inbox scope, but `/api/drops` and `/api/boxes` check only the permission and then return global data.

#### How it works

`asAdminOrAdminKey()` validates that the key has `admin` permission but does not pass or enforce `inboxScope`. The listing handlers query all inboxes. A key intended for one inbox can therefore read drop bodies and box metadata belonging to other inboxes.

Evidence: `src/api/gates.ts:155-167`, `src/api/router.ts:122-131`, and `src/api/admin-lists.ts`.

#### Fix

- Preserve global access for the master admin secret and unscoped admin keys.
- Filter both listings by inbox for a scoped admin key.
- Add multi-inbox regression tests for scoped and unscoped administrators.

#### Implications

Normal administration remains unchanged. A scoped key receives only its configured inbox, matching the existing scope model.

## Confirmed Bounded-Input and Validation Fixes

These issues are real, but most are small enough to travel in the first PR rather than becoming separate projects.

### 5. Multipart `fileSize` Drives an Unbounded Signing Loop

Severity: High availability risk

#### Vulnerability summary

Multipart initialization checks only whether `fileSize` is truthy, then derives a part count and signs every part in a loop.

#### How it works

A drop-token, Google, or API-key writer submits a very large finite number. The Worker initializes an R2 multipart upload and then attempts to allocate and sign a correspondingly large parts array, exhausting CPU or memory.

Evidence: `src/api/upload.ts:102-110` and `src/api/upload.ts:141-154`.

#### Fix

- Before calling R2, require a finite, positive safe integer.
- Reject any size that would exceed the supported maximum part count.
- Add boundary tests for zero, negative, fractional, unsafe, and oversized values.

#### Implications

Accurate existing clients continue to work. Invalid or platform-impossible uploads fail with a controlled `400` instead of consuming Worker resources.

### 6. Webhook Bodies Are Buffered Before Their Configured Limit

Severity: High availability risk for known receiver URLs

#### Vulnerability summary

The receiver checks `Content-Length`, but chunked or understated bodies are fully buffered before their real size is compared with `maxBodyBytes`.

#### How it works

A request to a registered receiver omits or lies about its length. `request.arrayBuffer()` allocates the complete platform-accepted body before the Worker returns `413`. Signature verification occurs later, so a valid provider signature is not required to reach the allocation.

Evidence: `src/lib/webhook-receive.ts:166-178`.

#### Fix

- Read the stream through a shared capped-body helper.
- Cancel as soon as `maxBodyBytes + 1` is observed.
- Keep the declared-length check as a cheap early rejection.
- Bound `maxBodyBytes` during receiver creation and update.

#### Implications

Accepted webhook bytes remain identical for signature verification. Oversized requests terminate earlier and with bounded memory.

### 7. Outbound Attachments Have No Aggregate Memory Budget

Severity: High availability risk for authenticated writers

#### Vulnerability summary

Base64, R2, and URL attachments are fully buffered, all attachments resolve concurrently, and compose creates additional MIME/base64 copies.

#### How it works

A writer supplies several large attachments. `Promise.all()` holds them simultaneously, while decoding and MIME rendering create more copies. `/api/compose` does not pass through the email provider, so a downstream provider limit cannot protect the Worker.

Evidence: `src/api/send.ts:26-32`, `src/api/send.ts:60-80`, and `src/api/send.ts:180-183`.

#### Fix

- Preserve base64, R2, and remote URL attachment features.
- Enforce attachment count, per-file, and aggregate decoded-byte limits consistent with the documented email limit.
- Check R2 object size and estimated base64 size before buffering.
- Read remote responses through the capped-body helper with a timeout.
- Resolve sequentially or with tightly bounded concurrency.

#### Implications

Normal attachments continue to work, including `--attach https://...`. Oversized messages fail predictably. This is a bounded-resource correction, not a removal of remote attachments.

### 8. Direct Multipart Drops Buffer the Full Request

Severity: Medium availability risk for credentialed uploaders

#### Vulnerability summary

The documented `curl -F file=@...` drop path calls `request.formData()` and then creates an additional `ArrayBuffer` for each file without a product-level cap.

#### How it works

A credentialed uploader sends a large multipart request. The runtime buffers the form, and the handler buffers file content again before R2 storage, increasing peak memory.

Evidence: `src/api/drop.ts:49-67`.

#### Fix

- Keep direct multipart ingestion for compatibility.
- Apply a deliberately bounded aggregate request limit before form parsing.
- For untrusted or absent declared lengths, use the capped-body helper and parse only the bounded copy.
- Cap file count and per-file size.

#### Implications

Documented small form uploads continue to work. Large files use the existing presigned upload flow. The feature is constrained, not retired.

### 9. Private Hosted Responses Are Publicly Cacheable

Severity: Medium confidentiality risk

#### Vulnerability summary

Private sites require a query token but receive the same `Cache-Control: public` response as public sites.

#### How it works

A browser or intermediary is explicitly permitted to store a successful token-authenticated response in a shared cache. That conflicts with the intended bearer-token confidentiality model.

Evidence: `src/lib/hosting.ts:112-116` and `src/lib/hosting.ts:153-159`.

#### Fix

- Return `Cache-Control: private, no-store` for private-site content and redirects.
- Keep public-site caching unchanged.
- Do not add a token-hashing migration to this fix; hashing at rest is separate hardening and does not solve query-string exposure.

#### Implications

Private sites lose shared-cache performance. Tokens and URLs remain compatible.

### 10. Generated Webhook URL Credentials Have About 30 Bits of Entropy

Severity: Medium

#### Vulnerability summary

Generated receiver slugs use six base32 characters even though the source describes the URL as the credential for unauthenticated receivers.

#### How it works

Six base32 characters provide roughly 30 bits. Incorrect guesses fail before the per-receiver limiter because no receiver has been resolved, so that limiter does not provide the protection claimed by the comment.

Evidence: `src/lib/webhook-defs.ts:33-41` and `src/lib/webhook-receive.ts:146-164`.

#### Fix

- Increase generated suffixes to at least 128 random bits for create and rotation.
- Preserve existing receiver URLs.
- Continue allowing an administrator to choose an exact slug; document that an exact slug with `authMode: none` is intentionally public/guessable rather than silently removing the feature.

#### Implications

New generated URLs become longer. Existing integrations and deliberate exact slugs continue to work.

### 11. `inReplyTo` Lookup Is Not Scoped to the Sending Inbox

Severity: Low

#### Vulnerability summary

A drop ID supplied as `inReplyTo` is queried by ID alone.

#### How it works

If a scoped writer already knows another inbox's high-entropy drop ID, compose can disclose its stored Message-ID and thread against it. The prerequisite and exposed metadata make this a low-impact boundary defect.

Evidence: `src/api/send.ts:160-177`.

#### Fix

Query by both `id` and `inbox` and add a cross-inbox regression test.

#### Implications

Same-inbox threading is unchanged. Undocumented cross-inbox threading stops.

### 12. Unknown API-Key Permissions Fall Through as Read Access

Severity: Low configuration-safety issue

#### Vulnerability summary

Key creation accepts arbitrary permission strings, while read gates require only a valid key and matching scope.

#### How it works

An administrator creates a key with a typo or unsupported value. Write and admin checks reject it, but read routes accept it as a base credential. An unprivileged user cannot create this condition.

Evidence: `src/api/keys.ts:9-24` and `src/api/gates.ts:235-245`.

#### Fix

- Accept only `read`, `write`, or `admin` at creation.
- Reject unknown legacy values during authentication after checking whether any exist.
- Normalize an optional inbox scope at creation.

#### Implications

Valid keys are unchanged. Malformed legacy keys need recreation.

### 13. Malformed Google Tokens Can Produce Server Errors

Severity: Low

#### Vulnerability summary

Base64 decoding, JSON parsing, JWKS fetching, and key import can throw outside a fail-closed validation boundary.

#### How it works

Malformed anonymous credentials can return a `500` instead of a controlled authentication failure and can create noisy logs. An unknown Google key ID also remains invalid until the cache refreshes naturally.

Evidence: `src/lib/google-auth.ts`.

#### Fix

- Bound token length.
- Catch parsing, fetch, response-shape, key-import, and verification failures.
- Return the normal invalid-token result.
- Refresh JWKS once when an otherwise valid token references an unknown key ID.

#### Implications

Valid sign-in is unchanged. Invalid credentials consistently fail closed.

### 14. Header-Derived Values Do Not Reject Control Characters

Severity: Low; confirmed in compose output

#### Vulnerability summary

The custom-header validator checks byte lengths but does not reject CR, LF, or NUL. A raw `inReplyTo` value can inject extra lines into `/api/compose` output.

#### How it works

For example, an `inReplyTo` beginning with `<` and containing `\r\nBcc:` is accepted and rendered as additional MIME header lines. Live-send impact depends on Cloudflare's structured email binding validation, and a writer already has a first-class Bcc field, so this is not a privilege-escalation finding.

Evidence: `src/api/send.ts:160-177`, `src/lib/email-builder.ts:80-104`, and `src/lib/mime.ts:115-126`.

#### Fix

- Reject CR, LF, NUL, and disallowed controls in every header-derived field.
- Validate raw Message-ID input as one syntactically valid token.
- Add a compose regression test proving no injected header line appears.

#### Implications

Normal Unicode subjects, display names, and filenames remain supported. Structurally invalid values receive `400`.

## Valid Findings That Are Not Security PRs

### 15. Relay Retry Counter Uses Immutable Message Data

Classification: Medium reliability bug, not a retry storm

#### Summary and operation

The queue body freezes `attempt: 0`; the consumer therefore logs attempt one and requests a two-second delay every time. The original assessment incorrectly projected this across 24 hours. `wrangler.toml` sets `max_retries = 50`, so Cloudflare eventually discards the message after roughly 51 deliveries, in about two minutes, because no dead-letter queue is configured.

Evidence: `src/lib/relay.ts:229-268`, `wrangler.toml:49`, and Cloudflare's Queues retry documentation.

#### Fix

Use `msg.attempts` for logging and exponential backoff, remove the body counter from new messages, and ensure configured retries are sufficient for the documented retry window. A dead-letter queue is a useful operational improvement but not required for the security remediation.

#### Implications

Failures retry more slowly and for longer instead of being silently exhausted in minutes. Successful delivery is unchanged.

### 16. Handshake Audit Rows Bypass `dailyCap`

Classification: Low-priority storage hardening; documented behavior

#### Summary and operation

Handshake rows are deliberately stored before the hard event cap. The code prioritizes answering provider validation and relies on the per-colocation burst limiter. The row is optional, so repeated handshake-shaped requests can still create more audit rows than `dailyCap` suggests.

Evidence: `src/lib/webhook-receive.ts:204-256` and its pinned tests.

#### Fix

If operators expect `dailyCap` to bound every row, keep returning the successful handshake but skip the optional audit insert after the cap. This is safe and small, but it does not need to block the three security PRs.

#### Implications

Provider validation remains available. Excess handshake diagnostics are omitted after the cap.

### 17. Remote URL Attachments Are an Intentional Fetch Feature

Classification: Not a separate demonstrated SSRF vulnerability; availability bounds are still required

#### Summary and operation

The writer-facing API intentionally accepts a URL and returns or sends its public response as an attachment. Calling every such fetch SSRF overstates the evidence and removing it would break documented `--attach https://...` behavior. The concrete defect is unbounded buffering, covered in finding 7.

#### Fix

Preserve URL attachments. Parse only HTTP(S) URLs, add a timeout, cap redirects if handled manually, and stream through the shared attachment budget. Revisit destination policy only if a private-network binding or other non-public reachability is introduced.

#### Implications

Normal remote attachments continue to work. Invalid schemes, timeouts, and oversized responses fail cleanly.

### 18. Dependency Advisories Are in Development Tooling

Classification: Maintenance and supply-chain hygiene

#### Summary and operation

The audit reported 33 advisories in Vite, Miniflare, Sharp, Undici, Nanoid, and source-map tooling. The affected packages are in the development/build toolchain rather than the deployed Worker runtime.

#### Fix

Upgrade the Cloudflare/Vite toolchain in a dedicated maintenance change and re-run the full build and test suite. Add an audit command if the team wants automated visibility, but do not represent the current report as 33 production Worker vulnerabilities.

#### Implications

Tool upgrades may change local development or build output. There is no direct Worker-runtime security behavior to patch.

### 19. GitHub Actions Use Mutable Major Tags

Classification: CI supply-chain hardening

#### Summary and operation

`actions/checkout@v4` and `oven-sh/setup-bun@v2` are movable tags. Pinning reviewed SHAs improves reproducibility, but the current workflow already has read-only contents permission and no repository secrets.

#### Fix

Pin full SHAs with version comments when doing CI maintenance and enable automated update PRs.

#### Implications

No application behavior changes. Action updates require review.

### 20. Worker Binding Types Do Not Cover Configuration Drift

Classification: CI accuracy issue

#### Summary and operation

The `types` script uses `--include-env false`, while `src/types.ts` manually declares bindings. CI's comment therefore overstates what `wrangler types --check` proves.

#### Fix

Either generate binding types or correct the CI claim and add a dedicated configuration check. This is useful engineering work, not a security remediation.

#### Implications

No runtime change. Stricter generation may require contributors to regenerate types after configuration edits.

### 21. Security Tests Use Bun Stubs Rather Than Workerd

Classification: Test-assurance gap

#### Summary and operation

The unit suite uses fake D1, R2, Queue, email, and execution-context implementations. A focused workerd suite would increase confidence in streams and bindings, but the absence of one is not itself a vulnerability.

#### Fix

Add workerd coverage later if production/runtime mismatches appear or the project wants higher assurance. It should not block these focused fixes.

#### Implications

Deferring it avoids new test infrastructure and CI time. Focused unit tests still need to cover every changed boundary.

## Rejected as Current Security Gaps

### 22. Lease ID Is Not an Authorization Boundary

Classification: Documented coordination behavior

#### Assessment

Every writer for an inbox already has authority to remove, return, requeue, and delete inbox events. `queue-remove ID` and `queue-return ID` intentionally do not require a lease ID, while `queue-extend` optionally accepts one as a coordination guard. Requiring it would break documented CLI behavior without creating tenant isolation.

#### Recommendation and implications

Make no security change. Optionally accept and enforce a lease ID when a caller supplies one to remove or return, or design separate consumer identities if true consumer isolation becomes a requirement.

### 23. The Existing Constant-Time Comparison Is Adequate Here

Classification: No actionable vulnerability demonstrated

#### Assessment

`constantTimeEqual()` checks length and then compares every character without an early exit. Master-admin comparison already hashes both inputs to fixed-length digests. Raw webhook-token length can be observable, but remote exploitation through Worker and network timing is not credible enough to justify changing every verifier in this pass.

#### Recommendation and implications

Keep the helper. Revisit native `crypto.subtle.timingSafeEqual()` only as a localized primitive cleanup, not as a security PR requirement.

### 24. Missing SPA Security Headers Are Defense in Depth

Classification: Optional browser hardening

#### Assessment

A CSP, frame policy, referrer policy, and permissions policy are worthwhile, but no concrete SPA injection or clickjacking exploit was demonstrated. A rushed CSP can break Google sign-in and external assets.

#### Recommendation and implications

Defer browser-header work until it can be tested in a browser, ideally starting in report-only mode. Hosted-content origin isolation does not depend on it.

## Revised Three-PR Plan

### PR 1: Close API Boundaries and Bound Input

- Restrict outbound R2 reads and cleanup to the sending inbox's temporary prefix.
- Filter global listings for scoped admin keys.
- Validate multipart sizes before R2 work.
- Bound webhook, direct multipart, and outbound attachment buffering without removing features.
- Fix private-site caching, generated webhook entropy, `inReplyTo` scope, permission values, malformed Google-token handling, and header controls.
- Include focused regression tests for every change.

### PR 2: Isolate Hosted Content

- Add `HOST_DOMAIN` configuration and URL generation.
- Redirect legacy `/f/*` paths to the dedicated host.
- Serve active content only on the dedicated host.
- Test origin routing, path/query preservation, private-site redirects, and existing hosted-site behavior.

### PR 3: Authenticate Relay Reply Routes

- Add a versioned HMAC to relay reply addresses, subject to local-part compatibility tests.
- Fall back to a non-expiring opaque token table only if the address-length tests require it.
- Define and test a migration window for unsigned legacy reply addresses.
- Correct relay retries to use `msg.attempts` and align the queue limit with the documented retry window.

## Verification

Each PR should pass focused exploit regressions, the full TypeScript checks, Biome, all Bun tests, a production build, and a deployment dry run. Dependency upgrades, workerd integration tests, broad SPA headers, Worker type generation, and lease-protocol changes are intentionally outside this security scope.

## Confirmed Existing Strengths

- The master admin secret fails closed when unset.
- API keys and generated IDs use cryptographically secure randomness.
- Normal keyed routes enforce permission and inbox scope.
- Upload finalization re-authenticates against the inbox stored in D1 and derives its object key server-side.
- Webhook signatures verify the exact received bytes and enforce replay windows where providers supply signed timestamps.
- Shared webhook credentials are redacted from stored headers and query strings.
- D1 queries inspected during the audit use parameter binding for untrusted values.
- `.env` and Google client-secret files are ignored and untracked.
- The baseline suite passes 734 tests with no failures.
