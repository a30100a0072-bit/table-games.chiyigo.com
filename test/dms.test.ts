// Handler-level tests for the DM API. Mock D1 implements the dms +
// friendships subset needed to exercise sendDm / listInbox / unread.

import { describe, expect, it, beforeEach } from "vitest";
import { sendDm, listInbox, unreadDmCount } from "../src/api/dms";
import type { DmEnv } from "../src/api/dms";
import { signJWT } from "../src/utils/auth";

interface DmRow {
  id: number; sender: string; recipient: string;
  body: string; created_at: number; read_at: number | null;
}
interface FriendRow {
  a_id: string; b_id: string; status: "pending" | "accepted";
}

class MockDb {
  dms:        DmRow[]      = [];
  nextId      = 1;
  friendships: FriendRow[] = [];

  prepare(sql: string) { return new MockStmt(this, sql); }
  batch() { throw new Error("not used"); }
}

class MockStmt {
  private args: unknown[] = [];
  constructor(public db: MockDb, public sql: string) {}
  bind(...a: unknown[]) { this.args = a; return this; }

  async first<T = unknown>(): Promise<T | null> {
    const sql = this.sql;
    if (sql.includes("FROM friendships WHERE a_id = ? AND b_id = ? AND status = 'accepted'")) {
      const [a, b] = this.args as [string, string];
      const r = this.db.friendships.find(x =>
        x.a_id === a && x.b_id === b && x.status === "accepted");
      return (r ? { 1: 1 } : null) as T | null;
    }
    if (sql.includes("COUNT(*) AS n FROM dms")) {
      const [me, cutoff] = this.args as [string, number];
      const n = this.db.dms.filter(d =>
        d.recipient === me && d.read_at === null && d.created_at >= cutoff).length;
      return { n } as T;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    const sql = this.sql;
    if (sql.includes("FROM dms") && sql.includes("ORDER BY created_at ASC")) {
      // peer-filtered conversation
      const [cutoff, me, peer, peer2, me2] = this.args as [number, string, string, string, string];
      void peer2; void me2;
      const out = this.db.dms
        .filter(d => d.created_at >= cutoff &&
          ((d.sender === me && d.recipient === peer) ||
           (d.sender === peer && d.recipient === me)))
        .sort((a, b) => a.created_at - b.created_at);
      return { results: out as unknown as T[] };
    }
    if (sql.includes("FROM dms") && sql.includes("ORDER BY created_at DESC")) {
      const [cutoff, me] = this.args as [number, string, string];
      const out = this.db.dms
        .filter(d => d.created_at >= cutoff && (d.sender === me || d.recipient === me))
        .sort((a, b) => b.created_at - a.created_at);
      return { results: out as unknown as T[] };
    }
    return { results: [] };
  }

  async run() {
    const sql = this.sql;

    if (sql.startsWith("INSERT INTO dms")) {
      const [sender, recipient, body, created] = this.args as [string, string, string, number];
      const id = this.db.nextId++;
      this.db.dms.push({ id, sender, recipient, body, created_at: created, read_at: null });
      return { success: true, meta: { changes: 1, last_row_id: id } };
    }

    if (sql.startsWith("UPDATE dms SET read_at = ?") && sql.includes("AND sender = ?")) {
      const [readAt, me, peer, cutoff] = this.args as [number, string, string, number];
      let changes = 0;
      for (const d of this.db.dms) {
        if (d.recipient === me && d.sender === peer && d.read_at === null && d.created_at >= cutoff) {
          d.read_at = readAt;
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }

    if (sql.startsWith("UPDATE dms SET read_at = ?")) {
      const [readAt, me, cutoff] = this.args as [number, string, number];
      let changes = 0;
      for (const d of this.db.dms) {
        if (d.recipient === me && d.read_at === null && d.created_at >= cutoff) {
          d.read_at = readAt;
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
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
let env: DmEnv;
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

function canon(x: string, y: string): { a: string; b: string } {
  return x < y ? { a: x, b: y } : { a: y, b: x };
}

function makeFriends(db: MockDb, x: string, y: string) {
  const { a, b } = canon(x, y);
  db.friendships.push({ a_id: a, b_id: b, status: "accepted" });
}

beforeEach(async () => {
  JWK = await makeKey();
  db  = new MockDb();
  env = { DB: db as unknown as D1Database, JWT_PRIVATE_JWK: JWK };
});

describe("DM send", () => {
  it("rejects self-DM", async () => {
    const tok = await tokenFor("alice");
    const r = await sendDm(authedReq("POST", "/api/dm/send", tok, { to: "alice", body: "hi" }), env);
    expect(r.status).toBe(400);
  });

  it("rejects empty body after trim", async () => {
    makeFriends(db, "alice", "bob");
    const tok = await tokenFor("alice");
    const r = await sendDm(authedReq("POST", "/api/dm/send", tok, { to: "bob", body: "   " }), env);
    expect(r.status).toBe(400);
  });

  it("rejects body over 500 chars", async () => {
    makeFriends(db, "alice", "bob");
    const tok = await tokenFor("alice");
    const r = await sendDm(authedReq("POST", "/api/dm/send", tok, { to: "bob", body: "x".repeat(501) }), env);
    expect(r.status).toBe(413);
  });

  it("rejects sending to a non-friend", async () => {
    const tok = await tokenFor("alice");
    const r = await sendDm(authedReq("POST", "/api/dm/send", tok, { to: "bob", body: "hi" }), env);
    expect(r.status).toBe(403);
  });

  it("inserts a row when sender + recipient are accepted friends", async () => {
    makeFriends(db, "alice", "bob");
    const tok = await tokenFor("alice");
    const r = await sendDm(authedReq("POST", "/api/dm/send", tok, { to: "bob", body: "yo" }), env);
    expect(r.status).toBe(201);
    expect(db.dms).toHaveLength(1);
    expect(db.dms[0]!.sender).toBe("alice");
    expect(db.dms[0]!.recipient).toBe("bob");
    expect(db.dms[0]!.body).toBe("yo");
  });
});

describe("DM inbox + unread", () => {
  it("inbox returns msgs involving me, sorted DESC by default", async () => {
    makeFriends(db, "alice", "bob");
    const tok = await tokenFor("alice");
    await sendDm(authedReq("POST", "/api/dm/send", tok, { to: "bob", body: "first" }), env);
    await new Promise(r => setTimeout(r, 5));
    await sendDm(authedReq("POST", "/api/dm/send", tok, { to: "bob", body: "second" }), env);

    const r = await listInbox(authedReq("GET", "/api/dm/inbox", tok), env);
    const body = await r.json() as { messages: { body: string }[] };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]!.body).toBe("second");   // newest first
  });

  it("?with=peer returns ASC conversation only", async () => {
    makeFriends(db, "alice", "bob");
    makeFriends(db, "alice", "carol");
    const aliceTok = await tokenFor("alice");
    await sendDm(authedReq("POST", "/api/dm/send", aliceTok, { to: "bob",   body: "to-bob" }),   env);
    await sendDm(authedReq("POST", "/api/dm/send", aliceTok, { to: "carol", body: "to-carol" }), env);

    const r = await listInbox(authedReq("GET", "/api/dm/inbox?with=carol", aliceTok), env);
    const body = await r.json() as { messages: { body: string }[] };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.body).toBe("to-carol");
  });

  it("inbox marks recipient's unread messages as read", async () => {
    makeFriends(db, "alice", "bob");
    const aliceTok = await tokenFor("alice");
    await sendDm(authedReq("POST", "/api/dm/send", aliceTok, { to: "bob", body: "ping" }), env);
    expect(db.dms[0]!.read_at).toBeNull();

    const bobTok = await tokenFor("bob");
    await listInbox(authedReq("GET", "/api/dm/inbox", bobTok), env);
    expect(db.dms[0]!.read_at).not.toBeNull();
  });

  it("unread count drops to 0 after recipient pulls inbox", async () => {
    makeFriends(db, "alice", "bob");
    const aliceTok = await tokenFor("alice");
    await sendDm(authedReq("POST", "/api/dm/send", aliceTok, { to: "bob", body: "1" }), env);
    await sendDm(authedReq("POST", "/api/dm/send", aliceTok, { to: "bob", body: "2" }), env);

    const bobTok = await tokenFor("bob");
    const before = await (await unreadDmCount(authedReq("GET", "/api/dm/unread", bobTok), env)).json() as { unread: number };
    expect(before.unread).toBe(2);

    await listInbox(authedReq("GET", "/api/dm/inbox", bobTok), env);
    const after = await (await unreadDmCount(authedReq("GET", "/api/dm/unread", bobTok), env)).json() as { unread: number };
    expect(after.unread).toBe(0);
  });

  it("retention filter excludes msgs older than 7 days", async () => {
    makeFriends(db, "alice", "bob");
    // Manually insert an old row past the 7-day cutoff.
    db.dms.push({
      id: 999, sender: "alice", recipient: "bob",
      body: "ancient", created_at: Date.now() - 8 * 86_400_000, read_at: null,
    });
    const bobTok = await tokenFor("bob");
    const r = await listInbox(authedReq("GET", "/api/dm/inbox", bobTok), env);
    const body = await r.json() as { messages: unknown[] };
    expect(body.messages).toHaveLength(0);
  });
});
