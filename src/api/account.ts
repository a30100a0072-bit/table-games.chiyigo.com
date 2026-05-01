// /src/api/account.ts
// DELETE /api/me — account deletion (GDPR / store compliance).
//
// Strategy: hybrid hard-delete + tombstone-anonymise.
//
//  Hard-deleted rows (truly personal, no audit value):
//    • users                             — wallet row, display name
//    • friendships                       — relationships are gone
//    • dms                               — both sent and received
//    • room_invites                      — pending invites in either direction
//    • room_tokens                       — links the user created
//
//  Anonymised rows (financial / replay audit must survive):
//    • chip_ledger.player_id             — accounting integrity
//    • player_settlements.player_id      — historical game records
//    • games.winner_id                   — winners list
//    • tournament_entries.player_id      — bracket history
//    • replay_meta.player_ids            — saved replays still playable
//
// The tombstone is `DELETED_<8-char hex>` so it can't ever collide with a
// real playerId (creation rejects the `DELETED_` prefix at /auth/token's
// validator) — but we double-belt with a length+prefix check there too.   // L3_架構含防禦觀測

import { verifyJWT, JWTError, jwksFromPrivateEnv } from "../utils/auth";
import { log }                                      from "../utils/log";

export interface AccountEnv {
  DB:              D1Database;
  JWT_PRIVATE_JWK: string;
}

export const TOMBSTONE_PREFIX = "DELETED_";

function makeTombstone(): string {
  // 8 hex chars = 32 bits — collision odds at our scale are negligible.
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const hex = Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
  return `${TOMBSTONE_PREFIX}${hex}`;
}

async function authPlayer(request: Request, env: AccountEnv): Promise<string | Response> {
  const auth  = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    return await verifyJWT(token, jwksFromPrivateEnv(env.JWT_PRIVATE_JWK));
  } catch (err) {
    return Response.json(
      { error: err instanceof JWTError ? err.message : "unauthorized" },
      { status: 401 },
    );
  }
}

// ── DELETE /api/me ───────────────────────────────────────────────────────
// Confirmation header `X-Confirm-Delete: yes` is required so a stolen-token
// holder can't wipe an account with a single replay of an arbitrary GET.
// Frontend must set this header explicitly.                               // L2_隔離
export async function deleteAccount(request: Request, env: AccountEnv): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;

  if (request.headers.get("X-Confirm-Delete") !== "yes")
    return Response.json({ error: "missing confirmation header" }, { status: 400 });

  const tomb = makeTombstone();

  // One batch — all-or-nothing. If any statement throws, none commit and
  // the user can retry without partial state.                              // L3_架構含防禦觀測
  try {
    await env.DB.batch([
      // Hard-delete personal-data rows
      env.DB.prepare("DELETE FROM friendships  WHERE a_id = ? OR b_id = ?").bind(me, me),
      env.DB.prepare("DELETE FROM dms          WHERE sender = ? OR recipient = ?").bind(me, me),
      env.DB.prepare("DELETE FROM room_invites WHERE inviter = ? OR invitee = ?").bind(me, me),
      env.DB.prepare("DELETE FROM room_tokens  WHERE created_by = ?").bind(me),

      // Anonymise audit-bearing rows
      env.DB.prepare("UPDATE chip_ledger        SET player_id = ? WHERE player_id = ?").bind(tomb, me),
      env.DB.prepare("UPDATE player_settlements SET player_id = ? WHERE player_id = ?").bind(tomb, me),
      env.DB.prepare("UPDATE games              SET winner_id = ? WHERE winner_id = ?").bind(tomb, me),
      env.DB.prepare("UPDATE tournament_entries SET player_id = ? WHERE player_id = ?").bind(tomb, me),
      // replay_meta.player_ids is a JSON array stored as text. Replace the
      // canonical JSON-quoted form so we never accidentally rewrite a
      // substring inside another ID.                                        // L2_實作
      env.DB.prepare("UPDATE replay_meta SET player_ids = REPLACE(player_ids, ?, ?) WHERE player_ids LIKE ?")
        .bind(JSON.stringify(me), JSON.stringify(tomb), `%${JSON.stringify(me)}%`),

      // Finally, drop the user row itself
      env.DB.prepare("DELETE FROM users WHERE player_id = ?").bind(me),
    ]);
  } catch (err) {
    log("error", "account_delete_failed", { playerId: me, err: String(err) });
    return Response.json({ error: "deletion failed" }, { status: 500 });
  }

  log("info", "account_deleted", { playerId: me, tombstone: tomb });
  return Response.json({ ok: true, tombstone: tomb });
}
