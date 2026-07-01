# Agent Drop

**Dead-drop system for AI agents.** Email, upload, or API-push content into named
inboxes ("boxes"). Agents retrieve drops via an authenticated API.

Self-hosted on Cloudflare — deploy it under your own domain.

```
email  ─┐
upload ─┼─▶  {box}@your-domain  ─▶  [ D1 index + R2 blobs ]  ─▶  agent pulls via API
api    ─┘                            rules: forward / webhook / relay
```

## What it does

- **Drop content in** three ways: send email to `{box}@your-domain`, drag-drop at
  `your-domain/{box}`, or `POST` via the API / CLI.
- **Retrieve** drops (bodies + attachments) through an authenticated REST API.
- **React** to drops with a cascading rules engine: email **forwards**, **webhooks**
  (queue-delivered with backoff), and Apple-style **email relay** (masked bidirectional
  email).
- **Send** real email on behalf of a box (`From: {box}@your-domain`) via SES, with
  attachments, inline images, threading, and templates.
- **Host** static sites publicly under a box at `your-domain/f/{box}/{site}/`.

## Stack

| Layer | Tech |
|-------|------|
| Compute | Cloudflare Workers (API + static serving + queue consumer) |
| Database | Cloudflare D1 (SQLite) — inbox index, keys, tokens, rules |
| Blobs | Cloudflare R2 — attachments, raw emails, uploads, hosted sites |
| Async | Cloudflare Queues — webhook + relay delivery with backoff |
| Outbound email | AWS SES (eu-central-1) via `aws4fetch` |
| Auth | API keys, drop tokens, admin key, Google OAuth (GIS) |
| Frontend | Vite 8 + React 19 + Tailwind 4 (Tokyo Night theme) |

## Configuration

All deployment identity lives in `.env` (gitignored) — it is the single source of
truth. Copy the example and fill in your values:

```bash
cp .env.example .env
# set DOMAIN, BRAND, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, GOOGLE_CLIENT_ID + secrets
```

- **`DOMAIN`** — the apex domain the Worker serves and sends mail from. The route
  becomes `$DOMAIN/*`.
- **`BRAND`** — display name shown across the web UI and CLI.

The committed `wrangler.toml` carries only placeholders (`example.com`, `your-*-id`);
`bun run deploy` renders them from `.env` at deploy time, so no real domain or account
id is ever committed. Remaining secrets (SES creds, admin/API keys, R2 tokens) are also
set as Wrangler secrets (`wrangler secret put <NAME>`).

## Quick start

```bash
bun install
cp .env.example .env      # then edit
bun run deploy            # vite build + render config from .env + wrangler deploy
```

## CLI

The `tools/agent-drop.ts` CLI (Bun) drives everything. Point it at your instance with
`AGENT_DROP_URL`; aliased as `drop`:

```bash
drop boxes                          # list all inboxes
drop inbox lisa                     # drops in a box
drop get DROP_ID                    # full drop details + files
drop send-email --drop lisa --to bob@x.com --subject Hi --body "Hello"
drop host lisa marketing ./dist     # publish a static site
drop rule-add "*" --forward "me@example.com" --scope email
drop mask-create --prefix j         # create a relay mask
drop --help                         # full command reference
```

## API

Base: `https://<your-domain>/api/`. Auth via `Authorization: Bearer <key>`.

```bash
# List drops in a box
curl -H "Authorization: Bearer ad_..." https://your-domain/api/inbox/lisa

# Create a drop
curl -X POST -H "Authorization: Bearer ad_..." -H "Content-Type: application/json" \
  -d '{"subject":"Test","text":"Hello"}' https://your-domain/api/drop/lisa

# Send email on behalf of a box
curl -X POST -H "Authorization: Bearer ad_..." -H "Content-Type: application/json" \
  -d '{"to":["bob@example.com"],"subject":"Hi","text":"Hello"}' \
  https://your-domain/api/send/lisa
```

Run `drop --help` for the full command + endpoint reference (admin, agent, presigned
upload, drop-token, hosting).

## Project layout

```
src/
  index.ts            Worker entry (fetch + email + queue consumer)
  email-handler.ts    Inbound email → D1 + R2 (quote stripping, relay detection)
  api/                Route handlers (inbox, drop, send, host, keys, rules, masks, …)
  lib/                auth, ses, hosting, rules, relay, google-auth, normalize, id
web/                  Vite + React SPA (Landing, InboxView, DropZone, GoogleSignIn)
migrations/           D1 schema (0001 … 0007)
scripts/deploy.ts     Deploy wrapper (renders wrangler.toml from .env)
tools/agent-drop.ts   CLI
wrangler.toml         Worker config (R2 / D1 / Queue bindings)
```

## License

[MIT](./LICENSE) © Jonas Frost
