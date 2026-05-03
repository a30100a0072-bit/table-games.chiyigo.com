// /src/utils/metrics.ts
// Per-isolate counters surfaced by GET /metrics. These are NOT persisted
// across isolate evictions — that's intentional: this is for cheap "is the
// system alive" introspection, not financial accounting. Real audit lives
// in chip_ledger; real durable counts come from D1 SUM() queries.       // L3_架構含防禦觀測

export type Counter =
  | "tokens_issued"
  | "matches_started"
  | "settlements_written"
  | "settlement_failures"
  | "bailouts_granted"
  | "daily_bonus_granted"
  | "rate_limited"
  | "admin_adjustments"
  | "oidc_start"
  | "oidc_exchange_ok"
  | "oidc_refresh_ok";

const counters: Record<Counter, number> = {
  tokens_issued:        0,
  matches_started:      0,
  settlements_written:  0,
  settlement_failures:  0,
  bailouts_granted:     0,
  daily_bonus_granted:  0,
  rate_limited:         0,
  admin_adjustments:    0,
  oidc_start:           0,
  oidc_exchange_ok:     0,
  oidc_refresh_ok:      0,
};

const startedAt = Date.now();

export function bump(c: Counter, n = 1): void { counters[c] += n; }

export function snapshotMetrics(): Record<string, number | string> {
  return {
    ...counters,
    isolate_uptime_ms: Date.now() - startedAt,
    timestamp:         new Date().toISOString(),
  };
}
