// Handler-level tests for room_invites API. Mocks D1 with just enough
// SQL routing for friendships + room_tokens + room_invites lookups so
// invite / list / decline can be exercised end-to-end.

import { describe, expect, it, beforeEach } from "vitest";
import { inviteToRoom, listInvites, declineInvite } from "../src/api/roomInvites";
import type { RoomInvitesEnv } from "../src/api/roomInvites";
import { signJWT } from "../src/utils/auth";

interface InviteRow {
  id: number; inviter: string; invitee: string; token: string;
  game_type: string; created_at: number; expires_at: number;
  status: "pending" | "declined"; responded_at: number | null;
}
interface TokenRow {
  token: string; game_id: string; game_type: string;
  capacity: number; created_by: string;
  created_at: number; expires_at: number;
}
interface FriendRow {
  a_id: string; b_id: string; status: "pending" | "accepted";
}

class MockDb {
  invites: InviteRow[]    = [];
  tokens:  TokenRow[]     = [];
  friends: FriendRow[]    = [];
  nextId = 1;
  prepare(sql: string) { return new MockStmt(this, sql); }
}

class MockStmt {
  private args: unknown[] = [];
  constructor(public db: MockDb, public sql: string) {}
  bind(...a: unknown[]) { this.args = a; return this; }

  async first<T = unknown>(): Promise<T | null> {
    const sql = this.sql;
    if (sql.includes("FROM friendships WHERE a_id = ? AND b_id = ?")) {
      const [a, b] = this.args as [string, string];
      const r = this.db.friends.find(x => x.a_id === a && x.b_id === b && x.status === "accepted");
      return (r ? { 1: 1 } : null) as T | null;
    }
    if (sql.includes("FROM room_tokens WHERE token = ?")) {
      const [t] = this.args as [string];
      const r = this.db.tokens.find(x => x.token === t);
      return (r ? { game_type: r.game_type, expires_at: r.expires_at } : null) as T | null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM room_invites") && this.sql.includes("invitee = ?")) {
      const [me, now] = this.args as [string, number];
      const out = this.db.invites
        .filter(r => r.invitee === me && r.status === "pending" && r.expires_at > now)
        .sort((a, b) => b.created_at - a.created_at);
      return { results: out as unknown as T[] };
    }
    return { results: [] };
  }

