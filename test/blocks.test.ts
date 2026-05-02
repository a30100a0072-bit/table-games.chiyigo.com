// /test/blocks.test.ts
// Handler-level tests for the block endpoints + the gate helper.

import { describe, expect, it, beforeEach } from "vitest";
import {
  blockPlayer, unblockPlayer, listMyBlocks, isBlockedEitherWay,
} from "../src/api/blocks";
import type { BlocksEnv } from "../src/api/blocks";
import { signJWT } from "../src/utils/auth";

interface BlockRow { blocker: string; blockee: string; created_at: number; }
interface FriendshipRow { a_id: string; b_id: string; }

class MockDb {
  blocks: BlockRow[] = [];
  friendships: FriendshipRow[] = [];
  prepare(sql: string) { return new MockStmt(this, sql); }
}
class MockStmt {
  args: unknown[] = [];
  constructor(public db: MockDb, public sql: string) {}
  bind(...a: unknown[]) { this.args = a; return this; }

  async first<T = unknown>(): Promise<T | null> {
    if (this.sql.includes("FROM blocks")) {
      const [a, b, c, d] = this.args as [string, string, string, string];
      const hit = this.db.blocks.some(r =>
        (r.blocker === a && r.blockee === b) ||
        (r.blocker === c && r.blockee === d),
      );
      return (hit ? { 1: 1 } : null) as T | null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    if (this.sql.startsWith("SELECT blockee, created_at FROM blocks")) {
      const [me] = this.args as [string];
      const out = this.db.blocks
        .filter(r => r.blocker === me)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 200);
      return { results: out as unknown as T[] };
    }
    return { results: [] };
  }

  async run() {
    if (this.sql.startsWith("INSERT OR IGNORE INTO blocks")) {
      const [blocker, blockee, created_at] = this.args as [string, string, number];
      const exists = this.db.blocks.some(r => r.blocker === blocker && r.blockee === blockee);
      if (!exists) this.db.blocks.push({ blocker, blockee, created_at });
      return { success: true, meta: { changes: exists ? 0 : 1 } };
    }
    if (this.sql.startsWith("DELETE FROM blocks")) {
      const [blocker, blockee] = this.args as [string, string];
      const before = this.db.blocks.length;
      this.db.blocks = this.db.blocks.filter(r => !(r.blocker === blocker && r.blockee === blockee));
      return { success: true, meta: { changes: before - this.db.blocks.length } };
    }
    if (this.sql.startsWith("DELETE FROM friendships")) {
      const [a, b] = this.args as [string, string];
      const before = this.db.friendships.length;
      this.db.friendships = this.db.friendships.filter(r => !(r.a_id === a && r.b_id === b));
      return { success: true, meta: { changes: before - this.db.friendships.length } };
    }
    return { success: true, meta: { changes: 0 } };
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
let env: BlocksEnv;

async function tokFor(p: string): Promise<string> { return signJWT(p, JWK, 3600); }

function authedReq(method: string, jwt: string, body?: unknown): Request {
  return new Request("https://gw.local/", {
    method,
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : null,
  });
}

beforeEach(async () => {
  JWK = await makeKey();
  db  = new MockDb();
  env = { DB: db as unknown as D1Database, JWT_PRIVATE_JWK: JWK };
});

describe("blocks API", () => {
  it("rejects unauthenticated POST /api/blocks", async () => {
    const r = await blockPlayer(new Request("https://gw/", { method: "POST" }), env);
    expect(r.status).toBe(401);
  });

  it("blocks a target — idempotent re-block returns 200 with no second row", async () => {
    const tok = await tokFor("alice");
    const r1 = await blockPlayer(authedReq("POST", tok, { targetPlayerId: "mallory" }), env);
    expect(r1.status).toBe(200);
    expect(db.blocks).toHaveLength(1);
    expect(db.blocks[0]).toMatchObject({ blocker: "alice", blockee: "mallory" });

    const r2 = await blockPlayer(authedReq("POST", tok, { targetPlayerId: "mallory" }), env);
    expect(r2.status).toBe(200);
    expect(db.blocks).toHaveLength(1);   // INSERT OR IGNORE preserves single row
  });

  it("rejects self-block (400)", async () => {
    const tok = await tokFor("alice");
    const r = await blockPlayer(authedReq("POST", tok, { targetPlayerId: "alice" }), env);
    expect(r.status).toBe(400);
    expect(db.blocks).toHaveLength(0);
  });

  it("block clears any existing friendship row in the canonical pair", async () => {
    db.friendships.push({ a_id: "alice", b_id: "mallory" });
    const tok = await tokFor("mallory");                     // either side initiates
    await blockPlayer(authedReq("POST", tok, { targetPlayerId: "alice" }), env);
    expect(db.friendships).toHaveLength(0);
  });

  it("unblock removes the row; unblocking a non-blocked target is a no-op 200", async () => {
    db.blocks.push({ blocker: "alice", blockee: "mallory", created_at: 1 });
    const tok = await tokFor("alice");
    const r1 = await unblockPlayer(authedReq("DELETE", tok), env, "mallory");
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { removed: boolean }).removed).toBe(true);
    expect(db.blocks).toHaveLength(0);

    const r2 = await unblockPlayer(authedReq("DELETE", tok), env, "ghost");
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { removed: boolean }).removed).toBe(false);
  });

  it("listMyBlocks returns only the caller's outgoing blocks, newest first", async () => {
    const now = Date.now();
    db.blocks.push({ blocker: "alice",   blockee: "old",   created_at: now - 1000 });
    db.blocks.push({ blocker: "alice",   blockee: "new",   created_at: now });
    db.blocks.push({ blocker: "bob",     blockee: "carol", created_at: now });
    const tok = await tokFor("alice");
    const r = await listMyBlocks(authedReq("GET", tok), env);
    const body = await r.json() as { blocks: { playerId: string }[] };
    expect(body.blocks.map(b => b.playerId)).toEqual(["new", "old"]);
  });

  it("isBlockedEitherWay flags both directions", async () => {
    db.blocks.push({ blocker: "alice", blockee: "mallory", created_at: 1 });
    expect(await isBlockedEitherWay(env.DB, "alice", "mallory")).toBe(true);
    expect(await isBlockedEitherWay(env.DB, "mallory", "alice")).toBe(true);
    expect(await isBlockedEitherWay(env.DB, "alice", "carol")).toBe(false);
  });
});
