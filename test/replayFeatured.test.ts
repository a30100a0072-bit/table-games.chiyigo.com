// Handler-level tests for the admin-curated featured-replays feed.
// Uses a minimal in-memory D1 mock — just enough SQL routing to exercise
// the auth gate + validation paths + happy-path insert/list/delete.

import { describe, expect, it, beforeEach } from "vitest";
import { featureReplay, unfeatureReplay, listFeaturedReplays } from "../src/api/replays";
import type { ReplaysEnv } from "../src/api/replays";

interface MetaRow { game_id: string; game_type: string; player_ids: string; finished_at: number; winner_id: string | null; }
interface ShareRow { token: string; game_id: string; owner_id: string; created_at: number; expires_at: number; view_count: number; }
interface FeatRow  { game_id: string; featured_by: string; featured_at: number; note: string | null; share_token: string; expires_at: number; }

class MockDb {
  meta: MetaRow[]    = [];
  shares: ShareRow[] = [];
  featured: FeatRow[] = [];
  prepare(sql: string) { return new MockStmt(this, sql); }
  // batch is a sequential helper — D1 spec returns an array of results.
  async batch(stmts: MockStmt[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

class MockStmt {
  private args: unknown[] = [];
  constructor(public db: MockDb, public sql: string) {}
  bind(...a: unknown[]) { this.args = a; return this; }

  async first<T = unknown>(): Promise<T | null> {
    if (this.sql.includes("SELECT game_id FROM replay_meta WHERE game_id")) {
      const [id] = this.args as [string];
      const row = this.db.meta.find(m => m.game_id === id);
      return (row ? { game_id: row.game_id } : null) as T | null;
    }
    return null;
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO replay_shares")) {
      const [token, gameId, createdAt, expiresAt] = this.args as [string, string, number, number];
      this.db.shares.push({ token, game_id: gameId, owner_id: "admin", created_at: createdAt, expires_at: expiresAt, view_count: 0 });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT OR REPLACE INTO replay_featured")) {
      const [gameId, featuredAt, note, shareToken, expiresAt] = this.args as [string, number, string | null, string, number];
      this.db.featured = this.db.featured.filter(f => f.game_id !== gameId);
      this.db.featured.push({ game_id: gameId, featured_by: "admin", featured_at: featuredAt, note, share_token: shareToken, expires_at: expiresAt });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM replay_featured")) {
      const [gameId] = this.args as [string];
      const before = this.db.featured.length;
      this.db.featured = this.db.featured.filter(f => f.game_id !== gameId);
      return { success: true, meta: { changes: before - this.db.featured.length } };
    }
    return { success: true, meta: { changes: 0 } };
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM replay_featured f")) {
      const [now, ...rest] = this.args as number[];
      const nowVal = now!;
      const limit = rest[rest.length - 1]!;
      const cursor = rest.length === 2 ? rest[0]! : null;
      const joined = this.db.featured
        .filter(f => f.expires_at > nowVal && (cursor === null || f.featured_at < cursor))
        .sort((a, b) => b.featured_at - a.featured_at)
        .slice(0, limit)
        .map(f => {
          const m = this.db.meta.find(x => x.game_id === f.game_id)!;
          const s = this.db.shares.find(x => x.token === f.share_token)!;
          return {
            game_id: f.game_id, featured_at: f.featured_at, note: f.note,
            share_token: f.share_token, expires_at: f.expires_at,
            game_type: m.game_type, player_ids: m.player_ids, finished_at: m.finished_at,
            winner_id: m.winner_id, view_count: s.view_count,
          };
        });
      return { results: joined as unknown as T[] };
    }
    return { results: [] };
  }
}

const SECRET = "test-admin-secret";
let db:  MockDb;
let env: ReplaysEnv & { ADMIN_SECRET: string };

beforeEach(() => {
  db  = new MockDb();
  db.meta.push({
    game_id: "g1", game_type: "bigTwo",
    player_ids: JSON.stringify(["alice", "bob"]),
    finished_at: 5000, winner_id: "alice",
  });
  env = { DB: db as unknown as D1Database, JWT_PRIVATE_JWK: "irrelevant", ADMIN_SECRET: SECRET };
});

function adminReq(method: string, path: string, secret: string | null, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (secret !== null) headers["X-Admin-Secret"] = secret;
  if (body) headers["Content-Type"] = "application/json";
  return new Request(`https://gw.local${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
}

describe("featureReplay (admin)", () => {
  it("requires X-Admin-Secret matching env.ADMIN_SECRET", async () => {
    const noSecret = await featureReplay(adminReq("POST", "/api/admin/replays/feature", null, { gameId: "g1" }), env);
    expect(noSecret.status).toBe(401);

    const wrong = await featureReplay(adminReq("POST", "/api/admin/replays/feature", "nope", { gameId: "g1" }), env);
    expect(wrong.status).toBe(401);
  });

  it("503 when env.ADMIN_SECRET is unset", async () => {
    const blank = { ...env, ADMIN_SECRET: "" };
    const r = await featureReplay(adminReq("POST", "/api/admin/replays/feature", "x", { gameId: "g1" }), blank);
    expect(r.status).toBe(503);
  });

  it("404 when the replay doesn't exist", async () => {
    const r = await featureReplay(adminReq("POST", "/api/admin/replays/feature", SECRET, { gameId: "missing" }), env);
    expect(r.status).toBe(404);
  });

  it("rejects out-of-range ttlDays", async () => {
    const tooHigh = await featureReplay(adminReq("POST", "/api/admin/replays/feature", SECRET, { gameId: "g1", ttlDays: 9999 }), env);
    expect(tooHigh.status).toBe(400);
    const tooLow = await featureReplay(adminReq("POST", "/api/admin/replays/feature", SECRET, { gameId: "g1", ttlDays: 0 }), env);
    expect(tooLow.status).toBe(400);
  });

  it("inserts a share_token + featured row on success", async () => {
    const r = await featureReplay(adminReq("POST", "/api/admin/replays/feature", SECRET, { gameId: "g1", note: "epic comeback", ttlDays: 7 }), env);
    expect(r.status).toBe(201);
    const body = await r.json() as { gameId: string; shareToken: string; expiresAt: number };
    expect(body.gameId).toBe("g1");
    expect(body.shareToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(db.shares).toHaveLength(1);
    expect(db.featured).toHaveLength(1);
    expect(db.featured[0]!.note).toBe("epic comeback");
    expect(db.featured[0]!.share_token).toBe(body.shareToken);
  });
});

describe("unfeatureReplay (admin)", () => {
  it("requires admin secret", async () => {
    const r = await unfeatureReplay(adminReq("DELETE", "/api/admin/replays/feature/g1", "wrong"), env, "g1");
    expect(r.status).toBe(401);
  });

  it("404 when the row doesn't exist", async () => {
    const r = await unfeatureReplay(adminReq("DELETE", "/api/admin/replays/feature/missing", SECRET), env, "missing");
    expect(r.status).toBe(404);
  });

  it("removes the featured row but leaves the share_token alive", async () => {
    await featureReplay(adminReq("POST", "/api/admin/replays/feature", SECRET, { gameId: "g1" }), env);
    expect(db.featured).toHaveLength(1);
    expect(db.shares).toHaveLength(1);
    const r = await unfeatureReplay(adminReq("DELETE", "/api/admin/replays/feature/g1", SECRET), env, "g1");
    expect(r.status).toBe(200);
    expect(db.featured).toHaveLength(0);
    expect(db.shares).toHaveLength(1);   // direct-link viewers preserved
  });
});

describe("listFeaturedReplays (public)", () => {
  it("returns the joined feed with player ids + share token", async () => {
    await featureReplay(adminReq("POST", "/api/admin/replays/feature", SECRET, { gameId: "g1", note: "n" }), env);
    const r = await listFeaturedReplays(new Request("https://gw.local/api/replays/featured"), env);
    expect(r.status).toBe(200);
    const body = await r.json() as { featured: Array<{ gameId: string; shareToken: string; playerIds: string[]; note: string | null }> };
    expect(body.featured).toHaveLength(1);
    expect(body.featured[0]!.gameId).toBe("g1");
    expect(body.featured[0]!.playerIds).toEqual(["alice", "bob"]);
    expect(body.featured[0]!.note).toBe("n");
    expect(body.featured[0]!.shareToken).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("excludes expired feature rows", async () => {
    db.featured.push({
      game_id: "g1", featured_by: "admin", featured_at: 1000,
      note: null, share_token: "tk-expired", expires_at: 100,   // already expired
    });
    db.shares.push({ token: "tk-expired", game_id: "g1", owner_id: "admin", created_at: 0, expires_at: 100, view_count: 0 });
    const r = await listFeaturedReplays(new Request("https://gw.local/api/replays/featured"), env);
    const body = await r.json() as { featured: unknown[] };
    expect(body.featured).toHaveLength(0);
  });
});
