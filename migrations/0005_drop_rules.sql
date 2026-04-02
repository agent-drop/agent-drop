-- Rules: pattern-matched forwards + webhooks
-- Multiple rules can match the same drop (cascading, ALL fire)
CREATE TABLE IF NOT EXISTS drop_rules (
    id          TEXT PRIMARY KEY,
    pattern     TEXT NOT NULL,        -- "lisa", "*", "shop-*", "*-invoices"
    type        TEXT NOT NULL,        -- "forward" | "webhook"
    scopes      TEXT NOT NULL,        -- "email", "web", "api", "all" (comma-separated)
    target      TEXT NOT NULL,        -- email addr or URL (supports {name}, {inbox}, {topic}, etc)
    headers     TEXT,                 -- JSON: custom headers for webhooks
    enabled     INTEGER DEFAULT 1,
    priority    INTEGER DEFAULT 0,    -- higher fires first
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drop_rules_pattern ON drop_rules(pattern, enabled);

-- Delivery log: every forward/webhook attempt
CREATE TABLE IF NOT EXISTS delivery_log (
    id          TEXT PRIMARY KEY,
    drop_id     TEXT NOT NULL,
    rule_id     TEXT NOT NULL,
    type        TEXT NOT NULL,        -- "forward" | "webhook"
    target      TEXT NOT NULL,        -- resolved target (variables substituted)
    status      TEXT NOT NULL,        -- "pending" | "success" | "failed" | "retrying"
    status_code INTEGER,             -- HTTP status for webhooks
    error       TEXT,                 -- error message if failed
    attempts    INTEGER DEFAULT 0,
    next_retry  INTEGER,             -- unix ms for next retry
    created_at  INTEGER NOT NULL,
    completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_delivery_log_drop ON delivery_log(drop_id);
CREATE INDEX IF NOT EXISTS idx_delivery_log_retry ON delivery_log(status, next_retry)
    WHERE status IN ('pending', 'retrying');
