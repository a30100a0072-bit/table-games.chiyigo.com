// /src/workers/cronCleanup.ts
// Daily housekeeping fired by a Cloudflare Cron Trigger.
//
// Each statement is independent: a failure in one prune doesn't block the
// others. The handler returns a summary so the Cron event log shows what
// got cleaned. None of these tables is on the gameplay hot path, so this
// is safe to run during low-traffic hours.                                 // L3_架構含防禦觀測

export interface CronEnv {
  DB: D1Database;
}

const DMS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface CleanupResult {
  dmsPurged:           number;
  roomTokensPurged:    number;
  replaySharesPurged:  number;
  roomInvitesPurged:   number;
  errors:              string[];
}

/** Run all retention sweeps once. Each query is wrapped so a single
 *  schema/permission glitch doesn't abort the whole pass — the operator
 *  can read the per-section counts and errors from the returned struct
 *  (also logged via the structured-log path).                            // L3_架構含防禦觀測 */
export async function runCleanup(env: CronEnv, now: number = Date.now()): Promise<CleanupResult> {
  const result: CleanupResult = {
    dmsPurged: 0, roomTokensPurged: 0, replaySharesPurged: 0, roomInvitesPurged: 0,
    errors: [],
  };

  const dmsCutoff = now - DMS_RETENTION_MS;

  const tasks: Array<[keyof Omit<CleanupResult, "errors">, string, unknown[]]> = [
    ["dmsPurged",          "DELETE FROM dms          WHERE created_at < ?", [dmsCutoff]],
    ["roomTokensPurged",   "DELETE FROM room_tokens  WHERE expires_at < ?", [now]],
    ["replaySharesPurged", "DELETE FROM replay_shares WHERE expires_at < ?", [now]],
    ["roomInvitesPurged",  "DELETE FROM room_invites WHERE expires_at < ?", [now]],
  ];

  for (const [key, sql, args] of tasks) {
    try {
      const r = await env.DB.prepare(sql).bind(...args).run();
      result[key] = (r.meta?.changes ?? 0) as number;
    } catch (err) {
      result.errors.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
