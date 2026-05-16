// /src/routes/rooms.ts
// Room lifecycle HTTP/WS handlers:
//   POST /rooms              — create a GameRoomDO + return ids
//   GET  /api/rooms/live     — public registry snapshot for spectators
//   GET  /rooms/:id/join     — WS upgrade after JWT verify
//
// joinRoom intentionally uses inline verifyJWT (not requireAuth): the
// browser WebSocket API can't set Authorization, so we accept the
// token via ?token= query as a fallback.                              // L3_架構含防禦觀測

import { verifyJWT, JWTError, jwksFromPrivateEnv } from "../utils/auth";
import { ErrorCode, errorResponse }                 from "../utils/errors";
import type { GameType }                            from "../types/game";
import { isGameType }                               from "../types/game";

export interface RoomsEnv {
  GAME_ROOM:       DurableObjectNamespace;
  LOBBY_DO:        DurableObjectNamespace;
  JWT_PRIVATE_JWK: string;
}

// ── GET /api/rooms/live — spectator registry snapshot ───────────────
export async function listLiveRooms(env: RoomsEnv): Promise<Response> {
  // Single-instance registry — one fetch returns the global view across
  // all game types. Keep the response shape stable for SpectatorModal. // L2_實作
  try {
    const stub = env.LOBBY_DO.get(env.LOBBY_DO.idFromName("registry"));
    const r = await stub.fetch(new Request("https://lobby.internal/live", { method: "GET" }));
    if (!r.ok) return Response.json({ rooms: [] });
    const body = await r.json<{ rooms: unknown }>();
    return Response.json(body);
  } catch {
    return Response.json({ rooms: [] });
  }
}

// ── POST /rooms — create a new GameRoomDO ───────────────────────────
export async function createRoom(request: Request, env: RoomsEnv): Promise<Response> {
  let capacity = 4;
  let gameType: GameType = "bigTwo";
  try {
    const body = await request.json<{ capacity?: number; gameType?: string }>();
    if (typeof body.capacity === "number") capacity = body.capacity;
    if (isGameType(body.gameType)) gameType = body.gameType;
  } catch { /* default */ }

  const gameId  = crypto.randomUUID();
  const roundId = crypto.randomUUID();
  const stub    = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId));

  const init = await stub.fetch(new Request("https://gameroom.internal/init", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId, roundId, gameType, capacity }),
  }));

  if (!init.ok) return new Response(await init.text(), { status: init.status });
  return Response.json({ gameId, roundId, gameType }, { status: 201 });
}

// ── GET /rooms/:gameId/join — verify JWT, upgrade WebSocket ──────────
export async function joinRoom(
  request: Request, env: RoomsEnv, gameId: string,
): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket")
    return new Response("WebSocket upgrade required", { status: 426 });

  // Inline verify (not requireAuth): the browser WebSocket API can't
  // set custom headers, so we accept the token via ?token= query as a
  // fallback. requireAuth only knows about the Authorization header.
  const url   = new URL(request.url);
  const auth  = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : url.searchParams.get("token") ?? "";

  let playerId: string;
  try {
    playerId = await verifyJWT(token, jwksFromPrivateEnv(env.JWT_PRIVATE_JWK));
  } catch (err) {
    return errorResponse(
      ErrorCode.UNAUTHORIZED, 401,
      err instanceof JWTError ? err.message : undefined,
    );
  }

  const stub  = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId));
  const doUrl = new URL("https://gameroom.internal/join");
  doUrl.searchParams.set("playerId", playerId);
  // Read-only spectator path: client passes `?spectator=1` and the DO
  // accepts the WS without taking a seat. Token auth still applies.
  if (url.searchParams.get("spectator") === "1")
    doUrl.searchParams.set("spectator", "1");

  return stub.fetch(new Request(doUrl.toString(), { headers: request.headers }));
}
