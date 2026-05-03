// /src/workers/gateway.ts
import { verifyJWT, signJWT, JWTError, jwksFromPrivateEnv } from "../utils/auth";
import { takeToken, rateLimited, clientIp }                 from "../utils/rateLimit";
import { ErrorCode, errorResponse }                          from "../utils/errors";
import { log, errStr }                                       from "../utils/log";
import { bump, snapshotMetrics }                             from "../utils/metrics";
import { handleMatch, LobbyEnv }        from "../api/lobby";
import {
  createTournament, joinTournament, listTournaments, getTournament,
  listMyTournaments,
} from "../api/tournaments";
import {
  requestFriend, acceptFriend, declineFriend, unfriend, listFriends, recommendFriends,
} from "../api/friends";
import { createPrivateRoom, resolvePrivateRoom } from "../api/privateRooms";
import { inviteToRoom, listInvites, declineInvite } from "../api/roomInvites";
import { listMyReplays, getReplay, shareReplay, resolveSharedReplay, listMyShares, revokeShare, featureReplay, unfeatureReplay, listFeaturedReplays } from "../api/replays";
import { sendDm, listInbox, unreadDmCount } from "../api/dms";
import { blockPlayer, unblockPlayer, listMyBlocks } from "../api/blocks";
import { deleteAccount, exportAccount } from "../api/account";
import { oauthStart, oauthExchange, oauthRefresh, oauthLogout } from "../api/oidc";
import type { SettlementQueueMessage, GameType }  from "../types/game";
import { isGameType } from "../types/game";

