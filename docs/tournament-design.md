# Tournament Mode — Design Sketch

Status: **proposed, not yet implemented.** This is a working design so the
next session can pick it up without re-litigating decisions.

## Goal

Multi-round elimination play where chips persist across hands and the last
player standing wins a prize pool. Distinct from the current free-flow
single-hand matchmaking.

## Why it's not in this sprint

It needs schema changes (new tables), a new DO type (`TournamentDO`),
match-orchestration that survives DO eviction, and prize-payout logic
that has to be bullet-proof against retries. ~6–8 hours of focused work
including tests. Out of scope for the "do everything in one round"
ask — needs a dedicated sprint.

## Schema additions

```sql
CREATE TABLE IF NOT EXISTS tournaments (
  tournament_id   TEXT    PRIMARY KEY,
  game_type       TEXT    NOT NULL,        -- bigTwo | mahjong | texas
  buy_in          INTEGER NOT NULL,        -- chips locked at registration
  max_players     INTEGER NOT NULL,        -- 4 | 8 | 16
  status          TEXT    NOT NULL,        -- registering | running | settled
  prize_pool      INTEGER NOT NULL,        -- sum of buy_ins (less rake)
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER
);

CREATE TABLE IF NOT EXISTS tournament_entries (
  tournament_id   TEXT    NOT NULL,
  player_id       TEXT    NOT NULL,
  registered_at   INTEGER NOT NULL,
  eliminated_at   INTEGER,                 -- NULL until they bust
  final_rank      INTEGER,                 -- 1 = winner; assigned at settle
  PRIMARY KEY (tournament_id, player_id),
  FOREIGN KEY (tournament_id) REFERENCES tournaments (tournament_id),
  FOREIGN KEY (player_id)     REFERENCES users (player_id)
);
```

## DO topology

- **`TournamentDO`** (one per tournament_id) — drives the bracket: spawns
  `GameRoomDO` instances for each match, listens for settlements, advances
  survivors, eliminates losers. Persists bracket state via storage so DO
  evictions resume cleanly.
- **`GameRoomDO`** stays as-is. Its `SettlementResult` already carries
  `winnerId` + per-player `scoreDelta`, which is what the tournament needs.

## Bracket logic (single-elimination, 8-player big two example)

1. Round 1: 2 tables × 4 players. Top 2 in each survive.
2. Round 2: 1 table × 4 survivors. Top 2 again.
3. Final: 1 table × 2 survivors (heads-up). Winner takes pool.

Edge cases that need explicit handling:
- **Disconnect mid-tournament**: elimination + buy-in forfeit (no refund).
- **DO eviction**: TournamentDO must rebuild bracket from `tournament_entries`
  on hydrate. Idempotency by tournament_id + round number.
- **Tied scores**: chip leader by tiebreaker, then random. Document choice.

## Endpoints

```
POST /api/tournaments            — register (debit buy_in atomically)
GET  /api/tournaments            — list registering / running
GET  /api/tournaments/:id        — bracket + survivors
POST /api/tournaments/:id/start  — admin (or auto when full)
```

## Payout

When `TournamentDO` finalises, write a single `chip_ledger` row per
non-winner with delta=−buy_in (already debited at registration, this is
just the audit trail) and one row for the winner with delta=+prize_pool.
Use `INSERT OR IGNORE` keyed by tournament_id so retries don't double-pay.

Use a `'tournament'` reason in `chip_ledger` (extend the existing reason
column).

## Integration points

- `lobby.ts` ANTE check: tournament rooms bypass it (buy-in already locked).
- `WalletBadge` ledger reasons: add `'tournament'` → 「賽事」.
- New `/tournaments` page in frontend with list + bracket view.

## Tests

Unit: TournamentDO bracket advancement (player A wins both rounds → final
rank 1, others 2/3/4 by elimination order).
Integration: handler-level register → start → settle → ledger row exists.

## Rollout

Behind a feature flag `TOURNAMENTS_ENABLED` (env var). Off until the DO
test suite is green.
