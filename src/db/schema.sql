-- /src/db/schema.sql
-- D1 DDL — run once with: wrangler d1 execute big-two-db --file=src/db/schema.sql

-- ── GameRooms ────────────────────────────────────────────────────────────
-- Written by LobbyDO.tryMatch(); status updated by settlementConsumer.
CREATE TABLE IF NOT EXISTS GameRooms (
  room_id     TEXT    PRIMARY KEY,
  player_ids  TEXT    NOT NULL,          -- JSON array, includes BOT_* IDs
  status      TEXT    NOT NULL DEFAULT 'waiting',  -- waiting | playing | settled
  created_at  INTEGER NOT NULL           -- Unix ms
);

CREATE INDEX IF NOT EXISTS idx_gamerooms_status ON GameRooms (status);

-- ── games ────────────────────────────────────────────────────────────────
-- One row per completed round, written atomically with player_settlements.
CREATE TABLE IF NOT EXISTS games (
  game_id     TEXT    PRIMARY KEY,
  round_id    TEXT    NOT NULL,
  finished_at INTEGER NOT NULL,          -- Unix ms
  reason      TEXT    NOT NULL,          -- lastCardPlayed | timeout | disconnect
  winner_id   TEXT    NOT NULL
);

-- ── player_settlements ───────────────────────────────────────────────────
-- One row per player per game; composite PK prevents duplicate writes.
CREATE TABLE IF NOT EXISTS player_settlements (
  game_id        TEXT    NOT NULL,
  player_id      TEXT    NOT NULL,
  final_rank     INTEGER NOT NULL,       -- 1 = winner
  score_delta    INTEGER NOT NULL,       -- positive for winner, negative for losers
  remaining_json TEXT    NOT NULL,       -- JSON array of Card objects at settlement
  PRIMARY KEY (game_id, player_id),
  FOREIGN KEY (game_id) REFERENCES games (game_id)
);

CREATE INDEX IF NOT EXISTS idx_ps_player ON player_settlements (player_id);

