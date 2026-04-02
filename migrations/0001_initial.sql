CREATE TABLE IF NOT EXISTS drops (
    id              TEXT PRIMARY KEY,
    inbox           TEXT NOT NULL,
    topic           TEXT,
    channel         TEXT NOT NULL,
    from_addr       TEXT,
    from_user       TEXT,
    subject         TEXT,
    body_text       TEXT,
    body_html       TEXT,
    has_attachments INTEGER DEFAULT 0,
    attachment_count INTEGER DEFAULT 0,
    r2_prefix       TEXT,
    raw_r2_key      TEXT,
    metadata        TEXT,
    created_at      INTEGER NOT NULL,
    read_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_drops_inbox ON drops(inbox, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_drops_inbox_topic ON drops(inbox, topic, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_drops_unread ON drops(inbox, read_at) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS api_keys (
    id              TEXT PRIMARY KEY,
    key_hash        TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    inbox_scope     TEXT,
    permissions     TEXT NOT NULL DEFAULT 'read',
    created_at      INTEGER NOT NULL,
    last_used_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

CREATE TABLE IF NOT EXISTS outbound (
    id              TEXT PRIMARY KEY,
    inbox           TEXT NOT NULL,
    to_addr         TEXT NOT NULL,
    subject         TEXT,
    body_text       TEXT,
    ses_message_id  TEXT,
    status          TEXT NOT NULL DEFAULT 'sent',
    created_at      INTEGER NOT NULL
);
