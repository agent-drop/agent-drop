# Agent Drop (frst.dev)

Dead-drop system for AI agents. Email, upload, or API-push content into named inboxes ("boxes"). Agents retrieve drops via authenticated API.

## Quick Reference

| What             | Where                                                                          |
|------------------|--------------------------------------------------------------------------------|
| Website           | https://frst.dev                                                               |
| API               | https://frst.dev/api/                                                          |
| Inbound email     | `{name}@frst.dev` or `{name}+{topic}@frst.dev`                                 |
| Web upload        | `https://frst.dev/{name}`                                                      |
| Static hosting    | `https://{HOST_DOMAIN}/f/{box}/{site}/` (served from R2 on an isolated origin; `https://frst.dev/f/*` 301-redirects there) |
| Webhook receiver  | `https://frst.dev/h/{box}/{slug}` -- public, unauthenticated by design         |
| CLI tool          | `tools/agent-drop.ts` (in this repo; Bun runtime, own `tools/tsconfig.json`)    |
| CLI alias         | `drop` -> `~/.local/bin/drop` -> `tools/agent-drop.ts`                         |
| Style guide       | https://frst.dev/styleguide.html                                               |

## Architecture

- **Cloudflare Workers** - API + static site serving. One Worker answers two origins: the app (`DOMAIN`: SPA, API, webhooks) and the isolated hosting origin (`HOST_DOMAIN`: hosted sites only)
- **Cloudflare D1** - SQLite database (inbox index, API keys, drop tokens, allowed users)
- **Cloudflare R2** - Blob storage (attachments, raw emails, uploads)
- **Cloudflare Queues** - Async webhook + relay delivery (`agent-drop-webhooks`), and R2 object-create notifications (`agent-drop-r2-events`)
- **Cloudflare Cron Triggers** - Hourly, two independent sweeps in one tick (`src/lib/reaper.ts` `runSweeps`): stale `pending` drops, and webhook events past their retention (`src/lib/hook-reaper.ts`). Neither can cancel the other
- **Cloudflare Email Sending binding** (`env.EMAIL`) - ALL outbound mail. Composed and forwarded messages hand it an `EmailMessageBuilder`; the relay queue consumer replays stored raw MIME through the legacy `EmailMessage` shape
- **AWS SES** (eu-central-1) - **dead fallback**, kept deliberately as a revert path. `sendRawEmail` in `src/lib/relay.ts` has zero callers. Deleting it also retires an AWS IAM user, two secrets, the DKIM CNAMEs, the MAIL FROM MX and the SPF include -- so it is a decision, not a cleanup
- **Webhook receivers** (`/h/{box}/{slug}`) - the fourth ingest channel: a third party POSTs, we answer its setup handshake, verify the sender, store the bytes unchanged, and hand them to an agent over a lease-based pull queue (`src/lib/webhook-receive.ts`)
- **Workers Rate Limiting** (`[[ratelimits]]`) - failed-auth, drop-token upload and webhook-receiver throttles, per-colo, fail-open
- **D1 Sessions API** - read paths run in a `first-unconstrained` session; writes take no session
- **R2 S3-compatible API** - Presigned upload URLs via `aws4fetch signQuery`
- **Google Identity Services (GIS)** - OAuth sign-in (client-side prompt, server-side JWT verification)
- **Vite 8 + React 19 + Tailwind 4** - Frontend (Tokyo Night theme), built by `@cloudflare/vite-plugin` in one pass with the Worker
- **Biome + GitHub Actions** - `bun run check` locally, `.github/workflows/ci.yml` on push

## Auth

| Method | Use |
|--------|-----|
| Admin key (`ADMIN_API_KEY`) | Manage keys, targets, users; list all boxes/drops |
| API key (`ad_...`) | Read/write specific inboxes; with `admin` permission, also list boxes/drops (only its own `inbox_scope`) |
| Drop token (`?auth=TOKEN`) | Temporary write-only access to one inbox |
| Google OAuth JWT | Web upload UI (sign-in with Google, verified against JWKS) |

**Admin key** is in `.env` and set as wrangler secret. Compared as a SHA-256
digest, not as a string, so the check does not leak its length or prefix through
timing -- and an unset `ADMIN_API_KEY` can no longer be satisfied by a bare
`Authorization: Bearer `.\
**API keys** are created via `POST /api/keys` or `tools/agent-drop.ts key-create`.\
**Google OAuth** - client sends Google ID token; server verifies against `https://www.googleapis.com/oauth2/v3/certs` JWKS. Email must exist in the `allowed_users` D1 table. A token that is oversized (over 16 KiB), malformed, or signed by an unknown key fails closed as `401`; an unknown `kid` triggers at most one JWKS refetch per 60 seconds.

### What a key may do

Two independent things, both enforced on **every** write path:

| Column | Question it answers |
|--------|---------------------|
| `permissions` | `read` / `write` / `admin` -- what this key may DO |
| `inbox_scope` | which box it may do it TO (`NULL` = any box) |

`inbox_scope` binds an `admin`-permission key exactly as it binds a `write` one:
permissions say what, scope says where. The comparison runs **after**
`normalizeInbox`, so a key scoped to `mrgray` matches `/api/send/Mr.Gray`.

This applies to `/api/drop/*`, the presigned upload routes and their finalize
endpoints, hosting, **and outbound mail** (`/api/send/*`, `/api/compose/*`) --
`:inbox` there becomes the From address, so a scoped key that skipped the check
could send as any identity the domain owns.

`permissions` is validated on creation (`POST /api/keys` answers `400` for
anything but `read`, `write` or `admin`; omitted means `read`), and so is
`inbox_scope` (must normalize to a valid inbox name). A stored key whose
`permissions` value is not one of the three fails authentication outright rather
than being treated as some default.

**Listings are scoped too.** `GET /api/drops` and `GET /api/boxes` accept the
admin key (every box) or an API key with `admin` permission, which sees only its
own `inbox_scope` (`NULL` scope = every box). Read and write keys get `403`.

### Rate limiting

Three Workers rate-limit bindings (`src/lib/ratelimit.ts`, and
`src/lib/webhook-throttle.ts` for the third):

| Binding | Counts | Keyed by |
|---------|--------|----------|
| `AUTH_RATE_LIMIT` | rejected **credentials** (bad key, bad token, bad Google JWT) | `CF-Connecting-IP` |
| `UPLOAD_RATE_LIMIT` | drop-token uploads | SHA-256 of the token |
| `HOOK_RATE_LIMIT` | every request that reaches a registered webhook receiver | receiver id |

The binding is **per-colo, not global**: it throttles abuse, it is not a hard
quota. Do not describe it as one. It also **fails open** -- a missing binding or
a limiter error lets the request through, because a throttle that converts its
own outage into an API outage is worse than the abuse it prevents.

Authorization failures on a *valid* credential (wrong scope, missing permission)
deliberately do NOT count. That is a misconfigured client, not a brute-force
attempt, and throttling it would punish the legitimate agent.

Because all three fail open, a receiver that must be **bounded** rather than
merely throttled sets `daily_cap` (`hook-update --daily-cap N`). That one is
counted in D1 over a rolling 24 hours and cannot fail open -- see "Webhook
Receivers" below. The two are not alternatives: the limiter sheds a burst, the
cap is what stops a table growing forever.

### CORS

Only `/api/health`, `/api/config`, `/api/drop/*` and `/api/upload/*` are ever
called cross-origin, and those get `Access-Control-Allow-Origin: https://{DOMAIN}`
-- the real origin, since credentials travel on them. Every other route is CLI-
and agent-driven over an `Authorization` header and gets **no CORS headers at
all**. There is no `*` anywhere.

The public webhook receivers at `/h/*` get none either: they are
server-to-server, and a provider's POST is not a browser's.

## Environment Variables

```bash
# In .env (this project). Copy .env.example; .env is gitignored.

# Deployment identity -- injected into the Worker config by `bun run deploy`,
# NOT set as wrangler secrets (scripts/deploy-identity.ts)
DOMAIN=...                     # App origin: SPA, API, webhooks. Route becomes $DOMAIN/*
HOST_DOMAIN=...                # REQUIRED. Hosted-sites origin, e.g. files.frst.dev. Must differ from DOMAIN
MAIL_DOMAIN=...                # Optional. Domain boxes send/receive mail on. Defaults to DOMAIN
ZONE_NAME=...                  # Optional. Cloudflare zone owning both routes. Defaults to DOMAIN
RELAY_LEGACY_REPLY_UNTIL=...   # Optional. ISO-8601 cutoff for pre-token relay replies. Leave unset
BRAND=...                      # Display name in the web UI + CLI
CLOUDFLARE_ACCOUNT_ID=...      # Account the Worker deploys to
D1_DATABASE_ID=...             # D1 database UUID for the DB binding

# Secrets -- also set as wrangler secrets on the Worker
ADMIN_API_KEY=...              # Admin access to all API endpoints
GOOGLE_CLIENT_ID=...           # OAuth 2.0 client ID for web sign-in (also injected as GOOGLE_CLIENT_ID_PUBLIC)
R2_ACCESS_KEY_ID=...           # R2 API token (for presigned upload URLs)
R2_SECRET_ACCESS_KEY=...       # R2 API token secret
AWS_ACCESS_KEY_ID=...          # Dead SES fallback only: IAM user agent-drop-ses
AWS_SECRET_ACCESS_KEY=...      # Same IAM user

# CLI only, never sent to the Worker
API_KEY=ad_...                 # A generated API key with admin permissions
```

`DOMAIN`, `HOST_DOMAIN`, `BRAND`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID` and
`GOOGLE_CLIENT_ID` are required: `bun run deploy` exits when one is missing, and
also when `HOST_DOMAIN` equals `DOMAIN`. The Worker enforces the same rule at
runtime and answers `503` on every request if `HOST_DOMAIN` is unset or equal to
`DOMAIN`. `.env.example` is the template, and `bun run deploy` refuses a build
whose injected values disagree with `.env`.

**Also in passage:** `AGENT_DROP_ADMIN_KEY` and `AGENT_DROP_API_KEY` (`key NAME` reads env/NAME, `key-set NAME` stores it). The CLI takes each from the shell env var first, then passage, then this `.env`, so it works from any directory with nothing exported. The Google OAuth client secret JSON is `key projects/agent-drop/google-oauth-client.json`.

## API Endpoints

### Admin endpoints (require admin key)

```bash
AUTH="-H 'Authorization: Bearer $ADMIN_API_KEY'"

# List all boxes with stats (an admin-permission API key works too, scoped to its inbox)
curl $AUTH https://frst.dev/api/boxes

# List all drops across all boxes (chronological; same scoping for an API key)
curl $AUTH "https://frst.dev/api/drops?limit=20"
curl $AUTH "https://frst.dev/api/drops?channel=email"

