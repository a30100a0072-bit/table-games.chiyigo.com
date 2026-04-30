// /test/gateway.handler.test.ts
// Handler-level tests for the gateway router, exercising the request →
// response path end-to-end against a fake D1 + JWKS env. We deliberately
// don't pull in miniflare here (would require restructuring the vitest
// pool); these tests cover the routing + auth + chip-economy logic in
// pure-Node, which catches the lion's share of regressions.

import { describe, expect, it, beforeEach } from "vitest";
import { handleRequest, GatewayEnv } from "../src/workers/gateway";
import { signJWT, jwksFromPrivateEnv } from "../src/utils/auth";

// ── In-memory D1 mock ─────────────────────────────────────────────────
// Captures bound parameters, supports the small set of statements the
// gateway issues. Not a SQL parser — a switch over the prepared text.

interface MockUser {
  player_id:       string;
  display_name:    string;
  chip_balance:    number;
  last_bailout_at: number;
  last_login_at:   number;
}

interface MockLedger {
  ledger_id:  number;
  player_id:  string;
  game_id:    string | null;
  delta:      number;
  reason:     string;
  created_at: number;
}

class MockDb {
  users  = new Map<string, MockUser>();
  ledger: MockLedger[] = [];
  nextLedger = 1;

  prepare(sql: string) { return new MockStmt(this, sql); }
  batch(stmts: MockStmt[]) {
    for (const s of stmts) s.run();
    return Promise.resolve(stmts.map(() => ({ success: true })));
  }
}

class MockStmt {
  private boundArgs: unknown[] = [];
  constructor(public db: MockDb, public sql: string) {}
  bind(...args: unknown[]) { this.boundArgs = args; return this; }
  async run() { return this.exec(); }
  async first<T = unknown>(): Promise<T | null> { return this.exec().firstRow as T | null; }
  async all<T = unknown>(): Promise<{ results: T[] }> {
    return { results: this.exec().rows as T[] };
  }

  private exec(): { success: boolean; meta: { changes: number }; firstRow: unknown; rows: unknown[] } {
    const a = this.boundArgs;
    const sql = this.sql;

    if (sql.startsWith("INSERT OR IGNORE INTO users")) {
      const [pid, name, bal, , , ] = a as [string, string, number, number, number];
      const created = a[3] as number;
      const updated = a[4] as number;
      if (this.db.users.has(pid)) return ok(0);
      this.db.users.set(pid, {
        player_id: pid, display_name: name, chip_balance: bal,
        last_bailout_at: 0, last_login_at: 0,
        // not stored fields below
      } as MockUser & Record<string, unknown> as MockUser);
      // record created_at/updated_at only as side-channel for completeness
      void created; void updated;
      return ok(1);
    }

    if (sql.startsWith("INSERT OR IGNORE INTO chip_ledger") ||
        sql.startsWith("INSERT INTO chip_ledger")) {
      const [pid, game_id, delta, reason, created_at] = sql.includes("'signup'")
        ? [a[0], null, a[1], "signup", a[2]] as const
        : sql.includes("'daily'")
          ? [a[0], null, a[1], "daily", a[2]] as const
          : sql.includes("'bailout'")
            ? [a[0], null, a[1], "bailout", a[2]] as const
            : sql.includes("'adjustment'")
              ? [a[0], null, a[1], "adjustment", a[2]] as const
              : sql.includes("'settlement'")
                ? [a[0], a[1], a[2], "settlement", a[3]] as const
                : [a[0], a[1], a[2], a[3], a[4]] as const;
      // dedupe by (player_id, game_id, reason)
      if (this.db.ledger.some(r =>
        r.player_id === pid && r.game_id === game_id && r.reason === reason
      )) return ok(0);
      this.db.ledger.push({
        ledger_id: this.db.nextLedger++,
        player_id: pid as string, game_id: game_id as string | null,
        delta: delta as number, reason: reason as string,
        created_at: created_at as number,
      });
      return ok(1);
    }

    // UPDATE users SET chip_balance += ?, last_login_at = ?, ... WHERE player_id = ? AND last_login_at <= ?
    if (sql.includes("UPDATE users") && sql.includes("last_login_at <= ?")) {
      const [delta, now, , pid, cutoff] = a as [number, number, number, string, number];
      const u = this.db.users.get(pid);
      if (!u || u.last_login_at > cutoff) return ok(0);
      u.chip_balance += delta;
      u.last_login_at = now;
      return ok(1);
    }

    // UPDATE users SET chip_balance += ?, last_bailout_at = ?, ... WHERE balance < ? AND last_bailout_at <= ?
    if (sql.includes("UPDATE users") && sql.includes("last_bailout_at <= ?")) {
      const [delta, now, , pid, threshold, cutoff] =
        a as [number, number, number, string, number, number];
      const u = this.db.users.get(pid);
      if (!u || u.chip_balance >= threshold || u.last_bailout_at > cutoff) return ok(0);
      u.chip_balance += delta;
      u.last_bailout_at = now;
      return ok(1);
    }

    // UPDATE users SET chip_balance += ? ... WHERE chip_balance + ? >= 0 (admin adjust)
    if (sql.includes("UPDATE users") && sql.includes("chip_balance + ? >= 0")) {
      const [delta, , pid, deltaAgain] = a as [number, number, string, number];
      void deltaAgain;
      const u = this.db.users.get(pid);
      if (!u || u.chip_balance + delta < 0) return ok(0);
      u.chip_balance += delta;
      return ok(1);
    }

    if (sql.includes("SELECT chip_balance, last_bailout_at FROM users")) {
      const u = this.db.users.get(a[0] as string);
      return { ...ok(0), firstRow: u ? { chip_balance: u.chip_balance, last_bailout_at: u.last_bailout_at } : null };
    }
    if (sql.includes("SELECT chip_balance FROM users")) {
      const u = this.db.users.get(a[0] as string);
      return { ...ok(0), firstRow: u ? { chip_balance: u.chip_balance } : null };
    }
    if (sql.includes("SELECT display_name, chip_balance, updated_at FROM users")) {
      const u = this.db.users.get(a[0] as string);
      return {
        ...ok(0),
        firstRow: u ? { display_name: u.display_name, chip_balance: u.chip_balance, updated_at: 0 } : null,
      };
    }

    if (sql.includes("FROM chip_ledger WHERE player_id")) {
      const rows = this.db.ledger
        .filter(r => r.player_id === a[0])
        .sort((x, y) => y.ledger_id - x.ledger_id)
        .slice(0, 20);
      return { ...ok(0), rows };
    }

    if (sql.includes("FROM users") && sql.includes("ORDER BY chip_balance DESC")) {
      const rows = [...this.db.users.values()]
        .filter(u => !u.player_id.startsWith("BOT_"))
        .sort((x, y) => y.chip_balance - x.chip_balance)
        .slice(0, 20)
        .map(u => ({ player_id: u.player_id, display_name: u.display_name, chip_balance: u.chip_balance }));
      return { ...ok(0), rows };
    }

    if (sql.includes("FROM player_settlements ps")) {
      // empty history for tests
      return { ...ok(0), rows: [] };
    }

    throw new Error(`mock D1: unhandled SQL: ${sql.slice(0, 80)}…`);
  }
}
function ok(changes: number) {
  return { success: true, meta: { changes }, firstRow: null as unknown, rows: [] as unknown[] };
}

