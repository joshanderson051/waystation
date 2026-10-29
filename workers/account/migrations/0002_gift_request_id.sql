-- ============================================================
-- PORT SOLACE — Port Authority (DESIGN2.md Addendum A9.2): idempotent gift creation
-- The portal sends one requestId per reviewed gift; POST /admin/gifts inserts with ON CONFLICT(request_id) DO NOTHING,
-- so a retry after a lost answer returns the first gift instead of minting a second. NULL (no requestId) never conflicts.
-- Applied with the rest of migrations/:  npx wrangler d1 migrations apply portsolace --remote
-- ============================================================

ALTER TABLE gifts ADD COLUMN request_id TEXT;
CREATE UNIQUE INDEX gifts_request ON gifts(request_id);
