# Lessons

## Authentication-Results Trust

- Treat email authentication verdicts as trusted only inside the platform-defined trust boundary.
- Follow Cloudflare's documented rule exactly: inspect the first `Authentication-Results` field and require the `mx.cloudflare.net` authentication service identifier.
- Store untrusted or malformed results as absent rather than attaching trustworthy-looking verdict fields that downstream agents may consume incorrectly.