export interface GatewayEnv extends LobbyEnv {
  GAME_ROOM:        DurableObjectNamespace;
  TOURNAMENT_DO:    DurableObjectNamespace;
  SETTLEMENT_QUEUE: Queue<SettlementQueueMessage>;
  ADMIN_SECRET?:    string;          // optional; admin endpoints fail closed if unset
  // OIDC client config (chiyigo.com SSO). Optional — endpoints return
  // 503 if unset so a misconfigured deploy fails closed instead of
  // silently routing users into a broken flow.                          // L2_隔離
  OIDC_ISSUER?:        string;
  OIDC_CLIENT_ID?:     string;
  OIDC_REDIRECT_URI?:  string;
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
      bump("rate_limited");
      log("warn", "rate_limited", { ip, route: "/auth/token" });
      return cors(rateLimited());
    }
    return cors(await issueToken(request, env));
  }

  // ── OIDC (chiyigo.com SSO) ──────────────────────────────────────────
  // start: 302 to authorize endpoint — NOT wrapped in cors() because
  //        it's a top-level browser navigation, not a fetch.
  // exchange / refresh / logout: SPA-driven JSON, normal cors().
  if (request.method === "GET" && url.pathname === "/auth/oauth/start") {
    const ip = clientIp(request);
    if (!takeToken(`token:${ip}`, "token")) {
      bump("rate_limited");
      log("warn", "rate_limited", { ip, route: "/auth/oauth/start" });
      return cors(rateLimited());
    }
    return oauthStart(request, env);
  }
  if (request.method === "POST" && url.pathname === "/auth/oauth/exchange") {
    const ip = clientIp(request);
    if (!takeToken(`token:${ip}`, "token")) {
      bump("rate_limited");
      return cors(rateLimited());
    }
    return cors(await oauthExchange(request, env));
  }
  if (request.method === "POST" && url.pathname === "/auth/oauth/refresh") {
    const auth  = request.headers.get("Authorization") ?? "";
    const tok   = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let pid: string;
    try { pid = await verifyJWT(tok, jwksFromPrivateEnv(env.JWT_PRIVATE_JWK)); }
    catch { return cors(new Response(JSON.stringify({ error: "unauthorized", code: "UNAUTHORIZED" }), { status: 401, headers: { "Content-Type": "application/json" } })); }
    return cors(await oauthRefresh(pid, env));
  }
  if (request.method === "POST" && url.pathname === "/auth/oauth/logout") {
    const auth  = request.headers.get("Authorization") ?? "";
    const tok   = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let pid = "";
    try { pid = await verifyJWT(tok, jwksFromPrivateEnv(env.JWT_PRIVATE_JWK)); }
    catch { /* logout without a valid token still clears state best-effort */ }
    return cors(await oauthLogout(pid, env));
  }

  if (request.method === "POST" && url.pathname === "/rooms")
    return cors(await createRoom(request, env));

  if (request.method === "POST" && url.pathname === "/api/match")
    return cors(await handleMatch(request, env));

  if (request.method === "GET" && url.pathname === "/api/me/wallet")
    return cors(await getWallet(request, env));

  if (request.method === "POST" && url.pathname === "/api/me/bailout")
    return cors(await claimBailout(request, env));

  if (request.method === "GET" && url.pathname === "/api/me/history")
    return cors(await getHistory(request, env));

  if (request.method === "GET" && url.pathname === "/api/leaderboard")
    return cors(await getLeaderboard(env));

  if (request.method === "GET" && url.pathname === "/metrics")
    return cors(Response.json(snapshotMetrics()));

  if (request.method === "POST" && url.pathname === "/api/admin/adjust")
    return cors(await adjustChips(request, env));

  if (request.method === "POST" && url.pathname === "/api/admin/freeze")
    return cors(await freezePlayer(request, env));

  if (request.method === "POST" && url.pathname === "/api/admin/unfreeze")
    return cors(await unfreezePlayer(request, env));

  if (request.method === "GET"  && url.pathname === "/api/admin/users")
    return cors(await listAdminUsers(request, env));

  if (request.method === "GET"  && url.pathname === "/api/admin/health")
    return cors(await getAdminHealth(request, env));

  if (request.method === "POST" && url.pathname === "/api/tournaments")
    return cors(await createTournament(request, env));

  if (request.method === "GET"  && url.pathname === "/api/tournaments")
    return cors(await listTournaments(request, env));

  if (request.method === "GET"  && url.pathname === "/api/me/tournaments")
    return cors(await listMyTournaments(request, env));

  const tJoin = url.pathname.match(/^\/api\/tournaments\/([^/]+)\/join$/);
  if (request.method === "POST" && tJoin)
    return cors(await joinTournament(request, env, tJoin[1]!));

  const tGet = url.pathname.match(/^\/api\/tournaments\/([^/]+)$/);
  if (request.method === "GET" && tGet)
    return cors(await getTournament(request, env, tGet[1]!));

  // ── Friends ─────────────────────────────────────────────────────────
  if (request.method === "GET"  && url.pathname === "/api/friends")
    return cors(await listFriends(request, env));

  if (request.method === "GET"  && url.pathname === "/api/friends/recommendations")
    return cors(await recommendFriends(request, env));

  if (request.method === "POST" && url.pathname === "/api/friends/request")
    return cors(await requestFriend(request, env));

  const fAccept = url.pathname.match(/^\/api\/friends\/([^/]+)\/accept$/);
  if (request.method === "POST" && fAccept)
    return cors(await acceptFriend(request, env, decodeURIComponent(fAccept[1]!)));

  const fDecline = url.pathname.match(/^\/api\/friends\/([^/]+)\/decline$/);
  if (request.method === "POST" && fDecline)
    return cors(await declineFriend(request, env, decodeURIComponent(fDecline[1]!)));

  const fOther = url.pathname.match(/^\/api\/friends\/([^/]+)$/);
  if (request.method === "DELETE" && fOther)
    return cors(await unfriend(request, env, decodeURIComponent(fOther[1]!)));

  // ── Private rooms ───────────────────────────────────────────────────
  if (request.method === "POST" && url.pathname === "/api/rooms/private")
    return cors(await createPrivateRoom(request, env));

  const tokenJoin = url.pathname.match(/^\/api\/rooms\/by-token\/([^/]+)$/);
  if (request.method === "GET" && tokenJoin)
    return cors(await resolvePrivateRoom(request, env, decodeURIComponent(tokenJoin[1]!)));

  // Spectator: list currently-running rooms (no auth required — privacy is
  // covered by not exposing player IDs, only counts + gameType + age).      // L2_實作
  if (request.method === "GET" && url.pathname === "/api/rooms/live")
    return cors(await listLiveRooms(env));

  // ── Room invites ────────────────────────────────────────────────────
  if (request.method === "POST" && url.pathname === "/api/rooms/invite")
    return cors(await inviteToRoom(request, env));

  if (request.method === "GET"  && url.pathname === "/api/rooms/invites")
    return cors(await listInvites(request, env));

  const invDecline = url.pathname.match(/^\/api\/rooms\/invites\/(\d+)\/decline$/);
  if (request.method === "POST" && invDecline)
    return cors(await declineInvite(request, env, invDecline[1]!));

  // ── Account deletion / export (GDPR) ────────────────────────────────
  if (request.method === "DELETE" && url.pathname === "/api/me")
    return cors(await deleteAccount(request, env));
  if (request.method === "GET"    && url.pathname === "/api/me/export")
    return cors(await exportAccount(request, env));

  // ── Direct messages ─────────────────────────────────────────────────
  if (request.method === "POST" && url.pathname === "/api/dm/send")
    return cors(await sendDm(request, env));
  if (request.method === "GET"  && url.pathname === "/api/dm/inbox")
    return cors(await listInbox(request, env));
  if (request.method === "GET"  && url.pathname === "/api/dm/unread")
    return cors(await unreadDmCount(request, env));

  // ── Blocks ──────────────────────────────────────────────────────────
  if (request.method === "POST" && url.pathname === "/api/blocks")
    return cors(await blockPlayer(request, env));
  if (request.method === "GET"  && url.pathname === "/api/blocks")
    return cors(await listMyBlocks(request, env));
  const blockDel = url.pathname.match(/^\/api\/blocks\/([^/]+)$/);
  if (request.method === "DELETE" && blockDel)
    return cors(await unblockPlayer(request, env, decodeURIComponent(blockDel[1]!)));

  // ── Replays ─────────────────────────────────────────────────────────
  if (request.method === "GET" && url.pathname === "/api/me/replays")
    return cors(await listMyReplays(request, env));

  if (request.method === "GET" && url.pathname === "/api/me/shares")
    return cors(await listMyShares(request, env));

  // Public featured feed (no auth) — list before by-token so the static path wins.
  if (request.method === "GET" && url.pathname === "/api/replays/featured")
    return cors(await listFeaturedReplays(request, env));

  // Admin curation
  if (request.method === "POST" && url.pathname === "/api/admin/replays/feature")
    return cors(await featureReplay(request, env));
  const adminUnfeatureMatch = url.pathname.match(/^\/api\/admin\/replays\/feature\/([^/]+)$/);
  if (request.method === "DELETE" && adminUnfeatureMatch)
    return cors(await unfeatureReplay(request, env, decodeURIComponent(adminUnfeatureMatch[1]!)));

  const repByToken = url.pathname.match(/^\/api\/replays\/by-token\/([^/]+)$/);
  if (request.method === "GET" && repByToken)
    return cors(await resolveSharedReplay(env, decodeURIComponent(repByToken[1]!)));

  const repShare = url.pathname.match(/^\/api\/replays\/([^/]+)\/share$/);
  if (request.method === "POST" && repShare)
    return cors(await shareReplay(request, env, decodeURIComponent(repShare[1]!)));

  const repShareDel = url.pathname.match(/^\/api\/replays\/share\/([^/]+)$/);
  if (request.method === "DELETE" && repShareDel)
    return cors(await revokeShare(request, env, decodeURIComponent(repShareDel[1]!)));

  const repGet = url.pathname.match(/^\/api\/replays\/([^/]+)$/);
  if (request.method === "GET" && repGet)
    return cors(await getReplay(request, env, decodeURIComponent(repGet[1]!)));

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
    return errorResponse(ErrorCode.INVALID_JSON, 400);
  }

  // Frozen account check — defended at the auth boundary so a banned
  // user can't even pick up a token. Match endpoint also checks (defence
  // in depth) for tokens issued before the freeze landed.               // L3_架構含防禦觀測
  const frozen = await env.DB
    .prepare("SELECT frozen_at, frozen_reason FROM users WHERE player_id = ?")
    .bind(playerId)
    .first<{ frozen_at: number; frozen_reason: string | null }>();
  if (frozen && frozen.frozen_at > 0) {
    log("warn", "auth_blocked_frozen", { playerId, reason: frozen.frozen_reason ?? "unspecified" });
    return errorResponse(
      ErrorCode.ACCOUNT_FROZEN, 423, undefined,
      { reason: frozen.frozen_reason ?? "" },
    );
  }

  if (playerId.length < 2 || playerId.length > 20)
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "playerId must be 2–20 chars");

  if (!/^[a-zA-Z0-9_-]+$/.test(playerId))
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "a-z A-Z 0-9 _ - only");

  if (playerId.toUpperCase().startsWith("BOT_"))
    return errorResponse(ErrorCode.RESERVED_PREFIX, 400);

  // Deletion tombstones look like `DELETED_<hex>`. Guard signup so a user
  // can't recreate a tombstoned identity.                                 // L3_架構含防禦觀測
  if (playerId.toUpperCase().startsWith("DELETED_"))
    return errorResponse(ErrorCode.RESERVED_PREFIX, 400);

  // Lazy-create the user wallet on first login. Idempotent: returning users
  // hit INSERT OR IGNORE / UNIQUE on the signup ledger row and nothing changes.
  // Bots are rejected above so this branch is humans-only.               // L2_實作
  await ensureUserWallet(env.DB, playerId);
  const dailyBonus = await maybeGrantDailyBonus(env.DB, playerId);

  const token = await signJWT(playerId, env.JWT_PRIVATE_JWK);
  bump("tokens_issued");
  log("info", "token_issued", { playerId, dailyBonus: dailyBonus ?? 0 });
  return Response.json({ token, playerId, dailyBonus });
}

