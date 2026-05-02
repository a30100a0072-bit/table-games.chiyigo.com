// /src/api/friends.ts
// Bidirectional-consent friend system. Schema canonicalises every pair as
// (a_id, b_id) with a_id < b_id so each relationship has exactly one row;
// `requester` distinguishes incoming vs outgoing pending state without a
// second row. See docs/social-spec.md (memory).                          // L3_架構含防禦觀測

import { verifyJWT, JWTError, jwksFromPrivateEnv } from "../utils/auth";
import { takeToken, rateLimited }                  from "../utils/rateLimit";
import { ErrorCode, errorResponse }                 from "../utils/errors";
import { isBlockedEitherWay }                       from "./blocks";
import { log }                                      from "../utils/log";

export interface FriendsEnv {
  DB:              D1Database;
  JWT_PRIVATE_JWK: string;
}

interface FriendshipRow {
  a_id: string; b_id: string; requester: string;
  status: "pending" | "accepted";
  created_at: number;
  responded_at: number | null;
}

async function authPlayer(request: Request, env: FriendsEnv): Promise<string | Response> {
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

/** Canonicalise an unordered pair into (a, b) with a < b. */
function canon(x: string, y: string): { a: string; b: string } {
  return x < y ? { a: x, b: y } : { a: y, b: x };
}

async function userExists(env: FriendsEnv, playerId: string): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT 1 FROM users WHERE player_id = ? LIMIT 1")
    .bind(playerId)
    .first<{ 1: number }>();
  return row !== null;
}

// ── POST /api/friends/request { targetPlayerId } ────────────────────────
//
// Conflict resolution:
// - self-request → 400
// - target unknown → 404
// - already accepted → 409 already_friends
// - existing pending in same direction → 409 pending
// - existing pending from the other side → auto-accept (mutual desire)

export async function requestFriend(request: Request, env: FriendsEnv): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;
  if (!takeToken(`friend:${me}`, "friend")) return rateLimited();

  let body: { targetPlayerId?: string };
  try { body = await request.json(); }
  catch { return errorResponse(ErrorCode.INVALID_JSON, 400); }

  const target = body.targetPlayerId;
  if (typeof target !== "string" || target.length === 0)
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "targetPlayerId required");
  if (target === me)
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "cannot friend yourself");
  if (!(await userExists(env, target)))
    return errorResponse(ErrorCode.NOT_FOUND, 404, "target user not found");
  // Block check both directions — a blocked user can't befriend the
  // blocker (would just spam their inbox), and a blocker shouldn't see
  // an outgoing pending row to someone they've cut off either.
  if (await isBlockedEitherWay(env.DB, me, target))
    return errorResponse(ErrorCode.BLOCKED, 403);

  const { a, b } = canon(me, target);
  const now = Date.now();

  const existing = await env.DB
    .prepare("SELECT a_id, b_id, requester, status FROM friendships WHERE a_id = ? AND b_id = ?")
    .bind(a, b)
    .first<FriendshipRow>();

  if (existing) {
    if (existing.status === "accepted")
      return errorResponse(ErrorCode.ALREADY_FRIENDS, 409);
    // existing.status === "pending"
    if (existing.requester === me)
      return errorResponse(ErrorCode.FRIEND_REQUEST_PENDING, 409);
    // Other side already asked us → auto-accept.
    await env.DB
      .prepare("UPDATE friendships SET status = 'accepted', responded_at = ? WHERE a_id = ? AND b_id = ?")
      .bind(now, a, b)
      .run();
    log("info", "friend_auto_accepted", { me, target });
    return Response.json({ status: "accepted" }, { status: 200 });
  }

  await env.DB
    .prepare(
      "INSERT INTO friendships (a_id, b_id, requester, status, created_at)" +
      " VALUES (?, ?, ?, 'pending', ?)",
    )
    .bind(a, b, me, now)
    .run();
  log("info", "friend_requested", { me, target });
  return Response.json({ status: "pending" }, { status: 201 });
}

