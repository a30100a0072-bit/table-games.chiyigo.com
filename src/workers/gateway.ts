// /src/workers/gateway.ts
import { verifyJWT, signJWT, JWTError, jwksFromPrivateEnv } from "../utils/auth";
import { takeToken, rateLimited, clientIp }                 from "../utils/rateLimit";
import { log, errStr }                                       from "../utils/log";
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

  if (request.method === "GET" && url.pathname === "/.well-known/jwks.json")
    return cors(jwksResponse(env));

  if (request.method === "POST" && url.pathname === "/auth/token") {
    const ip = clientIp(request);
    if (!takeToken(`token:${ip}`, "token")) {
      log("warn", "rate_limited", { ip, route: "/auth/token" });
      return cors(rateLimited());
    }
    return cors(await issueToken(request, env));
  }

  if (request.method === "POST" && url.pathname === "/rooms")
    return cors(await createRoom(request, env));

  if (request.method === "POST" && url.pathname === "/api/match")
    return cors(await handleMatch(request, env));

  if (request.method === "GET" && url.pathname === "/api/me/wallet")
    return cors(await getWallet(request, env));

  if (request.method === "POST" && url.pathname === "/api/me/bailout")
    return cors(await claimBailout(request, env));

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

  // Lazy-create the user wallet on first login. Idempotent: returning users
  // hit INSERT OR IGNORE / UNIQUE on the signup ledger row and nothing changes.
  // Bots are rejected above so this branch is humans-only.               // L2_實作
  await ensureUserWallet(env.DB, playerId);

  const token = await signJWT(playerId, env.JWT_PRIVATE_JWK);
  log("info", "token_issued", { playerId });
  return Response.json({ token, playerId });
}

const SIGNUP_GRANT = 1000;

// ── GET /api/me/wallet — current balance + recent ledger ─────────────
// Returns the authenticated player's chip balance and their last 20 ledger
// entries (newest first). Used by the frontend to render wallet UI.    // L2_實作

async function getWallet(request: Request, env: GatewayEnv): Promise<Response> {
  const auth  = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  let playerId: string;
  try {
    playerId = await verifyJWT(token, jwksFromPrivateEnv(env.JWT_PRIVATE_JWK));
  } catch (err) {
    return Response.json(
      { error: err instanceof JWTError ? err.message : "unauthorized" },
      { status: 401 },
    );
  }

  if (!takeToken(`wallet:${playerId}`, "wallet")) return rateLimited();

  const [walletRow, ledger] = await Promise.all([
    env.DB
      .prepare("SELECT display_name, chip_balance, updated_at FROM users WHERE player_id = ?")
      .bind(playerId)
      .first<{ display_name: string; chip_balance: number; updated_at: number }>(),
    env.DB
      .prepare(
        "SELECT ledger_id, game_id, delta, reason, created_at" +
        " FROM chip_ledger WHERE player_id = ?" +
        " ORDER BY ledger_id DESC LIMIT 20",
      )
      .bind(playerId)
      .all<{ ledger_id: number; game_id: string | null; delta: number; reason: string; created_at: number }>(),
  ]);

  if (!walletRow) return Response.json({ error: "wallet not found" }, { status: 404 });

  return Response.json({
    playerId,
    displayName: walletRow.display_name,
    chipBalance: walletRow.chip_balance,
    updatedAt:   walletRow.updated_at,
    ledger:      ledger.results ?? [],
  });
}

// ── POST /api/me/bailout — daily救濟金 ────────────────────────────────
// 條件：餘額 < 100 且距離上次領取 ≥ 24h；給 500 籌碼。寫一筆 ledger。
// 使用 chip_ledger 的 UNIQUE(player_id, game_id, reason) 無法擋（因為
// game_id 為 NULL，多次領取仍可能寫入），所以用 last_bailout_at 欄位
// 作為防重領的真正鎖。寫入採 conditional UPDATE 確保原子性。           // L3_架構含防禦觀測

const BAILOUT_THRESHOLD = 100;
const BAILOUT_AMOUNT    = 500;
const BAILOUT_COOLDOWN  = 24 * 60 * 60 * 1000;