const DAILY_BONUS_AMOUNT   = 100;
const DAILY_BONUS_COOLDOWN = 24 * 60 * 60 * 1000;

/**
 * Grant a daily-login bonus iff last_login_at is older than the cooldown.
 * Conditional UPDATE acts as CAS so concurrent /auth/token calls in the same
 * 24h window can't double-grant. Returns the granted amount or null.    // L3_架構含防禦觀測
 */
async function maybeGrantDailyBonus(db: D1Database, playerId: string): Promise<number | null> {
  const now    = Date.now();
  const cutoff = now - DAILY_BONUS_COOLDOWN;
  const upd = await db
    .prepare(
      "UPDATE users SET" +
      "  chip_balance  = chip_balance + ?," +
      "  last_login_at = ?," +
      "  updated_at    = ?" +
      " WHERE player_id = ?" +
      "   AND last_login_at <= ?",
    )
    .bind(DAILY_BONUS_AMOUNT, now, now, playerId, cutoff)
    .run();
  if (!upd.success || (upd.meta?.changes ?? 0) === 0) return null;
  await db
    .prepare(
      "INSERT INTO chip_ledger (player_id, game_id, delta, reason, created_at)" +
      " VALUES (?, NULL, ?, 'daily', ?)",
    )
    .bind(playerId, DAILY_BONUS_AMOUNT, now)
    .run();
  bump("daily_bonus_granted");
  log("info", "daily_bonus_granted", { playerId, amount: DAILY_BONUS_AMOUNT });
  return DAILY_BONUS_AMOUNT;
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
    return errorResponse(
      ErrorCode.UNAUTHORIZED, 401,
      err instanceof JWTError ? err.message : undefined,
    );
  }

  if (!takeToken(`wallet:${playerId}`, "wallet")) return rateLimited();

  // Cursor pagination: ?ledgerCursor=N returns rows with ledger_id < N,
  // newest first. Lets the wallet UI load older history without re-
  // fetching everything. Cursor of 0 / unset = "from the top".
  const url = new URL(request.url);
  const cursorRaw = url.searchParams.get("ledgerCursor");
  const cursor = cursorRaw && /^\d+$/.test(cursorRaw)
    ? Number(cursorRaw)
    : Number.MAX_SAFE_INTEGER;

  const PAGE_SIZE = 20;

  const [walletRow, ledger] = await Promise.all([
    env.DB
      .prepare("SELECT display_name, chip_balance, updated_at FROM users WHERE player_id = ?")
      .bind(playerId)
      .first<{ display_name: string; chip_balance: number; updated_at: number }>(),
    env.DB
      .prepare(
        "SELECT ledger_id, game_id, delta, reason, created_at" +
        " FROM chip_ledger WHERE player_id = ? AND ledger_id < ?" +
        " ORDER BY ledger_id DESC LIMIT 20",
      )
      .bind(playerId, cursor)
      .all<{ ledger_id: number; game_id: string | null; delta: number; reason: string; created_at: number }>(),
  ]);

  if (!walletRow) return errorResponse(ErrorCode.WALLET_NOT_FOUND, 404);

  const rows = ledger.results ?? [];
  // nextCursor signals "there might be more" — we stamp it whenever we
  // returned a full page. Caller passes it back as ledgerCursor to get
  // the next chunk; null means "you've seen everything".
  const nextLedgerCursor = rows.length === PAGE_SIZE ? rows[rows.length - 1]!.ledger_id : null;

  return Response.json({
    playerId,
    displayName: walletRow.display_name,
    chipBalance: walletRow.chip_balance,
    updatedAt:   walletRow.updated_at,
    ledger:      rows,
    nextLedgerCursor,
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
    return errorResponse(
      ErrorCode.UNAUTHORIZED, 401,
      err instanceof JWTError ? err.message : undefined,
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
      return errorResponse(ErrorCode.WALLET_NOT_FOUND, 404);
    }
    const reason = wallet.chip_balance >= BAILOUT_THRESHOLD
      ? "balance above threshold"
      : "cooldown active";
    const nextEligibleAt = wallet.last_bailout_at + BAILOUT_COOLDOWN;
    log("info", "bailout_blocked", { playerId, reason, balance: wallet.chip_balance });
    return errorResponse(
      ErrorCode.BAILOUT_INELIGIBLE, 409, reason,
      { balance: wallet.chip_balance, nextEligibleAt },
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

  bump("bailouts_granted");
  log("info", "bailout_granted", {
    playerId, granted: BAILOUT_AMOUNT, balanceAfter: after?.chip_balance ?? BAILOUT_AMOUNT,
  });

  return Response.json({
    granted: BAILOUT_AMOUNT,
    chipBalance: after?.chip_balance ?? BAILOUT_AMOUNT,
    nextEligibleAt: now + BAILOUT_COOLDOWN,
  });
}

// ── GET /api/me/history — last 50 settled games for this player ─────
// Joins games × player_settlements so we can show "won/lost X chips on
// game Y at time Z" without N+1 round-trips.

async function getHistory(request: Request, env: GatewayEnv): Promise<Response> {
  const auth  = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  let playerId: string;
  try {
    playerId = await verifyJWT(token, jwksFromPrivateEnv(env.JWT_PRIVATE_JWK));
  } catch (err) {
    return errorResponse(
      ErrorCode.UNAUTHORIZED, 401,
      err instanceof JWTError ? err.message : undefined,
    );
  }

  if (!takeToken(`wallet:${playerId}`, "wallet")) {
    bump("rate_limited");
    return rateLimited();
  }

  const rows = await env.DB
    .prepare(
      "SELECT g.game_id, g.finished_at, g.reason, g.winner_id," +
      "       ps.final_rank, ps.score_delta" +
      " FROM player_settlements ps" +
      " JOIN games g ON g.game_id = ps.game_id" +
      " WHERE ps.player_id = ?" +
      " ORDER BY g.finished_at DESC" +
      " LIMIT 50",
    )
    .bind(playerId)
    .all<{
      game_id: string; finished_at: number; reason: string; winner_id: string;
      final_rank: number; score_delta: number;
    }>();

  return Response.json({
    playerId,
    games: rows.results ?? [],
  });
}

// ── GET /api/leaderboard — top 20 by chip_balance ────────────────────
// No auth required — public scoreboard. Bots are filtered out via the
// BOT_ prefix; settlement consumer never inserts BOT_* into users so
// this is mostly defence-in-depth.

async function getLeaderboard(env: GatewayEnv): Promise<Response> {
  const rows = await env.DB
    .prepare(
      "SELECT player_id, display_name, chip_balance" +
      " FROM users" +
      " WHERE player_id NOT LIKE 'BOT\\_%' ESCAPE '\\'" +
      " ORDER BY chip_balance DESC" +
      " LIMIT 20",
    )
    .all<{ player_id: string; display_name: string; chip_balance: number }>();

  return Response.json({
    updatedAt: Date.now(),
    rows: rows.results ?? [],
  });
}

// ── POST /api/admin/adjust — manual chip adjustment ──────────────────
// Auth: X-Admin-Secret header must equal env.ADMIN_SECRET (timing-safe).
// Body: { playerId, delta (signed integer), reason (free text) }.
// Writes a chip_ledger 'adjustment' row + atomically refreshes balance.

async function adjustChips(request: Request, env: GatewayEnv): Promise<Response> {
  if (!env.ADMIN_SECRET) return errorResponse(ErrorCode.ADMIN_DISABLED, 503);
  const provided = request.headers.get("X-Admin-Secret") ?? "";
  if (!timingSafeEqual(provided, env.ADMIN_SECRET))
    return errorResponse(ErrorCode.UNAUTHORIZED, 401);

  let body: { playerId?: string; delta?: number; reason?: string };
  try { body = await request.json(); }
  catch { return errorResponse(ErrorCode.INVALID_JSON, 400); }

  const playerId = (body.playerId ?? "").trim();
  const delta    = Number(body.delta);
  const reason   = (body.reason ?? "").trim() || "manual";
  if (!playerId || !Number.isFinite(delta) || delta === 0 || !Number.isInteger(delta))
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "playerId + non-zero integer delta required");

  const now = Date.now();
  const upd = await env.DB
    .prepare(
      "UPDATE users SET chip_balance = chip_balance + ?, updated_at = ?" +
      " WHERE player_id = ? AND chip_balance + ? >= 0",
    )
    .bind(delta, now, playerId, delta)
    .run();

  if (!upd.success || (upd.meta?.changes ?? 0) === 0) {
    return errorResponse(ErrorCode.OVERDRAW, 409, "player not found or would overdraw");
  }

  await env.DB
    .prepare(
      "INSERT INTO chip_ledger (player_id, game_id, delta, reason, created_at)" +
      " VALUES (?, NULL, ?, 'adjustment', ?)",
    )
    .bind(playerId, delta, now)
    .run();

  bump("admin_adjustments");
  log("warn", "admin_adjusted", { playerId, delta, reason });
  await writeAudit(env.DB, "adjust", playerId, delta, reason);

  const after = await env.DB
    .prepare("SELECT chip_balance FROM users WHERE player_id = ?")
    .bind(playerId)
    .first<{ chip_balance: number }>();

  return Response.json({
    playerId, delta, reason, chipBalance: after?.chip_balance ?? 0,
  });
}

// ── Shared admin gate (timing-safe + 503 when secret unset) ──────────
function checkAdmin(request: Request, env: GatewayEnv): Response | null {
  if (!env.ADMIN_SECRET) return errorResponse(ErrorCode.ADMIN_DISABLED, 503);
  const provided = request.headers.get("X-Admin-Secret") ?? "";
  if (!timingSafeEqual(provided, env.ADMIN_SECRET))
    return errorResponse(ErrorCode.UNAUTHORIZED, 401);
  return null;
}

// ── POST /api/admin/freeze — block a player from auth + matchmaking ──
async function freezePlayer(request: Request, env: GatewayEnv): Promise<Response> {
  const gate = checkAdmin(request, env);
  if (gate) return gate;

  let body: { playerId?: string; reason?: string };
  try { body = await request.json(); }
  catch { return errorResponse(ErrorCode.INVALID_JSON, 400); }
  const playerId = (body.playerId ?? "").trim();
  const reason   = (body.reason ?? "").trim().slice(0, 200);
  if (!playerId) return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "playerId required");

  const upd = await env.DB
    .prepare(
      "UPDATE users SET frozen_at = ?, frozen_reason = ?, updated_at = ?" +
      " WHERE player_id = ?",
    )
    .bind(Date.now(), reason || null, Date.now(), playerId)
    .run();
  if (!upd.success || (upd.meta?.changes ?? 0) === 0)
    return errorResponse(ErrorCode.NOT_FOUND, 404, "player not found");

  log("warn", "admin_froze", { playerId, reason });
  await writeAudit(env.DB, "freeze", playerId, null, reason);
  return Response.json({ playerId, frozen: true, reason });
}

