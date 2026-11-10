-- Opaque, reusable reply routes for masked email.
--
-- Tokens deliberately have no expiry: replying to an old message must keep
-- working. Only the SHA-256 digest is stored, so a database read does not reveal
-- a usable relay address. Disabling a mask makes all of its routes inert; mask
-- deletion removes them explicitly in the API.
CREATE TABLE IF NOT EXISTS relay_reply_routes (
    token_hash  TEXT PRIMARY KEY,
    mask_id     TEXT NOT NULL,
    sender      TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relay_reply_routes_mask
    ON relay_reply_routes(mask_id);
