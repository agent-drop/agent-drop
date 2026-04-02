CREATE TABLE IF NOT EXISTS drop_tokens (
    id          TEXT PRIMARY KEY,
    inbox       TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  INTEGER NOT NULL,
    created_by  TEXT,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drop_tokens_hash ON drop_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_drop_tokens_inbox ON drop_tokens(inbox);