// ── POST /api/admin/unfreeze ─────────────────────────────────────────
async function unfreezePlayer(request: Request, env: GatewayEnv): Promise<Response> {
  const gate = checkAdmin(request, env);
  if (gate) return gate;

  let body: { playerId?: string };
  try { body = await request.json(); }
  catch { return errorResponse(ErrorCode.INVALID_JSON, 400); }
  const playerId = (body.playerId ?? "").trim();
  if (!playerId) return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "playerId required");

  const upd = await env.DB
    .prepare(
      "UPDATE users SET frozen_at = 0, frozen_reason = NULL, updated_at = ?" +
      " WHERE player_id = ?",
    )
    .bind(Date.now(), playerId)
    .run();
  if (!upd.success || (upd.meta?.changes ?? 0) === 0)
    return errorResponse(ErrorCode.NOT_FOUND, 404, "player not found");

  log("warn", "admin_unfroze", { playerId });
  await writeAudit(env.DB, "unfreeze", playerId, null, null);
  return Response.json({ playerId, frozen: false });
}

// Append-only admin audit row. Best-effort — failure is logged but never
// blocks the user-facing admin response (the action's primary effect is
// already committed by the time we get here).                          // L3_架構含防禦觀測
async function writeAudit(
  db: D1Database, action: string, playerId: string,
  delta: number | null, reason: string | null,
): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT INTO admin_audit (action, player_id, delta, reason, created_at)" +
        " VALUES (?, ?, ?, ?, ?)",
      )
      .bind(action, playerId, delta, reason, Date.now())
      .run();
  } catch (err) {
    log("error", "admin_audit_failed", { err: errStr(err), action, playerId });
  }
}

