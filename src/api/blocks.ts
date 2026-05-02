// /src/api/blocks.ts
// Unilateral block list. The blocker pays one row of state; the
// blockee gets no signal — friend / DM / invite attempts return the
// same FORBIDDEN they'd see as a stranger, so a block can't be
// detected by probing. Used at the API layer by friends / dms /
// roomInvites — see isBlockedEitherWay() below.                          // L3_架構含防禦觀測

import { verifyJWT, JWTError, jwksFromPrivateEnv } from "../utils/auth";
import { takeToken, rateLimited }                  from "../utils/rateLimit";
import { ErrorCode, errorResponse }                 from "../utils/errors";
import { log }                                      from "../utils/log";

export interface BlocksEnv {
  DB:              D1Database;
  JWT_PRIVATE_JWK: string;
}

async function authPlayer(request: Request, env: BlocksEnv): Promise<string | Response> {
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

/** Returns true iff a blocks b OR b blocks a — i.e. any communication
 *  attempt between them should fail closed. Used by DM send / friend
 *  request / room invite gates. Single SELECT 1 covers both directions
 *  thanks to the (blocker, blockee) PK and the idx_blocks_blockee
 *  index on the reverse lookup column. */
export async function isBlockedEitherWay(
  db: D1Database, a: string, b: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 FROM blocks" +
      " WHERE (blocker = ? AND blockee = ?) OR (blocker = ? AND blockee = ?) LIMIT 1",
    )
    .bind(a, b, b, a)
    .first<{ 1: number }>();
  return row !== null;
}

// ── POST /api/blocks { targetPlayerId } ─────────────────────────────────
// Idempotent: re-blocking is a no-op (INSERT OR IGNORE). Self-block
// is rejected by the schema CHECK and surfaced as VALIDATION_FAILED.
export async function blockPlayer(request: Request, env: BlocksEnv): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;
  if (!takeToken(`friend:${me}`, "friend")) return rateLimited();

  let body: { targetPlayerId?: string };
  try { body = await request.json(); }
  catch { return errorResponse(ErrorCode.INVALID_JSON, 400); }
  const target = (body.targetPlayerId ?? "").trim();
  if (target.length === 0)
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "targetPlayerId required");
  if (target === me)
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "cannot block yourself");

  await env.DB
    .prepare("INSERT OR IGNORE INTO blocks (blocker, blockee, created_at) VALUES (?, ?, ?)")
    .bind(me, target, Date.now())
    .run();
  // Drop any pending friendship state from either direction so the
  // block cleans up the relationship rather than leaving stale rows.
  // Canonical pair: (a_id, b_id) with a_id < b_id.
  const [a, b] = me < target ? [me, target] : [target, me];
  await env.DB
    .prepare("DELETE FROM friendships WHERE a_id = ? AND b_id = ?")
    .bind(a, b)
    .run();

  log("info", "block_added", { blocker: me, blockee: target });
  return Response.json({ ok: true });
}

// ── DELETE /api/blocks/:target ──────────────────────────────────────────
// Idempotent: unblocking a non-blocked player returns 200 with
// removed=false so the UI can fire-and-forget.
export async function unblockPlayer(request: Request, env: BlocksEnv, target: string): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;
  if (!takeToken(`friend:${me}`, "friend")) return rateLimited();

  const r = await env.DB
    .prepare("DELETE FROM blocks WHERE blocker = ? AND blockee = ?")
    .bind(me, target)
    .run();
  const removed = ((r.meta?.changes ?? 0) as number) > 0;
  if (removed) log("info", "block_removed", { blocker: me, blockee: target });
  return Response.json({ ok: true, removed });
}

// ── GET /api/blocks ─────────────────────────────────────────────────────
// List the caller's outgoing blocks. The blockee side intentionally
// has NO read endpoint — the whole point of a unilateral block is
// that the blockee can't tell.
export async function listMyBlocks(request: Request, env: BlocksEnv): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;

  const rows = await env.DB
    .prepare(
      "SELECT blockee, created_at FROM blocks WHERE blocker = ?" +
      " ORDER BY created_at DESC LIMIT 200",
    )
    .bind(me)
    .all<{ blockee: string; created_at: number }>();

  return Response.json({
    blocks: (rows.results ?? []).map(r => ({
      playerId:  r.blockee,
      createdAt: r.created_at,
    })),
  });
}
