// /src/api/replays.ts
// Read-only replay API. Per-game payloads are denormalised into a single
// replay_meta row at settle time (see GameRoomDO.handleSettlement).
//
// engine_version stamping: a replay carrying an older version still
// returns the metadata + winner, but `replayable: false` tells the
// client not to attempt to restoreEngine + step through the events,
// since the state machine has shifted underneath them.                   // L3_架構

import { verifyJWT, JWTError, jwksFromPrivateEnv } from "../utils/auth";
import { takeToken, rateLimited }                  from "../utils/rateLimit";
import { ErrorCode, errorResponse }                 from "../utils/errors";
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
    return errorResponse(
      ErrorCode.UNAUTHORIZED, 401,
      err instanceof JWTError ? err.message : undefined,
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

  // Indexed lookup via replay_participants. Without it this would be a
  // LIKE-scan over replay_meta.player_ids — fine on a small DB, quadratic
  // on a busy one.
  const rows = await env.DB
    .prepare(
      "SELECT rm.game_id, rm.game_type, rm.engine_version, rm.player_ids," +
      "       rm.started_at, rm.finished_at, rm.winner_id, rm.reason" +
      "  FROM replay_participants rp" +
      "  JOIN replay_meta rm ON rm.game_id = rp.game_id" +
      " WHERE rp.player_id = ?" +
      " ORDER BY rp.finished_at DESC LIMIT 30",
    )
    .bind(me)
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
  if (!row) return errorResponse(ErrorCode.REPLAY_NOT_FOUND, 404);

  const playerIds = JSON.parse(row.player_ids) as string[];
  if (!playerIds.includes(me))
    return errorResponse(ErrorCode.REPLAY_FORBIDDEN, 403);

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

// ── POST /api/replays/:gameId/share { ttlMs? } ───────────────────────────
// Mint a share token for this replay. Caller must have been a seated
// player. Token defaults to 7-day TTL, capped at 30.                     // L2_實作
const SHARE_TTL_DEFAULT_MS = 7  * 86_400_000;
const SHARE_TTL_MIN_MS     = 60 * 60_000;
const SHARE_TTL_MAX_MS     = 30 * 86_400_000;

export async function shareReplay(request: Request, env: ReplaysEnv, gameId: string): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;
  // Mint creates a public capability — tighter limit than the default friend
  // bucket so a compromised token can't spew share URLs into the wild.
  if (!takeToken(`share:${me}`, "share")) return rateLimited();

  let ttlMs = SHARE_TTL_DEFAULT_MS;
  try {
    const body = await request.json<{ ttlMs?: number }>();
    if (typeof body.ttlMs === "number" && Number.isFinite(body.ttlMs)) ttlMs = body.ttlMs;
  } catch { /* default */ }
  if (ttlMs < SHARE_TTL_MIN_MS || ttlMs > SHARE_TTL_MAX_MS)
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "ttlMs out of range");

  const seatRow = await env.DB
    .prepare("SELECT player_ids FROM replay_meta WHERE game_id = ?")
    .bind(gameId)
    .first<{ player_ids: string }>();
  if (!seatRow) return errorResponse(ErrorCode.REPLAY_NOT_FOUND, 404);
  const playerIds = JSON.parse(seatRow.player_ids) as string[];
  if (!playerIds.includes(me))
    return errorResponse(ErrorCode.REPLAY_FORBIDDEN, 403);

  // 16 random bytes URL-safe base64. The token IS the capability — anyone
  // with it can read the replay until it expires.                         // L2_隔離
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  const token = btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const now = Date.now();
  await env.DB
    .prepare(
      "INSERT INTO replay_shares (token, game_id, owner_id, created_at, expires_at)" +
      " VALUES (?, ?, ?, ?, ?)",
    )
    .bind(token, gameId, me, now, now + ttlMs)
    .run();

  return Response.json({ token, expiresAt: now + ttlMs }, { status: 201 });
}

// ── GET /api/me/shares ──────────────────────────────────────────────────
// Active (non-expired) share tokens minted by the caller. Used by the
// frontend revoke UI so the user can see what's currently public before
// deciding whether to retract a link.
export async function listMyShares(request: Request, env: ReplaysEnv): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;

  const rows = await env.DB
    .prepare(
      "SELECT token, game_id, created_at, expires_at, view_count, last_viewed_at" +
      "  FROM replay_shares" +
      " WHERE owner_id = ? AND expires_at > ?" +
      " ORDER BY created_at DESC LIMIT 50",
    )
    .bind(me, Date.now())
    .all<{
      token: string; game_id: string; created_at: number; expires_at: number;
      view_count: number; last_viewed_at: number | null;
    }>();

  return Response.json({
    shares: (rows.results ?? []).map(r => ({
      token:        r.token,
      gameId:       r.game_id,
      createdAt:    r.created_at,
      expiresAt:    r.expires_at,
      viewCount:    r.view_count ?? 0,
      lastViewedAt: r.last_viewed_at,
    })),
  });
}

