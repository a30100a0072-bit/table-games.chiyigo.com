// Handler-level tests for replays API. Mocks D1 with just enough SQL
// routing for replay_meta lookups to exercise list / get / version-mismatch
// / forbidden-when-not-a-player paths.

import { describe, expect, it, beforeEach } from "vitest";
import { listMyReplays, getReplay, shareReplay, resolveSharedReplay, listMyShares, revokeShare } from "../src/api/replays";
import type { ReplaysEnv } from "../src/api/replays";
import { ENGINE_VERSION } from "../src/game/GameEngineAdapter";
import { signJWT } from "../src/utils/auth";

interface MetaRow {
  game_id: string; game_type: string; engine_version: number;
  player_ids: string; initial_snapshot: string; events: string;
  started_at: number; finished_at: number;
  winner_id: string | null; reason: string | null;
}

interface ShareRow { token: string; game_id: string; owner_id: string; created_at: number; expires_at: number; view_count?: number; }

class MockDb {
  rows: MetaRow[] = [];
  shares: ShareRow[] = [];
  prepare(sql: string) { return new MockStmt(this, sql); }
}

class MockStmt {
  private args: unknown[] = [];
  constructor(public db: MockDb, public sql: string) {}
  bind(...a: unknown[]) { this.args = a; return this; }

  async first<T = unknown>(): Promise<T | null> {
    if (this.sql.includes("FROM replay_meta WHERE game_id = ?")) {
      const [id] = this.args as [string];
      return (this.db.rows.find(r => r.game_id === id) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT player_ids FROM replay_meta")) {
      const [id] = this.args as [string];
      const row = this.db.rows.find(r => r.game_id === id);
      return (row ? { player_ids: row.player_ids } : null) as T | null;
    }
    if (this.sql.includes("FROM replay_shares WHERE token = ?")) {
      const [t] = this.args as [string];
      return (this.db.shares.find(s => s.token === t) ?? null) as T | null;
    }
    return null;
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO replay_shares")) {
      const [token, gameId, ownerId, createdAt, expiresAt] = this.args as [string, string, string, number, number];
      this.db.shares.push({ token, game_id: gameId, owner_id: ownerId, created_at: createdAt, expires_at: expiresAt });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.startsWith("DELETE FROM replay_shares")) {
      const [token, ownerId] = this.args as [string, string];
      const before = this.db.shares.length;
      this.db.shares = this.db.shares.filter(s => !(s.token === token && s.owner_id === ownerId));
      return { success: true, meta: { changes: before - this.db.shares.length } };
    }
    if (this.sql.startsWith("UPDATE replay_shares SET view_count")) {
      const [token] = this.args as [string];
      const row = this.db.shares.find(s => s.token === token);
      if (row) row.view_count = (row.view_count ?? 0) + 1;
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    return { success: true, meta: { changes: 0 } };
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    // Indexed list path: SELECT … FROM replay_participants rp JOIN replay_meta rm …
    // The mock derives participants from each row's player_ids array so
    // we don't have to maintain a parallel join table in the fixture.
    if (this.sql.includes("FROM replay_participants") && this.sql.includes("JOIN replay_meta")) {
      const [me] = this.args as [string];
      const out = this.db.rows
        .filter(r => (JSON.parse(r.player_ids) as string[]).includes(me))
        .sort((a, b) => b.finished_at - a.finished_at)
        .slice(0, 30);
      return { results: out as unknown as T[] };
    }
    // listMyShares: caller's active (non-expired) shares.
    if (this.sql.includes("FROM replay_shares") && this.sql.includes("owner_id = ?")) {
      const [owner, now] = this.args as [string, number];
      const out = this.db.shares
        .filter(s => s.owner_id === owner && s.expires_at > now)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 50);
      return { results: out as unknown as T[] };
    }
    return { results: [] };
  }
}

