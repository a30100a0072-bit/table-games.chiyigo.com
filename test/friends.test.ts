// Handler-level tests for the friends API. The mock D1 is purpose-built
// for the friendships table — it implements just enough SQL routing to
// exercise the api/friends.ts state transitions end-to-end.

import { describe, expect, it, beforeEach } from "vitest";
import {
  requestFriend, acceptFriend, declineFriend, unfriend, listFriends,
} from "../src/api/friends";
import type { FriendsEnv } from "../src/api/friends";
import { signJWT } from "../src/utils/auth";

interface FriendRow {
  a_id: string; b_id: string; requester: string;
  status: "pending" | "accepted";
  created_at: number;
  responded_at: number | null;
}

class MockDb {
  rows: FriendRow[]      = [];
  knownUsers = new Set<string>();    // userExists lookup

  prepare(sql: string) { return new MockStmt(this, sql); }
  batch() { throw new Error("not used"); }
}

class MockStmt {
  private args: unknown[] = [];
  constructor(public db: MockDb, public sql: string) {}
  bind(...a: unknown[]) { this.args = a; return this; }

  async first<T = unknown>(): Promise<T | null> {
    const sql = this.sql;
    if (sql.includes("FROM users WHERE player_id")) {
      const [pid] = this.args as [string];
      return (this.db.knownUsers.has(pid) ? { 1: 1 } : null) as T | null;
    }
    if (sql.includes("SELECT") && sql.includes("FROM friendships WHERE a_id = ? AND b_id = ?")) {
      const [a, b] = this.args as [string, string];
      const r = this.db.rows.find(x => x.a_id === a && x.b_id === b);
      return (r ?? null) as T | null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM friendships WHERE a_id = ? OR b_id = ?")) {
      const [me] = this.args as [string, string];
      const out = this.db.rows
        .filter(r => r.a_id === me || r.b_id === me)
        .sort((a, b) => b.created_at - a.created_at);
      return { results: out as unknown as T[] };
    }
    return { results: [] };
  }

