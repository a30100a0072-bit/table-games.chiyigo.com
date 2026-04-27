// /src/workers/gateway.ts
import { verifyJWT, signJWT, JWTError } from "../utils/auth";
import { handleMatch, LobbyEnv }        from "../api/lobby";
import type { SettlementQueueMessage, GameType }  from "../types/game";
import { isGameType } from "../types/game";

export interface GatewayEnv extends LobbyEnv {
  GAME_ROOM:        DurableObjectNamespace;
  SETTLEMENT_QUEUE: Queue<SettlementQueueMessage>;
}

// ── Router ────────────────────────────────���─────────────────────────���─────

export async function handleRequest(request: Request, env: GatewayEnv): Promise<Response> {
  const url = new URL(request.url);

  // CORS pre-flight (Cloudflare Pages frontend on a different origin)
  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

  if (request.method === "POST" && url.pathname === "/auth/token")
    return cors(await issueToken(request, env));

  if (request.method === "POST" && url.pathname === "/rooms")
    return cors(await createRoom(request, env));

  if (request.method === "POST" && url.pathname === "/api/match")
    return cors(await handleMatch(request, env));

  const wsMatch = url.pathname.match(/^\/rooms\/([^/]+)\/join$/);
  if (request.method === "GET" && wsMatch)
    return joinRoom(request, env, wsMatch[1]!);   // WS: no CORS wrapper; regex guarantees group 1   // L2_鎖定

  return cors(new Response("not found", { status: 404 }));
}

// ── POST /auth/token — issue a JWT for a given playerId ───────────────���───
// No password required (guest-style auth for MVP).
// Players choose a display name; the JWT sub claim becomes their playerId.

async function issueToken(request: Request, env: GatewayEnv): Promise<Response> {
  let playerId: string;
  try {
    const body = await request.json<{ playerId?: string }>();
    playerId   = (body.playerId ?? "").trim();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (playerId.length < 2 || playerId.length > 20)
    return Response.json({ error: "playerId must be 2–20 chars" }, { status: 400 });

  if (!/^[a-zA-Z0-9_-]+$/.test(playerId))
    return Response.json({ error: "a-z A-Z 0-9 _ - only" }, { status: 400 });

  if (playerId.toUpperCase().startsWith("BOT_"))
    return Response.json({ error: "reserved prefix" }, { status: 400 });

  const token = await signJWT(playerId, env.JWT_SECRET);
  return Response.json({ token, playerId });
}

// ── POST /rooms — create a new GameRoomDO ─────────────────────��──────────

async function createRoom(request: Request, env: GatewayEnv): Promise<Response> {
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

// ── GET /rooms/:gameId/join — verify JWT, upgrade WebSocket ──────────────
// Browser WebSocket does not support custom headers; JWT is in ?token=.   // L3_架構含防禦觀測

async function joinRoom(request: Request, env: GatewayEnv, gameId: string): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket")
    return new Response("WebSocket upgrade required", { status: 426 });

  const url   = new URL(request.url);
  const auth  = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : url.searchParams.get("token") ?? "";  // fallback for browser WS

  let playerId: string;
  try {
    playerId = await verifyJWT(token, env.JWT_SECRET);
  } catch (err) {
    return Response.json(
      { error: err instanceof JWTError ? err.message : "unauthorized" },
      { status: 401 },
    );
  }

  const stub  = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId));
  const doUrl = new URL("https://gameroom.internal/join");
  doUrl.searchParams.set("playerId", playerId);

  return stub.fetch(new Request(doUrl.toString(), { headers: request.headers }));
}

// ── CORS helper ─────────────────────────��─────────────────────────────────

function cors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin",  "*");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  return new Response(res.body, { status: res.status, headers: h });
}
