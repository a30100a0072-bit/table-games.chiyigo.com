// /src/api/tournaments.ts
// Tournament endpoints: create / list / get / join.
// Buy-in deduction lives at this layer so it shares a transaction with
// the tournament_entries write — keeping chip economy auditable.        // L3_架構含防禦觀測

import { verifyJWT, JWTError, jwksFromPrivateEnv } from "../utils/auth";
import { takeToken, rateLimited }                  from "../utils/rateLimit";
import { log }                                      from "../utils/log";
import type { GameType }                           from "../types/game";
import { isGameType }                               from "../types/game";

export interface TournamentEnv {
  TOURNAMENT_DO:    DurableObjectNamespace;
  DB:               D1Database;
  JWT_PRIVATE_JWK:  string;
}

const MIN_BUY_IN  = 100;
const MAX_BUY_IN  = 5000;
const REQUIRED    = 4;
const RAKE_PCT    = 5;

async function authPlayer(request: Request, env: TournamentEnv): Promise<string | Response> {
  const auth  = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    return await verifyJWT(token, jwksFromPrivateEnv(env.JWT_PRIVATE_JWK));
  } catch (err) {
    return Response.json(
      { error: err instanceof JWTError ? err.message : "unauthorized" },
      { status: 401 },
    );
  }
}

// ── POST /api/tournaments ────────────────────────────────────────────
// Body: { gameType, buyIn }. Creator is auto-registered (and pays buy-in).

export async function createTournament(request: Request, env: TournamentEnv): Promise<Response> {
  const playerId = await authPlayer(request, env);
  if (playerId instanceof Response) return playerId;
  if (!takeToken(`match:${playerId}`, "match")) return rateLimited();

  let body: { gameType?: string; buyIn?: number };
  try { body = await request.json(); }
  catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }

  if (!isGameType(body.gameType))
    return Response.json({ error: "gameType required" }, { status: 400 });
  const buyIn = Number(body.buyIn);
  if (!Number.isInteger(buyIn) || buyIn < MIN_BUY_IN || buyIn > MAX_BUY_IN)
    return Response.json({ error: `buyIn must be ${MIN_BUY_IN}–${MAX_BUY_IN}` }, { status: 400 });

  const tournamentId = crypto.randomUUID();
  const now          = Date.now();
  const grossPool    = buyIn * REQUIRED;
  const prizePool    = grossPool - Math.floor(grossPool * RAKE_PCT / 100);

  // Atomic: insert tournament row, debit buy-in (CAS on balance), insert
  // entry, write 'tournament' ledger row. If any fails we don't leave a
  // half-registered state behind.
  try {
    const debit = await env.DB
      .prepare(
        "UPDATE users SET chip_balance = chip_balance - ?, updated_at = ?" +
        " WHERE player_id = ? AND chip_balance >= ?",
      )
      .bind(buyIn, now, playerId, buyIn)
      .run();
    if (!debit.success || (debit.meta?.changes ?? 0) === 0) {
      return Response.json({ error: "insufficient chips" }, { status: 402 });
    }
    await env.DB.batch([
      env.DB
        .prepare(
          "INSERT INTO tournaments" +
          " (tournament_id, game_type, buy_in, rounds_total, rounds_done, status, prize_pool, created_at)" +
          " VALUES (?, ?, ?, 3, 0, 'registering', ?, ?)",
        )
        .bind(tournamentId, body.gameType, buyIn, prizePool, now),
      env.DB
        .prepare(
          "INSERT INTO tournament_entries (tournament_id, player_id, registered_at)" +
          " VALUES (?, ?, ?)",
        )
        .bind(tournamentId, playerId, now),
      env.DB
        .prepare(
          "INSERT INTO chip_ledger (player_id, game_id, delta, reason, created_at)" +
          " VALUES (?, ?, ?, 'tournament', ?)",
        )
        .bind(playerId, tournamentId, -buyIn, now),
    ]);
  } catch (err) {
    // Refund the buy-in if anything past the debit failed — best effort.
    await env.DB
      .prepare("UPDATE users SET chip_balance = chip_balance + ? WHERE player_id = ?")
      .bind(buyIn, playerId)
      .run().catch(() => {});
    return Response.json({ error: "tournament create failed" }, { status: 500 });
  }

  // Spin up the TournamentDO and register the creator.
  const stub = env.TOURNAMENT_DO.get(env.TOURNAMENT_DO.idFromName(tournamentId));
  await stub.fetch(new Request("https://tournament.internal/init", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tournamentId, gameType: body.gameType, buyIn }),
  }));
  await stub.fetch(new Request("https://tournament.internal/join", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId }),
  }));

  log("info", "tournament_created", { tournamentId, gameType: body.gameType, buyIn });

  return Response.json({
    tournamentId, gameType: body.gameType, buyIn, prizePool,
    status: "registering", registered: 1, required: REQUIRED,
  }, { status: 201 });
}

