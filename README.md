# Agent Drop

**Give your AI agents an email address, an inbox, and a drop box.**

Agent Drop is a dead-drop system for AI agents. Email, drag-drop, or `POST` content
into named inboxes ("boxes") — your agents pull it back out over an authenticated REST
API. Spin up `research@your-domain`, `invoices@your-domain`, `scraper@your-domain` on
a whim; no mailbox provisioning, no IMAP, no cron-polling some third-party inbox.

It runs **entirely on Cloudflare Workers** — inbound email (Email Routing), the web UI
and API (Workers), blobs (R2), the index (D1), async delivery (Queues), and outbound
email (Email Sending). No origin server, no egress bill, scales to zero, deploys in
minutes under your own domain.

```
email   ─┐
upload  ─┼─▶  {box}@your-domain  ─▶  [ D1 index + R2 blobs ]  ─▶  agent pulls via API
api     ─┤                            rules: forward · webhook · relay
webhook ─┘   your-domain/h/{box}/{slug}  ─▶  lease · ack · replay
```

## Why you'd want this

- **Agents can receive email.** Point a signup, a newsletter, a vendor invoice, a
  2FA code at `{box}@your-domain` and your agent reads it via the API a second later.
  `+addressing` (`box+topic@…`) sorts it for you.
- **Agents can send email.** Real mail `From: {box}@your-domain` — attachments, inline
  images (`cid:`), threading, YAML templates. Your own SPF/DKIM, no SendGrid tax.
- **Four ways in, one way out.** Email, a drag-drop web page at `your-domain/{box}`,
  a one-line `POST`, or a webhook receiver. The first three land in the same box,
  readable through one API.
- **Agents can receive webhooks.** Paste `your-domain/h/{box}/{slug}` into Stripe,
  GitHub, Shopify, Slack, Zoom or Meta's console. Agent Drop answers their setup
  handshake, verifies the signature (11 schemes, including the plain-SHA-256 kind
  that is not HMAC), stores the bytes **unchanged**, and hands them to your agent
  over a lease-based pull queue -- `queue-get`, work, `queue-remove`. A crashed
  consumer's lease expires and the event is served again. Or relay it onward
  byte-for-byte with `--payload-mode passthrough`, so your own service still sees
  exactly what the provider sent, signature header included.
- **A rules engine that reacts to drops.** Cascading pattern rules (`shop-*`,
  `*-invoices`) that **forward** email, fire **webhooks** (queue-delivered, exponential
  backoff, 24h retry), or run an **Apple-style email relay** — masked bidirectional
  addresses so the other side never sees your real inbox.
- **Static hosting, because why not.** `drop host lisa report ./dist` publishes a
  folder to `your-domain/f/lisa/report/`, straight off R2. Optional TTL and auth token.
- **Yours, on your domain, on the edge.** Self-hosted on Cloudflare's free-ish tier.
  No SaaS in the loop, no per-seat pricing, no data leaving your account.

## Stack

Every layer is Cloudflare — one platform, one `wrangler deploy`.

| Layer | Tech |
|-------|------|
| Compute | Cloudflare Workers (API + static serving + queue consumer) |
| Inbound email | Cloudflare Email Routing (catch-all `*@your-domain` → Worker) |
| Outbound email | Cloudflare Email Sending (`cloudflare:email` binding) — sends, forwards, relay |
| Database | Cloudflare D1 (SQLite) — inbox index, keys, tokens, rules |
| Blobs | Cloudflare R2 — attachments, raw emails, uploads, hosted sites, webhook bodies |
| Async | Cloudflare Queues — webhook + relay delivery with backoff |
| Auth | API keys, drop tokens, admin key, Google OAuth (GIS) |
| Frontend | Vite 8 + React 19 + Tailwind 4 (Tokyo Night theme) |

> AWS SES support ships as a dormant fallback in `lib/relay.ts` (`sendRawEmail`) — the
> live path uses the Cloudflare Email Sending binding. No AWS account required.

## 60-second tour

```bash
# Your agent drops a note into the "research" box…
curl -X POST -H "Authorization: Bearer ad_..." -H "Content-Type: application/json" \
  -d '{"subject":"Q3 numbers","text":"see attached model"}' \
  https://your-domain/api/drop/research

# …a human emails a PDF to research@your-domain…
#   (Cloudflare Email Routing → Worker → D1 + R2, quote-stripped, attachments extracted)

# …and the agent pulls the latest drop back out, files and all.
curl -H "Authorization: Bearer ad_..." https://your-domain/api/inbox/research/latest
```

```bash
# Point a provider at a URL you own, then let an agent drain the queue.
drop hook-create research stripe-prod --auth stripe --secret whsec_...
#   → https://your-domain/h/research/stripe-prod-k7f2q9m4v6x8z1a3b5c7d9e2fg (paste into Stripe)

drop queue-get research --limit 10 --lease 60 --json | jq        # lease, work…
drop queue-remove research EVENT_ID                              # …then ack
```

## Deploy

Everything lives in one Cloudflare account. From zero to live in five steps.

### 0 · What you need

- A **Cloudflare account** with a **domain (zone)** on it — this is where mail arrives
  and the Worker serves from.
