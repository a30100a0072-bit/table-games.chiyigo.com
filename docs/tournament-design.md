# Tournament Mode

Status: **shipped.** Best-of-3, 4-player, single-table, scores accumulate
across rounds, winner takes prize pool (rake-adjusted). MVP differs from
the original sketch in two ways:

- **No bracket / elimination.** Single table, all 4 players play every
  round. Final rank is by aggregate score, ties broken by registration
  order. Simpler to reason about and matches our existing `GameRoomDO`
  shape without spawning multiple rooms per round.
- **Modal, not page.** Frontend lives in `TournamentModal` opened from
  `GameSelectScreen`, not a dedicated `/tournaments` route.

## Code map

- `src/db/schema.sql` — `tournaments` + `tournament_entries` tables.
- `src/do/TournamentDO.ts` — orchestrator: register / start / round-result
  / payout. Hydrates from storage so DO eviction is safe.
- `src/api/tournaments.ts` — `POST /api/tournaments`, `GET /api/tournaments`,
  `POST /api/tournaments/:id/join`, `GET /api/tournaments/:id`.
- `src/do/GameRoomDO.ts` — accepts `tournamentId` on `/init` and POSTs
  `/round-result` to the matching `TournamentDO` when settlement fires.
- `frontend/src/components/TournamentModal.tsx` — list, create, join,
  detail-with-bracket, polls every 3 s.
- `test/tournamentDO.test.ts` — 7 tests covering init / join cap /
  multi-round score accumulation / payout / tie-break.

## Economy

- `MIN_BUY_IN = 100`, `MAX_BUY_IN = 5000` chips.
- House rake: 5 % of gross pool (`buy_in × 4`). Winner receives the rest.
- Buy-in is debited at registration via the same D1 batch that inserts
  the `tournament_entries` row and a `chip_ledger` row with
  `reason='tournament'` (negative). Failure path refunds best-effort.
- Payout writes a single `INSERT OR IGNORE INTO chip_ledger` keyed on
  `(player_id, game_id=tournament_id, reason='tournament')` so retries
  don't double-pay.

## DO topology

One `TournamentDO` per `tournament_id`. Spawns one `GameRoomDO` per
round (new `gameId` each time), waits for its settlement to POST back
`/round-result`, accumulates `aggScore`, then either spawns the next
round or finalises. State is persisted to DO storage on every mutation;
`hydrate()` restores on cold start so eviction is transparent.

## What's NOT implemented (deliberate scope cuts)

- **Multi-table brackets.** 8/16-player elimination would need bracket
  state and concurrent `GameRoomDO`s; deferred until 4-player mode has
  real usage.
- **Disconnect mid-tournament.** The current `GameRoomDO` disconnect
  policy (bot replacement / forfeit) carries through; we don't refund
  buy-in and we don't kick the entry from the bracket. Acceptable
  because there is no bracket — the player just keeps playing badly.
- **Feature flag.** Originally planned (`TOURNAMENTS_ENABLED`) but the
  feature shipped behind tests-green gating instead. Add a flag if we
  ever need to dark-launch a redesign.
- **Dedicated `/tournaments` route.** Modal works; route adds nav
  surface area without UX value at this player count.

## Future work

- Stat: track per-player tournament wins / placings on the leaderboard.
- 8-player single-elimination once 4-player has steady traffic.
- Scheduled tournaments (cron-spawned) — would need a `RemoteTrigger`
  or scheduled Worker entry.
