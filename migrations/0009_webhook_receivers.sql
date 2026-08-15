-- Generic webhook receiver: a public URL per receiver at {domain}/h/{box}/{slug},
-- and one row per request that arrives on it.
--
-- Both tables ship in one migration because they are one feature: a receiver
-- with no events is inert, and an event with no receiver cannot exist.

CREATE TABLE IF NOT EXISTS webhook_receivers (
    id              TEXT PRIMARY KEY,
    inbox           TEXT NOT NULL,        -- the box; ties into inbox_scope and rule patterns
    slug            TEXT NOT NULL,        -- path segment, normalized [a-z0-9-]
    label           TEXT,
    auth_mode       TEXT NOT NULL DEFAULT 'none',       -- see the verify table
    auth_config     TEXT,                 -- JSON: secret, header name, encoding, tolerance
    handshake_mode  TEXT NOT NULL DEFAULT 'none',
    handshake_config TEXT,                -- JSON: verify token, static response
    preset          TEXT,                 -- github|stripe|standard|slack|shopify|generic
    extract_config  TEXT,                 -- JSON: event_type/routing_key/dedupe overrides
    response_status INTEGER DEFAULT 200,  -- what we answer the provider with
    response_body   TEXT,
    response_content_type TEXT,
    allowed_methods TEXT DEFAULT 'POST',  -- comma-separated
    max_body_bytes  INTEGER DEFAULT 1048576,  -- hard cap, enforced before the read
    retention_days  INTEGER DEFAULT 120,
    daily_cap       INTEGER,              -- per-receiver event cap; null = none
    mirror_to_drops INTEGER DEFAULT 0,
    enabled         INTEGER DEFAULT 1,
    -- Rotation keeps the row and its history: the old slug keeps answering until
    -- previous_slug_expires_at so a dashboard cutover cannot drop traffic.
    previous_slug   TEXT,
    previous_slug_expires_at INTEGER,
    expires_at      INTEGER,              -- unix ms; null = never. 410 past it.
    created_at      INTEGER NOT NULL,
    last_event_at   INTEGER,
    event_count     INTEGER DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hook_receivers_slug ON webhook_receivers(inbox, slug);
CREATE INDEX IF NOT EXISTS idx_hook_receivers_prev ON webhook_receivers(inbox, previous_slug);

-- One row per request that reached a receiver, INCLUDING the ones we rejected and
-- the handshakes -- "the provider says my URL failed validation" is the number-one
-- thing you will need to debug, and the request that failed is the only evidence.
CREATE TABLE IF NOT EXISTS webhook_events (
    id           TEXT PRIMARY KEY,        -- ULID: sortable, so ?since= is free
    receiver_id  TEXT NOT NULL,
    inbox        TEXT NOT NULL,           -- denormalized: scope checks and pulls never join
    slug         TEXT NOT NULL,
    subpath      TEXT,                    -- anything after /h/{box}/{slug}
    method       TEXT NOT NULL,
    event_type   TEXT,
    routing_key  TEXT,                    -- correlation handle, extracted by configured path
    dedupe_key   TEXT,                    -- provider's message id, or the bucketed body hash
    headers      TEXT,                    -- JSON, complete; only true credentials redacted
    query        TEXT,                    -- JSON
    content_type TEXT,
    body_text    TEXT,                    -- inline when <= 64 KiB AND the body is valid UTF-8
    body_r2_key  TEXT,                    -- else hooks/{box}/{slug}/{id} -- raw bytes, unmodified
    body_bytes   INTEGER,
    body_sha256  TEXT,                    -- over the raw bytes, before any decode
    verified     INTEGER,                 -- 1 pass, 0 fail, NULL not applicable
    remote_ip    TEXT,
    country      TEXT,
    user_agent   TEXT,
    status       TEXT NOT NULL DEFAULT 'queued',  -- queued|leased|acked|rejected|handshake
    lease_id     TEXT,
    leased_until INTEGER,
    lease_count  INTEGER DEFAULT 0,
    acked_at     INTEGER,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL         -- created_at + retention_days
);

CREATE INDEX IF NOT EXISTS idx_hook_events_pull   ON webhook_events(inbox, status, created_at);
CREATE INDEX IF NOT EXISTS idx_hook_events_recv   ON webhook_events(receiver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hook_events_route  ON webhook_events(receiver_id, routing_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hook_events_expiry ON webhook_events(expires_at);

-- The dedupe index is the point, not decoration. Every provider on the list
-- retries on a slow response, and a retry carries the same message id. Without
-- it one flaky 3-second response becomes four copies in the agent's queue.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hook_events_dedupe
    ON webhook_events(receiver_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
