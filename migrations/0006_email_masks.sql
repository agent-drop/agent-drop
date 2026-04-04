CREATE TABLE IF NOT EXISTS email_masks (
    id          TEXT PRIMARY KEY,
    label       TEXT,
    active      INTEGER DEFAULT 1,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_masks_active ON email_masks(active);