-- ── users ────────────────────────────────────────────────────────────────
-- Chip wallet — one row per player. JWT `sub` is the primary key.
-- Created lazily on first /auth/token call (not yet wired; reserved for the
-- chip-economy milestone). Bots (BOT_*) never appear here.
CREATE TABLE IF NOT EXISTS users (
  player_id       TEXT    PRIMARY KEY,
  display_name    TEXT    NOT NULL,
  chip_balance    INTEGER NOT NULL DEFAULT 1000,
  last_bailout_at INTEGER NOT NULL DEFAULT 0,    -- ms; 0 = never claimed
  last_login_at   INTEGER NOT NULL DEFAULT 0,    -- ms; 0 = never logged in (gets daily bonus on next /auth/token)
  frozen_at       INTEGER NOT NULL DEFAULT 0,    -- ms; 0 = active. >0 = blocked from auth + matchmaking.
  frozen_reason   TEXT,                          -- audit trail; NULL when active
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- ── chip_ledger ──────────────────────────────────────────────────────────
-- Append-only chip-flow record. One row per balance change. Never UPDATE or
-- DELETE — the ledger is the source of truth and `users.chip_balance` is a
-- derived cache. `game_id` is NULL for non-game adjustments (signup grant,
-- admin correction). Composite settlement writes use a single SQL transaction
-- so games / player_settlements / chip_ledger / users stay consistent.
CREATE TABLE IF NOT EXISTS chip_ledger (
  ledger_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id  TEXT    NOT NULL,
  game_id    TEXT,
  delta      INTEGER NOT NULL,
  reason     TEXT    NOT NULL,           -- settlement | signup | bailout | daily | adjustment
  created_at INTEGER NOT NULL,
  FOREIGN KEY (player_id) REFERENCES users (player_id),
  FOREIGN KEY (game_id)   REFERENCES games (game_id),
  -- Idempotency: queue retries of the same settlement get dropped silently
  -- by INSERT OR IGNORE. NULL game_id rows (signup, adjustment) are treated
  -- as distinct under SQLite's NULL-in-UNIQUE semantics, so manual entries
  -- are not blocked.
  UNIQUE (player_id, game_id, reason)
);

CREATE INDEX IF NOT EXISTS idx_chip_ledger_player ON chip_ledger (player_id);
CREATE INDEX IF NOT EXISTS idx_chip_ledger_game   ON chip_ledger (game_id);

-- ── tournaments / tournament_entries ──────────────────────────────────
-- Best-of-N tournament: 4 players each pay `buy_in`, play N rounds of the
-- same game type, scores accumulate, winner takes prize_pool (rake-adjusted).
-- Buy-ins are debited atomically at registration time and the matching
-- chip_ledger row uses reason='tournament' so flow is auditable.

CREATE TABLE IF NOT EXISTS tournaments (
  tournament_id  TEXT    PRIMARY KEY,
  game_type      TEXT    NOT NULL,           -- bigTwo | mahjong | texas
  buy_in         INTEGER NOT NULL,
  rounds_total   INTEGER NOT NULL DEFAULT 3, -- best-of-N
  rounds_done    INTEGER NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL,           -- registering | running | settled
  prize_pool     INTEGER NOT NULL,           -- 4 * buy_in (after rake)
  current_room   TEXT,                       -- active GameRoomDO id (NULL between rounds)
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER,
  winner_id      TEXT
);

CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments (status);

CREATE TABLE IF NOT EXISTS tournament_entries (
  tournament_id  TEXT    NOT NULL,
  player_id      TEXT    NOT NULL,
  registered_at  INTEGER NOT NULL,
  agg_score      INTEGER NOT NULL DEFAULT 0,  -- sum of per-round scoreDelta
  final_rank     INTEGER,                      -- assigned at settle (1=winner)
  PRIMARY KEY (tournament_id, player_id),
  FOREIGN KEY (tournament_id) REFERENCES tournaments (tournament_id)
);

CREATE INDEX IF NOT EXISTS idx_tentries_player ON tournament_entries (player_id);

-- ── admin_audit ──────────────────────────────────────────────────────────
-- Append-only record of every admin action (chip adjust, freeze, unfreeze).
-- The chip_ledger already captures balance changes; this table answers
-- "who pulled the lever and why" for ops review.
CREATE TABLE IF NOT EXISTS admin_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT    NOT NULL,    -- adjust | freeze | unfreeze
  player_id   TEXT    NOT NULL,
  delta       INTEGER,             -- chip delta for 'adjust'; NULL for freeze/unfreeze
  reason      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_player ON admin_audit (player_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit (created_at DESC);

-- ── friendships ──────────────────────────────────────────────────────────
-- Bidirectional consent. (a_id, b_id) is canonical with a_id < b_id so the
-- same relationship has exactly one row regardless of who initiated.
-- `requester` records who sent the request (one of a_id / b_id) so we can
-- distinguish incoming vs outgoing pending without a second row.
CREATE TABLE IF NOT EXISTS friendships (
  a_id          TEXT    NOT NULL,
  b_id          TEXT    NOT NULL,
  requester     TEXT    NOT NULL,           -- a_id | b_id, set on request
  status        TEXT    NOT NULL,           -- pending | accepted
  created_at    INTEGER NOT NULL,
  responded_at  INTEGER,                    -- set when status leaves pending
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id),
  CHECK (status IN ('pending', 'accepted')),
  CHECK (requester = a_id OR requester = b_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships (b_id);

-- ── room_tokens ──────────────────────────────────────────────────────────
-- Private rooms: capability token grants WS-join to a specific game_id.
-- The token IS the access control — anyone holding it can join until
-- it expires. game_id is a v4 UUID so direct guessing without the token
-- is practically infeasible.
CREATE TABLE IF NOT EXISTS room_tokens (
  token       TEXT    PRIMARY KEY,
  game_id     TEXT    NOT NULL,
  game_type   TEXT    NOT NULL,                 -- bigTwo | mahjong | texas
  capacity    INTEGER NOT NULL,
  created_by  TEXT    NOT NULL,                 -- creator's playerId
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL                  -- Unix ms
);

CREATE INDEX IF NOT EXISTS idx_room_tokens_game    ON room_tokens (game_id);
CREATE INDEX IF NOT EXISTS idx_room_tokens_expires ON room_tokens (expires_at);

-- ── room_invites ─────────────────────────────────────────────────────────
-- One row per (inviter, invitee, token). Pending invites are surfaced to
-- the invitee as in-app notifications. Accepting an invite is implicit —
-- the invitee just uses the token to join — so we don't track an
-- "accepted" state, only pending → declined or pending → expired.
CREATE TABLE IF NOT EXISTS room_invites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  inviter       TEXT    NOT NULL,
  invitee       TEXT    NOT NULL,
  token         TEXT    NOT NULL,           -- room_tokens.token
  game_type     TEXT    NOT NULL,           -- denormalised for listing
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  status        TEXT    NOT NULL,           -- pending | declined
  responded_at  INTEGER,
  CHECK (status IN ('pending', 'declined')),
  UNIQUE (inviter, invitee, token)          -- one invite per pair-per-room
);

CREATE INDEX IF NOT EXISTS idx_room_invites_invitee ON room_invites (invitee, status);
