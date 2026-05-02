// /src/api/roomInvites.ts
// In-app room invitations: a logged-in user with a valid room_tokens
// row can push pending invite rows to specific friends. The invitee
// sees the invite in their UI and can either join (using the token
// like any other shared URL) or decline.                              // L3_架構含防禦觀測
//
// "Accepting" is not a backend operation — joining via the token IS
// the accept. We only track pending → declined to keep the list clean.

import { verifyJWT, JWTError, jwksFromPrivateEnv } from "../utils/auth";
import { takeToken, rateLimited }                  from "../utils/rateLimit";
import { ErrorCode, errorResponse }                 from "../utils/errors";
import { log }                                      from "../utils/log";

export interface RoomInvitesEnv {
  DB:              D1Database;
  JWT_PRIVATE_JWK: string;
}

async function authPlayer(request: Request, env: RoomInvitesEnv): Promise<string | Response> {
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

async function isFriend(env: RoomInvitesEnv, x: string, y: string): Promise<boolean> {
  const { a, b } = canon(x, y);
  const row = await env.DB
    .prepare("SELECT 1 FROM friendships WHERE a_id = ? AND b_id = ? AND status = 'accepted' LIMIT 1")
    .bind(a, b)
    .first<{ 1: number }>();
  return row !== null;
}

// ── POST /api/rooms/invite { friendPlayerId, joinToken } ─────────────────
// Inserts a pending invite. The invitee MUST already be an accepted
// friend, and the token MUST exist & be unexpired.
export async function inviteToRoom(request: Request, env: RoomInvitesEnv): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;
  if (!takeToken(`invite:${me}`, "invite")) return rateLimited();

  let body: { friendPlayerId?: string; joinToken?: string };
  try { body = await request.json(); }
  catch { return errorResponse(ErrorCode.INVALID_JSON, 400); }

  const friend = body.friendPlayerId;
  const tok    = body.joinToken;
  if (typeof friend !== "string" || friend.length === 0)
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "friendPlayerId required");
  if (typeof tok !== "string" || tok.length === 0)
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "joinToken required");
  if (friend === me)
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "cannot invite yourself");

  if (!(await isFriend(env, me, friend)))
    return errorResponse(ErrorCode.FORBIDDEN, 403, "not friends");

  const room = await env.DB
    .prepare("SELECT game_type, expires_at FROM room_tokens WHERE token = ?")
    .bind(tok)
    .first<{ game_type: string; expires_at: number }>();
  if (!room) return errorResponse(ErrorCode.NOT_FOUND, 404, "token not found");
  const now = Date.now();
  if (room.expires_at < now) return errorResponse(ErrorCode.TOKEN_EXPIRED, 410);

  // INSERT OR IGNORE so re-inviting the same friend to the same room
  // is a no-op rather than an error. status='pending' on the surviving row.
  await env.DB
    .prepare(
      "INSERT OR IGNORE INTO room_invites" +
      " (inviter, invitee, token, game_type, created_at, expires_at, status)" +
      " VALUES (?, ?, ?, ?, ?, ?, 'pending')",
    )
    .bind(me, friend, tok, room.game_type, now, room.expires_at)
    .run();

  log("info", "room_invite_sent", { from: me, to: friend, gameType: room.game_type });
  return Response.json({ ok: true }, { status: 201 });
}

// ── GET /api/rooms/invites ───────────────────────────────────────────────
// Pending invites where I'm the invitee. Stale rows (expired) are filtered
// at read time so we don't have to maintain a sweeper.
export async function listInvites(request: Request, env: RoomInvitesEnv): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;

  const now = Date.now();
  const rows = await env.DB
    .prepare(
      "SELECT id, inviter, token, game_type, created_at, expires_at" +
      " FROM room_invites" +
      " WHERE invitee = ? AND status = 'pending' AND expires_at > ?" +
      " ORDER BY created_at DESC LIMIT 50",
    )
    .bind(me, now)
    .all<{
      id: number; inviter: string; token: string; game_type: string;
      created_at: number; expires_at: number;
    }>();

  return Response.json({
    invites: (rows.results ?? []).map(r => ({
      id:        r.id,
      inviter:   r.inviter,
      joinToken: r.token,
      gameType:  r.game_type,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    })),
  });
}

// ── POST /api/rooms/invites/:id/decline ──────────────────────────────────
// Mark a pending invite as declined. Only the invitee can act on it.
// Idempotent: declining a non-pending row is a 200 no-op so the UI can
// fire-and-forget.
export async function declineInvite(request: Request, env: RoomInvitesEnv, id: string): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;
  if (!takeToken(`invite:${me}`, "invite")) return rateLimited();

  const idNum = Number(id);
  if (!Number.isInteger(idNum) || idNum <= 0)
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "bad id");

  await env.DB
    .prepare(
      "UPDATE room_invites SET status = 'declined', responded_at = ?" +
      " WHERE id = ? AND invitee = ? AND status = 'pending'",
    )
    .bind(Date.now(), idNum, me)
    .run();
  return Response.json({ ok: true });
}