async function makeKey(): Promise<string> {
  const { privateKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", privateKey) as JsonWebKey & {
    kid?: string; alg?: string; use?: string;
  };
  jwk.kid = crypto.randomUUID(); jwk.alg = "ES256"; jwk.use = "sig";
  return JSON.stringify(jwk);
}

let JWK: string;
let db:  MockDb;
let env: ReplaysEnv;

async function tokFor(pid: string): Promise<string> { return signJWT(pid, JWK, 3600); }

function authedReq(method: string, path: string, jwt: string): Request {
  return new Request(`https://gw.local${path}`, {
    method, headers: { "Authorization": `Bearer ${jwt}` },
  });
}

function mkRow(p: Partial<MetaRow> = {}): MetaRow {
  return {
    game_id: "g1", game_type: "bigTwo", engine_version: ENGINE_VERSION,
    player_ids: JSON.stringify(["alice", "bob", "carol", "dave"]),
    initial_snapshot: JSON.stringify({ stub: true }),
    events: JSON.stringify([{ kind: "action", seq: 0, playerId: "alice", action: { type: "pass" }, ts: 1 }]),
    started_at: 1000, finished_at: 2000,
    winner_id: "alice", reason: "lastCardPlayed",
    ...p,
  };
}

beforeEach(async () => {
  JWK = await makeKey();
  db  = new MockDb();
  env = { DB: db as unknown as D1Database, JWT_PRIVATE_JWK: JWK };
});