# Manage drop targets (temporary upload links)
curl -X POST $AUTH -H "Content-Type: application/json" \
  -d '{"inbox":"mr-gray","ttl_hours":2}' \
  https://frst.dev/api/targets

# List active targets
curl $AUTH https://frst.dev/api/targets

# Manage API keys. permissions: read (default) | write | admin; inbox_scope is optional
curl $AUTH https://frst.dev/api/keys
curl -X POST $AUTH -H "Content-Type: application/json" \
  -d '{"name":"my-agent","permissions":"admin"}' \
  https://frst.dev/api/keys

# Manage allowed users (Google OAuth allowlist)
curl $AUTH https://frst.dev/api/users
curl -X POST $AUTH -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","name":"Alice"}' \
  https://frst.dev/api/users
curl -X DELETE $AUTH https://frst.dev/api/users/user@example.com
```

### Public endpoints (no auth required)

```bash
# Google OAuth client ID (for web sign-in button)
curl https://frst.dev/api/config
# Returns: {"google_client_id":"..."}
```

### Agent endpoints (require API key with read/write/admin)

```bash
KEY="-H 'Authorization: Bearer ad_...'"

# List drops in an inbox
curl $KEY "https://frst.dev/api/inbox/{name}"
curl $KEY "https://frst.dev/api/inbox/{name}?unread=true"
curl $KEY "https://frst.dev/api/inbox/{name}?topic=invoices&limit=5"

# Get latest drop
curl $KEY https://frst.dev/api/inbox/{name}/latest

# Get specific drop
curl $KEY https://frst.dev/api/inbox/{name}/{drop-id}

# List attachments
curl $KEY https://frst.dev/api/inbox/{name}/{drop-id}/attachments

# Download attachment
curl $KEY https://frst.dev/api/inbox/{name}/{drop-id}/file/{filename}

# Original message, unstripped (email drops only; 404 otherwise). CLI: drop raw
curl $KEY https://frst.dev/api/inbox/{name}/{drop-id}/raw

# Create a drop (API)
curl -X POST $KEY -H "Content-Type: application/json" \
  -d '{"subject":"Test","text":"Hello","topic":"test"}' \
  https://frst.dev/api/drop/{name}

# Upload files
# Direct multipart accepts up to 32 files, 20 MiB each, in a 25 MiB request (413 past any of
# them; the body is cut off while streaming, not buffered first).
# Use the presigned upload endpoints below for larger files.
curl -X POST $KEY -F "file=@document.pdf" \
  https://frst.dev/api/drop/{name}

# Send outbound email (From: {name}@frst.dev). JSON fields are camelCase.
# Supports: to/cc/bcc (string or array), replyTo, fromName, topic (+addressing),
# text, html, markdown, inReplyTo (drop id or <message-id> for threading),
# attachments[], deleteAfterSend.
# Attachments resolve from one of: dataBase64 (inline), r2Key (uploaded), or url (fetched).
# Worker hands an EmailMessageBuilder to the Email Sending binding, which assembles the MIME.
# One send carries the whole to/cc/bcc list. Limits: 8 MiB JSON request body, 50 combined
# recipients, 32 attachments, 5 MiB per inline base64 attachment, and 16 MiB decoded
# attachment data in total (leaving room under the 25 MiB message cap). All 413.
# r2Key must be one this box presigned (outbound/temp/{box}/...); url must be http(s).
# CR/LF and other control characters in subject, recipients, replyTo, fromName, topic,
# attachment filename/contentType/cid or headers are a 400. inReplyTo is a drop id IN THIS
# box, or exactly one <local@domain> Message-ID.
curl -X POST $KEY -H "Content-Type: application/json" \
  -d '{"to":["bob@example.com"],"cc":["team@example.com"],"subject":"Hi","text":"Hello",
       "html":"<b>Hi</b> <img src=\"cid:logo\">",
       "attachments":[{"cid":"logo","inline":true,"r2Key":"outbound/temp/...","filename":"logo.png"},
                      {"url":"https://example.com/report.pdf","filename":"report.pdf"}]}' \
  https://frst.dev/api/send/{name}

# Same, from markdown. The worker renders it to email-safe HTML and carries the
# raw markdown as the text part, so a plain-text reader still gets the report.
curl -X POST $KEY -H "Content-Type: application/json" \
  -d '{"to":["bob@example.com"],"subject":"Retrospect",
       "markdown":"# Retrospect\n\n| leg | cost |\n|---|--:|\n| one | 3 |\n"}' \
  https://frst.dev/api/send/{name}

# Presigned PUT for an outbound attachment (lands in outbound/temp/{box}/, no drop record).
# Use the returned r2Key in the send call's attachments[]. CLI auto-uses this for files >1MB.
curl -X POST $KEY -H "Content-Type: application/json" \
  -d '{"fileName":"big.zip","contentType":"application/zip"}' \
  https://frst.dev/api/send/presign/{name}
# Returns: {"uploadUrl":"https://...r2...","r2Key":"outbound/temp/...","fileName":"big.zip"}
```

### Presigned R2 upload endpoints (require API key or drop token)

The inbox is in the **path**, not the body, and every field is camelCase.

```bash
# Presigned PUT for a direct-to-R2 upload (small files, single-part).
curl -X POST $KEY -H "Content-Type: application/json" \
  -d '{"fileName":"report.pdf","contentType":"application/pdf","topic":"invoices"}' \
  https://frst.dev/api/upload/presign/{name}
# Returns: {"dropId":"...","objectKey":"drops/{name}/{dropId}/uploads/report.pdf",
#           "uploadUrl":"https://...r2...?X-Amz-Signature=...",
#           "fileName":"report.pdf","originalFileName":"report.pdf"}

# Initiate a multipart upload (large files). Part count is derived from fileSize
# at 50 MiB per part; the response presigns every part. fileSize must be a positive
# integer, at most 100 parts (5000 MiB), else 400 / 413.
curl -X POST $KEY -H "Content-Type: application/json" \
  -d '{"fileName":"big.zip","contentType":"application/zip","fileSize":734003200}' \
  https://frst.dev/api/upload/multipart/{name}
# Returns: {"dropId":"...","uploadId":"...","objectKey":"...",
#           "parts":[{"partNumber":1,"url":"https://...r2..."},...]}

# Complete a multipart upload. dropId and uploadId ONLY -- the worker lists the
# parts from R2 itself and derives the object key from the drop row.
curl -X POST $KEY -H "Content-Type: application/json" \
  -d '{"dropId":"...","uploadId":"..."}' \
  https://frst.dev/api/upload/complete
# Returns: {"completed":true,"dropId":"..."}

# Confirm a direct upload landed in R2 (transitions the drop pending -> completed).
# Optional and idempotent since the R2 event notification does this on its own --
# returns 200 {"confirmed":true,"alreadyCompleted":true} if it already happened.
curl -X POST $KEY -H "Content-Type: application/json" \
  -d '{"dropId":"..."}' \
  https://frst.dev/api/upload/confirm
# Returns: {"confirmed":true,"dropId":"...","alreadyCompleted":false}
```

**Both finalize endpoints authenticate.** They look the drop row up by `dropId`,
recover its inbox, and re-run the same write auth the presign required -- so
`404 {"error":"drop not found"}` for an unknown id comes from the router, before
any handler runs. They used to run with **no auth at all**, on the theory that
"the dropId was already authenticated at presign", which nothing re-checked:
anyone who learned a drop id could flip it to `completed` and publish it to
every agent reading that inbox.

**`complete` does not accept an `objectKey`.** It used to take one alongside
`dropId` and never check they belonged to the same row, so a caller holding any
valid drop id could complete an upload against an arbitrary R2 key. The key is
recorded at presign time (migration `0008`) and read back from the row; the
request body is not consulted. Pre-`0008` rows fall back to
`r2_prefix + slugify(subject)`, still server-side only.

### Drop token endpoints (temporary, write-only)

```bash
# Upload via temporary link
curl -X POST -F "file=@photo.jpg" \
  "https://frst.dev/api/drop/{name}?auth=TOKEN"
