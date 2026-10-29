-- ============================================================
-- PORT SOLACE — Port Authority (DESIGN2.md Addendum A9): players seen by presence, gifts from the crew, admin log
-- D1 database `portsolace`, binding DB on the account worker. Apply with:
--   npx wrangler d1 migrations apply portsolace --remote
-- ============================================================

CREATE TABLE players (
  player_id   TEXT PRIMARY KEY,          -- profile.playerId (8-64 chars [A-Za-z0-9_-])
  user_id     TEXT,                      -- account id when the game was signed in, else NULL
  email       TEXT,                      -- account email when signed in, else NULL
  station     TEXT NOT NULL DEFAULT '',  -- station name (<= 40 chars, cleaned)
  day INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0, rank INTEGER NOT NULL DEFAULT 0,
  credits INTEGER NOT NULL DEFAULT 0, am INTEGER NOT NULL DEFAULT 0, sectors INTEGER NOT NULL DEFAULT 0,
  platform    TEXT NOT NULL DEFAULT '',  -- 'phone' | 'desktop'
  version     TEXT NOT NULL DEFAULT '',  -- game build string if one exists, else ''
  first_seen  INTEGER NOT NULL,          -- ms
  last_seen   INTEGER NOT NULL,          -- ms
  sessions    INTEGER NOT NULL DEFAULT 1 -- incremented when last_seen is older than 30 minutes
);
CREATE INDEX players_last_seen ON players(last_seen DESC);
CREATE INDEX players_user ON players(user_id);

CREATE TABLE gifts (
  id          TEXT PRIMARY KEY,          -- 'gft_' + 16 random bytes base64url
  player_id   TEXT NOT NULL,
  credits     INTEGER NOT NULL DEFAULT 0,
  am          INTEGER NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT '',  -- shown to the player (<= 140 chars)
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL,             -- admin email
  delivered_at INTEGER,                  -- first time /presence returned it
  acked_at    INTEGER,                   -- the game confirmed it applied it
  revoked_at  INTEGER                    -- admin cancelled it before it was acked
);
CREATE INDEX gifts_player ON gifts(player_id, acked_at);

CREATE TABLE admin_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, admin TEXT NOT NULL,
  action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT ''
);
