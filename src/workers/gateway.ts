// /src/workers/gateway.ts
// HTTP entry point. Pure dispatch — every handler lives in src/routes/<area>.ts
// or src/api/<area>.ts (legacy naming for the social/replay surface). Business
// logic and D1 access are NOT permitted here; if you find yourself reaching for
// env.DB.prepare(), put the SQL in src/domain/ and call it from a route.
//
// Per Production Engineering review, post-refactor (2026-05-16): this file is
// the dispatch table + CORS + jwks shell. The "frozen for new routes" banner
// from the prior commit is retired now that the split is in place — adding a
// new endpoint is one route file + one dispatch line.                  // L3_架構含防禦觀測

import { verifyJWT, JWTError, jwksFromPrivateEnv }     from "../utils/auth";
import { takeToken, rateLimited, clientIp }            from "../utils/rateLimit";
import { ErrorCode, errorResponse }                    from "../utils/errors";
import { log }                                          from "../utils/log";
import { bump, snapshotMetrics }                       from "../utils/metrics";
import { checkAdmin }                                   from "../utils/adminAuth";

import { handleMatch, LobbyEnv }                       from "../api/lobby";
import {
  createTournament, joinTournament, listTournaments, getTournament,
  listMyTournaments,
} from "../api/tournaments";
import {
  requestFriend, acceptFriend, declineFriend, unfriend, listFriends, recommendFriends,
} from "../api/friends";
import { createPrivateRoom, resolvePrivateRoom }       from "../api/privateRooms";
import { inviteToRoom, listInvites, declineInvite }    from "../api/roomInvites";
import {
  listMyReplays, getReplay, shareReplay, resolveSharedReplay, listMyShares,
  revokeShare, featureReplay, unfeatureReplay, listFeaturedReplays,
} from "../api/replays";
import { sendDm, listInbox, unreadDmCount }            from "../api/dms";
import { blockPlayer, unblockPlayer, listMyBlocks }    from "../api/blocks";
import { deleteAccount, exportAccount }                from "../api/account";
import { oauthStart, oauthExchange, oauthRefresh, oauthLogout } from "../api/oidc";

import { issueToken }                                  from "../routes/auth";
import { getWallet, claimBailout, getHistory }         from "../routes/wallet";
import { getLeaderboard }                              from "../routes/leaderboard";
import {
  adjustChips, freezePlayer, unfreezePlayer, listAdminUsers, getAdminHealth,
} from "../routes/admin";
import { createRoom, joinRoom, listLiveRooms }         from "../routes/rooms";

import type { SettlementQueueMessage } from "../types/game";

export interface GatewayEnv extends LobbyEnv {
  GAME_ROOM:        DurableObjectNamespace;
  TOURNAMENT_DO:    DurableObjectNamespace;
  SETTLEMENT_QUEUE: Queue<SettlementQueueMessage>;
  ADMIN_SECRET?:    string;          // optional; admin endpoints fail closed if unset
  // Comma-separated CORS allowlist; supports `*.host` wildcard for Pages
  // preview deployments. Unset → only localhost dev origins echoed (fail
  // closed for any public origin).                                       // L3_架構含防禦觀測
  ALLOWED_ORIGINS?:    string;
  // OIDC client config (chiyigo.com SSO). Optional — endpoints return
  // 503 if unset so a misconfigured deploy fails closed instead of
  // silently routing users into a broken flow.                          // L2_隔離
  OIDC_ISSUER?:        string;
  OIDC_CLIENT_ID?:     string;
  OIDC_REDIRECT_URI?:  string;
}

// ── Router ──────────────────────────────────────────────────────────────

export async function handleRequest(request: Request, env: GatewayEnv): Promise<Response> {
  const url = new URL(request.url);

  // ── API versioning (/api/v1/* alias to /api/*) ───────────────────────
  // New clients should target /api/v1/*; legacy /api/* keeps working
  // until SUNSET_DATE. The router below dispatches on /api/*, so we
  // rewrite v1 paths down and remember whether this was a legacy hit
  // so we can stamp Deprecation + Sunset headers on the way out.       // L3_架構含防禦觀測
  const isLegacyApi = url.pathname.startsWith("/api/")
                   && !url.pathname.startsWith("/api/v1/");
  if (url.pathname.startsWith("/api/v1/")) {
    url.pathname = "/api" + url.pathname.slice("/api/v1".length);
  }

  // Per-request CORS origin pick. Closure shadows the module-level
  // `applyCors` so every `cors(res)` call site below is unchanged.
  // Also injects Deprecation/Sunset headers on legacy /api/* hits.       // L3_架構含防禦觀測
  const allowedOrigin = pickCorsOrigin(request, env);
  const cors = (res: Response): Response => {
    const withCors = applyCors(res, allowedOrigin);
    return isLegacyApi ? withDeprecation(withCors) : withCors;
  };

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
    // IP rate limit BEFORE JWT verify so a flood of bad tokens can't burn
    // JWKS work per request. Same `token` bucket as start/exchange
    // (10/min/IP) — refresh is rare in legitimate flows.                  // L3_架構含防禦觀測
    const ip = clientIp(request);
    if (!takeToken(`token:${ip}`, "token")) {
      bump("rate_limited");
      log("warn", "rate_limited", { ip, route: "/auth/oauth/refresh" });
      return cors(rateLimited());
    }
    // Inline verify (not requireAuth) so the IP rate-limit above fires
    // BEFORE JWKS work — a bad-token flood must not burn signature ops.
    const auth  = request.headers.get("Authorization") ?? "";
    const tok   = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let pid: string;
    try { pid = await verifyJWT(tok, jwksFromPrivateEnv(env.JWT_PRIVATE_JWK)); }
    catch { return cors(new Response(JSON.stringify({ error: "unauthorized", code: "UNAUTHORIZED" }), { status: 401, headers: { "Content-Type": "application/json" } })); }
    return cors(await oauthRefresh(pid, env));
  }
  if (request.method === "POST" && url.pathname === "/auth/oauth/logout") {
    // Inline verify (not requireAuth): logout intentionally swallows
    // JWTError so an expired/stolen token can still clear server-side
    // state best-effort. requireAuth would 401 and block that path.
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

  if (request.method === "GET" && url.pathname === "/metrics") {
    // Ops snapshot — admin-only to avoid leaking traffic shape / counters
    // to scrapers. Same gate as /api/admin/*.                            // L3_架構含防禦觀測
    const gate = checkAdmin(request, env);
    if (gate) return cors(gate);
    return cors(Response.json(snapshotMetrics()));
  }

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
    return joinRoom(request, env, wsMatch[1]!);   // WS: no CORS wrapper

  return cors(new Response("not found", { status: 404 }));
}