describe("replays API", () => {
  it("rejects unauthenticated", async () => {
    const r = await listMyReplays(new Request("https://gw/", { method: "GET" }), env);
    expect(r.status).toBe(401);
  });

  it("lists only games the caller played", async () => {
    db.rows.push(mkRow({ game_id: "g-alice", player_ids: JSON.stringify(["alice", "bob"]) }));
    db.rows.push(mkRow({ game_id: "g-other", player_ids: JSON.stringify(["bob", "carol"]) }));

    const aliceTok = await tokFor("alice");
    const list = await (await listMyReplays(authedReq("GET", "/", aliceTok), env)).json() as {
      replays: { gameId: string }[];
    };
    expect(list.replays.map(r => r.gameId)).toEqual(["g-alice"]);
  });

  it("LIKE needle quotes the playerId so substrings don't false-match", async () => {
    // A player called "ali" must not match a game whose seats contain "alice".
    db.rows.push(mkRow({ game_id: "g-alice", player_ids: JSON.stringify(["alice", "bob"]) }));
    const aliTok = await tokFor("ali");
    const list = await (await listMyReplays(authedReq("GET", "/", aliTok), env)).json() as { replays: unknown[] };
    expect(list.replays).toHaveLength(0);
  });

  it("flags rows with a non-current engine_version as not replayable", async () => {
    db.rows.push(mkRow({ game_id: "old", engine_version: ENGINE_VERSION - 1 }));
    db.rows.push(mkRow({ game_id: "new" }));

    const aliceTok = await tokFor("alice");
    const list = await (await listMyReplays(authedReq("GET", "/", aliceTok), env)).json() as {
      replays: { gameId: string; replayable: boolean }[];
    };
    const map = Object.fromEntries(list.replays.map(r => [r.gameId, r.replayable]));
    expect(map.old).toBe(false);
    expect(map.new).toBe(true);
  });

  it("get returns full payload including events for caller's own game", async () => {
    db.rows.push(mkRow({ game_id: "g1" }));
    const tok = await tokFor("alice");
    const r = await getReplay(authedReq("GET", "/", tok), env, "g1");
    const body = await r.json() as {
      gameId: string; replayable: boolean; events: unknown[]; initialSnapshot: unknown;
    };
    expect(r.status).toBe(200);
    expect(body.gameId).toBe("g1");
    expect(body.replayable).toBe(true);
    expect(body.events).toHaveLength(1);
    expect(body.initialSnapshot).toBeTruthy();
  });

  it("get strips events + snapshot when engine_version mismatches", async () => {
    db.rows.push(mkRow({ game_id: "g1", engine_version: ENGINE_VERSION - 1 }));
    const tok = await tokFor("alice");
    const r = await getReplay(authedReq("GET", "/", tok), env, "g1");
    const body = await r.json() as {
      replayable: boolean; events: unknown[]; initialSnapshot: unknown; winnerId: string;
    };
    expect(body.replayable).toBe(false);
    expect(body.events).toEqual([]);
    expect(body.initialSnapshot).toBeNull();
    // Settlement-level info is still present so the UI can render the result.
    expect(body.winnerId).toBe("alice");
  });

  it("get refuses non-participants (403)", async () => {
    db.rows.push(mkRow({ game_id: "g1", player_ids: JSON.stringify(["bob", "carol"]) }));
    const aliceTok = await tokFor("alice");
    const r = await getReplay(authedReq("GET", "/", aliceTok), env, "g1");
    expect(r.status).toBe(403);
  });

  it("get returns 404 for unknown gameId", async () => {
    const tok = await tokFor("alice");
    const r = await getReplay(authedReq("GET", "/", tok), env, "ghost");
    expect(r.status).toBe(404);
  });

  it("share mints a token for a seated player and persists it", async () => {
    db.rows.push(mkRow({ game_id: "g1" }));
    const tok = await tokFor("alice");
    const req = new Request("https://gw.local/", {
      method: "POST",
      headers: { "Authorization": `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const r = await shareReplay(req, env, "g1");
    expect(r.status).toBe(201);
    const body = await r.json() as { token: string; expiresAt: number };
    expect(body.token).toBeTruthy();
    expect(db.shares).toHaveLength(1);
    expect(db.shares[0]!.game_id).toBe("g1");
    expect(db.shares[0]!.owner_id).toBe("alice");
  });

  it("share refuses non-seated callers (403)", async () => {
    db.rows.push(mkRow({ game_id: "g1", player_ids: JSON.stringify(["bob", "carol"]) }));
    const tok = await tokFor("alice");
    const req = new Request("https://gw.local/", {
      method: "POST",
      headers: { "Authorization": `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const r = await shareReplay(req, env, "g1");
    expect(r.status).toBe(403);
  });

  it("share rejects bad ttlMs (out-of-range)", async () => {
    db.rows.push(mkRow({ game_id: "g1" }));
    const tok = await tokFor("alice");
    const req = new Request("https://gw.local/", {
      method: "POST",
      headers: { "Authorization": `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttlMs: 1 }),               // < 1h floor
    });
    const r = await shareReplay(req, env, "g1");
    expect(r.status).toBe(400);
  });

  it("resolveSharedReplay returns the replay payload + sharedBy for a valid token", async () => {
    db.rows.push(mkRow({ game_id: "g1" }));
    db.shares.push({
      token: "abc", game_id: "g1", owner_id: "alice",
      created_at: Date.now(), expires_at: Date.now() + 60_000,
    });
    const r = await resolveSharedReplay(env, "abc");
    expect(r.status).toBe(200);
    const body = await r.json() as { gameId: string; sharedBy: string; replayable: boolean };
    expect(body.gameId).toBe("g1");
    expect(body.sharedBy).toBe("alice");
    expect(body.replayable).toBe(true);
  });

  it("resolveSharedReplay returns 410 for an expired token", async () => {
    db.rows.push(mkRow({ game_id: "g1" }));
    db.shares.push({
      token: "abc", game_id: "g1", owner_id: "alice",
      created_at: Date.now() - 1000, expires_at: Date.now() - 1,
    });
    const r = await resolveSharedReplay(env, "abc");
    expect(r.status).toBe(410);
  });

  it("resolveSharedReplay returns 404 for an unknown token", async () => {
    const r = await resolveSharedReplay(env, "ghost");
    expect(r.status).toBe(404);
  });

  // ── revoke + list-my-shares ─────────────────────────────────────────
  it("listMyShares returns only the caller's non-expired tokens, newest first", async () => {
    const now = Date.now();
    db.shares.push({ token: "old",     game_id: "g1", owner_id: "alice", created_at: now - 1000, expires_at: now + 60_000 });
    db.shares.push({ token: "new",     game_id: "g1", owner_id: "alice", created_at: now,        expires_at: now + 60_000 });
    db.shares.push({ token: "expired", game_id: "g1", owner_id: "alice", created_at: now - 9999, expires_at: now - 1      });
    db.shares.push({ token: "other",   game_id: "g2", owner_id: "bob",   created_at: now,        expires_at: now + 60_000 });

    const tok = await tokFor("alice");
    const r = await listMyShares(authedReq("GET", "/", tok), env);
    expect(r.status).toBe(200);
    const body = await r.json() as { shares: Array<{ token: string }> };
    expect(body.shares.map(s => s.token)).toEqual(["new", "old"]);   // expired + bob's filtered out
  });

  it("revokeShare removes the row when the caller is the owner", async () => {
    db.shares.push({
      token: "abc", game_id: "g1", owner_id: "alice",
      created_at: Date.now(), expires_at: Date.now() + 60_000,
    });
    const tok = await tokFor("alice");
    const r = await revokeShare(authedReq("DELETE", "/", tok), env, "abc");
    expect(r.status).toBe(200);
    const body = await r.json() as { revoked: boolean };
    expect(body.revoked).toBe(true);
    expect(db.shares).toHaveLength(0);
  });

  it("revokeShare 404s when called by a non-owner — and does NOT delete the row (no token-existence leak)", async () => {
    db.shares.push({
      token: "abc", game_id: "g1", owner_id: "alice",
      created_at: Date.now(), expires_at: Date.now() + 60_000,
    });
    const malloryTok = await tokFor("mallory");
    const r = await revokeShare(authedReq("DELETE", "/", malloryTok), env, "abc");
    expect(r.status).toBe(404);
    expect(db.shares).toHaveLength(1);              // row preserved
  });

  it("revokeShare 404s on an unknown token", async () => {
    const tok = await tokFor("alice");
    const r = await revokeShare(authedReq("DELETE", "/", tok), env, "ghost");
    expect(r.status).toBe(404);
  });

  it("resolveSharedReplay bumps view_count on each public hit", async () => {
    db.rows.push(mkRow({ game_id: "g1" }));
    db.shares.push({
      token: "abc", game_id: "g1", owner_id: "alice",
      created_at: Date.now(), expires_at: Date.now() + 60_000,
    });
    await resolveSharedReplay(env, "abc");
    await resolveSharedReplay(env, "abc");
    await resolveSharedReplay(env, "abc");
    expect(db.shares[0]!.view_count).toBe(3);
  });

  it("listMyShares surfaces viewCount alongside expiry", async () => {
    db.shares.push({
      token: "t1", game_id: "g1", owner_id: "alice",
      created_at: Date.now(), expires_at: Date.now() + 60_000,
      view_count: 7,
    });
    const tok = await tokFor("alice");
    const r = await listMyShares(authedReq("GET", "/", tok), env);
    const body = await r.json() as { shares: Array<{ token: string; viewCount: number }> };
    expect(body.shares[0]!.viewCount).toBe(7);
  });

  it("after revoke, resolveSharedReplay falls through to 404", async () => {
    db.rows.push(mkRow({ game_id: "g1" }));
    db.shares.push({
      token: "abc", game_id: "g1", owner_id: "alice",
      created_at: Date.now(), expires_at: Date.now() + 60_000,
    });
    const tok = await tokFor("alice");
    await revokeShare(authedReq("DELETE", "/", tok), env, "abc");
    const r = await resolveSharedReplay(env, "abc");
    expect(r.status).toBe(404);
  });
});
