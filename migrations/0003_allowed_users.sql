CREATE TABLE IF NOT EXISTS allowed_users (
    email       TEXT PRIMARY KEY,
    name        TEXT,
    added_by    TEXT,
    created_at  INTEGER NOT NULL
);