async function claimBailout(request: Request, env: GatewayEnv): Promise<Response> {
  const auth  = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  let playerId: string;
  try {
    playerId = await verifyJWT(token, jwksFromPrivateEnv(env.JWT_PRIVATE_JWK));
  } catch (err) {
    return Response.json(
      { error: err instanceof JWTError ? err.message : "unauthorized" },
      { status: 401 },
    );
  }

  if (!takeToken(`bailout:${playerId}`, "bailout")) return rateLimited();

  const now    = Date.now();
  const cutoff = now - BAILOUT_COOLDOWN;

  // Single-statement UPDATE acts as a CAS: rows-affected tells us whether
  // the cooldown window let us through. If 0, we know the player is either
  // already over the threshold or still on cooldown.                       // L3_架構含防禦觀測
  const upd = await env.DB
    .prepare(
      "UPDATE users SET" +
      "  chip_balance    = chip_balance + ?," +
      "  last_bailout_at = ?," +
      "  updated_at      = ?" +
      " WHERE player_id = ?" +
      "   AND chip_balance < ?" +
      "   AND last_bailout_at <= ?",
    )
    .bind(BAILOUT_AMOUNT, now, now, playerId, BAILOUT_THRESHOLD, cutoff)
    .run();

  if (!upd.success || (upd.meta?.changes ?? 0) === 0) {
    const wallet = await env.DB
      .prepare("SELECT chip_balance, last_bailout_at FROM users WHERE player_id = ?")
      .bind(playerId)
      .first<{ chip_balance: number; last_bailout_at: number }>();
    if (!wallet) {
      log("warn", "bailout_blocked", { playerId, reason: "wallet_not_found" });
      return Response.json({ error: "wallet not found" }, { status: 404 });
    }
    const reason = wallet.chip_balance >= BAILOUT_THRESHOLD
      ? "balance above threshold"
      : "cooldown active";
    const nextEligibleAt = wallet.last_bailout_at + BAILOUT_COOLDOWN;
    log("info", "bailout_blocked", { playerId, reason, balance: wallet.chip_balance });
    return Response.json(
      { error: reason, balance: wallet.chip_balance, nextEligibleAt },
      { status: 409 },
    );
  }

  await env.DB
    .prepare(
      "INSERT INTO chip_ledger (player_id, game_id, delta, reason, created_at)" +
      " VALUES (?, NULL, ?, 'bailout', ?)",
    )
    .bind(playerId, BAILOUT_AMOUNT, now)
    .run();

  const after = await env.DB
    .prepare("SELECT chip_balance FROM users WHERE player_id = ?")
    .bind(playerId)
    .first<{ chip_balance: number }>();

  log("info", "bailout_granted", {
    playerId, granted: BAILOUT_AMOUNT, balanceAfter: after?.chip_balance ?? BAILOUT_AMOUNT,
  });

  return Response.json({
    granted: BAILOUT_AMOUNT,
    chipBalance: after?.chip_balance ?? BAILOUT_AMOUNT,
    nextEligibleAt: now + BAILOUT_COOLDOWN,
  });
}

async function ensureUserWallet(db: D1Database, playerId: string): Promise<void> {
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO users (player_id, display_name, chip_balance, created_at, updated_at)" +
        " VALUES (?, ?, ?, ?, ?)",
      )
      .bind(playerId, playerId, SIGNUP_GRANT, now, now),
    db
      .prepare(
        "INSERT OR IGNORE INTO chip_ledger (player_id, game_id, delta, reason, created_at)" +
        " VALUES (?, NULL, ?, 'signup', ?)",
      )
      .bind(playerId, SIGNUP_GRANT, now),
  ]);
}

// ── GET /.well-known/jwks.json — public keys for token verification ───
// Stateless: any external service (or this Worker on a future cold start)
// can verify our ES256 tokens by fetching this document.               // L3_架構含防禦觀測

function jwksResponse(env: GatewayEnv): Response {
  const jwks = jwksFromPrivateEnv(env.JWT_PRIVATE_JWK);
  return new Response(JSON.stringify(jwks), {
    headers: {
      "Content-Type": "application/jwk-set+json",
      "Cache-Control": "public, max-age=300",
    },
  });
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
    playerId = await verifyJWT(token, jwksFromPrivateEnv(env.JWT_PRIVATE_JWK));
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