// ── ES256 key for tests ─────────────────────────────────────────────
async function makeKey(): Promise<string> {
  const { privateKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", privateKey) as JsonWebKey & {
    kid?: string; alg?: string; use?: string;
  };
  // Unique kid per test — auth.ts has a module-scoped verify-key cache
  // keyed by kid, so reusing the same kid across tests would cache the
  // first key and fail signatures from later tests.                       // L3_邏輯安防
  jwk.kid = crypto.randomUUID();
  jwk.alg = "ES256";
  jwk.use = "sig";
  return JSON.stringify(jwk);
}

let env: GatewayEnv;
let db: MockDb;
let JWK: string;

beforeEach(async () => {
  JWK = await makeKey();
  db  = new MockDb();
  env = {
    GAME_ROOM:        {} as DurableObjectNamespace,
    LOBBY_DO:         {} as DurableObjectNamespace,
    TOURNAMENT_DO:    {} as DurableObjectNamespace,
    SETTLEMENT_QUEUE: {} as GatewayEnv["SETTLEMENT_QUEUE"],
    MATCH_KV:         {} as KVNamespace,
    DB:               db as unknown as D1Database,
    JWT_PRIVATE_JWK:  JWK,
    ADMIN_SECRET:     "test-admin-secret",
  };
});