// ── DELETE /api/replays/share/:token ────────────────────────────────────
// Manual revoke. Only the minter can retract their own token. Returns 200
// with `{ revoked: true }` if the token existed and was owned by the
// caller; 404 otherwise (intentionally identical for "doesn't exist" and
// "exists but not yours" — don't leak token validity to non-owners).
export async function revokeShare(request: Request, env: ReplaysEnv, token: string): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;

  const r = await env.DB
    .prepare("DELETE FROM replay_shares WHERE token = ? AND owner_id = ?")
    .bind(token, me)
    .run();
  const changes = (r.meta?.changes ?? 0) as number;
  if (changes === 0) return errorResponse(ErrorCode.NOT_FOUND, 404);
  return Response.json({ revoked: true });
}

// ── GET /api/replays/by-token/:token ────────────────────────────────────
// Public read of a shared replay. No auth — the token is the capability.
// 410 = expired, 404 = unknown.                                          // L2_實作
export async function resolveSharedReplay(env: ReplaysEnv, token: string): Promise<Response> {
  const share = await env.DB
    .prepare("SELECT game_id, owner_id, expires_at FROM replay_shares WHERE token = ?")
    .bind(token)
    .first<{ game_id: string; owner_id: string; expires_at: number }>();
  if (!share) return errorResponse(ErrorCode.NOT_FOUND, 404, "unknown token");
  if (share.expires_at <= Date.now())
    return errorResponse(ErrorCode.REPLAY_SHARE_EXPIRED, 410);

  // Increment view counter + stamp last_viewed_at so the owner can see
  // how often the link is hit and when it last fired. Best-effort: a
  // failure here doesn't block the resolve — the analytics signal is
  // far less important than serving the replay.
  try {
    await env.DB
      .prepare("UPDATE replay_shares SET view_count = view_count + 1, last_viewed_at = ? WHERE token = ?")
      .bind(Date.now(), token)
      .run();
  } catch { /* swallow — analytics is non-critical */ }

  const row = await env.DB
    .prepare(
      "SELECT game_id, game_type, engine_version, player_ids, initial_snapshot," +
      "       events, started_at, finished_at, winner_id, reason" +
      " FROM replay_meta WHERE game_id = ?",
    )
    .bind(share.game_id)
    .first<ReplayMetaRow>();
  if (!row) return errorResponse(ErrorCode.REPLAY_NOT_FOUND, 404, "replay vanished");

  const replayable      = row.engine_version === ENGINE_VERSION;
  const events          = replayable ? JSON.parse(row.events) : [];
  const initialSnapshot = replayable ? JSON.parse(row.initial_snapshot) : null;

  return Response.json({
    gameId:          row.game_id,
    gameType:        row.game_type,
    engineVersion:   row.engine_version,
    currentVersion:  ENGINE_VERSION,
    replayable,
    playerIds:       JSON.parse(row.player_ids) as string[],
    initialSnapshot,
    events,
    startedAt:       row.started_at,
    finishedAt:      row.finished_at,
    winnerId:        row.winner_id,
    reason:          row.reason,
    sharedBy:        share.owner_id,
  });
}

// ── Featured replays (admin curation) ────────────────────────────────────
// Admins pick interesting games from replay_meta and surface them at the
// public /api/replays/featured feed. Each feature row carries its own
// long-TTL share_token so anonymous viewers can read the replay through
// the existing per-seat view-isolation.                                  // L2_隔離
//
// Privacy: the featured feed exposes player_ids, finished_at, and a short
// admin note. Hand contents are still rendered through the share_token's
// owner-seat perspective — opponent hands stay hidden. Admins choosing to
// feature a game implicitly accept that participant ids become public.
const FEATURE_TTL_DEFAULT_DAYS = 30;
const FEATURE_TTL_MIN_DAYS     = 1;
const FEATURE_TTL_MAX_DAYS     = 365;