```

## Drop Lifecycle

Drops created via presigned R2 upload start in `pending` and become `completed`
when the bytes actually land. Drops created via API, email, or direct multipart
upload go straight to `completed`.

| Status | Meaning |
|--------|---------|
| `pending` | Upload initiated, R2 object not yet observed |
| `completed` | Drop fully landed, readable by agents |

**Three independent things complete a `pending` drop.** Whichever gets there
first wins; the others are no-ops.

| Path | When |
|------|------|
| **R2 event notification** (`src/lib/r2-events.ts`) | The bucket reports the object landing under `drops/{box}/{id}/uploads/`, via the `agent-drop-r2-events` queue. This is the authoritative one -- it needs nothing from the client. |
| **`POST /api/upload/confirm`** | The client says so. Kept for the SPA and CLI; nothing depends on it any more. |
| **Cron reaper** (`src/lib/reaper.ts`) | Hourly backstop for a notification that never arrived. |

`/api/upload/confirm` is **idempotent**: confirming a drop the R2 notification
already completed answers `200 {"confirmed":true,"alreadyCompleted":true}`, not
a 404. A healthy upload frequently hits that case, because the notification
usually wins the race.

The reaper (cron `17 * * * *`) looks at `pending` drops older than 24h, up to 500
per run, and asks R2 what actually happened:

- object present -> `completed` (the upload landed, nothing completed it)
- object absent -> the row is **deleted** (the presign was never spent)
- no resolvable object key -> left alone and logged, never deleted on a guess

## Drop Metadata

Every drop records:

| Field | Source |
|-------|--------|
| `auth_method` | `api_key` (a Google sign-in lands here too), `drop_token`, or `email` |
| `auth_key_name` | Name of the API key, or `google:<email>` for a Google sign-in (non-email drops) |
| `remote_ip` | Uploader's IP (via CF-Connecting-IP) (non-email drops) |
| `user_agent` | Browser/client User-Agent (non-email drops) |
| `country` | Country code (via CF-IPCountry) (non-email drops) |
| `city` | City (via CF geo) (non-email drops) |
| `to_full` | Full recipient address including any `+topic` (email only) |
| `from_name` | Sender name (email only) |
| `from_header` | First RFC 5322 From header; unlike `from_addr`, this is not the envelope sender (email only) |
| `message_id` | Email Message-ID header (email only) |
| `sender_auth` | Trusted Cloudflare SPF, DKIM, and DMARC verdicts, each with the identity it checked, or `null` (email only) |

Stored as JSON in the `metadata` column.

## Email Handling

Inbound emails are processed by `email-handler.ts`:

- **Quote stripping** - `stripQuotedText` removes forwarded/reply chains from plain text; `stripQuotedHtml` does the same for HTML
- Raw email stored in R2; stripped body stored in D1
- Attachments extracted and stored in R2 under `{drop-id}/attachments/`
- `from_name`, `from_header`, and `message_id` captured in drop metadata
- `sender_auth` records the first `Authentication-Results` field only when its authentication service is exactly `mx.cloudflare.net`; missing, malformed, or untrusted results become `null`
- `spf`, `dkim` and `dmarc` are each a list of `{ result, reason?, props }` in field order. `props` holds the RFC 8601 `ptype.property=value` pairs, keyed `smtp.mailfrom`, `smtp.helo`, `header.d`, `header.from`, `policy.dmarc` and so on. Select by property, never by position: Cloudflare reports HELO and MAIL FROM SPF as two separate results, and `spf[0]` can be the HELO one

## Inbox Name Normalization

All inbox names are normalized via `normalizeInbox()`:
- Lowercase
- Dots stripped (gmail-style: `mr.gray` = `mrgray`)
- Underscores converted to hyphens
- Only a-z, 0-9, hyphens allowed
- Must start with a letter, max 64 chars

## Filename Slugification

All uploaded filenames are slugified via `slugifyFilename()`:
- Unicode romanized (NFD decomposition + char map: `ä`->`a`, `ß`->`ss`, `ø`->`o`)
- Lowercase, spaces/underscores -> hyphens
- Original filename preserved in R2 `customMetadata.originalFilename`

Examples: `Z Profile.jpg` -> `z-profile.jpg`, `résumé.docx` -> `resume.docx`, `Ärende Ö.pdf` -> `arende-o.pdf`

## CLI Tool

Available as `drop` in PATH or `bun tools/agent-drop.ts` from this project root.

Run `drop --help` for full command reference. Key commands:

```bash
drop boxes                              # list all inboxes
drop drops --limit 5                    # recent drops across all boxes
drop inbox lisa                         # drops in a specific box
drop get DROP_ID                        # full details + metadata + files
drop body lisa                          # print full email body text
drop files lisa                         # list files in latest drop
drop download lisa DROP_ID file.pdf     # download a file
drop raw lisa DROP_ID -o msg.eml        # the original .eml (email drops only)
drop url lisa DROP_ID file.pdf          # presigned download URL (shareable)
drop target mr-gray --ttl 2             # create temp upload link
drop invite user@x.com --target box    # invite flow (allowlist + link + email)
drop host lisa marketing ./dist         # publish a folder -> $HOST_DOMAIN/f/lisa/marketing/
drop sites lisa                         # list hosted sites for a box
drop unhost lisa marketing              # delete a hosted site (purges R2)
drop rules                             # list forward/webhook rules
drop rule-test shop-returns --channel email  # dry-run rule matching
drop deliveries                         # webhook delivery log
drop hook-create lisa stripe-prod       # register a webhook receiver, print its URL
drop hooks                              # list webhook receivers
drop queue-get lisa --limit 10          # LEASE webhook events off the queue
drop queue-peek lisa                    # read them without leasing anything
drop queue-remove lisa EVENT_ID         # ack
```

The full `hook-*` (receiver) and `queue-*` (message) vocabularies are in
"Webhook Receivers" below.

### `invite` command

Creates a drop token and prints a pre-filled upload URL:

```bash
bun tools/agent-drop.ts invite alice@example.com --target mr-gray --ttl 48
# Prints: https://frst.dev/mr-gray?auth=TOKEN  (expires in 48h)
```

The `--ttl` defaults to 24 hours. The email is just for labeling - no email is actually sent.

### `send-email` command

Send a real email **on behalf of a box** (`From: {drop}@frst.dev`). The CLI resolves
attachments client-side, uploads large ones to R2, then the Worker builds an
`EmailMessageBuilder` and hands it to the Cloudflare Email Sending binding, which assembles
the MIME. `--dry-run` renders that same builder payload as an `.eml` preview via
`/api/compose` -- the preview is local, so Message-ID, Date and the exact MIME nesting are
approximations; the fields are not.

```bash
# Basic
drop send-email --drop lisa --to bob@example.com --subject "Hi" --body "Hello"

# Multiple recipients (display-name syntax OK), cc/bcc, reply-to, from-name
drop send-email --drop lisa \
  --to '"Bob" <bob@x.com>' --to alice@x.com --cc team@x.com --bcc audit@x.com \
  --reply-to lisa@frst.dev --from-name "Lisa" \
  --subject "Report" --body "see attached"

# HTML body from a file + inline image (cid) + a regular attachment + a remote URL
drop send-email --drop lisa --to bob@x.com --subject "Report" \
  --body-html ./mail.html \
  --attach logo:./logo.png \         # inline, referenced as cid:logo in the HTML
  --attach ./report.pdf \            # regular attachment
  --attach https://example.com/x.pdf # fetched server-side

# Markdown body -- rendered to email-safe HTML by the WORKER, not the CLI
drop send-email --drop lisa --to bob@x.com --subject "Retrospect" --body-md @./retro.md

# +addressing (From: lisa+sales@frst.dev), threading, YAML template, preview
drop send-email --drop lisa --to bob@x.com --subject Hi --body Yo --topic sales
drop send-email --drop lisa --to bob@x.com --subject Re --body "reply" --in-reply-to DROP_ID
drop send-email --template ./campaign.yml --to bob@x.com   # flags override template
drop send-email --drop lisa --to bob@x.com --subject Hi --body Yo --dry-run  # assemble, don't send
```

**Flags:** `--drop` (sender box), `--to/--cc/--bcc` (repeatable), `--reply-to`, `--from-name`,
`--subject`, `--body` (text or file path), `--body-html` (html or file path), `--body-md`
(markdown or file path), `--attach` (repeatable; `path`, `url`, or `cid:path` for inline),
`--topic`, `--in-reply-to` (drop id or `<message-id>`), `--template` (YAML), `--upload` (force
R2 for all local files), `--dry-run`.

### Markdown bodies

`markdown` on `/api/send/:inbox` and `/api/compose/:inbox` (CLI: `--body-md`) is rendered
**server-side** by `src/lib/markdown.ts`, so every consumer gets the same output instead of
each shipping its own renderer. It fills two parts at once: the rendered HTML, and -- unless
an explicit `text` is supplied -- the raw markdown as the plain-text part, markdown being the
one markup a plain-text reader can still read.

`markdown` **and** `html` together is a `400`. Two sources for one MIME part, and silently
preferring either is invisible until a caller wonders where half its message went.

Parsing is `marked`'s lexer; the rendering is ours, because the HTML an email needs is not
the HTML a browser needs:

- **Every style is inline.** Gmail discards `<style>` blocks and strips `<html>`/`<head>`/
  `<body>`, so a stylesheet is not a stylesheet -- an attribute is.
- **Tables carry `cellpadding`/`cellspacing`/`border` attributes** as well as CSS, because
  Outlook renders through Word and ignores half the CSS beside them.
- **`<pre>` wraps** (`white-space:pre-wrap` + `word-break`). A fenced code block is the one
  thing guaranteed to be wider than a phone, and an unwrapped `<pre>` widens the whole message.
- **`href`/`src` are scheme-filtered** to `http(s)`, `mailto:`, `tel:` and `cid:`. `cid:` is on
  the list on purpose: `![logo](cid:logo)` addresses an inline attachment from markdown.
- Task items render `☑`/`☐`, never `<input>` -- mail clients strip form controls.
- Raw HTML in the source passes through, as markdown says it must. That grants nothing new:
  the same key can post arbitrary `html` directly.

**Attachment transport:** local files <1MB ride inline as base64; files >1MB (or any with
`--upload`) are presigned + PUT to R2 (`outbound/temp/{box}/`) and pulled by the Worker at send
time; the Worker only pulls keys under the sending box's own prefix. URLs are fetched
server-side over HTTP(S) with a 15 second timeout. The Worker accepts an 8 MiB JSON request
body, at most 32 attachments, 5 MiB per inline base64 attachment, and 16 MiB of decoded
attachment data in total, leaving room below Cloudflare's 25 MiB assembled-message cap; the
recipient list remains capped at 50 combined to/cc/bcc.

**YAML template** keys are camelCase, mirroring the flags (`drop`/`from`, `to`, `cc`, `bcc`,
`replyTo`, `fromName`, `subject`, `body`, `bodyHtml`, `markdown`, `topic`, `inReplyTo`,
`attach`/`attachments`).
CLI flags override template values; `--to` replaces the template's recipient list.

## Static Site Hosting

Publish files publicly under a box at `https://{HOST_DOMAIN}/f/{box}/{site}/`.
`HOST_DOMAIN` is a single dedicated hostname, not a zone-wide wildcard, so it
does not shadow unrelated subdomains. Uploaded HTML never shares the application
origin. Both routes use the same Worker; `run_worker_first = true` lets
`src/index.ts` reject every non-hosting path on `HOST_DOMAIN` before the asset
binding can serve the SPA. Application-origin asset requests are delegated back
to `env.ASSETS`.

- **Origin gate** (`src/index.ts`, runs before every other route): on `HOST_DOMAIN`, only
  `GET`/`HEAD` under `/f/` reach `serveHostedSite`; every other path or method is a bare
  `404`, so `/api/*`, `/h/*` and the SPA do not exist there. `HOST_DOMAIN` unset or equal
  to `DOMAIN` is a `503` on every request.
