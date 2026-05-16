// /src/domain/audit.ts
// Append-only admin_audit row writer. Best-effort: failure is logged
// but never thrown, because the action's primary effect is already
// committed by the time we get here.                                  // L3_架構含防禦觀測

import { log, errStr } from "../utils/log";

export type AdminAction = "adjust" | "freeze" | "unfreeze";

export async function writeAudit(
  db: D1Database, action: AdminAction, playerId: string,
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
