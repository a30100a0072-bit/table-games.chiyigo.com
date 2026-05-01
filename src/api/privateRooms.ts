// /src/api/privateRooms.ts
// Private rooms via capability tokens. Creator gets a 128-bit token,
// shares the URL out-of-band, and any JWT-authed user holding the
// token can resolve it back to a game_id and WS-join. Anyone WITHOUT
// the token has nothing to attack — game_id is a v4 UUID, the access
// path requires the token to discover it.                              // L3_架構含防禦觀測
//
// ANTE / chip economy bypassed at room creation: private rooms don't
// route through Lobby/handleMatch, so the per-match floor doesn't fire.
// Settlement chips still flow normally on game outcome.

import { verifyJWT, JWTError, jwksFromPrivateEnv } from "../utils/auth";
import { takeToken, rateLimited }                  from "../utils/rateLimit";
import { log }                                      from "../utils/log";
import type { GameType }                           from "../types/game";
import { isGameType }                               from "../types/game";

export interface PrivateRoomsEnv {
  GAME_ROOM:       DurableObjectNamespace;
  DB:              D1Database;
  JWT_PRIVATE_JWK: string;
}

const DEFAULT_TTL_MIN = 24 * 60;        // 24 h
const MAX_TTL_MIN     = 7  * 24 * 60;   // 7 days hard cap
const MIN_TTL_MIN     = 5;

async function authPlayer(request: Request, env: PrivateRoomsEnv): Promise<string | Response> {
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

/** 16 random bytes → base64url, ~22 chars, 128-bit entropy. */
function newToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function defaultCapacity(gt: GameType): number {
  return gt === "mahjong" ? 4 : 4;   // all games are 4-player today; explicit for future
}

// ── POST /api/rooms/private ──────────────────────────────────────────────
// Body: { gameType, capacity?, ttlMinutes? }
// Returns: { roomId, gameType, capacity, joinToken, expiresAt }
export async function createPrivateRoom(request: Request, env: PrivateRoomsEnv): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;
  // Reuse the match bucket — creating rooms is roughly the same blast
  // radius as queueing for matchmaking, and stops a creation flood from
  // exhausting D1 storage with parked tokens.
  if (!takeToken(`match:${me}`, "match")) return rateLimited();

  let body: { gameType?: string; capacity?: number; ttlMinutes?: number };
  try { body = await request.json(); }
  catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }

  if (!isGameType(body.gameType))
    return Response.json({ error: "gameType required" }, { status: 400 });

  const gt       = body.gameType;
  const capacity = Number.isInteger(body.capacity) ? body.capacity! : defaultCapacity(gt);
  if (capacity < 2 || capacity > 4)
    return Response.json({ error: "capacity must be 2–4" }, { status: 400 });
  if (gt === "mahjong" && capacity !== 4)
    return Response.json({ error: "mahjong requires capacity=4" }, { status: 400 });

  const ttlMin =
    Number.isInteger(body.ttlMinutes)
      ? Math.max(MIN_TTL_MIN, Math.min(MAX_TTL_MIN, body.ttlMinutes!))
      : DEFAULT_TTL_MIN;

  const gameId  = crypto.randomUUID();
  const roundId = crypto.randomUUID();
  const stub    = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId));

  // 1. Init the DO. Failure here means we never persist a token, so a
  //    half-broken state can't leak.
  const init = await stub.fetch(new Request("https://gameroom.internal/init", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId, roundId, gameType: gt, capacity }),
  }));
  if (!init.ok)
    return Response.json({ error: "room init failed" }, { status: 500 });

  // 2. Persist the token. INSERT can theoretically collide on the
  //    PRIMARY KEY but base64url(16 bytes) makes that ~1-in-2^128.
  const now       = Date.now();
  const expiresAt = now + ttlMin * 60 * 1000;
  const token     = newToken();
  await env.DB
    .prepare(
      "INSERT INTO room_tokens (token, game_id, game_type, capacity, created_by, created_at, expires_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(token, gameId, gt, capacity, me, now, expiresAt)
    .run();

  log("info", "private_room_created", { creator: me, gameId, gameType: gt, ttlMin });
  return Response.json(
    { roomId: gameId, gameType: gt, capacity, joinToken: token, expiresAt },
    { status: 201 },
  );
}

// ── GET /api/rooms/by-token/:token ───────────────────────────────────────
// Auth required so anonymous reconnaissance doesn't enumerate. Returns
// the gameId + meta the client needs to open a WS via existing path.
export async function resolvePrivateRoom(
  request: Request, env: PrivateRoomsEnv, token: string,
): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;
  if (!takeToken(`match:${me}`, "match")) return rateLimited();

  const row = await env.DB
    .prepare("SELECT game_id, game_type, capacity, expires_at FROM room_tokens WHERE token = ?")
    .bind(token)
    .first<{ game_id: string; game_type: string; capacity: number; expires_at: number }>();
  if (!row) return Response.json({ error: "token not found" }, { status: 404 });
  if (row.expires_at < Date.now())
    return Response.json({ error: "token expired" }, { status: 410 });

  return Response.json({
    roomId:    row.game_id,
    gameType:  row.game_type,
    capacity:  row.capacity,
    expiresAt: row.expires_at,
  });
}