// ── GET /api/admin/users — list with frozen state, paginated ─────────
async function listAdminUsers(request: Request, env: GatewayEnv): Promise<Response> {
  const gate = checkAdmin(request, env);
  if (gate) return gate;

  const url    = new URL(request.url);
  const limit  = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const search = (url.searchParams.get("q") ?? "").trim();

  const rows = search
    ? await env.DB
        .prepare(
          "SELECT player_id, display_name, chip_balance, frozen_at, frozen_reason, created_at" +
          " FROM users WHERE player_id LIKE ?" +
          " ORDER BY created_at DESC LIMIT ? OFFSET ?",
        )
        .bind(`%${search}%`, limit, offset)
        .all()
    : await env.DB
        .prepare(
          "SELECT player_id, display_name, chip_balance, frozen_at, frozen_reason, created_at" +
          " FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?",
        )
        .bind(limit, offset)
        .all();

  return Response.json({ rows: rows.results ?? [], limit, offset });
}

// ── GET /api/admin/health — operational snapshot ─────────────────────
// Aggregates the few signals an operator wants at a glance: most recent
// cron sweep + recent runs window, table sizes, and frozen-account
// count. All cheap COUNT(*) / single-row reads — meant to be cheap
// enough to poll once a minute from a dashboard.
async function getAdminHealth(request: Request, env: GatewayEnv): Promise<Response> {
  const gate = checkAdmin(request, env);
  if (gate) return gate;

  const now    = Date.now();
  const dayAgo = now - 86_400_000;

  // Run all reads in parallel; each falls back so a single missing table
  // (e.g. cron_runs on a fresh deploy) doesn't tank the whole endpoint.
  const [lastCron, recentCronRows, frozen, ledger, replays, dms, shares] = await Promise.all([
    env.DB.prepare(
      "SELECT ran_at, dms_purged, room_tokens_purged, replay_shares_purged," +
      "       room_invites_purged, errors_json" +
      "  FROM cron_runs ORDER BY ran_at DESC LIMIT 1",
    ).first<{
      ran_at: number; dms_purged: number; room_tokens_purged: number;
      replay_shares_purged: number; room_invites_purged: number;
      errors_json: string | null;
    }>().catch(() => null),
    env.DB.prepare(
      "SELECT COUNT(*) AS n, SUM(CASE WHEN errors_json IS NOT NULL THEN 1 ELSE 0 END) AS failed" +
      "  FROM cron_runs WHERE ran_at >= ?",
    ).bind(now - 7 * 86_400_000)
     .first<{ n: number; failed: number }>().catch(() => ({ n: 0, failed: 0 })),
    env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE frozen_at > 0")
      .first<{ n: number }>().catch(() => ({ n: 0 })),
    env.DB.prepare("SELECT COUNT(*) AS n FROM chip_ledger WHERE created_at >= ?")
      .bind(dayAgo).first<{ n: number }>().catch(() => ({ n: 0 })),
    env.DB.prepare("SELECT COUNT(*) AS n FROM replay_meta")
      .first<{ n: number }>().catch(() => ({ n: 0 })),
    env.DB.prepare("SELECT COUNT(*) AS n FROM dms")
      .first<{ n: number }>().catch(() => ({ n: 0 })),
    env.DB.prepare("SELECT COUNT(*) AS n FROM replay_shares WHERE expires_at > ?")
      .bind(now).first<{ n: number }>().catch(() => ({ n: 0 })),
  ]);

  return Response.json({
    now,
    cron: {
      lastRunAt:      lastCron?.ran_at ?? null,
      lastResult:     lastCron && {
        dmsPurged:          lastCron.dms_purged,
        roomTokensPurged:   lastCron.room_tokens_purged,
        replaySharesPurged: lastCron.replay_shares_purged,
        roomInvitesPurged:  lastCron.room_invites_purged,
        errors:             lastCron.errors_json ? JSON.parse(lastCron.errors_json) as string[] : [],
      },
      runsLast7d:     recentCronRows?.n      ?? 0,
      failuresLast7d: recentCronRows?.failed ?? 0,
    },
    counts: {
      frozenUsers:        frozen?.n  ?? 0,
      ledgerRowsLast24h:  ledger?.n  ?? 0,
      replayRows:         replays?.n ?? 0,
      dmRows:             dms?.n     ?? 0,
      activeReplayShares: shares?.n  ?? 0,
    },
  });
}

// Constant-time string compare to avoid leaking the admin secret length.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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

async function listLiveRooms(env: GatewayEnv): Promise<Response> {
  // Single-instance registry — one fetch returns the global view across all
  // game types. Keep the response shape stable for the SpectatorModal.    // L2_實作
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

// ── CORS helper ─────────────────────────��─────────────────────────────────

function cors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin",  "*");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Secret, X-Confirm-Delete");
  h.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  return new Response(res.body, { status: res.status, headers: h });
}
