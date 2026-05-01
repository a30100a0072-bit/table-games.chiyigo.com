// /src/api/replays.ts
// Read-only replay API. Per-game payloads are denormalised into a single
// replay_meta row at settle time (see GameRoomDO.handleSettlement).
//
// engine_version stamping: a replay carrying an older version still
// returns the metadata + winner, but `replayable: false` tells the
// client not to attempt to restoreEngine + step through the events,
// since the state machine has shifted underneath them.                   // L3_架構

import { verifyJWT, JWTError, jwksFromPrivateEnv } from "../utils/auth";
import { ENGINE_VERSION }                          from "../game/GameEngineAdapter";

export interface ReplaysEnv {
  DB:              D1Database;
  JWT_PRIVATE_JWK: string;
}

async function authPlayer(request: Request, env: ReplaysEnv): Promise<string | Response> {
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

interface ReplayMetaRow {
  game_id: string; game_type: string; engine_version: number;
  player_ids: string; initial_snapshot: string; events: string;
  started_at: number; finished_at: number;
  winner_id: string | null; reason: string | null;
}

// ── GET /api/me/replays ──────────────────────────────────────────────────
// Recent finished games where the caller was a player. Cheap listing —
// snapshot/events blobs are NOT included to keep the response small.
export async function listMyReplays(request: Request, env: ReplaysEnv): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;

  // SQLite has no native JSON contains; use LIKE on the JSON-encoded
  // player_ids array. Quoting the playerId in JSON form ("alice")
  // prevents a substring match against bots like "BOT_alice_1" and
  // also rules out matching "ali" inside "alice".
  const needle = `%${JSON.stringify(me)}%`;
  const rows = await env.DB
    .prepare(
      "SELECT game_id, game_type, engine_version, player_ids," +
      "       started_at, finished_at, winner_id, reason" +
      " FROM replay_meta" +
      " WHERE player_ids LIKE ?" +
      " ORDER BY finished_at DESC LIMIT 30",
    )
    .bind(needle)
    .all<Omit<ReplayMetaRow, "initial_snapshot" | "events">>();

  return Response.json({
    engineVersion: ENGINE_VERSION,
    replays: (rows.results ?? []).map(r => ({
      gameId:        r.game_id,
      gameType:      r.game_type,
      engineVersion: r.engine_version,
      playerIds:     JSON.parse(r.player_ids) as string[],
      startedAt:     r.started_at,
      finishedAt:    r.finished_at,
      winnerId:      r.winner_id,
      reason:        r.reason,
      replayable:    r.engine_version === ENGINE_VERSION,
    })),
  });
}

// ── GET /api/replays/:gameId ─────────────────────────────────────────────
// Full replay payload. Caller must have been one of the seats — bots
// don't query this endpoint, and arbitrary users shouldn't be able to
// browse other people's hands.
export async function getReplay(request: Request, env: ReplaysEnv, gameId: string): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;

  const row = await env.DB
    .prepare(
      "SELECT game_id, game_type, engine_version, player_ids, initial_snapshot," +
      "       events, started_at, finished_at, winner_id, reason" +
      " FROM replay_meta WHERE game_id = ?",
    )
    .bind(gameId)
    .first<ReplayMetaRow>();
  if (!row) return Response.json({ error: "not found" }, { status: 404 });

  const playerIds = JSON.parse(row.player_ids) as string[];
  if (!playerIds.includes(me))
    return Response.json({ error: "forbidden" }, { status: 403 });

  const replayable = row.engine_version === ENGINE_VERSION;
  const events = replayable ? JSON.parse(row.events) : [];
  const initialSnapshot = replayable ? JSON.parse(row.initial_snapshot) : null;

  return Response.json({
    gameId:          row.game_id,
    gameType:        row.game_type,
    engineVersion:   row.engine_version,
    currentVersion:  ENGINE_VERSION,
    replayable,
    playerIds,
    initialSnapshot,
    events,
    startedAt:       row.started_at,
    finishedAt:      row.finished_at,
    winnerId:        row.winner_id,
    reason:          row.reason,
  });
}
