// /src/forwarder/index.ts
// Tail-consumer worker — receives tail events from `big-two-game-production`
// and POSTs interesting ones to a webhook (Discord, Slack, or any sink that
// accepts `{ content, text }`). Deployed as its own worker via
// wrangler.forwarder.toml so the main worker's binding budget stays clean.
//
// What gets forwarded:
//   • all unhandled exceptions (always)
//   • console.error / console.warn lines (always)
//   • console.log lines whose JSON parses to an event matched by
//     ALWAYS_FORWARD_EVENTS (admin_*, settlement_failed, frozen, bailout)
//
// Routine info-level traffic (token_issued, matches_started, ...) is
// dropped on the floor — there's no point tailing that into a webhook.   // L3_架構含防禦觀測

export interface ForwarderEnv {
  /** Webhook URL — Discord, Slack, or any sink. Set as a secret:
   *  `wrangler secret put WEBHOOK_URL --config wrangler.forwarder.toml`. */
  WEBHOOK_URL: string;
  /** Free-form name shown in the webhook message header. */
  SOURCE?: string;
}

/** Event names that warrant a webhook ping even at info level — these are
 *  audit-trail or anomaly signals, not steady-state metrics. */
const ALWAYS_FORWARD_EVENTS = new Set<string>([
  "admin_adjusted",
  "admin_frozen",
  "admin_unfrozen",
  "settlement_failed",
  "settlement_db_failed",
  "tournament_settlement_db_failed",
  "tournament_round_init_failed",
  "match_blocked_frozen",
  "bailout_granted",
  "rate_limited",                 // useful for spotting attacks
  "tournament_db_update_failed",
]);

interface ParsedLog {
  level: string;
  event: string;
  rest: Record<string, unknown>;
}

/** Best-effort JSON parse of a structured log line. Falls back to {} on
 *  any failure — non-JSON lines are routed by their console level alone. */
export function parseLogLine(raw: unknown): ParsedLog | null {
  if (typeof raw !== "string") return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const { level, event, ...rest } = obj;
    if (typeof level !== "string" || typeof event !== "string") return null;
    return { level, event, rest };
  } catch {
    return null;
  }
}

/** Decide whether a single log line should be forwarded.
 *  - error / warn: always
 *  - structured log with event in ALWAYS_FORWARD_EVENTS: always
 *  - anything else: drop                                                  // L2_實作 */
export function shouldForwardLog(consoleLevel: string, parsed: ParsedLog | null): boolean {
  if (consoleLevel === "error" || consoleLevel === "warn") return true;
  if (parsed && ALWAYS_FORWARD_EVENTS.has(parsed.event))  return true;
  return false;
}

/** Compress one trace's interesting bits into a single string. Returns
 *  `null` when nothing in this trace meets the bar (caller skips POST). */
export function formatTrace(trace: TraceItem, source: string): string | null {
  const lines: string[] = [];

  for (const ex of trace.exceptions ?? []) {
    lines.push(`🔥 ${ex.name}: ${ex.message}`);
  }

  for (const l of trace.logs ?? []) {
    const raw    = Array.isArray(l.message) ? l.message[0] : l.message;
    const parsed = parseLogLine(raw);
    if (!shouldForwardLog(l.level, parsed)) continue;

    if (parsed) {
      const tag = parsed.level === "error" ? "❌" : parsed.level === "warn" ? "⚠️" : "ℹ️";
      const fields = Object.entries(parsed.rest)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      lines.push(`${tag} ${parsed.event}${fields ? " · " + fields : ""}`);
    } else {
      // Non-JSON warn/error — keep the raw text up to a sane length.
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      lines.push(`📝 ${text.slice(0, 400)}`);
    }
  }

  if (lines.length === 0) return null;

  const ts = trace.eventTimestamp ?? Date.now();
  const header = `[${source}] ${new Date(ts).toISOString()}`;
  // Cap total payload — Discord limit is 2000, Slack 40 000. 1500 is safe
  // for both and leaves room for the JSON envelope.
  const body = lines.join("\n").slice(0, 1500);
  return `${header}\n${body}`;
}

/** Bounded retry around the webhook POST. Retries on network errors,
 *  HTTP 429, and 5xx with exponential backoff (200 / 800 / 3200 ms). 4xx
 *  is treated as a permanent misconfiguration — no point retrying.
 *
 *  No DLQ: the forwarder intentionally has no bindings (see
 *  wrangler.forwarder.toml), so terminal failures are surfaced via
 *  console.error, which `wrangler tail big-two-log-forwarder` can pick
 *  up. Adding a D1 dead-letter table would defeat the "minimal surface"
 *  rationale for this worker.                                            // L3_架構含防禦觀測 */
export async function postWithRetry(
  url: string,
  payload: string,
  opts: {
    fetchImpl?: typeof fetch;
    sleep?:     (ms: number) => Promise<void>;
    maxAttempts?: number;
  } = {},
): Promise<{ ok: boolean; attempts: number; lastStatus?: number; lastError?: string }> {
  const f       = opts.fetchImpl ?? fetch;
  const sleep   = opts.sleep     ?? ((ms) => new Promise(r => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? 3;

  let lastStatus: number | undefined;
  let lastError:  string | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await f(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    payload,
      });
      if (r.ok) return { ok: true, attempts: attempt, lastStatus: r.status };
      lastStatus = r.status;
      // Permanent client errors (auth, malformed payload): give up early.
      if (r.status >= 400 && r.status < 500 && r.status !== 429) {
        return { ok: false, attempts: attempt, lastStatus };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < maxAttempts) await sleep(200 * Math.pow(4, attempt - 1));
  }
  return { ok: false, attempts: maxAttempts, lastStatus, lastError };
}

export default {
  async tail(events: TraceItem[], env: ForwarderEnv, ctx: ExecutionContext): Promise<void> {
    if (!env.WEBHOOK_URL) return;        // misconfigured → silent no-op  // L2_隔離
    const source = env.SOURCE ?? "worker";

    const messages: string[] = [];
    for (const ev of events) {
      const formatted = formatTrace(ev, source);
      if (formatted) messages.push(formatted);
    }
    if (messages.length === 0) return;

    // Coalesce all interesting messages from this batch into one POST.
    // Discord caps content at 2000; Slack accepts both `text` and `content`
    // so we send both keys to stay sink-agnostic.                          // L2_實作
    const content = messages.join("\n──────\n").slice(0, 1900);
    const payload = JSON.stringify({ content, text: content });

    ctx.waitUntil(
      postWithRetry(env.WEBHOOK_URL, payload).then(r => {
        if (!r.ok) {
          console.error(JSON.stringify({
            level: "error",
            event: "forwarder_webhook_failed",
            attempts:   r.attempts,
            lastStatus: r.lastStatus,
            lastError:  r.lastError,
            droppedMessages: messages.length,
          }));
        }
      }),
    );
  },
};
