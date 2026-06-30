-- Hosted static sites: public file hosting under {domain}/f/{box}/{site}/
-- R2 objects live under sites/{inbox}/{site}/{relpath}. This table is the
-- registry (for listing, TTL, and optional private-token gating).

CREATE TABLE IF NOT EXISTS hosted_sites (
    id          TEXT PRIMARY KEY,
    inbox       TEXT NOT NULL,
    site        TEXT NOT NULL,
    file_count  INTEGER DEFAULT 0,
    total_bytes INTEGER DEFAULT 0,
    auth_token  TEXT,                 -- null = public; set = require ?auth=token
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    expires_at  INTEGER               -- unix ms; null = never. Enforced at read.
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hosted_sites_inbox_site ON hosted_sites(inbox, site);
CREATE INDEX IF NOT EXISTS idx_hosted_sites_inbox ON hosted_sites(inbox);
