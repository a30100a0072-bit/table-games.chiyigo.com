// /src/api/dms.ts
// Friend-to-friend direct messages. v1 scope:
//   • only accepted friends may exchange messages (enforced via a JOIN on
//     the friendships table, so the same canonical-pair semantics apply);
//   • 1-on-1 only (no groups);
//   • 7-day retention (inbox filters on created_at, manual prune cron);
//   • 500-char body cap, plain text;
//   • 30 msg/min/sender rate limit (utils/rateLimit.ts "dm" bucket);
//   • no live WS push in v1 — recipients poll /inbox.                       // L2_實作

import { verifyJWT, JWTError, jwksFromPrivateEnv } from "../utils/auth";
import { takeToken, rateLimited }                  from "../utils/rateLimit";
import { ErrorCode, errorResponse }                 from "../utils/errors";
import { log }                                      from "../utils/log";

export interface DmEnv {
  DB:              D1Database;
  JWT_PRIVATE_JWK: string;
}

const RETENTION_DAYS = 7;
const RETENTION_MS   = RETENTION_DAYS * 86_400_000;
const BODY_MAX       = 500;

async function authPlayer(request: Request, env: DmEnv): Promise<string | Response> {
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

function canon(x: string, y: string): { a: string; b: string } {
  return x < y ? { a: x, b: y } : { a: y, b: x };
}

async function areFriends(env: DmEnv, me: string, other: string): Promise<boolean> {
  const { a, b } = canon(me, other);
  const row = await env.DB
    .prepare("SELECT 1 FROM friendships WHERE a_id = ? AND b_id = ? AND status = 'accepted' LIMIT 1")
    .bind(a, b)
    .first<{ 1: number }>();
  return row !== null;
}

// ── POST /api/dm/send { to, body } ───────────────────────────────────────
// Recipient must be an accepted friend; body trimmed and ≤ 500 chars.
// Empty body after trim is rejected so accidental keystrokes don't spam.
export async function sendDm(request: Request, env: DmEnv): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;
  if (!takeToken(`dm:${me}`, "dm")) return rateLimited();

  let body: { to?: string; body?: string };
  try { body = await request.json(); }
  catch { return errorResponse(ErrorCode.INVALID_JSON, 400); }

  const to       = body.to;
  const text     = (body.body ?? "").trim();
  if (typeof to !== "string" || to.length === 0)
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "to required");
  if (to === me)
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "cannot DM yourself");
  if (text.length === 0)
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "empty body");
  if (text.length > BODY_MAX)
    return errorResponse(ErrorCode.VALIDATION_FAILED, 413, "body too long", { max: BODY_MAX });
  if (!(await areFriends(env, me, to)))
    return errorResponse(ErrorCode.FORBIDDEN, 403, "recipient is not your friend");

  const now = Date.now();
  const res = await env.DB
    .prepare("INSERT INTO dms (sender, recipient, body, created_at) VALUES (?, ?, ?, ?)")
    .bind(me, to, text, now)
    .run();
  log("info", "dm_sent", { from: me, to, len: text.length });
  return Response.json({ ok: true, id: res.meta?.last_row_id ?? null, createdAt: now }, { status: 201 });
}

// ── GET /api/dm/inbox?since=<ms>&with=<otherId>?  ────────────────────────
// Returns recent DMs *involving me* (sent or received) within retention.
// Optional `with` filters to a single conversation. Optional `since` lets a
// client pull only deltas without re-reading history.
export async function listInbox(request: Request, env: DmEnv): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;

  const url   = new URL(request.url);
  const since = Number(url.searchParams.get("since") ?? 0);
  const peer  = url.searchParams.get("with");
  const cutoff = Math.max(Date.now() - RETENTION_MS, Number.isFinite(since) ? since : 0);

  let rows;
  if (peer) {
    rows = await env.DB
      .prepare(
        "SELECT id, sender, recipient, body, created_at, read_at FROM dms" +
        " WHERE created_at >= ?" +
        " AND ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))" +
        " ORDER BY created_at ASC LIMIT 200",
      )
      .bind(cutoff, me, peer, peer, me)
      .all<{ id: number; sender: string; recipient: string; body: string; created_at: number; read_at: number | null }>();
  } else {
    rows = await env.DB
      .prepare(
        "SELECT id, sender, recipient, body, created_at, read_at FROM dms" +
        " WHERE created_at >= ? AND (sender = ? OR recipient = ?)" +
        " ORDER BY created_at DESC LIMIT 200",
      )
      .bind(cutoff, me, me)
      .all<{ id: number; sender: string; recipient: string; body: string; created_at: number; read_at: number | null }>();
  }

  // Mark all just-fetched messages addressed to me as read. One UPDATE,
  // bounded by the same WHERE shape as the SELECT so we never accidentally
  // mark someone else's row.
  const now = Date.now();
  if (peer) {
    await env.DB
      .prepare(
        "UPDATE dms SET read_at = ?" +
        " WHERE recipient = ? AND sender = ? AND read_at IS NULL AND created_at >= ?",
      )
      .bind(now, me, peer, cutoff)
      .run();
  } else {
    await env.DB
      .prepare("UPDATE dms SET read_at = ? WHERE recipient = ? AND read_at IS NULL AND created_at >= ?")
      .bind(now, me, cutoff)
      .run();
  }

  return Response.json({ messages: rows.results ?? [] });
}

// ── GET /api/dm/unread ───────────────────────────────────────────────────
// Lightweight badge feeder — count of unread inbound DMs within retention.
export async function unreadDmCount(request: Request, env: DmEnv): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;
  const cutoff = Date.now() - RETENTION_MS;
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM dms WHERE recipient = ? AND read_at IS NULL AND created_at >= ?")
    .bind(me, cutoff)
    .first<{ n: number }>();
  return Response.json({ unread: row?.n ?? 0 });
}