  async run() {
    const sql = this.sql;
    if (sql.startsWith("INSERT OR IGNORE INTO room_invites")) {
      const [inviter, invitee, token, game_type, created_at, expires_at] =
        this.args as [string, string, string, string, number, number];
      const dup = this.db.invites.find(r =>
        r.inviter === inviter && r.invitee === invitee && r.token === token,
      );
      if (dup) return { success: true, meta: { changes: 0 } };
      this.db.invites.push({
        id: this.db.nextId++, inviter, invitee, token, game_type,
        created_at, expires_at, status: "pending", responded_at: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.startsWith("UPDATE room_invites SET status = 'declined'")) {
      const [responded_at, id, invitee] = this.args as [number, number, string];
      const r = this.db.invites.find(x => x.id === id && x.invitee === invitee && x.status === "pending");
      if (r) { r.status = "declined"; r.responded_at = responded_at; return { success: true, meta: { changes: 1 } }; }
      return { success: true, meta: { changes: 0 } };
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
let env: RoomInvitesEnv;

async function tokFor(pid: string): Promise<string> { return signJWT(pid, JWK, 3600); }

function authedReq(method: string, path: string, jwt: string, body?: unknown): Request {
  return new Request(`https://gw.local${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${jwt}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function seed() {
  // alice ↔ bob accepted; carol unrelated.
  db.friends.push({ a_id: "alice", b_id: "bob", status: "accepted" });
  // alice owns a private-room token.
  db.tokens.push({
    token: "tok-alice",
    game_id: "g1", game_type: "bigTwo", capacity: 4,
    created_by: "alice", created_at: 0, expires_at: Date.now() + 3600_000,
  });
  // an already-expired token, still in DB.
  db.tokens.push({
    token: "tok-stale",
    game_id: "g2", game_type: "bigTwo", capacity: 4,
    created_by: "alice", created_at: 0, expires_at: Date.now() - 1000,
  });
}

beforeEach(async () => {
  JWK = await makeKey();
  db  = new MockDb();
  env = { DB: db as unknown as D1Database, JWT_PRIVATE_JWK: JWK };
  seed();
});

describe("room invites API", () => {
  it("rejects unauthenticated", async () => {
    const r = await listInvites(new Request("https://gw/", { method: "GET" }), env);
    expect(r.status).toBe(401);
  });

  it("rejects self-invite", async () => {
    const t = await tokFor("alice");
    const r = await inviteToRoom(authedReq("POST", "/", t, { friendPlayerId: "alice", joinToken: "tok-alice" }), env);
    expect(r.status).toBe(400);
  });

  it("rejects invite to non-friend", async () => {
    const t = await tokFor("alice");
    const r = await inviteToRoom(authedReq("POST", "/", t, { friendPlayerId: "carol", joinToken: "tok-alice" }), env);
    expect(r.status).toBe(403);
  });

  it("rejects invite for unknown token (404) and expired token (410)", async () => {
    const t = await tokFor("alice");
    const r1 = await inviteToRoom(authedReq("POST", "/", t, { friendPlayerId: "bob", joinToken: "ghost" }), env);
    expect(r1.status).toBe(404);
    const r2 = await inviteToRoom(authedReq("POST", "/", t, { friendPlayerId: "bob", joinToken: "tok-stale" }), env);
    expect(r2.status).toBe(410);
  });

  it("happy path: invite → row exists; list returns it for invitee", async () => {
    const aliceTok = await tokFor("alice");
    const bobTok   = await tokFor("bob");
    const r = await inviteToRoom(authedReq("POST", "/", aliceTok, { friendPlayerId: "bob", joinToken: "tok-alice" }), env);
    expect(r.status).toBe(201);
    expect(db.invites).toHaveLength(1);

    const list = await (await listInvites(authedReq("GET", "/", bobTok), env)).json() as {
      invites: { inviter: string; gameType: string; joinToken: string }[];
    };
    expect(list.invites).toHaveLength(1);
    expect(list.invites[0]).toMatchObject({
      inviter: "alice", gameType: "bigTwo", joinToken: "tok-alice",
    });

    // Alice should NOT see bob's incoming list (it's hers as inviter).
    const aliceList = await (await listInvites(authedReq("GET", "/", aliceTok), env)).json() as { invites: unknown[] };
    expect(aliceList.invites).toHaveLength(0);
  });

  it("re-inviting same friend to same room is a no-op (UNIQUE)", async () => {
    const aliceTok = await tokFor("alice");
    await inviteToRoom(authedReq("POST", "/", aliceTok, { friendPlayerId: "bob", joinToken: "tok-alice" }), env);
    await inviteToRoom(authedReq("POST", "/", aliceTok, { friendPlayerId: "bob", joinToken: "tok-alice" }), env);
    expect(db.invites).toHaveLength(1);
  });

  it("decline flips status; subsequent decline is idempotent", async () => {
    const aliceTok = await tokFor("alice");
    const bobTok   = await tokFor("bob");
    await inviteToRoom(authedReq("POST", "/", aliceTok, { friendPlayerId: "bob", joinToken: "tok-alice" }), env);
    const id = db.invites[0]!.id;

    const r1 = await declineInvite(authedReq("POST", "/", bobTok), env, String(id));
    expect(r1.status).toBe(200);
    expect(db.invites[0]!.status).toBe("declined");

    // Second decline still 200 — UPDATE just changes 0 rows.
    const r2 = await declineInvite(authedReq("POST", "/", bobTok), env, String(id));
    expect(r2.status).toBe(200);

    // List for bob now empty.
    const list = await (await listInvites(authedReq("GET", "/", bobTok), env)).json() as { invites: unknown[] };
    expect(list.invites).toHaveLength(0);
  });

  it("only the invitee can decline (alice can't decline her own outgoing)", async () => {
    const aliceTok = await tokFor("alice");
    await inviteToRoom(authedReq("POST", "/", aliceTok, { friendPlayerId: "bob", joinToken: "tok-alice" }), env);
    const id = db.invites[0]!.id;

    await declineInvite(authedReq("POST", "/", aliceTok), env, String(id));
    expect(db.invites[0]!.status).toBe("pending");
  });

  it("list filters out expired invites at read time", async () => {
    db.invites.push({
      id: db.nextId++, inviter: "alice", invitee: "bob", token: "tok-stale",
      game_type: "bigTwo", created_at: Date.now() - 7200_000,
      expires_at: Date.now() - 1000, status: "pending", responded_at: null,
    });
    const bobTok = await tokFor("bob");
    const list = await (await listInvites(authedReq("GET", "/", bobTok), env)).json() as { invites: unknown[] };
    expect(list.invites).toHaveLength(0);
  });

  it("decline rejects bad id", async () => {
    const tok = await tokFor("bob");
    const r = await declineInvite(authedReq("POST", "/", tok), env, "abc");
    expect(r.status).toBe(400);
  });
});
