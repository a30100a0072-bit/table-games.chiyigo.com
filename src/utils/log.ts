// /src/utils/log.ts
// Structured JSON logging for Cloudflare Workers.
// Workers route stdout to `wrangler tail` and the Cloudflare Logpush
// pipeline; emitting JSON instead of free-form strings makes those logs
// queryable (by event name, playerId, etc.) without parsing.            // L3_架構含防禦觀測

export type LogLevel = "info" | "warn" | "error";

interface LogFields {
  // Common observed dimensions — typed so a typo doesn't silently widen
  // the column space. Add fields as the system grows.
  playerId?: string;
  gameId?:   string;
  gameType?: string;
  ip?:       string;
  status?:   number;
  durationMs?: number;
  reason?:   string;
  err?:      string;
  // Free-form bag for one-offs.
  [extra: string]: unknown;
}

/**
 * Emit a single JSON line to stdout/stderr. Workers' runtime appends
 * timestamps and request ids automatically — don't duplicate them here.
 */
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const entry = { level, event, ...fields };
  // Workers honour console.error level for routing into Sentry/Logpush
  // error sinks; everything else goes through console.log.
  const out = level === "error" ? console.error : console.log;
  try { out(JSON.stringify(entry)); }
  catch { out(`{"level":"${level}","event":"${event}","err":"log_serialise_failed"}`); }
}

/** Convenience helper for catch blocks — coerces unknowns to a string. */
export function errStr(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === "string") return e;
  try   { return JSON.stringify(e); }
  catch { return String(e); }
}
