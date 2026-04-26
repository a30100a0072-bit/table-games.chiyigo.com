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
