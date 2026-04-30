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
  player_id    TEXT    PRIMARY KEY,
  display_name TEXT    NOT NULL,
  chip_balance INTEGER NOT NULL DEFAULT 1000,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
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
  reason     TEXT    NOT NULL,           -- settlement | signup | adjustment
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