function req(method: string, path: string, init?: { body?: unknown; headers?: Record<string, string> }): Request {
  const url = `https://test.local${path}`;
  return new Request(url, {
    method,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("gateway routes", () => {
  it("GET /.well-known/jwks.json returns the active public key", async () => {
    const r = await handleRequest(req("GET", "/.well-known/jwks.json"), env);
    expect(r.status).toBe(200);
    const body = await r.json() as { keys: Array<{ kid: string; alg: string }> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]!.kid).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.keys[0]!.alg).toBe("ES256");
  });

  it("POST /auth/token issues a token, creates wallet, grants signup + daily bonus", async () => {
    const r = await handleRequest(req("POST", "/auth/token", { body: { playerId: "alice" } }), env);
    expect(r.status).toBe(200);
    const body = await r.json() as { token: string; playerId: string; dailyBonus: number };
    expect(body.playerId).toBe("alice");
    expect(body.dailyBonus).toBe(100);

    const u = db.users.get("alice")!;
    expect(u.chip_balance).toBe(1100);   // signup 1000 + daily 100
    expect(db.ledger.filter(r => r.player_id === "alice").map(r => r.reason).sort())
      .toEqual(["daily", "signup"]);
  });

  it("POST /auth/token rejects reserved BOT_ prefix", async () => {
    const r = await handleRequest(req("POST", "/auth/token", { body: { playerId: "BOT_evil" } }), env);
    expect(r.status).toBe(400);
  });

  it("GET /api/me/wallet requires JWT and returns balance + ledger", async () => {
    const noAuth = await handleRequest(req("GET", "/api/me/wallet"), env);
    expect(noAuth.status).toBe(401);

    await handleRequest(req("POST", "/auth/token", { body: { playerId: "alice" } }), env);
    const token = await signJWT("alice", JWK, 60);
    const r = await handleRequest(req("GET", "/api/me/wallet", { headers: { Authorization: `Bearer ${token}` } }), env);
    expect(r.status).toBe(200);
    const body = await r.json() as { chipBalance: number; ledger: Array<{ reason: string }> };
    expect(body.chipBalance).toBe(1100);
    expect(body.ledger.map(l => l.reason).sort()).toEqual(["daily", "signup"]);
  });

  it("GET /metrics exposes counters", async () => {
    await handleRequest(req("POST", "/auth/token", { body: { playerId: "alice" } }), env);
    const r = await handleRequest(req("GET", "/metrics"), env);
    const body = await r.json() as Record<string, number>;
    expect(body.tokens_issued).toBeGreaterThanOrEqual(1);
    expect(typeof body.isolate_uptime_ms).toBe("number");
  });

  it("POST /api/me/bailout 409s when balance is above threshold", async () => {
    await handleRequest(req("POST", "/auth/token", { body: { playerId: "alice" } }), env);
    const token = await signJWT("alice", JWK, 60);
    const r = await handleRequest(req("POST", "/api/me/bailout", {
      headers: { Authorization: `Bearer ${token}` },
    }), env);
    expect(r.status).toBe(409);
    const body = await r.json() as { error: string };
    expect(body.error).toMatch(/threshold/);
  });

  it("POST /api/admin/adjust requires the secret and credits chips", async () => {
    await handleRequest(req("POST", "/auth/token", { body: { playerId: "alice" } }), env);

    const wrong = await handleRequest(req("POST", "/api/admin/adjust", {
      headers: { "X-Admin-Secret": "wrong" },
      body: { playerId: "alice", delta: 500, reason: "promo" },
    }), env);
    expect(wrong.status).toBe(401);

    const ok = await handleRequest(req("POST", "/api/admin/adjust", {
      headers: { "X-Admin-Secret": "test-admin-secret" },
      body: { playerId: "alice", delta: 500, reason: "promo" },
    }), env);
    expect(ok.status).toBe(200);
    const body = await ok.json() as { chipBalance: number };
    expect(body.chipBalance).toBe(1600);   // 1000 signup + 100 daily + 500 admin
    expect(db.ledger.find(r => r.reason === "adjustment")?.delta).toBe(500);
  });

  it("POST /api/admin/adjust returns 503 when ADMIN_SECRET unset", async () => {
    delete env.ADMIN_SECRET;
    const r = await handleRequest(req("POST", "/api/admin/adjust", {
      headers: { "X-Admin-Secret": "anything" },
      body: { playerId: "alice", delta: 100 },
    }), env);
    expect(r.status).toBe(503);
  });

  it("GET /api/leaderboard returns rows sorted desc, BOT_ filtered", async () => {
    db.users.set("alice", { player_id: "alice", display_name: "alice", chip_balance: 1500, last_bailout_at: 0, last_login_at: 0 });
    db.users.set("BOT_X", { player_id: "BOT_X", display_name: "bot", chip_balance: 9999, last_bailout_at: 0, last_login_at: 0 });
    db.users.set("bob",   { player_id: "bob",   display_name: "bob",   chip_balance: 800, last_bailout_at: 0, last_login_at: 0 });

    const r = await handleRequest(req("GET", "/api/leaderboard"), env);
    const body = await r.json() as { rows: Array<{ player_id: string }> };
    expect(body.rows.map(r => r.player_id)).toEqual(["alice", "bob"]);
  });

  it("unknown route returns 404", async () => {
    const r = await handleRequest(req("GET", "/no-such-thing"), env);
    expect(r.status).toBe(404);
  });

  it("OPTIONS preflight returns 204 with CORS headers", async () => {
    const r = await handleRequest(req("OPTIONS", "/api/match"), env);
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

