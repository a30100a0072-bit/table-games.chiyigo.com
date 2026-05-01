// Handler-level tests for replays API. Mocks D1 with just enough SQL
// routing for replay_meta lookups to exercise list / get / version-mismatch
// / forbidden-when-not-a-player paths.

import { describe, expect, it, beforeEach } from "vitest";
import { listMyReplays, getReplay } from "../src/api/replays";
import type { ReplaysEnv } from "../src/api/replays";
import { ENGINE_VERSION } from "../src/game/GameEngineAdapter";
import { signJWT } from "../src/utils/auth";

interface MetaRow {
  game_id: string; game_type: string; engine_version: number;
  player_ids: string; initial_snapshot: string; events: string;
  started_at: number; finished_at: number;
  winner_id: string | null; reason: string | null;
}

class MockDb {
  rows: MetaRow[] = [];
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
    return null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM replay_meta") && this.sql.includes("LIKE ?")) {
      const [pattern] = this.args as [string];
      // Strip the surrounding %…% wildcards and the JSON quotes to get
      // the raw playerId, then check membership against each row's seat list.
      const needle = pattern.slice(1, -1);              // drop %..%
      const me = JSON.parse(needle) as string;          // un-stringify "alice"
      const out = this.db.rows
        .filter(r => (JSON.parse(r.player_ids) as string[]).includes(me))
        .sort((a, b) => b.finished_at - a.finished_at)
        .slice(0, 30);
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
});
