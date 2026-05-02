// /test/friendRecommendations.test.ts
// Targeted tests for GET /api/friends/recommendations. The mock D1
// implements just enough of the self-join + NOT-IN-friendships +
// NOT-IN-blocks filters to drive the SQL shape exercised by the
// real prepared statement.

import { describe, expect, it, beforeEach } from "vitest";
import { recommendFriends } from "../src/api/friends";
import type { FriendsEnv } from "../src/api/friends";
import { signJWT } from "../src/utils/auth";

interface Participant { game_id: string; player_id: string; finished_at: number; }
interface Friendship  { a_id: string; b_id: string; }
interface Block       { blocker: string; blockee: string; }

class MockDb {
  participants: Participant[] = [];
  friendships:  Friendship[]  = [];
  blocks:       Block[]       = [];
  prepare(sql: string) { return new MockStmt(this, sql); }
}
class MockStmt {
  args: unknown[] = [];
  constructor(public db: MockDb, public sql: string) {}
  bind(...a: unknown[]) { this.args = a; return this; }
  async first<T = unknown>(): Promise<T | null> { return null; }
  async all<T = unknown>(): Promise<{ results: T[] }> {
    // Recommendation query has the distinctive `replay_participants mine
    // JOIN replay_participants theirs` shape.
    if (this.sql.includes("replay_participants mine") && this.sql.includes("replay_participants theirs")) {
      const me = this.args[0] as string;

      // Self-join over (game_id) — for every game `me` was in, list everyone else.
      const myGameIds = new Set(
        this.db.participants.filter(p => p.player_id === me).map(p => p.game_id),
      );

      const blockedSet = new Set([
        ...this.db.blocks.filter(b => b.blocker === me).map(b => b.blockee),
        ...this.db.blocks.filter(b => b.blockee === me).map(b => b.blocker),
      ]);
      const friendSet = new Set([
        ...this.db.friendships.filter(f => f.a_id === me).map(f => f.b_id),
        ...this.db.friendships.filter(f => f.b_id === me).map(f => f.a_id),
      ]);

      const counts = new Map<string, { together: number; last_at: number }>();
      for (const p of this.db.participants) {
        if (!myGameIds.has(p.game_id)) continue;
        if (p.player_id === me) continue;
        if (p.player_id.startsWith("BOT_") || p.player_id.startsWith("DELETED_")) continue;
        if (friendSet.has(p.player_id)) continue;
        if (blockedSet.has(p.player_id)) continue;
        const cur = counts.get(p.player_id) ?? { together: 0, last_at: 0 };
        cur.together += 1;
        if (p.finished_at > cur.last_at) cur.last_at = p.finished_at;
        counts.set(p.player_id, cur);
      }

      const out = Array.from(counts.entries())
        .map(([player_id, v]) => ({ player_id, together: v.together, last_at: v.last_at }))
        .sort((a, b) => b.together - a.together || b.last_at - a.last_at)
        .slice(0, 10);
      return { results: out as unknown as T[] };
    }
    return { results: [] };
  }
  async run() { return { success: true, meta: { changes: 0 } }; }
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
let env: FriendsEnv;

async function tokFor(p: string): Promise<string> { return signJWT(p, JWK, 3600); }
function authedReq(jwt: string): Request {
  return new Request("https://gw.local/api/friends/recommendations", {
    headers: { Authorization: `Bearer ${jwt}` },
  });
}

beforeEach(async () => {
  JWK = await makeKey();
  db  = new MockDb();
  env = { DB: db as unknown as D1Database, JWT_PRIVATE_JWK: JWK };
});

function seedGame(id: string, finishedAt: number, players: string[]): void {
  for (const p of players) db.participants.push({ game_id: id, player_id: p, finished_at: finishedAt });
}

describe("recommendFriends", () => {
  it("rejects unauthenticated", async () => {
    const r = await recommendFriends(new Request("https://gw/"), env);
    expect(r.status).toBe(401);
  });

  it("ranks by co-play count desc, recency tiebreak", async () => {
    seedGame("g1", 1000, ["alice", "bob",   "carol"]);
    seedGame("g2", 2000, ["alice", "bob",   "dave"]);
    seedGame("g3", 3000, ["alice", "carol", "ed"]);   // ed appears once but most recent
    const tok = await tokFor("alice");
    const body = await (await recommendFriends(authedReq(tok), env)).json() as {
      recommendations: { playerId: string; together: number }[];
    };
    // bob & carol both played twice; carol's most-recent shared game (g3,
    // 3000) is newer than bob's (g2, 2000) so the recency tiebreak ranks
    // carol first. ed (1 game @3000) > dave (1 game @2000) on recency.
    expect(body.recommendations.map(r => r.playerId)).toEqual(["carol", "bob", "ed", "dave"]);
    expect(body.recommendations[0]!.together).toBe(2);
  });

  it("excludes bots, tombstones, and self", async () => {
    seedGame("g1", 1000, ["alice", "BOT_alice_1", "DELETED_abc12345", "alice"]);
    const tok = await tokFor("alice");
    const body = await (await recommendFriends(authedReq(tok), env)).json() as { recommendations: unknown[] };
    expect(body.recommendations).toEqual([]);
  });

  it("excludes existing friends (any state)", async () => {
    seedGame("g1", 1000, ["alice", "bob", "carol"]);
    db.friendships.push({ a_id: "alice", b_id: "bob" });   // accepted
    db.friendships.push({ a_id: "alice", b_id: "carol" }); // pending — also excluded
    const tok = await tokFor("alice");
    const body = await (await recommendFriends(authedReq(tok), env)).json() as { recommendations: unknown[] };
    expect(body.recommendations).toEqual([]);
  });

  it("excludes blocked targets in either direction", async () => {
    seedGame("g1", 1000, ["alice", "bob", "carol"]);
    db.blocks.push({ blocker: "alice", blockee: "bob" });    // alice blocked bob
    db.blocks.push({ blocker: "carol", blockee: "alice" });  // carol blocked alice
    const tok = await tokFor("alice");
    const body = await (await recommendFriends(authedReq(tok), env)).json() as { recommendations: unknown[] };
    expect(body.recommendations).toEqual([]);
  });

  it("returns empty list when caller has never played a game", async () => {
    const tok = await tokFor("newcomer");
    const body = await (await recommendFriends(authedReq(tok), env)).json() as { recommendations: unknown[] };
    expect(body.recommendations).toEqual([]);
  });
});
