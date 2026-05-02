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
import { ErrorCode, errorResponse }                 from "../utils/errors";
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
    return errorResponse(
      ErrorCode.UNAUTHORIZED, 401,
      err instanceof JWTError ? err.message : undefined,
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
    return errorResponse(ErrorCode.MISSING_CONFIRMATION, 400);

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
      env.DB.prepare("DELETE FROM blocks       WHERE blocker = ? OR blockee = ?").bind(me, me),

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
      // Mirror the anonymisation in the participants index table so the
      // tombstone surfaces consistently in both list and lookup paths.
      env.DB.prepare("UPDATE OR REPLACE replay_participants SET player_id = ? WHERE player_id = ?").bind(tomb, me),

      // Finally, drop the user row itself
      env.DB.prepare("DELETE FROM users WHERE player_id = ?").bind(me),
    ]);
  } catch (err) {
    log("error", "account_delete_failed", { playerId: me, err: String(err) });
    return errorResponse(ErrorCode.ACCOUNT_DELETE_FAILED, 500);
  }

  log("info", "account_deleted", { playerId: me, tombstone: tomb });
  return Response.json({ ok: true, tombstone: tomb });
}

// ── GET /api/me/export ───────────────────────────────────────────────────
// GDPR right-to-portability sibling of DELETE. Returns a single JSON blob
// with everything we hold *about you* — wallet, ledger, settlement
// history, friendships, DMs, tournament entries, your replay rows. The
// payload is meant to be downloaded as a file by the browser; we set
// content-disposition so a fetch + click flow lands on disk cleanly.
export async function exportAccount(request: Request, env: AccountEnv): Promise<Response> {
  const me = await authPlayer(request, env);
  if (me instanceof Response) return me;

  // Run reads in parallel — they're independent and the smallest tables
  // dominate latency anyway. Each falls back to [] on error so a single
  // bad query doesn't tank the export.                                    // L2_實作
  const [user, ledger, settlements, friendships, dmsSent, dmsRcv, tEntries, replays] =
    await Promise.all([
      env.DB.prepare("SELECT player_id, display_name, chip_balance, created_at, updated_at FROM users WHERE player_id = ?")
        .bind(me).first<unknown>().catch(() => null),
      env.DB.prepare("SELECT ledger_id, game_id, delta, reason, created_at FROM chip_ledger WHERE player_id = ? ORDER BY ledger_id")
        .bind(me).all<unknown>().catch(() => ({ results: [] })),
      env.DB.prepare("SELECT game_id, final_rank, score_delta FROM player_settlements WHERE player_id = ? ORDER BY game_id")
        .bind(me).all<unknown>().catch(() => ({ results: [] })),
      env.DB.prepare("SELECT a_id, b_id, requester, status, created_at, responded_at FROM friendships WHERE a_id = ? OR b_id = ?")
        .bind(me, me).all<unknown>().catch(() => ({ results: [] })),
      env.DB.prepare("SELECT id, recipient AS counterparty, body, created_at FROM dms WHERE sender = ? ORDER BY id")
        .bind(me).all<unknown>().catch(() => ({ results: [] })),
      env.DB.prepare("SELECT id, sender AS counterparty, body, created_at, read_at FROM dms WHERE recipient = ? ORDER BY id")
        .bind(me).all<unknown>().catch(() => ({ results: [] })),
      env.DB.prepare("SELECT tournament_id, registered_at, agg_score, final_rank FROM tournament_entries WHERE player_id = ?")
        .bind(me).all<unknown>().catch(() => ({ results: [] })),
      env.DB.prepare(
        "SELECT rm.game_id, rm.game_type, rm.started_at, rm.finished_at, rm.winner_id, rm.reason" +
        "  FROM replay_participants rp" +
        "  JOIN replay_meta rm ON rm.game_id = rp.game_id" +
        " WHERE rp.player_id = ? ORDER BY rp.finished_at DESC LIMIT 500",
      ).bind(me).all<unknown>().catch(() => ({ results: [] })),
    ]);

  type Bag = { results?: unknown[] };
  const payload = {
    schema:      "big-two-export-v1",
    exportedAt:  Date.now(),
    playerId:    me,
    profile:     user ?? null,
    chipLedger:  (ledger      as Bag).results ?? [],
    settlements: (settlements as Bag).results ?? [],
    friendships: (friendships as Bag).results ?? [],
    dmsSent:     (dmsSent     as Bag).results ?? [],
    dmsReceived: (dmsRcv      as Bag).results ?? [],
    tournaments: (tEntries    as Bag).results ?? [],
    replays:     (replays     as Bag).results ?? [],
  };

  log("info", "account_exported", { playerId: me });
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type":        "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="big-two-export-${me}.json"`,
    },
  });
}