  async run() {
    const sql = this.sql;

    if (sql.startsWith("INSERT INTO friendships")) {
      const [a, b, requester, created] = this.args as [string, string, string, number];
      this.db.rows.push({
        a_id: a, b_id: b, requester, status: "pending",
        created_at: created, responded_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (sql.startsWith("UPDATE friendships SET status = 'accepted'")) {
      const args = this.args as [number, string, string] | [number, string, string, string];
      const [respondedAt, a, b] = args;
      const guardPending = sql.includes("status = 'pending'");
      const r = this.db.rows.find(x => x.a_id === a && x.b_id === b);
      if (r && (!guardPending || r.status === "pending")) {
        r.status = "accepted";
        r.responded_at = respondedAt;
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }

    if (sql.startsWith("DELETE FROM friendships")) {
      const [a, b, ...rest] = this.args as [string, string, ...string[]];
      const before = this.db.rows.length;
      this.db.rows = this.db.rows.filter(x => {
        if (x.a_id !== a || x.b_id !== b) return true;
        if (sql.includes("status = 'pending' AND requester != ?")) {
          // decline — only delete if pending AND requester !== me (rest[0])
          return !(x.status === "pending" && x.requester !== rest[0]);
        }
        if (sql.includes("(status = 'accepted' OR (status = 'pending' AND requester = ?))")) {
          // unfriend / cancel-own-pending
          return !(x.status === "accepted" || (x.status === "pending" && x.requester === rest[0]));
        }
        return false;   // safety: drop
      });
      return { success: true, meta: { changes: before - this.db.rows.length } };
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
  jwk.kid = crypto.randomUUID();
  jwk.alg = "ES256";
  jwk.use = "sig";
  return JSON.stringify(jwk);
}

let db:  MockDb;
let env: FriendsEnv;
let JWK: string;

async function tokenFor(playerId: string): Promise<string> {
  return signJWT(playerId, JWK, 3600);
}

function authedReq(method: string, path: string, token: string, body?: unknown): Request {
  return new Request(`https://gw.local${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(async () => {
  JWK = await makeKey();
  db  = new MockDb();
  // Pre-register the test cast so userExists() lookups succeed.
  for (const u of ["alice", "bob", "carol"]) db.knownUsers.add(u);
  env = { DB: db as unknown as D1Database, JWT_PRIVATE_JWK: JWK };
});

describe("friends API", () => {
  it("rejects self-friend", async () => {
    const tok = await tokenFor("alice");
    const r = await requestFriend(authedReq("POST", "/api/friends/request", tok, { targetPlayerId: "alice" }), env);
    expect(r.status).toBe(400);
  });

  it("rejects unknown target", async () => {
    const tok = await tokenFor("alice");
    const r = await requestFriend(authedReq("POST", "/api/friends/request", tok, { targetPlayerId: "ghost" }), env);
    expect(r.status).toBe(404);
  });

  it("creates a pending row stored in canonical (a<b) order", async () => {
    const tok = await tokenFor("bob");   // bob asks alice; canonical row should be (alice, bob)
    const r   = await requestFriend(authedReq("POST", "/api/friends/request", tok, { targetPlayerId: "alice" }), env);
    expect(r.status).toBe(201);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ a_id: "alice", b_id: "bob", requester: "bob", status: "pending" });
  });

  it("auto-accepts when the other side already has a pending request", async () => {
    const aliceTok = await tokenFor("alice");
    const bobTok   = await tokenFor("bob");
    await requestFriend(authedReq("POST", "/api/friends/request", aliceTok, { targetPlayerId: "bob" }), env);
    expect(db.rows[0]?.status).toBe("pending");
    const r2 = await requestFriend(authedReq("POST", "/api/friends/request", bobTok, { targetPlayerId: "alice" }), env);
    const body = await r2.json() as { status: string };
    expect(r2.status).toBe(200);
    expect(body.status).toBe("accepted");
    expect(db.rows[0]?.status).toBe("accepted");
  });

  it("accept flips pending → accepted (only by the recipient)", async () => {
    const aliceTok = await tokenFor("alice");
    const bobTok   = await tokenFor("bob");
    await requestFriend(authedReq("POST", "/api/friends/request", aliceTok, { targetPlayerId: "bob" }), env);

    // alice (the requester) cannot accept her own request
    const selfAccept = await acceptFriend(authedReq("POST", "/", aliceTok), env, "bob");
    expect(selfAccept.status).toBe(409);

    // bob (the recipient) can
    const r = await acceptFriend(authedReq("POST", "/", bobTok), env, "alice");
    expect(r.status).toBe(200);
    expect(db.rows[0]?.status).toBe("accepted");
  });

  it("decline removes the pending row when called by the recipient", async () => {
    const aliceTok = await tokenFor("alice");
    const bobTok   = await tokenFor("bob");
    await requestFriend(authedReq("POST", "/api/friends/request", aliceTok, { targetPlayerId: "bob" }), env);

    // alice (requester) declining must be a no-op (decline is recipient-only)
    await declineFriend(authedReq("POST", "/", aliceTok), env, "bob");
    expect(db.rows).toHaveLength(1);

    // bob (recipient) declining drops the row
    await declineFriend(authedReq("POST", "/", bobTok), env, "alice");
    expect(db.rows).toHaveLength(0);
  });

  it("unfriend drops accepted rows from either side; pending only by requester", async () => {
    const aliceTok = await tokenFor("alice");
    const bobTok   = await tokenFor("bob");

    // pending: alice asks bob
    await requestFriend(authedReq("POST", "/api/friends/request", aliceTok, { targetPlayerId: "bob" }), env);
    // bob (non-requester) tries to "unfriend" the pending row → no change
    await unfriend(authedReq("DELETE", "/", bobTok), env, "alice");
    expect(db.rows).toHaveLength(1);
    // alice cancels her own pending → drops
    await unfriend(authedReq("DELETE", "/", aliceTok), env, "bob");
    expect(db.rows).toHaveLength(0);

    // accepted: re-add and confirm both sides can drop
    await requestFriend(authedReq("POST", "/api/friends/request", aliceTok, { targetPlayerId: "bob" }), env);
    await acceptFriend(authedReq("POST", "/", bobTok), env, "alice");
    expect(db.rows[0]?.status).toBe("accepted");
    await unfriend(authedReq("DELETE", "/", bobTok), env, "alice");
    expect(db.rows).toHaveLength(0);
  });

  it("list partitions rows into accepted / incoming / outgoing from the caller's POV", async () => {
    // Set up: alice ↔ bob accepted; alice → carol pending; bob → alice already accepted (above)
    const aliceTok = await tokenFor("alice");
    const bobTok   = await tokenFor("bob");
    await requestFriend(authedReq("POST", "/api/friends/request", aliceTok, { targetPlayerId: "bob" }), env);
    await acceptFriend(authedReq("POST", "/", bobTok), env, "alice");
    await requestFriend(authedReq("POST", "/api/friends/request", aliceTok, { targetPlayerId: "carol" }), env);

    const aliceList = await (await listFriends(authedReq("GET", "/", aliceTok), env)).json() as {
      accepted: { playerId: string }[]; incoming: { playerId: string }[]; outgoing: { playerId: string }[];
    };
    expect(aliceList.accepted.map(x => x.playerId)).toEqual(["bob"]);
    expect(aliceList.outgoing.map(x => x.playerId)).toEqual(["carol"]);
    expect(aliceList.incoming).toEqual([]);

    const carolTok = await tokenFor("carol");
    const carolList = await (await listFriends(authedReq("GET", "/", carolTok), env)).json() as {
      incoming: { playerId: string }[];
    };
    expect(carolList.incoming.map(x => x.playerId)).toEqual(["alice"]);
  });

  it("requesting again in same direction is rejected; idempotent accept", async () => {
    const aliceTok = await tokenFor("alice");
    const bobTok   = await tokenFor("bob");
    await requestFriend(authedReq("POST", "/api/friends/request", aliceTok, { targetPlayerId: "bob" }), env);
    const dup = await requestFriend(authedReq("POST", "/api/friends/request", aliceTok, { targetPlayerId: "bob" }), env);
    expect(dup.status).toBe(409);

    await acceptFriend(authedReq("POST", "/", bobTok), env, "alice");
    // Second accept after already accepted = idempotent 200, not 409.
    const r = await acceptFriend(authedReq("POST", "/", bobTok), env, "alice");
    expect(r.status).toBe(200);
  });

  it("rejects unauthenticated", async () => {
    const r = await listFriends(new Request("https://gw/", { method: "GET" }), env);
    expect(r.status).toBe(401);
  });
});
