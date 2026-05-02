// /test/workers/admin-health.test.ts
// Real workerd-runtime check of GET /api/admin/health. Seeds a cron_runs
// row + a frozen user, then asserts the aggregate response shape.

import { describe, expect, it, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { applyTestSchema } from "./_schema";

const DB = () => (env as unknown as { DB: D1Database }).DB;

beforeAll(applyTestSchema);

describe("Worker (miniflare): GET /api/admin/health", () => {
  it("rejects without admin secret (401)", async () => {
    const r = await SELF.fetch("https://t.local/api/admin/health");
    expect(r.status).toBe(401);
  });

  it("returns aggregate cron + count snapshot for a valid admin", async () => {
    // Seed a clean cron run + a failed one so the 7-day counters move.
    const now = Date.now();
    const db  = DB();
    await db.prepare(
      "INSERT INTO cron_runs (ran_at, dms_purged, room_tokens_purged," +
      " replay_shares_purged, room_invites_purged, errors_json)" +
      " VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(now - 5000, 3, 1, 0, 2, null).run();
    await db.prepare(
      "INSERT INTO cron_runs (ran_at, dms_purged, room_tokens_purged," +
      " replay_shares_purged, room_invites_purged, errors_json)" +
      " VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(now - 1000, 7, 0, 1, 0, null).run();
    await db.prepare(
      "INSERT INTO cron_runs (ran_at, dms_purged, room_tokens_purged," +
      " replay_shares_purged, room_invites_purged, errors_json)" +
      " VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(now - 500, 0, 0, 0, 0, JSON.stringify(["dmsPurged: boom"])).run();

    const r = await SELF.fetch("https://t.local/api/admin/health", {
      headers: { "X-Admin-Secret": "test-admin" },
    });
    expect(r.status).toBe(200);
    const body = await r.json() as {
      cron: {
        lastRunAt: number;
        lastResult: { dmsPurged: number; errors: string[] };
        runsLast7d: number;
        failuresLast7d: number;
      };
      counts: Record<string, number>;
    };
    expect(body.cron.lastRunAt).toBeGreaterThan(now - 1000);
    expect(body.cron.lastResult.errors).toHaveLength(1);   // most recent run failed
    expect(body.cron.runsLast7d).toBeGreaterThanOrEqual(3);
    expect(body.cron.failuresLast7d).toBeGreaterThanOrEqual(1);
    // counts is always present, all numeric, no NaN
    for (const v of Object.values(body.counts)) {
      expect(typeof v).toBe("number");
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