- [**Bun**](https://bun.sh) and the **Wrangler** CLI, authenticated: `bunx wrangler login`.
- **Email Routing** enabled on the zone (Cloudflare dashboard → your domain → Email).
- **Email Sending** onboarded for the domain (public beta) so boxes can send real mail.
- *(optional)* a **Google OAuth client id** if you want "Sign in with Google" on the
  web upload UI.

### 1 · Create the Cloudflare resources

```bash
bunx wrangler d1 create agent-drop-db          # → copy the database_id it prints
bunx wrangler r2 bucket create agent-drop-storage
bunx wrangler queues create agent-drop-webhooks
```

Generate an **R2 API token** (Cloudflare dashboard → R2 → *Manage API tokens*, or
`wrangler r2`) — the access key + secret power presigned upload/download URLs.

### 2 · Fill in `.env`

`.env` (gitignored) is the single source of truth — no real domain, account, or id is
ever committed. `bun run deploy` renders the placeholder `wrangler.toml` from it at
deploy time.

```bash
cp .env.example .env
```

| Var                     | What                                                      |
|-------------------------|-----------------------------------------------------------|
| `DOMAIN`                | host the Worker serves from; route becomes `$DOMAIN/*`    |
| `MAIL_DOMAIN`           | domain boxes send + receive mail on. Defaults to `DOMAIN` |
| `ZONE_NAME`             | Cloudflare zone owning the route. Defaults to `DOMAIN`    |
| `BRAND`                 | display name across the web UI + CLI                      |
| `CLOUDFLARE_ACCOUNT_ID` | your CF account id                                        |
| `D1_DATABASE_ID`        | the id printed in step 1                                  |
| `GOOGLE_CLIENT_ID`      | OAuth client id (public)                                  |

Set all three domain vars to the same apex for the simple case. They come apart
when the apex is already serving something else: put the Worker on a subdomain
(`DOMAIN=drop.example.com`) while mail keeps the short address
(`MAIL_DOMAIN=example.com`), and name the zone that owns the route
(`ZONE_NAME=example.com`) — `zone_name` must be a real Cloudflare zone, which a
subdomain is not.

### 3 · Migrate the database + set secrets

```bash
bun run db:migrate     # 0001 … 0010, against the remote DB

# Secrets — set once, stored on the Worker (never in the repo):
bunx wrangler secret put ADMIN_API_KEY          # full-access admin key you choose
bunx wrangler secret put R2_ACCESS_KEY_ID       # from the R2 API token
bunx wrangler secret put R2_SECRET_ACCESS_KEY
bunx wrangler secret put GOOGLE_CLIENT_ID        # same value as .env (server-side verify)
```

> Run the migrations **before** the deploy, and use `bun run db:migrate` rather than
> a bare `wrangler d1 migrations apply` — the committed `wrangler.toml` carries
> placeholder ids, so the bare form cannot find your database. The script renders
> the real config first, exactly as `bun run deploy` does.

### 4 · Wire up email (Cloudflare dashboard)

- **Inbound:** Email Routing → **catch-all** → *Send to Worker* → `agent-drop`. Now
  every `{box}@your-domain` lands in the Worker, no per-address rules.
- **Outbound:** confirm the domain is verified for Email Sending (SPF + DKIM records
  Cloudflare gives you). That's what lets a box send `From: {box}@your-domain`.

### 5 · Ship it

```bash
bun install
bun run deploy            # vite build → render wrangler.toml from .env → wrangler deploy
```

That's it — `your-domain` is live, boxes accept email/upload/API, and agents can pull.

> **Harden R2 (recommended):** set lifecycle rules (auto-expire old blobs) and CORS
> (so the SPA can PUT presigned uploads). Exact `wrangler r2 bucket lifecycle` / `cors`
> commands are in [`CLAUDE.md`](./CLAUDE.md) under *R2 Bucket Configuration*.

## CLI

One TypeScript file (`tools/agent-drop.ts`, Bun) drives the whole system. Point it at
your instance with `AGENT_DROP_URL`; aliased as `drop`:

```bash
drop boxes                          # list all inboxes
drop inbox lisa                     # drops in a box
drop get DROP_ID                    # full drop details + files
drop send-email --drop lisa --to bob@x.com --subject Hi --body "Hello"
drop host lisa marketing ./dist     # publish a static site
drop rule-add "*" --forward "me@example.com" --scope email
drop mask-create --prefix j         # create a relay mask
drop hook-create lisa stripe-prod   # register a webhook receiver, print its URL
drop queue-get lisa --limit 10      # lease webhook events off the queue
drop queue-peek lisa                # …or read them without leasing anything
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

# Lease webhook events off a box's queue (POST leases; GET peeks and changes nothing)
curl -X POST -H "Authorization: Bearer ad_..." -H "Content-Type: application/json" \
  -d '{"limit":10,"leaseSeconds":60}' https://your-domain/api/hooks/queue/lisa/get
```

Run `drop --help` for the full command + endpoint reference (admin, agent, presigned
upload, drop-token, hosting).

## Project layout

```
src/
  index.ts            Worker entry (fetch + email + queue consumers + cron)
  email-handler.ts    Inbound email → D1 + R2 (quote stripping, relay detection)
  api/                Route handlers (inbox, drop, send, host, keys, rules, masks, hooks, …)
  lib/                auth, hosting, rules, relay, google-auth, normalize, id,
                      webhook-* (receive, verify, handshake, store, throttle), reapers
web/                  Vite + React SPA (Landing, InboxView, DropZone, GoogleSignIn)
migrations/           D1 schema (0001 … 0010)
scripts/deploy.ts     Deploy wrapper (renders wrangler.toml from .env)
tools/agent-drop.ts   CLI
wrangler.toml         Worker config (R2 / D1 / Queue bindings)
```

## License

[MIT](./LICENSE) © Jonas Frost