// ── POST /api/tournaments/:id/join ───────────────────────────────────

export async function joinTournament(request: Request, env: TournamentEnv, tournamentId: string): Promise<Response> {
  const playerId = await authPlayer(request, env);
  if (playerId instanceof Response) return playerId;
  if (!takeToken(`match:${playerId}`, "match")) return rateLimited();

  const t = await env.DB
    .prepare("SELECT buy_in, status FROM tournaments WHERE tournament_id = ?")
    .bind(tournamentId)
    .first<{ buy_in: number; status: string }>();
  if (!t) return Response.json({ error: "tournament not found" }, { status: 404 });
  if (t.status !== "registering")
    return Response.json({ error: "registration closed" }, { status: 409 });

  const now = Date.now();
  const debit = await env.DB
    .prepare(
      "UPDATE users SET chip_balance = chip_balance - ?, updated_at = ?" +
      " WHERE player_id = ? AND chip_balance >= ?",
    )
    .bind(t.buy_in, now, playerId, t.buy_in)
    .run();
  if (!debit.success || (debit.meta?.changes ?? 0) === 0) {
    return Response.json({ error: "insufficient chips" }, { status: 402 });
  }

  try {
    await env.DB.batch([
      env.DB
        .prepare(
          "INSERT INTO tournament_entries (tournament_id, player_id, registered_at)" +
          " VALUES (?, ?, ?)",
        )
        .bind(tournamentId, playerId, now),
      env.DB
        .prepare(
          "INSERT INTO chip_ledger (player_id, game_id, delta, reason, created_at)" +
          " VALUES (?, ?, ?, 'tournament', ?)",
        )
        .bind(playerId, tournamentId, -t.buy_in, now),
    ]);
  } catch {
    // duplicate entry / DB error — refund and report
    await env.DB
      .prepare("UPDATE users SET chip_balance = chip_balance + ? WHERE player_id = ?")
      .bind(t.buy_in, playerId)
      .run().catch(() => {});
    return Response.json({ error: "already registered or DB error" }, { status: 409 });
  }

  // Notify TournamentDO; it auto-starts when the 4th player joins.
  const stub = env.TOURNAMENT_DO.get(env.TOURNAMENT_DO.idFromName(tournamentId));
  const r = await stub.fetch(new Request("https://tournament.internal/join", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId }),
  }));
  if (!r.ok) return new Response(await r.text(), { status: r.status });

  log("info", "tournament_joined", { tournamentId, playerId });
  return Response.json({ ok: true });
}

// ── GET /api/tournaments — list registering tournaments ──────────────

export async function listTournaments(_request: Request, env: TournamentEnv): Promise<Response> {
  const rows = await env.DB
    .prepare(
      "SELECT t.tournament_id, t.game_type, t.buy_in, t.prize_pool, t.status, t.created_at," +
      "       (SELECT COUNT(*) FROM tournament_entries WHERE tournament_id = t.tournament_id) AS registered" +
      " FROM tournaments t" +
      " WHERE t.status = 'registering'" +
      " ORDER BY t.created_at DESC LIMIT 20",
    )
    .all<{
      tournament_id: string; game_type: string; buy_in: number;
      prize_pool: number; status: string; created_at: number; registered: number;
    }>();
  return Response.json({ rows: rows.results ?? [], required: REQUIRED });
}

// ── GET /api/tournaments/:id ─────────────────────────────────────────

export async function getTournament(_request: Request, env: TournamentEnv, tournamentId: string): Promise<Response> {
  const t = await env.DB
    .prepare(
      "SELECT tournament_id, game_type, buy_in, rounds_total, rounds_done," +
      "       status, prize_pool, current_room, started_at, finished_at, winner_id" +
      " FROM tournaments WHERE tournament_id = ?",
    )
    .bind(tournamentId)
    .first();
  if (!t) return Response.json({ error: "not found" }, { status: 404 });

  const entries = await env.DB
    .prepare(
      "SELECT player_id, agg_score, final_rank FROM tournament_entries" +
      " WHERE tournament_id = ? ORDER BY agg_score DESC",
    )
    .bind(tournamentId)
    .all<{ player_id: string; agg_score: number; final_rank: number | null }>();

  // Live currentRoom comes from TournamentDO since the DB column is updated lazily.
  const stub = env.TOURNAMENT_DO.get(env.TOURNAMENT_DO.idFromName(tournamentId));
  let currentRoom: string | null = null;
  try {
    const r = await stub.fetch(new Request("https://tournament.internal/state"));
    if (r.ok) {
      const live = await r.json<{ currentRoom: string | null }>();
      currentRoom = live.currentRoom;
    }
  } catch { /* DO may not be hydrated yet */ }

  return Response.json({ tournament: t, entries: entries.results ?? [], currentRoom });
}
