// /test/account.test.ts
// Handler-level tests for DELETE /api/me. The mock D1 records every
// statement so we can prove which rows got deleted vs anonymised, and
// in the right order.

import { describe, expect, it, beforeEach } from "vitest";
import { deleteAccount, TOMBSTONE_PREFIX } from "../src/api/account";
import type { AccountEnv } from "../src/api/account";
import { signJWT } from "../src/utils/auth";

type Stmt = { sql: string; args: unknown[] };

class MockDb {
  statements: Stmt[] = [];
  prepare(sql: string) { return new MockStmt(this, sql); }
  async batch(stmts: MockStmt[]) {
    for (const s of stmts) this.statements.push({ sql: s.sql, args: s.args });
    return stmts.map(() => ({ success: true }));
  }
}
class MockStmt {
  args: unknown[] = [];
  constructor(public db: MockDb, public sql: string) {}
  bind(...a: unknown[]) { this.args = a; return this; }
  async first() { return null; }
  async run() { return { success: true, meta: { changes: 1 } }; }
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
let env: AccountEnv;
let JWK: string;

async function tokenFor(playerId: string): Promise<string> {
  return signJWT(playerId, JWK, 3600);
}

function deleteReq(token: string, withConfirm = true): Request {
  return new Request("https://gw.local/api/me", {
    method: "DELETE",
    headers: {
      "Authorization":     `Bearer ${token}`,
      ...(withConfirm ? { "X-Confirm-Delete": "yes" } : {}),
    },
  });
}

beforeEach(async () => {
  JWK = await makeKey();
  db  = new MockDb();
  env = { DB: db as unknown as D1Database, JWT_PRIVATE_JWK: JWK };
});

describe("DELETE /api/me", () => {
  it("rejects without confirmation header even with a valid token", async () => {
    const tok = await tokenFor("alice");
    const r = await deleteAccount(deleteReq(tok, false), env);
    expect(r.status).toBe(400);
    expect(db.statements).toHaveLength(0);     // nothing should have run
  });

  it("rejects without authorization", async () => {
    const r = await deleteAccount(new Request("https://gw.local/api/me", { method: "DELETE" }), env);
    expect(r.status).toBe(401);
  });

  it("happy path: hard-deletes friendships / dms / invites / tokens / users", async () => {
    const tok = await tokenFor("alice");
    const r = await deleteAccount(deleteReq(tok), env);
    expect(r.status).toBe(200);
    const sqls = db.statements.map(s => s.sql);
    expect(sqls.some(s => s.startsWith("DELETE FROM friendships"))).toBe(true);
    expect(sqls.some(s => s.startsWith("DELETE FROM dms"))).toBe(true);
    expect(sqls.some(s => s.startsWith("DELETE FROM room_invites"))).toBe(true);
    expect(sqls.some(s => s.startsWith("DELETE FROM room_tokens"))).toBe(true);
    expect(sqls.some(s => s.startsWith("DELETE FROM users"))).toBe(true);
  });

  it("happy path: anonymises ledger / settlements / games / tournaments / replays", async () => {
    const tok = await tokenFor("alice");
    await deleteAccount(deleteReq(tok), env);
    const updates = db.statements.filter(s => s.sql.startsWith("UPDATE"));
    const tables  = updates.map(s => s.sql.split(" ")[1]);
    expect(tables).toEqual(expect.arrayContaining([
      "chip_ledger", "player_settlements", "games", "tournament_entries", "replay_meta",
    ]));
    // Most UPDATEs bind (tomb, me); replay_meta is the odd one out because
    // it does a JSON-quoted REPLACE with a different arg order. Pin the
    // tombstone shape via the first row, then sanity-check the others.
    const tomb = updates[0]!.args[0] as string;
    expect(tomb.startsWith(TOMBSTONE_PREFIX)).toBe(true);
    for (const u of updates) {
      const found = u.args.some(a => typeof a === "string" && a.includes(tomb));
      expect(found).toBe(true);
    }
  });

  it("returns the tombstone in the response so audit logs can correlate", async () => {
    const tok = await tokenFor("alice");
    const r = await deleteAccount(deleteReq(tok), env);
    const body = await r.json() as { tombstone: string; ok: boolean };
    expect(body.ok).toBe(true);
    expect(body.tombstone.startsWith(TOMBSTONE_PREFIX)).toBe(true);
    expect(body.tombstone.length).toBeGreaterThan(TOMBSTONE_PREFIX.length);
  });

  it("replay_meta UPDATE uses JSON-quoted IDs to avoid substring collisions", async () => {
    // If we replaced raw "alice" we'd accidentally rewrite "alice2"; the
    // canonical JSON form ("alice") prevents that.
    const tok = await tokenFor("alice");
    await deleteAccount(deleteReq(tok), env);
    const replayUpdate = db.statements.find(s => s.sql.includes("replay_meta"));
    expect(replayUpdate).toBeTruthy();
    expect(replayUpdate!.args[0]).toBe('"alice"');
    // The LIKE pattern at index 2 must include the JSON-quoted form too.
    expect(replayUpdate!.args[2]).toBe('%"alice"%');
  });
});