- **Legacy links:** `GET`/`HEAD` on `{DOMAIN}/f/*` answer `301` to the same path and query
  on `HOST_DOMAIN` (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`; the query is
  kept so a private site's `?auth=` survives). Other methods are `404`. The application
  origin never serves the bytes.
- **DNS:** the route for `HOST_DOMAIN` is generated by the deploy, the proxied DNS record
  for it is not. See "Out-of-band steps".
- **R2 layout:** `sites/{box}/{site}/{relpath}` (relpath preserved verbatim, traversal-safe).
- **Serving** (`lib/hosting.ts` `serveHostedSite`): inline real content-types, `index.html`
  at directory roots, `301` no-slash -> slash so relative links resolve, `404` for misses,
  `410` if the site's TTL expired, `401` if a private `auth_token` is set and `?auth=` doesn't match.
  `/f/` and `/f/{box}` with no site `302` to the app root. Every file carries
  `X-Content-Type-Options: nosniff` and `Cache-Control: public, max-age=3600`; a private
  site's files and its 401/404/410/301 answers carry `private, no-store` instead.
- **Registry:** `hosted_sites` D1 table (migration `0007`) -- inbox, site, file_count,
  total_bytes, optional `auth_token` (private), optional `expires_at` (TTL).
- **API** (`api/host.ts`, API key with write to the box):
  - `POST /api/host/presign/:box` `{site, path, contentType}` -> presigned PUT into `sites/`
  - `POST /api/host/finalize/:box` `{site, ttlHours?, authToken?}` -> registers site, counts derived from R2
  - `GET /api/host/sites/:box` -> list ; `DELETE /api/host/sites/:box/:site` -> purge R2 prefix + row
- **CLI** (prints the site URL from `HOST_DOMAIN` in the shell env or `.env`, falling back to
  the host of `AGENT_DROP_URL` when unset, which prints the app domain, not the real hosting URL):

```bash
drop host lisa marketing ./dist        # upload a folder as site "marketing"
drop host lisa docs ./a.html ./img/b.png --base .   # explicit files, keep relative paths
drop host lisa promo ./site --ttl 7d   # auto-expire after 7 days
drop host lisa private ./site --auth s3cr3t   # require ?auth=s3cr3t to view
drop sites lisa                        # list hosted sites
drop unhost lisa marketing             # delete (purges R2 + registry)
```

Hosted pages should use **relative** asset paths (`./style.css`), since absolute paths
(`/style.css`) resolve outside the `/f/{box}/{site}/` prefix.

## DNS Records (frst.dev)

| Type | Name | Value | Purpose |
|------|------|-------|---------|
| MX | frst.dev | route{1,2,3}.mx.cloudflare.net | CF Email Routing (inbound) |
| CNAME | `*._domainkey.frst.dev` | `*.dkim.amazonses.com` (x3) | SES DKIM |
| MX | agent.frst.dev | feedback-smtp.eu-central-1.amazonses.com | SES MAIL FROM |
| TXT | agent.frst.dev | `v=spf1 include:amazonses.com ~all` | SPF for MAIL FROM |
| TXT | frst.dev | `v=spf1 include:_spf.mx.cloudflare.net include:_spf.protonmail.ch include:amazonses.com ~all` | Root SPF |
| TXT | _dmarc.frst.dev | `v=DMARC1; p=quarantine; ...` | DMARC |
| A / AAAA / CNAME (proxied) | `{HOST_DOMAIN}` | any proxied placeholder record; the Worker route answers, the target is never contacted | Hosted-sites origin. The deploy creates the route, not this record |

## Dev loop & Deployment

`@cloudflare/vite-plugin` runs the Worker inside `vite dev`, so one process
serves the SPA **and** `src/index.ts` in workerd with live D1/R2/Queue/assets
bindings. There is no `/api` proxy and no separate `wrangler dev`.

```bash
bun install
bun run dev            # SPA + Worker + real bindings, one process
bun run db:migrate:local   # seed the local D1 (first run only)
bun run build          # -> web/dist/client (assets) + web/dist/agent_drop (worker + wrangler.json)
bun run deploy         # build, then deploy the generated config
bun run verify         # the green gate: check + build + deploy --dry-run
```

**Deployment identity.** The committed `wrangler.toml` carries only
placeholders (`example.com`, `files.example.com`, `your-cloudflare-account-id`,
`your-d1-database-id`, `your-google-client-id`) so the public repo leaks nothing.
It declares two `[[routes]]` (`DOMAIN/*` and `HOST_DOMAIN/*`, both on `ZONE_NAME`). `vite.config.ts`
injects the real values from `.env` through the plugin's `config` hook
(`scripts/deploy-identity.ts`), which writes them into the generated
`web/dist/agent_drop/wrangler.json`. `scripts/deploy.ts` locates that config via
`web/.wrangler/deploy/config.json`, **refuses to deploy if it does not match
`.env`**, and hands it to wrangler. The committed `wrangler.toml` is never
written to.

Because of that indirection, a bare `wrangler deploy` from the repo root would
silently deploy the placeholder config. Always go through `bun run deploy`.

`vite build` also writes `web/dist/agent_drop/.dev.vars` containing **every
secret in `.env` in plaintext** (the plugin's local-dev secret injection). It is
inside a gitignored directory and `.assetsignore` keeps it out of the asset
upload -- but do not `cp -r` the build output anywhere public.

### Out-of-band steps the deploy does NOT do

Five things live outside `wrangler.toml` and must exist before, or the code is
inert (and the first one makes the deploy itself fail):

```bash
# 1. The R2-event queue. Declared as a consumer in wrangler.toml, so a deploy
#    before it exists FAILS.
wrangler queues create agent-drop-r2-events

# 2. The bucket notification rule. Bucket config, not wrangler.toml, and lost if
#    the bucket is ever recreated.
wrangler r2 bucket notification create agent-drop-storage \
  --event-type object-create --queue agent-drop-r2-events --prefix "drops/"

# 3. Migrations, BEFORE the deploy. Every one of them is a table or column the
#    new code writes to on its first request: 0008 `object_key` (presigned
#    uploads), 0009 the two webhook tables, 0010 `payload_mode`, and 0011 the
#    authenticated relay reply routes.
bun run db:migrate          # = vite build + wrangler d1 migrations apply --remote

# 4. The webhook-body lifecycle rule. Bucket config again, same fragility.
wrangler r2 bucket lifecycle add agent-drop-storage hooks-130d "hooks/" --expire-days 130

# 5. The HOST_DOMAIN DNS record. The deploy registers the Worker route for it, but
#    a route only fires for traffic that reaches Cloudflare: add a PROXIED
#    (orange-cloud) A/AAAA/CNAME record for HOST_DOMAIN in the zone (any placeholder
#    target, e.g. AAAA 100::), same as DOMAIN has. Without it hosted sites do not
#    resolve and the {DOMAIN}/f/* redirect lands on NXDOMAIN.
```

**Use `bun run db:migrate`, not a bare `wrangler d1 migrations apply`** -- the
committed `wrangler.toml` carries placeholder account and database ids, so the
bare form fails with a "could not route" API error. The script builds the real
config first and points wrangler at it, exactly as `bun run deploy` does.

The cron trigger needs nothing extra -- `bun run deploy` registers it, and the
webhook receivers reuse the existing `agent-drop-webhooks` queue, so they need no
`queues create` of their own. Until step 2 lands, `/api/upload/confirm` completes
drops exactly as it always did and the reaper is the backstop, so a partial
rollout degrades rather than breaks. Step 4 is the same shape: without it,
webhook bodies in R2 simply never expire, while D1 keeps pruning on time. Step 5
is silent in the other direction: the deploy succeeds and nothing warns, and the
first sign is a hosted URL that does not resolve.

Account: **Duplo**. The account id lives in `.env` (`CLOUDFLARE_ACCOUNT_ID`),
never in a tracked file -- `wrangler.toml` carries a placeholder for exactly
this reason.

## Rules Engine (Forwards + Webhooks)

Pattern-matched rules that fire when drops arrive **and when webhook events do**.
ALL matching rules fire (cascading, not first-match).

The engine takes a `RuleSubject` -- a small interface with mostly-optional
fields that both a `Drop` and a `WebhookEvent` satisfy structurally. An email has
a `from_addr` and no `slug`; a webhook event has a `slug` and no `subject`.
Making the fields optional is what let the fourth channel arrive without a single
existing call site or rules test changing.

### Patterns

| Pattern | Matches | `{name}` capture |
|---------|---------|-----------------|
| `*` | everything | full inbox name |
| `lisa` | exact match | (none) |
| `shop-*` | `shop-returns`, `shop-eu` | `returns`, `eu` |
| `*-invoices` | `lisa-invoices`, `hr-invoices` | `lisa`, `hr` |

### Template Variables

Available in forward targets and webhook headers:

| Variable | Value |
|----------|-------|
| `{inbox}` | Full normalized inbox name |
| `{name}` | Wildcard capture from pattern |
| `{topic}` | Email +addressing topic |
| `{from}` | Sender email address |
| `{subject}` | Email/drop subject |
| `{drop_id}` | Drop ID (the event id on the `hook` channel) |
| `{channel}` | `email`, `web`, `api`, or `hook` |
| `{slug}` | Receiver slug (`hook` channel) |
| `{event_type}` | Extracted event type (`hook` channel) |
| `{routing_key}` | Extracted correlation handle (`hook` channel) |

`{routing_key}` is the one worth reaching for: a rule targeting
`https://x/{routing_key}` files each event under the entity the provider echoed
back (17TRACK's `data.tag`, a parcel number, a customer id).

### Scopes

A rule's `scope` is `all`, or one of `email` / `web` / `api` / `hook`.
**`all` means all, including `hook`** -- a scope word that quietly excluded the
newest channel would be a lie in the data. The one rule type that could surprise
an existing operator, `forward`, never fires on anything but email anyway.

### Webhook Payload

Webhooks POST JSON to the target URL. A **drop** publishes `drop.created`:

```json
{
  "event": "drop.created",
  "drop": {
    "id": "01kn6g82k0...",
    "inbox": "lisa",
    "channel": "email",
    "topic": "invoices",
    "subject": "Invoice #2847",
    "from_addr": "accounting@example.com",
    "body_text": "Plain text body (quote-stripped for emails)",
    "has_attachments": 1,
    "attachment_count": 1,
    "metadata": {
      "auth_method": "email",
      "from_name": "Accounting Dept",
      "from_header": "Accounting Dept <accounting@example.com>",
      "message_id": "<abc123@mail.example.com>",
      "sender_auth": {
        "authserv": "mx.cloudflare.net",
        "spf": [
          { "result": "none", "props": { "smtp.helo": "mta1.example.com" } },
          { "result": "pass", "props": { "smtp.mailfrom": "bounce@example.com" } }
        ],
        "dkim": [{ "result": "pass", "props": { "header.d": "example.com", "header.s": "s1" } }],
        "dmarc": [{ "result": "pass", "props": { "header.from": "example.com", "policy.dmarc": "reject" } }]
      }
    },
    "created_at": 1775112960019
  },
  "rule": {
    "id": "43858f85-...",
    "pattern": "lisa"
  },
  "captures": {
    "inbox": "lisa",
    "name": "lisa",
    "topic": "invoices",
    "from": "accounting@example.com",
    "subject": "Invoice #2847",
    "drop_id": "01kn6g82k0...",
    "channel": "email"
  }
}
```

A **webhook event** publishes its own envelope, `hook.received`, and NOT a
`drop`. It has no subject, no sender and no attachments, and it has a slug, a
routing key and a verification verdict that no drop has; dressing one as the
other would hand every consumer a `drop` that is mostly nulls and hide the three
fields it wanted. The `rule` and `captures` frames are identical.

```json
{
  "event": "hook.received",
  "hook": {
    "id": "01m025m0f5...",
    "inbox": "lisa",
    "slug": "stripe-prod-k7f2q9m4v6x8z1a3b5c7d9e2fg",
    "event_type": "charge.succeeded",
    "routing_key": "cus_42",
    "method": "POST",
    "content_type": "application/json",
    "body": "the provider's body, verbatim, when it was inline UTF-8",
    "body_bytes": 143,
    "body_sha256": "573425f3b945...",
    "body_available": true,
    "verified": 1,
    "headers": { "stripe-signature": "t=...,v1=...", "authorization": "<redacted>" },
    "query": {},
    "created_at": 1775112960019
  },
  "rule": { "id": "43858f85-...", "pattern": "lisa" },
  "captures": { "inbox": "lisa", "slug": "stripe-prod-k7f2q9m4v6x8z1a3b5c7d9e2fg", "...": "..." }
}
```

`body_available: false` means the bytes were too large or not UTF-8 and live in
R2 -- `passthrough` mode or `queue-body` is how you get them.

### Payload modes (`payload_mode`)

A rule sends one of two shapes. Migration `0010` added the column; `envelope` is
the default, so no existing rule changed meaning.

| Mode | Body | Headers |
|---|---|---|
| `envelope` | agent-drop's JSON wrapper, above | ours: `Content-Type: application/json`, `User-Agent: AgentDrop/1.0`, `X-Drop-Id`, `X-Webhook-Attempt`, plus the rule's |
| `passthrough` | the provider's **original bytes**, unmodified | the provider's own, minus redacted credentials and hop-by-hop, plus the rule's. **None of ours.** |

`passthrough` is what makes agent-drop a real relay: point Stripe at frst.dev,
get retries and an audit log, and your own service still sees exactly what Stripe
sent -- signature header included, so it can verify. "Exactly" does not survive
an extra `X-Drop-Id`, so passthrough adds none.

Rule headers are merged **case-insensitively**. `{"User-Agent": x}` and
`{"user-agent": y}` are two object keys and one HTTP header; a plain spread keeps
both and `fetch` sends `User-Agent: x, y`, a value nobody wrote.

The passthrough body is fetched from the stored event at **delivery** time, not
carried in the queue message -- a body may be a megabyte and a queue message may
not, and a source that has been destroyed fails permanently instead of retrying
for a day against bytes that no longer exist.

### Webhook Headers

Every `envelope`-mode webhook request includes:

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `User-Agent` | `AgentDrop/1.0` |
| `X-Drop-Id` | Drop or event ID |
| `X-Webhook-Attempt` | Attempt number (1, 2, 3...) |
| Custom headers | From rule `headers` config (variables substituted) |

### Webhook Delivery (Queue-Based)

Webhooks are delivered via CF Queue (`agent-drop-webhooks`), not inline:

1. Rule fires -> webhook message pushed to queue
2. Queue consumer processes with exponential backoff
3. Backoff: 2s, 4s, 8s, 16s, 32s... up to 20min cap
4. Retries for up to 24 hours before marking failed
5. Every attempt logged in `delivery_log` table

Delivery statuses: `queued` -> `retrying` -> `success` | `failed`

The attempt counter is **`Message.attempts`**, the platform's own. It used to be
read out of the message body, which `retry()` re-enqueues unchanged -- so it was
0 forever, the ladder above was two seconds flat (roughly 43,200 requests at a
dead target over the 24h window instead of ~80), and `delivery_log.attempts`
reported 1 throughout so nobody could see it. A counter that has to grow between
retries cannot live in the thing that gets re-enqueued.

**A hook rule pointed at this instance's own `/h/` URL is refused**, logged
`failed`, and never queued. That is where the loop closes -- event arrives, rule
re-delivers to the same receiver, the copy fires the same rule -- with 24 hours
of retries behind every hop. Drop rules are left alone: a drop rule pointed at a
receiver makes one event and stops.

**A `handshake` or `rejected` event is never re-delivered**, by a rule or by
`hook-replay`. A refusal is not a delivery.

### Forwards

Email forwards execute inline by **re-sending via the Cloudflare Email Sending binding** (`forwardViaBinding` in `lib/relay.ts`), NOT `message.forward()`. `message.forward()` only delivers to CF-verified destination addresses; re-sending via the unrestricted `EMAIL` binding reaches any address (frst.dev is onboarded for Email Sending). The forwarded mail is `From: "<sender> (via {box}@frst.dev)" <{box}@frst.dev>` (so frst.dev DKIM/SPF apply) with the original sender in `Reply-To`, carrying the full unstripped body + original attachments. Logged in `delivery_log` with status `success` or `failed`.

A single forward rule's `target` may be a **comma-separated list** of addresses; each is delivered and logged independently. CLI: `rule-add --forward` is repeatable / comma-aware.

> Inbound email reaches the worker via the CF Email Routing **catch-all** (`*@frst.dev` -> worker `agent-drop`), so every box captures mail without per-address rules.

### CLI

```bash
# List rules
bun tools/agent-drop.ts rules

# Add forward rule
bun tools/agent-drop.ts rule-add "*" --forward "owner+drop+{inbox}@example.org" --scope email
bun tools/agent-drop.ts rule-add "lisa" --forward "lisa@example.com" --scope email
bun tools/agent-drop.ts rule-add "shop-*" --forward "owner+shopping+{name}@example.org" --scope email

# Add webhook rule
bun tools/agent-drop.ts rule-add "*" --webhook "https://hooks.example.com/drops" --scope all
bun tools/agent-drop.ts rule-add "lisa" --webhook "https://api.example.com/ingest" --scope email --header "X-Api-Key:abc123"

# Relay a provider's webhooks onward, byte-for-byte
bun tools/agent-drop.ts rule-add "lisa" --webhook "https://mine.example.com/stripe" \
  --scope hook --payload-mode passthrough

# Test which rules would fire (dry run)
bun tools/agent-drop.ts rule-test shop-returns --channel email
bun tools/agent-drop.ts rule-test lisa --channel web
bun tools/agent-drop.ts rule-test lisa --channel hook

# Enable/disable
bun tools/agent-drop.ts rule-disable RULE_ID
bun tools/agent-drop.ts rule-enable RULE_ID

# Update
bun tools/agent-drop.ts rule-update RULE_ID --target "new@email.com"

# Delete
bun tools/agent-drop.ts rule-remove RULE_ID

# View delivery log
bun tools/agent-drop.ts deliveries
bun tools/agent-drop.ts deliveries --status failed
bun tools/agent-drop.ts deliveries --drop DROP_ID
```

## Email Relay (Masked Bidirectional Email)

Apple "Hide My Email" style relay. Sender never sees the real address.

### How It Works

```
INBOUND: sender@example.com -> j-7k9m@frst.dev
  1. Worker detects mask j-7k9m
  2. Finds relay rule j-* -> target owner@example.org
  3. Mints an opaque reply+<130-bit-token>@frst.dev route, used as both From and Reply-To
  4. Queues raw MIME, replayed via the CF Email Sending binding -> owner@example.org

REPLY: the owner replies to reply+<130-bit-token>@frst.dev
  1. Worker hashes the token and resolves its stored route
  2. Route yields sender=sender@example.com, mask=j-7k9m
  3. Sends From: j-7k9m@frst.dev To: sender@example.com
  4. Sender never sees owner@example.org
```

### Relay Reply Routes

```
Original sender: lisa@example.com
Mask: j-7k9m

Relay reply-to: reply+0123456789abcdefghjkmnpqrs@frst.dev
                ^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^
                prefix 130-bit lowercase token
```

Migration `0011` stores only the token's SHA-256 digest plus its sender and mask.
A new route is minted for every inbound relayed message. Routes are reusable and
deliberately have no expiry, so replying to an old thread still works; disabling
a mask makes them inert and deleting it (`DELETE /api/masks/:id`) removes its
rows. The fixed 32-character local part also supports sender addresses that
would not fit if their text and a signature were embedded under SMTP's
64-character limit.

A `reply+<token>` that does not resolve (unknown token, disabled or deleted mask)
is rejected at SMTP with `Invalid relay reply address`; it never falls through to
become an ordinary inbox drop.

Pre-token `_at_` reply addresses are forgeable and rejected by default. An
existing deployment may set `RELAY_LEGACY_REPLY_UNTIL` to a short absolute
ISO-8601 cutoff for a bounded migration. Never enable it on a new deployment.

### Setup

```bash
# 1. Create relay rule (prefix pattern -> real email)
drop rule-add "j-*" --relay owner@example.org --scope email

# 2. Create mask (auto-generate or explicit)
drop mask-create --prefix j --label "shopping"     # j-7k9m@frst.dev
drop mask-create --id j-dating --label "dating"     # j-dating@frst.dev

# 3. Share the mask address: j-7k9m@frst.dev
```

### Mask Management

```bash
drop masks                    # list active masks
drop masks --all              # include disabled
drop mask-create --prefix j   # auto-generate
drop mask-create --id j-shop  # explicit ID
drop mask-disable j-shop      # stop forwarding (emails bounce)
drop mask-enable j-shop       # resume
drop mask-remove j-shop       # delete permanently (and its reply routes)
```

### Delivery

Relay emails are queued via CF Queue (same as webhooks). Exponential backoff 2s -> 20min cap, retry up to 24h. Logged in `delivery_log` with type `relay`.

The relay consumer reads Cloudflare's 1-based `Message.attempts`; `retry()`
re-enqueues an immutable body, so its deprecated `attempt` field never changes.
The shared consumer allows 82 retries: the capped ladder crosses 24 hours after
retry 81, then the age guard records `failed` and acknowledges the message.

### D1 Tables

- `email_masks` - mask ID, label, active flag
- `relay_reply_routes` - SHA-256 token digest, mask, original sender; no expiry
- `drop_rules` - type `relay` with pattern + target (real email)
- `delivery_log` - every relay attempt tracked

## Webhook Receivers (`/h/{box}/{slug}`)

The fourth ingest channel, and the only one whose producer agent-drop does not
control. A third party POSTs to a URL we own; we answer its setup handshake,
verify the sender, store the request **byte-identically**, and hand it to an
agent over a real pull queue. Faithful preservation is the whole product: a
consumer holding the provider's secret must be able to verify the signature from
what we stored, which is only true if nothing ever re-serialized it.

**Webhook events are a separate surface from drops.** Own table, own CLI verbs,
no subject and no attachments. The one bridge is the opt-in per-receiver
`mirror_to_drops` flag, off by default.

### The URL

```
https://frst.dev/h/{box}/{slug}
https://frst.dev/h/{box}/{slug}/anything/after    <- stored as `subpath`, same receiver
```

The Worker runs before assets on both configured origins, but `/h/*` exists only
on the app origin: `HOST_DOMAIN` answers it with `404`. `/h/*` deliberately
sits **outside** `/api/*`, whose invariant is "unknown path answers 401, not 404" -- a fully
public, unauthenticated, body-swallowing endpoint has no business in there.

For a receiver with `auth_mode: none` **the URL is the credential**, so
`hook-create` appends a 130-bit random suffix
(`stripe-prod-k7f2q9m4v6x8z1a3b5c7d9e2fg`) unless `--slug` says otherwise, and
says so out loud. An exact slug on an `authMode: none` receiver is deliberately
public/guessable; use the generated default unless that is intentional.

### Request handling (`src/lib/webhook-receive.ts`)

The order is the contract, not a style choice:

```
resolve receiver -> method -> burst limit -> size cap -> read raw BYTES and hash
them -> handshake -> daily cap -> verify -> extract -> store -> respond
```

- The body is read **once, as bytes** (`readBodyCapped`, which never holds more
  than `max_body_bytes` and cancels the stream past it) and hashed before
  anything decodes it. `body_text` is filled only when the bytes were valid
  UTF-8; otherwise the body lives in R2 unmodified. Nothing downstream
  re-serializes.
- Bodies <= 64 KiB and UTF-8 store inline in D1; anything else goes to
  `hooks/{box}/{slug}/{id}` in R2.
- **The response goes out the moment the row lands.** Rule firing and counters
  ride `ctx.waitUntil`. Zoom allows 3 seconds; 17TRACK turns any non-200 into
  three more copies over 100 minutes.
- **An unparseable or unrecognised body is a successful receive.** Unknown event
  types, dashboard test pings and malformed JSON all store and return 200. The
  receiver's job is to preserve, not to understand.

### Status codes -- what the provider sees

| Situation | Status | Why |
|---|---|---|
| Stored, or a handshake answered | `200` | |
| Duplicate of a stored `dedupe_key` | `200 {"duplicate":true}` | Never 409 -- a 4xx makes it retry what we deliberately discarded |
| Slug never registered | `404` | `403` would confirm the slug is real to an enumerator |
| Registered but **disabled** | `403` | It exists; the operator turned it off |
| Registered but **expired** | `410` | Gone permanently, stop sending |
| Old slug inside its `--grace` window | `200` | Rotation must not drop traffic mid-cutover |
| Method not in `allowed_methods` | `405` + `Allow:` | |
| Body over `max_body_bytes` (default 1 MiB) | `413` | `Content-Length` checked first; a chunked body declares none, so the read itself stops at the cap |
| Signature wrong | `401` | Stored `rejected`, burns an `AUTH_RATE_LIMIT` token |
| Burst limit or daily cap | `429` + `Retry-After` | |
| Our own failure (D1/R2 down) | `503` | The ONLY case that should make a provider retry |

### Headers: preserve, don't curate

The **complete** header map is stored. Only headers that are credentials in
their own right are redacted -- `Authorization`, `Cookie`, `Proxy-Authorization`,
plus whatever this receiver's `auth_config` names as a shared secret. The same
redaction list applies to the query string.

**Signature headers are kept verbatim.** An HMAC or digest proves one specific
body came from the signer and is worthless against any other request; redacting
it would only make consumer-side verification impossible, which is the one thing
a faithful receiver exists to enable. The exception carve-out is exact:
`auth_config.header` names the SHARED SECRET under `header` mode and the
SIGNATURE under `hmac`/`digest`, so those two modes are the only ones where that
header survives.

### Verification (`auth_mode`)

`src/lib/webhook-verify.ts`, all comparisons constant-time. `SUPPORTED_AUTH_MODES`
is **derived** from the verifier's own dispatch table, so a registerable mode
nothing implements cannot exist.

| Mode | Header | Signed string | Encoding |
|---|---|---|---|
| `none` | -- | -- | -- |
| `standard` | `webhook-signature` (`v1,<b64>`) | `{id}.{ts}.{body}` | base64, 5-min window |
| `github` | `X-Hub-Signature-256` | `{body}` | hex |
| `stripe` | `Stripe-Signature` (`t=,v1=`) | `{t}.{body}` | hex, 5-min window |
| `slack` | `X-Slack-Signature` | `v0:{ts}:{body}` | hex, 5-min window |
| `shopify` | `X-Shopify-Hmac-Sha256` | `{body}` | base64 |
| `hmac` | configurable | template over `{body}` `{ts}` `{id}` `{method}` `{path}` `{url}` `{secret}` | hex or base64 |
| `digest` | configurable | plain `SHA-256(template)`, **not** HMAC -- e.g. 17TRACK's `sign` = `SHA256_hex({body}/{secret})` | hex or base64 |
| `bearer` / `basic` / `header` / `query` | -- | shared secret, compared directly | -- |

- The signed message is assembled as **bytes**, never as a string, so a
  non-UTF-8 body verifies against what actually arrived.
- `standard` and `stripe` send **several** signatures mid-rotation. Any match
  passes, and every candidate is compared even after one matches.
- Hex compares case-insensitively and zero-pads up to width: 17TRACK's
  `BigInteger` encoding drops leading zeros, so ~1 in 256 signatures is 63 chars.
- `verified` is three-valued: `1` pass, `0` fail, `NULL` never asked. A 401's
  body says nothing about why -- the reason goes to the logs.
- **`auth_mode: none` is a supported end state**, not a half-configured one. A
  consumer that would rather hold the provider's key and verify the bytes itself
  gets exactly that.

### Handshakes (`handshake_mode`)

`src/lib/webhook-handshake.ts`. Detection runs **before** verification and never
falls through to it -- a provider sends its challenge before any secret has been
agreed, so a handshake gated on a signature is a receiver that can never be set
up. Handshake requests are stored with `status='handshake'`, never deduped,
never counted in `event_count`.

| Mode | Trigger | Response |
|---|---|---|
| `meta` | `GET` + `hub.mode=subscribe` + `hub.challenge` | `hub.challenge` verbatim, bare `text/plain`. Covers Facebook, WhatsApp, Instagram, Threads |
| `slack` | `{"type":"url_verification"}` | `{"challenge":...}` |
| `zoom` | `{"event":"endpoint.url_validation"}` | `{plainToken, encryptedToken: hex(HMAC-SHA256(plainToken, secret))}`. Re-fires every 72h; six consecutive failures disable the endpoint |
| `echo` | any short non-JSON body | the raw body verbatim |
| `static` | a configured predicate | fixed status + body |

- Detection is on **shape**, and a failed handshake is still a handshake: a
  `meta` request with the wrong `hub.verify_token` answers `403` rather than
  falling through to `{"ok":true}`, which is not the challenge.
- Every handler may **decline**, so the same URL still takes ordinary deliveries.
- A config that could not answer is **refused at registration** (`meta` with no
  token, `zoom` with no secret, `static` with an empty predicate), and a `meta`
  receiver gets `GET` added to its method list automatically.
- **A storage failure does not fail a handshake.** The one place a failed write
  is not a 503: there is no event to keep, the answer is the whole product.

### Extraction

Three fields are pulled out per receiver, by preset or by configured dotted path
over the parsed body. A parse failure is non-fatal -- the event still stores and
the fields are NULL.

| Preset | `event_type` | `dedupe_key` |
|---|---|---|
| `github` | header `X-GitHub-Event` | header `X-GitHub-Delivery` |
| `stripe` | `$.type` | `$.id` |
| `standard` | `$.type` | header `webhook-id` |
| `slack` | `$.event.type` | header `X-Slack-Request-Timestamp` + body hash |
| `shopify` | header `X-Shopify-Topic` | header `X-Shopify-Webhook-Id` |
| generic | configured path | configured header/path, or `body-hash` |

`routing_key` has no preset -- only the operator knows which field correlates
(`data.tag`, `$.data.object.customer`). It is indexed, so `queue-list --key` is a
server-side filter.

**Dedupe.** Every provider retries on a slow response with the same message id,
so the partial unique index on `(receiver_id, dedupe_key)` is what stops one
flaky 3-second response becoming four copies. No message id means `dedupe_key`
is NULL and nothing dedupes, which is correct by default -- two byte-identical
bodies can be two real events. `--dedupe body-hash` opts in, bucketed as
`{sha256}.{floor(now/window)}` with the previous bucket checked as an alternate
(a bare hash could never expire, since the index has no time column). This
narrows the window; it does not close it.

**A `rejected` row never carries a dedupe key.** Otherwise: wrong secret -> 401
stored `rejected` -> operator fixes the secret -> the provider retries the same
bytes -> `200 {"duplicate":true}`, nothing stored, the provider stops, and the
only row left is one no lease will ever hand out.

### The pull queue

At-least-once with leases. `queue-get` leases, the agent works, `queue-remove`
acks. One atomic `UPDATE ... RETURNING` with a subselect does the lease; an
expired lease returns to the pool implicitly, with no sweeper.

| Verb | Row after | Use |
|---|---|---|
| `queue-remove` | kept, `acked_at` set, out of the queue, readable and replayable until `expires_at` | the default "I processed this" |
| `queue-get --remove` | same, but at handout | at-most-once, no lease bookkeeping |
| `queue-get --delete-on-success` | **destroyed** as each message is written out | the consumer is the archive |
| `queue-delete` | **destroyed**, R2 body too | junk, test pings, a misconfigured provider's noise |
| `queue-return` | back on the queue immediately | the nack |

- **`queue-peek` takes no lease and changes nothing.** Peeking a leased message
  shows who holds it and for how long. It is a GET; `get` is a POST. So a peek is
  retry-safe, cacheable, servable to a read-only key, and you cannot consume a
  queue by accident with a curl you meant as a look.
- `queue-extend` will not resurrect an **expired** lease (it is back in the pool
  and may already be someone else's) and takes an optional `--lease-id`.
- `queue-requeue` admits removed and rejected rows only. Handshakes never
  requeue, and `queue-remove` refuses one -- `acked` has no way back for a row
  whose only purpose is evidence.
- `--delete-on-success` destroys after the write **returned**, which down a pipe
  means the OS accepted the bytes, not that the reader processed them. The
  guarantee is the remainder: a pull that dies halfway leaves it leased, not
  destroyed.
- `?since=<event id>` is an arrival cursor (ULID), granular to the
  **millisecond** -- two events landing in the same one may sort either way.
  Providers do not guarantee delivery order anyway; a consumer that cares must
  sort by the provider's own timestamp inside the body.
- `queue-put` injects through the **same** code path a provider takes, including
  the parts that say no: an unsigned injection into a signed receiver answers 401
  and stores `rejected`. There is no flag that writes `verified=1` for a
  signature nothing checked.

### Rotation

`hook-rotate` issues a new slug on the same row, so events (which key on
`receiver_id`) all survive. `--grace 24h` keeps the old slug answering during a
dashboard cutover. `--receiver` filters resolve through the receiver **row** --
id, current slug or pre-rotation slug -- so rotation costs no history.

### Retention

- Per-receiver `retention_days`, default **120**. `expires_at` is stamped at
  INSERT, never recomputed at read: raising a receiver's retention must not
  resurrect what aged out, and lowering it must not retroactively destroy
  history somebody was promised.
- `rejected` events get **7 days**, hardcoded. They are evidence for a rotated
  secret, not an archive.
- The hourly cron (`src/lib/hook-reaper.ts`) destroys rows past `expires_at`,
  500 per run, oldest first, **R2 bodies before rows**. A body that will not
  delete leaves its row behind on purpose, so the next tick tries again --
  dropping the row would strand the bytes with nothing pointing at them.
- R2 lifecycle on `hooks/` is **130 days**, deliberately longer than D1, so D1
  stays authoritative and the bucket is a backstop rather than a source of
  surprise 404s.

### Security posture

- The receiver URL is **public and unauthenticated by design**. `auth_mode` is
  what makes it trustworthy; `none` means anyone who learns the URL can write to
  that box's queue.
- `HOOK_RATE_LIMIT` fails open like the other two, so the per-receiver
  `daily_cap` (counted in D1 over a rolling 24h) is the actual bound. Every row
  counts towards it, whatever its status -- a flood of garbage that fails
  verification grows the table exactly as fast as real traffic.
- **The daily cap does not refuse a handshake.** It bounds rows, and a handshake
  does not need one; refusing a Zoom CRC over a cap costs the operator their
  endpoint registration to save one row. The burst limiter is what stops a
  handshake flood.
- Secrets are plaintext in `auth_config` (same posture as `drop_tokens`),
  admin-read-only. The list API returns `secret_set: true`, never the value.

### API

Receiver CRUD is `asAdmin` and prefix-routed. Queue reads are `keyedReader`;
everything that leases, mutates or destroys is `keyedWriter`. Same gates as
everything else, no new auth concepts.

```bash
# Receivers (admin key)
POST   /api/hooks/receivers                  create
GET    /api/hooks/receivers[/:box|/:id]      list all / list a box / get one
PATCH  /api/hooks/receivers/:id              update, enable/disable, rotate the secret
POST   /api/hooks/receivers/:id/rotate       rotate the SLUG, keep the row and history
DELETE /api/hooks/receivers/:id              delete (?purge=1 destroys its events)

# Queue reads (API key, read) -- no lease taken, nothing mutated
GET    /api/hooks/queue/:box                 list (?receiver= ?status= ?key= ?since= ?limit=)
GET    /api/hooks/queue/:box/stats           counts by status, bytes, last arrival
GET    /api/hooks/queue/:box/:id             peek one
GET    /api/hooks/queue/:box/:id/body        raw bytes, original content-type
POST   /api/hooks/queue/:box/peek            peek N

# Queue writes (API key, write)
POST   /api/hooks/queue/:box/get             LEASE n and return them
POST   /api/hooks/queue/:box/put             inject as if a provider sent it
POST   /api/hooks/queue/:box/remove          {ids} -- the ack
POST   /api/hooks/queue/:box/return          {ids} -- release the lease now
POST   /api/hooks/queue/:box/extend          {ids, leaseSeconds}
POST   /api/hooks/queue/:box/requeue         {ids} -- removed/rejected -> queued
POST   /api/hooks/queue/:box/delete          {ids} | {removed:true} | {before:<id>}
DELETE /api/hooks/queue/:box/:id             destroy one
POST   /api/hooks/queue/:box/:id/replay      server-side re-delivery through the queue
```

`POST .../peek` is a POST only because it takes a body of ids; it still takes no
lease and runs under the read gate.

### CLI

```bash
# Receivers
drop hook-create lisa stripe-prod --auth stripe --secret whsec_...
drop hook-create lisa meta --handshake meta --handshake-token TOKEN
drop hook-create lisa track --auth digest --secret KEY --auth-header sign \
     --routing-key data.tag --dedupe body-hash --dedupe-window 65m
drop hooks                                   # alias for hook-list
drop hook-get lisa/stripe-prod               # full config, URL, counters
drop hook-url lisa/stripe-prod               # just the URL, for the clipboard
drop hook-test lisa/stripe-prod --secret ... # fire a correctly-signed synthetic request
drop hook-update REF --disable | --secret ... | --retention 90 | --daily-cap 5000
drop hook-rotate REF --grace 24h
drop hook-delete REF [--purge]
drop hook-replay lisa EVENT_ID [--to URL] [--mode passthrough]

# The queue
drop queue-list lisa [--receiver x] [--status queued] [--key TAG] [--since ID]
drop queue-peek lisa [EVENT_ID]              # no lease, changes nothing
drop queue-get lisa --limit 10 --lease 60 [--remove | --delete-on-success]
drop queue-body lisa EVENT_ID -o file        # raw bytes, unmodified
drop queue-remove lisa ID...                 # the ack
drop queue-return lisa ID...                 # the nack
drop queue-extend lisa ID... --lease 300 [--lease-id ...]
drop queue-requeue lisa ID...
drop queue-delete lisa ID... | --removed | --before ID
drop queue-put lisa --receiver stripe-prod --body @file.json --header k:v
drop queue-stats [lisa]
drop queue-replay lisa EVENT_ID --to URL     # one-shot POST from HERE
```

**`hook-replay` and `queue-replay` are different verbs.** `hook-replay` is
server-side: it queues the stored event through the retry machinery and writes a
`delivery_log` row, and with no `--to` it re-fires whatever rules match now.
`queue-replay` POSTs the stored bytes from your machine, once, with no retries
and no log. Both `--help` texts say which is which.

`--json` on any read verb emits machine-shaped output, so an agent pipes it
straight into `jq`.

## Storage & TTL

- **R2 inbound blobs (`drops/`):** auto-deleted after 90 days (lifecycle rule)
- **R2 outbound attachments (`outbound/temp/`):** auto-deleted after 30 days (lifecycle rule). Uploaded by `send-email` for files >1MB; pulled by the worker at send time. Optionally deleted right after send via `--delete-after-send`.
- **R2 hosted sites (`sites/`):** no auto-expiry lifecycle rule -- sites persist until `drop unhost` or, if a per-site TTL was set, are served `410` past `expires_at` (R2 bytes removed by `unhost`).
- **R2 webhook bodies (`hooks/`):** auto-deleted after 130 days (lifecycle rule) -- deliberately longer than the D1 retention below, so D1 stays authoritative and the bucket is a backstop rather than a source of surprise 404s.
- **R2 multipart:** incomplete uploads aborted after 7 days
- **D1 records:** kept forever (audit log) -- **except `webhook_events`**, which carry a per-row `expires_at` (the receiver's `retention_days`, default 120; 7 days for `rejected`) and are destroyed by the hourly cron, R2 body first.
- **Drop tokens:** expire per TTL (default 2h)
- **R2 CORS:** configured for `https://frst.dev` origin (PUT, GET, HEAD)

### R2 Bucket Configuration (reproducible)

Bucket: `agent-drop-storage`. All config below is set via `wrangler` and must be
reapplied if the bucket is recreated (lifecycle/CORS are bucket-level, not in `wrangler.toml`).

**Lifecycle rules** (`wrangler r2 bucket lifecycle list agent-drop-storage`):

| Rule name | Prefix | Action |
|-----------|--------|--------|
| `expire-drops-90d` | `drops/` | Expire objects after 90 days |
| `outbound-temp-30d` | `outbound/temp/` | Expire objects after 30 days |
| `hooks-130d` | `hooks/` | Expire objects after 130 days |
| `abort-multipart-7d` | (all) | Abort incomplete multipart uploads after 7 days |

```bash
wrangler r2 bucket lifecycle add agent-drop-storage expire-drops-90d "drops/" --expire-days 90
wrangler r2 bucket lifecycle add agent-drop-storage outbound-temp-30d "outbound/temp/" --expire-days 30
wrangler r2 bucket lifecycle add agent-drop-storage hooks-130d "hooks/" --expire-days 130
wrangler r2 bucket lifecycle add agent-drop-storage abort-multipart-7d "" --abort-multipart-days 7
```

**CORS** (`wrangler r2 bucket cors list agent-drop-storage`) - allows the SPA to PUT
presigned uploads directly to R2:

```json
[{
  "AllowedOrigins": ["https://frst.dev"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3600
}]
```

```bash
# Save the JSON above to cors.json, then:
wrangler r2 bucket cors set agent-drop-storage --file cors.json
```

**Event notifications** (`wrangler r2 bucket notification list agent-drop-storage`)
- the bucket tells the Worker when an upload lands, so a drop no longer depends
on the client coming back to call `/api/upload/confirm`. Like lifecycle and CORS
this is bucket config, not `wrangler.toml`, and must be reapplied if the bucket
is recreated. The consumer side IS in `wrangler.toml` (`[[queues.consumers]]`
for `agent-drop-r2-events`); there is deliberately no producer binding, because
R2 is the producer.

```bash
# The queue must exist before the notification rule can target it.
wrangler queues create agent-drop-r2-events

wrangler r2 bucket notification create agent-drop-storage \
  --event-type object-create \
  --queue agent-drop-r2-events \
  --prefix "drops/"
```

The `drops/` prefix is as narrow as R2 notification filters go (prefix/suffix
only, no globs), so the queue also carries email `raw.eml` and `attachments/`
writes. `parseUploadKey` in `src/lib/r2-events.ts` drops anything that is not
`drops/{box}/{id}/uploads/{file}`, and only ever moves a row that is still
`pending`.

**Cron trigger.** `[triggers] crons = ["17 * * * *"]` in `wrangler.toml` runs the
stale-`pending` reaper. It needs no separate provisioning -- `bun run deploy`
registers it. Locally it can be fired by hand against `bun run dev`:

```bash
curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=17+*+*+*+*"
```

## Project Structure

```
src/
  index.ts              -- Worker entry: HOST_DOMAIN gate, /api/, /f/* 301, /h/, assets; email + queue consumers + scheduled
  email-handler.ts      -- Inbound email -> D1 + R2 (with quote stripping + relay detection)
  types.ts              -- TypeScript interfaces
  api/
    router.ts           -- Two ordered route tables + the dispatch loop
    match.ts            -- exact / prefix / segments / segmentsThenRest matchers
    gates.ts            -- The auth gates the tables compose from, incl. scoped asAdminOrAdminKey (see below)
    cors.ts             -- isBrowserRoute + the scoped CORS headers
    admin-lists.ts      -- GET /api/drops + GET /api/boxes (filtered by an admin key's inbox_scope)
    inbox.ts            -- GET /api/inbox/:name (+ presigned download URLs, /:id/raw)
    drop.ts             -- POST /api/drop/:name (multipart capped at 32 files / 20 MiB each / 25 MiB)
    send.ts             -- POST /api/send/:name (Email Sending binding; request, attachment and header limits)
    host.ts             -- Static hosting: presign/finalize/list/delete (sites/ prefix)
    keys.ts             -- API key CRUD (validates permissions + inbox_scope)
    targets.ts          -- Temporary drop token CRUD
    users.ts            -- Allowed users CRUD (Google OAuth allowlist)
    upload.ts           -- Presigned R2 upload (presign, multipart capped at 100 x 50 MiB parts, complete, confirm)
    rules.ts            -- Rules CRUD + delivery log
    masks.ts            -- Email mask CRUD
    hooks.ts            -- Webhook receiver CRUD (asAdmin, prefix-routed)
    hook-config.ts      -- Receiver config validation + the secret-free public view
    hook-queue.ts       -- Queue reads: list / peek / one / body (keyedReader, inert)
    hook-lease.ts       -- The UPDATE...RETURNING lease, plus remove/return/extend/requeue
    hook-queue-write.ts -- put (through the real receive path), delete, stats
    hook-rotate.ts      -- New slug on the same row, previous_slug + grace window
    hook-replay.ts      -- POST .../:id/replay -- server-side, through the retry queue
  lib/
    auth.ts             -- API key + drop token validation, digest-compare isAdmin, API_KEY_PERMISSIONS
    body-limit.ts       -- readBodyCapped: stream a body, never retain more than a cap
    mail-auth.ts        -- Parses Cloudflare's Authentication-Results into drop metadata `sender_auth`
    compare.ts          -- constantTimeEqual, one copy, shared by auth and the verifier
    ratelimit.ts        -- The auth + upload rate-limit bindings, fail-open
    drops.ts            -- FinalizeDrop + resolveObjectKey (router AND reaper use it)
    id.ts               -- ULID-like ID generation
    normalize.ts        -- normalizeInbox + normalizeSlug + slugifyFilename
    hosting.ts          -- serveHostedSite ({HOST_DOMAIN}/f/{box}/{site}), normalizeSite, siteUrl
    rules.ts            -- Rule firing (matching, payload and delivery live next door)
    rule-match.ts       -- Pattern matching + scope filtering
    rule-payload.ts     -- The two wire formats, mergeHeaders, buildDelivery
    rule-deliver.ts     -- The retrying queue consumer (on Message.attempts)
    webhook-receive.ts  -- The /h/ flow: resolve -> method -> cap -> bytes -> store -> respond
    webhook-store.ts    -- Header/query collection + redaction, dedupe, the insert
    webhook-body.ts     -- sha256, strict UTF-8 decode, secretHeaders/secretParams
    webhook-extract.ts  -- Presets, dotted-path reader, dedupe key derivation
    webhook-defs.ts     -- HOOK_PREFIX, the DERIVED supported-mode lists, hookUrl, generatedSlug (130-bit suffix)
    webhook-verify.ts   -- Dispatch, replay windows, the 4 shared-secret modes
    webhook-crypto.ts   -- hmac/digest, hex/base64, buildSignedBytes (bytes, not strings)
    webhook-schemes.ts  -- The 7 signed schemes' header/parsing/template trivia
    webhook-handshake.ts -- meta/slack/zoom/echo/static, one dispatch table
    webhook-throttle.ts -- HOOK_RATE_LIMIT (fails open) + the D1 daily cap (does not)
    webhook-headers.ts  -- replayableHeaders: the ONE redaction + hop-by-hop filter
    webhook-load.ts     -- loadStoredBody: the ONE inline-vs-R2 reader
    hook-fanout.ts      -- Fire rules + mirror, for an accepted event only
    hook-reaper.ts      -- Cron sweep for webhook events past expires_at
    markdown.ts         -- Markdown -> email-safe HTML (marked's lexer, our renderer)
    email-builder.ts    -- EmailMessageBuilder construction + platform-limit validation
    mime.ts             -- Hand-rolled MIME: relay replay + /api/compose preview only
    relay.ts            -- Email relay (opaque reply routes, legacy cutoff) + forwardViaBinding + sendRawViaBinding (CF Email Sending)
    google-auth.ts      -- Google JWT verification against JWKS (size cap, fail-closed, rate-limited key refresh)
    xml.ts              -- Small strict XML reader (no DOMParser in workerd)
    s3-xml.ts           -- Reads/writes R2's multipart documents via xml.ts
    r2-events.ts        -- R2 object-create notification consumer (pending -> completed)
    reaper.ts           -- Stale-`pending` drop sweep + runSweeps (both cron sweeps)
web/
  index.html            -- SPA entry
  public/
    styleguide.html     -- Tokyo Night palette + component showcase
  src/
    main.tsx            -- React router setup
    components/
      Landing.tsx       -- FRST landing page
      InboxView.tsx     -- Box view + drop list + curl instructions
      DropZone.tsx      -- Drag & drop upload (presigned R2, file list, copy button)
      GoogleSignIn.tsx  -- GIS OAuth button + token handling
    styles/
      globals.css       -- Tokyo Night + neon theme
migrations/
  0001_initial.sql      -- drops, api_keys, outbound tables
  0002_drop_tokens.sql  -- drop_tokens table
  0003_allowed_users.sql -- allowed_users table
  0004_drop_status.sql  -- status column on drops
  0005_drop_rules.sql   -- drop_rules + delivery_log tables
  0006_email_masks.sql  -- email_masks table
  0007_hosted_sites.sql -- hosted_sites table (static hosting registry)
  0008_drop_object_key.sql -- object_key on drops (the presigned R2 key)
  0009_webhook_receivers.sql -- webhook_receivers + webhook_events, all indexes
  0010_rule_payload_mode.sql -- payload_mode on drop_rules, default `envelope`
  0011_relay_reply_routes.sql -- non-expiring opaque reply routes (digests only)
tools/
  agent-drop.ts         -- The CLI (Bun), every verb
  lib/
    hook-sign.ts        -- The producing half of the signature schemes, for hook-test
    queue-emit.ts       -- The --delete-on-success loop, extracted so its ORDER is testable
    rule-preview.ts     -- rule-test's prediction, including the engine's refusals
    cli-utils.ts        -- Output formatting, common flags, outputFlag (the program-wide -o shadows a subcommand's)
    secrets.ts          -- CLI key lookup: shell env var, else passage (`key NAME`)
test/
  helpers/              -- D1-over-bun:sqlite, Env builders, EMAIL + R2 doubles
  router-routes.test.ts -- The API's dispatch contract, route by route
  webhook-*.test.ts     -- receive / api / verify / handshake / queue / rules / throttle
  hook-reaper.test.ts   -- Retention: what the cron destroys and what it must not
  ...                   -- one suite per lib/ module it covers
scripts/
  deploy.ts             -- Deploy guard: refuses a config that disagrees with .env
  deploy-identity.ts    -- The .env -> Worker-config bridge
.github/workflows/
  ci.yml                -- install, wrangler types --check, typecheck, lint, test,
                           build, deploy dry-run (no secrets; uses .env.example)
docs/
  SECURITY-AUDIT.md     -- Security assessment + remediation scope (hosting origin, relay routes, scoped listings, bounded inputs)
  *-PLAN.md             -- Build plans with their STATE files (WEBHOOKS, MODERNIZE)
wrangler.toml           -- CF Worker config (R2, D1, Queues, ratelimits, crons, two routes)
vite.config.ts          -- Vite 8 + @cloudflare/vite-plugin + identity injection
biome.jsonc             -- Lint + format (tabs, double quotes, 100 cols)
```

## How the router dispatches

`src/api/router.ts` is **two ordered tables, not one**, and that is the behavior
rather than a style choice:

1. **Tier 1** is reachable without an API key. Each route carries its own gate:
   none (`/api/health`, `/api/config`), admin, admin-or-admin-key
   (`/api/drops`, `/api/boxes`: the admin credential sees every box, an
   `admin`-permission API key only its own `inbox_scope`), inbox-write
   (`/api/drop/*`, the presign routes), or finalize
   (`/api/upload/complete|confirm`, which recover the inbox from the drop ROW
   and re-run the write auth the presign required).
2. Then **every** remaining request must present a valid API key. A caller with
   no credential gets `401` on an unknown path, never `404`, so an anonymous
   prober cannot map the API.
3. **Tier 2** routes only decide what that already-validated key may do.

The admin routes match by `startsWith`, so `/api/keys/{id}` and even
`/api/keysfoo` land in the keys handler, which sub-routes itself. That is a
wart, preserved deliberately and pinned by a test.

Gates live once, in `src/api/gates.ts`, and a route names the one it wants
(`asAdmin`, `asAdminOrAdminKey`, `asWriter`, `asFinalizer`, `keyedWriter`,
`keyedReader`). Before
that they were pasted inline at four call sites and had drifted apart -- the
outbound-mail copy had stopped checking `inbox_scope`.

**Neither `/h/*` nor `/f/*` is in either table.** `src/index.ts` branches in this
order: the `HOST_DOMAIN` gate (hosted sites or `404`, nothing else), `/api/*` into
`handleAPI`, the `/f/*` legacy redirect, `/h/*` into the public webhook
receivers, and everything else to `env.ASSETS`. The receivers never reach
`handleAPI`, so the `/api/` invariant above stays true. Their *management* API
(`/api/hooks/*`) is in the tables like everything else.

Two ordering details in the hook routes are deliberate and pinned by tests:
`/queue/:inbox/stats` sits **before** `/queue/:inbox/:id`, which would otherwise
swallow "stats" as an event id; and every queue read filters by `inbox` AND id,
never id alone, so an event id by itself can never reach another box's row.

## Testing

```bash
bun test                 # the whole suite
bun run check            # types + typecheck (src/web/test/tools/scripts) + lint + test
bun run lint             # biome check .
bun run format           # biome check --write . -- run this BEFORE committing
bun run verify           # the green gate: check + vite build + deploy --dry-run
```

The suite runs on a **real D1**: `test/helpers/d1.ts` executes the actual
`migrations/*.sql` against an in-memory `bun:sqlite`, so "did this UPDATE match
a row" is answered honestly rather than by a mock. `test/setup.ts` (preloaded
via `bunfig.toml`) registers a virtual `cloudflare:email` module, without which
importing the router explodes under `bun test`.

Helpers worth knowing before writing a new suite:

| Helper | What it is for |
|--------|----------------|
| `makeEnv(overrides)` | A complete `Env` with fakes; override any binding |
| `makeCtx()` | Records `waitUntil` promises; `settle()` drains them |
| `makeBucket(objects)` | R2 over a plain map; records `heads` and `deletes` |
| `makeEmail()` | The `EMAIL` binding, recording builder vs raw sends |
| `gateStatement(env, sql)` | Holds a statement open, so a deferred write is distinguishable from an inline one |
| `env.DB.sessions` | Every `withSession` constraint asked for |
| `seedReceiver(env, opts)` | A `webhook_receivers` row written straight in (the CRUD has its own tests) |
| `env.DB.raw.query(...)` | The escape hatch every webhook suite asserts through -- read the ROW, not the handler's claim |

`makeBucket` keeps bodies **exactly** as they were put, byte for byte. Coercing
them to strings would make the receiver's one real promise untestable.
