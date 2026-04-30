// /test/workers/auth-flow.test.ts
// Real workerd-runtime end-to-end auth flow: /auth/token issues a token
// signed with the miniflare-bound JWT_PRIVATE_JWK, /api/me/wallet
// verifies it against the published JWKS. No mocks — DB is the real
// in-memory D1 instance miniflare provisions from wrangler.toml.

import { describe, expect, it, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";

// Apply schema once before any tests run. miniflare gives us a fresh D1
// per test run, so the tables don't exist until we create them.
beforeAll(async () => {
  const ddl = `
    CREATE TABLE IF NOT EXISTS GameRooms (
      room_id TEXT PRIMARY KEY, player_ids TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS games (
      game_id TEXT PRIMARY KEY, round_id TEXT NOT NULL, finished_at INTEGER NOT NULL,
      reason TEXT NOT NULL, winner_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS player_settlements (
      game_id TEXT NOT NULL, player_id TEXT NOT NULL, final_rank INTEGER NOT NULL,
      score_delta INTEGER NOT NULL, remaining_json TEXT NOT NULL,
      PRIMARY KEY (game_id, player_id));
    CREATE TABLE IF NOT EXISTS users (
      player_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      chip_balance INTEGER NOT NULL DEFAULT 1000,
      last_bailout_at INTEGER NOT NULL DEFAULT 0,
      last_login_at INTEGER NOT NULL DEFAULT 0,
      frozen_at INTEGER NOT NULL DEFAULT 0, frozen_reason TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chip_ledger (
      ledger_id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL,
      game_id TEXT, delta INTEGER NOT NULL, reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (player_id, game_id, reason));
  `;
  // D1 binding is exposed by miniflare via the env from cloudflare:test.
  const db = (env as unknown as { DB: D1Database }).DB;
  for (const stmt of ddl.split(";").map(s => s.trim()).filter(Boolean)) {
    await db.prepare(stmt).run();
  }
});

describe("Worker (miniflare): full auth + wallet flow", () => {
  it("issues a token, lazy-creates wallet, then /api/me/wallet verifies", async () => {
    const tok = await SELF.fetch("https://t.local/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: "alice" }),
    });
    expect(tok.status).toBe(200);
    const tokBody = await tok.json() as { token: string; playerId: string; dailyBonus: number };
    expect(tokBody.playerId).toBe("alice");
    expect(typeof tokBody.token).toBe("string");
    expect(tokBody.dailyBonus).toBe(100);

    const wallet = await SELF.fetch("https://t.local/api/me/wallet", {
      headers: { Authorization: `Bearer ${tokBody.token}` },
    });
    expect(wallet.status).toBe(200);
    const wb = await wallet.json() as { chipBalance: number; ledger: Array<{ reason: string }> };
    expect(wb.chipBalance).toBe(1100);          // 1000 signup + 100 daily
    expect(wb.ledger.map(l => l.reason).sort()).toEqual(["daily", "signup"]);
  });

  it("rejects malformed JWT", async () => {
    const r = await SELF.fetch("https://t.local/api/me/wallet", {
      headers: { Authorization: "Bearer not.a.token" },
    });
    expect(r.status).toBe(401);
  });

  it("admin freeze then /auth/token returns 423", async () => {
    // Bootstrap a user
    const tok = await SELF.fetch("https://t.local/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: "banhammer" }),
    });
    expect(tok.status).toBe(200);

    const freeze = await SELF.fetch("https://t.local/api/admin/freeze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Secret": "test-admin",
      },
      body: JSON.stringify({ playerId: "banhammer", reason: "abuse" }),
    });
    expect(freeze.status).toBe(200);

    const blocked = await SELF.fetch("https://t.local/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: "banhammer" }),
    });
    expect(blocked.status).toBe(423);
    const body = await blocked.json() as { error: string; reason: string };
    expect(body.error).toBe("account frozen");
    expect(body.reason).toBe("abuse");
  });
});