/** POST /api/admin/replays/feature  body: { gameId, note?, ttlDays? } */
export async function featureReplay(request: Request, env: ReplaysEnv & { ADMIN_SECRET?: string }): Promise<Response> {
  if (!env.ADMIN_SECRET) return errorResponse(ErrorCode.ADMIN_DISABLED, 503);
  const provided = request.headers.get("X-Admin-Secret") ?? "";
  // Cheap timing-safe — same length + char-by-char XOR. Avoids importing
  // the gateway helper directly to keep this module's env shape minimal.
  if (provided.length !== env.ADMIN_SECRET.length) return errorResponse(ErrorCode.UNAUTHORIZED, 401);
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ env.ADMIN_SECRET.charCodeAt(i);
  if (diff !== 0) return errorResponse(ErrorCode.UNAUTHORIZED, 401);

  let body: { gameId?: string; note?: string; ttlDays?: number };
  try { body = await request.json(); }
  catch { return errorResponse(ErrorCode.INVALID_JSON, 400); }

  const gameId = (body.gameId ?? "").trim();
  if (!gameId) return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "gameId required");
  const note = (body.note ?? "").trim().slice(0, 200) || null;
  const ttlDays = body.ttlDays ?? FEATURE_TTL_DEFAULT_DAYS;
  if (!Number.isInteger(ttlDays) || ttlDays < FEATURE_TTL_MIN_DAYS || ttlDays > FEATURE_TTL_MAX_DAYS)
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "ttlDays out of range");

  // Replay must exist; we mint the share_token using a synthetic owner ("admin")
  // — featured shares aren't tied to a seated player.                    // L2_實作
  const meta = await env.DB
    .prepare("SELECT game_id FROM replay_meta WHERE game_id = ?")
    .bind(gameId)
    .first<{ game_id: string }>();
  if (!meta) return errorResponse(ErrorCode.REPLAY_NOT_FOUND, 404);

  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  const token = btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const now = Date.now();
  const expiresAt = now + ttlDays * 86_400_000;

  // Two-row insert as a batch so a partial failure (token without feature row,
  // or vice versa) can't leave the FK pointing nowhere.                  // L3_邏輯安防
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO replay_shares (token, game_id, owner_id, created_at, expires_at)" +
      " VALUES (?, ?, 'admin', ?, ?)",
    ).bind(token, gameId, now, expiresAt),
    env.DB.prepare(
      "INSERT OR REPLACE INTO replay_featured (game_id, featured_by, featured_at, note, share_token, expires_at)" +
      " VALUES (?, 'admin', ?, ?, ?, ?)",
    ).bind(gameId, now, note, token, expiresAt),
  ]);

  return Response.json({ gameId, shareToken: token, expiresAt }, { status: 201 });
}

/** DELETE /api/admin/replays/feature/:gameId */
export async function unfeatureReplay(request: Request, env: ReplaysEnv & { ADMIN_SECRET?: string }, gameId: string): Promise<Response> {
  if (!env.ADMIN_SECRET) return errorResponse(ErrorCode.ADMIN_DISABLED, 503);
  const provided = request.headers.get("X-Admin-Secret") ?? "";
  if (provided.length !== env.ADMIN_SECRET.length) return errorResponse(ErrorCode.UNAUTHORIZED, 401);
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ env.ADMIN_SECRET.charCodeAt(i);
  if (diff !== 0) return errorResponse(ErrorCode.UNAUTHORIZED, 401);

  const r = await env.DB
    .prepare("DELETE FROM replay_featured WHERE game_id = ?")
    .bind(gameId)
    .run();
  if ((r.meta?.changes ?? 0) === 0) return errorResponse(ErrorCode.REPLAY_NOT_FOUND, 404);
  // Note: share_token row is intentionally left alive so any direct-link
  // viewers (e.g. someone who copied the URL) aren't broken. Admin can
  // separately revoke the share if they want a hard takedown.            // L2_實作
  return Response.json({ ok: true });
}

/** GET /api/replays/featured — public, no auth. Paginated by featured_at. */
export async function listFeaturedReplays(request: Request, env: ReplaysEnv): Promise<Response> {
  const url = new URL(request.url);
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(Math.max(limitRaw || 20, 1), 50);
  const cursorRaw = url.searchParams.get("before");
  const cursor = cursorRaw ? parseInt(cursorRaw, 10) : null;

  // Surface only non-expired features. Cron sweep also clears expired
  // share_tokens, but we filter here defensively.                         // L3_邏輯安防
  const now = Date.now();
  const rows = await env.DB
    .prepare(
      "SELECT f.game_id, f.featured_at, f.note, f.share_token, f.expires_at," +
      "       m.game_type, m.player_ids, m.finished_at, m.winner_id," +
      "       s.view_count" +
      "  FROM replay_featured f" +
      "  JOIN replay_meta     m ON m.game_id = f.game_id" +
      "  JOIN replay_shares   s ON s.token   = f.share_token" +
      " WHERE f.expires_at > ?" +
      (cursor !== null ? " AND f.featured_at < ?" : "") +
      " ORDER BY f.featured_at DESC LIMIT ?",
    )
    .bind(...(cursor !== null ? [now, cursor, limit] : [now, limit]))
    .all<{
      game_id: string; featured_at: number; note: string | null;
      share_token: string; expires_at: number;
      game_type: string; player_ids: string; finished_at: number;
      winner_id: string | null; view_count: number | null;
    }>();

  const featured = (rows.results ?? []).map(r => ({
    gameId:      r.game_id,
    gameType:    r.game_type,
    playerIds:   JSON.parse(r.player_ids) as string[],
    finishedAt:  r.finished_at,
    winnerId:    r.winner_id,
    note:        r.note,
    shareToken:  r.share_token,
    featuredAt:  r.featured_at,
    expiresAt:   r.expires_at,
    viewCount:   r.view_count ?? 0,
  }));
  const nextCursor = featured.length === limit ? featured[featured.length - 1]!.featuredAt : null;
  return Response.json({ featured, nextCursor });
}