// ── /.well-known/jwks.json ───────────────────────────────────────────
// Stateless: any external service (or this Worker on a future cold start)
// can verify ES256 tokens by fetching this document.                    // L3_架構含防禦觀測
function jwksResponse(env: GatewayEnv): Response {
  const jwks = jwksFromPrivateEnv(env.JWT_PRIVATE_JWK);
  return new Response(JSON.stringify(jwks), {
    headers: {
      "Content-Type": "application/jwk-set+json",
      "Cache-Control": "public, max-age=300",
    },
  });
}

// Suppress unused-import warnings — JWTError is referenced via instanceof
// inside the inline verify branches above; without an explicit touch tsc
// may flag the type-only import when the file is read in isolation.
const _kept: unknown = JWTError;
void _kept;

// ── CORS helpers ─────────────────────────────────────────────────────
// Allowlist-driven. Echo the request's Origin only when it matches an
// entry in env.ALLOWED_ORIGINS (exact or `*.host` wildcard); otherwise
// omit Allow-Origin (browser blocks; native clients unaffected).
//
// Fail-closed: when env.ALLOWED_ORIGINS is unset/empty we accept ONLY
// localhost/127.0.0.1 origins (dev convenience). A prod deploy that
// forgets the env var therefore can't echo any public origin.          // L3_架構含防禦觀測

const DEV_FALLBACK_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:9999",
  "http://127.0.0.1:9999",
];

function originMatches(reqOrigin: string, pattern: string): boolean {
  if (pattern === reqOrigin) return true;
  // Wildcard form: "https://*.example.com" matches "https://foo.example.com"
  // but NOT "https://example.com" (the dot is part of the suffix).
  const star = pattern.indexOf("*.");
  if (star < 0) return false;
  const scheme = pattern.slice(0, star);          // "https://"
  const suffix = pattern.slice(star + 1);          // ".example.com"
  return reqOrigin.startsWith(scheme) && reqOrigin.endsWith(suffix)
      && reqOrigin.length > scheme.length + suffix.length;
}

function pickCorsOrigin(request: Request, env: GatewayEnv): string | null {
  const reqOrigin = request.headers.get("Origin");
  if (!reqOrigin) return null;
  const configured = (env.ALLOWED_ORIGINS ?? "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (configured.length > 0) {
    return configured.some(p => originMatches(reqOrigin, p)) ? reqOrigin : null;
  }
  return DEV_FALLBACK_ORIGINS.includes(reqOrigin) ? reqOrigin : null;
}

// ── API deprecation headers (RFC 9745 + RFC 8594) ────────────────────
// Legacy /api/* (non-v1) is being retired. Frontend should be on /api/v1/*
// well before SUNSET_DATE. After that date, the router will start returning
// 410 Gone for legacy paths — bump the date here when you genuinely extend
// the window (telemetry says clients still on legacy), not just because
// you forgot to migrate something.                                       // L3_架構含防禦觀測
const SUNSET_DATE     = new Date("2026-08-14T00:00:00Z");
const SUNSET_HEADER   = SUNSET_DATE.toUTCString();
const DEPRECATION_DOC = "https://github.com/a30100a0072-bit/table-games.chiyigo.com#api-versioning";

function withDeprecation(res: Response): Response {
  const h = new Headers(res.headers);
  h.set("Deprecation", "true");
  h.set("Sunset",      SUNSET_HEADER);
  h.set("Link",        `<${DEPRECATION_DOC}>; rel="deprecation"; type="text/html"`);
  return new Response(res.body, { status: res.status, headers: h });
}

function applyCors(res: Response, allowedOrigin: string | null): Response {
  const h = new Headers(res.headers);
  // Vary: Origin ALWAYS — otherwise a cached 200 from one origin could
  // be replayed by a CDN to a different origin.                          // L3_架構含防禦觀測
  h.append("Vary", "Origin");
  if (allowedOrigin) {
    h.set("Access-Control-Allow-Origin",  allowedOrigin);
    h.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Secret, X-Confirm-Delete");
    h.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    // Expose deprecation signals + X-Request-Id (from withTrace) so the
    // SPA can see them via fetch().headers.                              // L3_架構含防禦觀測
    h.set("Access-Control-Expose-Headers", "Deprecation, Sunset, Link, X-Request-Id");
  }
  return new Response(res.body, { status: res.status, headers: h });
}