// ── POST /api/friends/:other/accept ──────────────────────────────────────
// Only the request's recipient (i.e. NOT the original requester) can accept.

export async function acceptFriend(request: Request, env: FriendsEnv, other: string): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;
  if (!takeToken(`friend:${me}`, "friend")) return rateLimited();
  if (other === me) return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "cannot accept yourself");

  const { a, b } = canon(me, other);
  const now = Date.now();

  const row = await env.DB
    .prepare("SELECT requester, status FROM friendships WHERE a_id = ? AND b_id = ?")
    .bind(a, b)
    .first<{ requester: string; status: string }>();
  if (!row) return errorResponse(ErrorCode.NOT_FOUND, 404, "no pending request");
  if (row.status === "accepted")
    return Response.json({ status: "accepted" });   // idempotent
  if (row.requester === me)
    return errorResponse(ErrorCode.CONFLICT, 409, "cannot accept your own request");

  await env.DB
    .prepare("UPDATE friendships SET status = 'accepted', responded_at = ? WHERE a_id = ? AND b_id = ? AND status = 'pending'")
    .bind(now, a, b)
    .run();
  log("info", "friend_accepted", { me, other });
  return Response.json({ status: "accepted" });
}

// ── POST /api/friends/:other/decline ─────────────────────────────────────
// Recipient deletes a pending request. Idempotent: deleting a missing row
// is success.

export async function declineFriend(request: Request, env: FriendsEnv, other: string): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;
  if (!takeToken(`friend:${me}`, "friend")) return rateLimited();

  const { a, b } = canon(me, other);
  await env.DB
    .prepare(
      "DELETE FROM friendships" +
      " WHERE a_id = ? AND b_id = ? AND status = 'pending' AND requester != ?",
    )
    .bind(a, b, me)
    .run();
  log("info", "friend_declined", { me, other });
  return Response.json({ ok: true });
}

// ── DELETE /api/friends/:other ───────────────────────────────────────────
// Unfriend (either side, status=accepted) OR cancel own outgoing pending.
// One DELETE handles both since the row uniquely identifies the pair.

export async function unfriend(request: Request, env: FriendsEnv, other: string): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;
  if (!takeToken(`friend:${me}`, "friend")) return rateLimited();

  const { a, b } = canon(me, other);
  // For pending: only the requester (me) can cancel. For accepted: either
  // side can drop. Encode both in a single WHERE.
  await env.DB
    .prepare(
      "DELETE FROM friendships" +
      " WHERE a_id = ? AND b_id = ?" +
      " AND (status = 'accepted' OR (status = 'pending' AND requester = ?))",
    )
    .bind(a, b, me)
    .run();
  log("info", "friend_removed", { me, other });
  return Response.json({ ok: true });
}

// ── GET /api/friends ─────────────────────────────────────────────────────
// Returns three lists: confirmed friends, requests waiting for me to act on,
// requests I've sent that the other side hasn't answered yet.

export async function listFriends(request: Request, env: FriendsEnv): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;

  const rows = await env.DB
    .prepare(
      "SELECT a_id, b_id, requester, status, created_at, responded_at" +
      " FROM friendships WHERE a_id = ? OR b_id = ?" +
      " ORDER BY created_at DESC",
    )
    .bind(me, me)
    .all<FriendshipRow>();

  const accepted: { playerId: string; since: number }[]    = [];
  const incoming: { playerId: string; createdAt: number }[] = [];
  const outgoing: { playerId: string; createdAt: number }[] = [];

  for (const r of rows.results ?? []) {
    const other = r.a_id === me ? r.b_id : r.a_id;
    if (r.status === "accepted") {
      accepted.push({ playerId: other, since: r.responded_at ?? r.created_at });
    } else if (r.requester === me) {
      outgoing.push({ playerId: other, createdAt: r.created_at });
    } else {
      incoming.push({ playerId: other, createdAt: r.created_at });
    }
  }

  return Response.json({ accepted, incoming, outgoing });
}
