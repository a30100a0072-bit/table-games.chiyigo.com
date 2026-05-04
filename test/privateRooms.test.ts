// Handler-level tests for the private-rooms API. Mocks D1 (just the
// room_tokens table) and the GAME_ROOM DurableObjectNamespace so we
// can drive the create + resolve flow end-to-end.

import { describe, expect, it, beforeEach } from "vitest";
import { createPrivateRoom, resolvePrivateRoom } from "../src/api/privateRooms";
import type { PrivateRoomsEnv } from "../src/api/privateRooms";
import { signJWT } from "../src/utils/auth";

interface TokenRow {
  token: string; game_id: string; game_type: string;
  capacity: number; created_by: string;
  created_at: number; expires_at: number;
}

class MockDb {
  rows: TokenRow[] = [];
  prepare(sql: string) { return new MockStmt(this, sql); }
}

class MockStmt {
  private args: unknown[] = [];
  constructor(public db: MockDb, public sql: string) {}
  bind(...a: unknown[]) { this.args = a; return this; }

  async first<T = unknown>(): Promise<T | null> {
    if (this.sql.startsWith("SELECT") && this.sql.includes("FROM room_tokens WHERE token")) {
      const [tok] = this.args as [string];
      const r = this.db.rows.find(x => x.token === tok);
      return (r ? {
        game_id:    r.game_id,
        game_type:  r.game_type,
        capacity:   r.capacity,
        expires_at: r.expires_at,
      } : null) as T | null;
    }
    return null;
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO room_tokens")) {
      const [token, game_id, game_type, capacity, created_by, created_at, expires_at] =
        this.args as [string, string, string, number, string, number, number];
      this.db.rows.push({ token, game_id, game_type, capacity, created_by, created_at, expires_at });
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 0 } };
  }
}

let initCalls: { url: string; body: unknown }[] = [];
const okStub = {
  fetch: async (req: Request) => {
    const body = await req.json().catch(() => null);
    initCalls.push({ url: req.url, body });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  },
};
const failStub = {
  fetch: async () => new Response("nope", { status: 500 }),
};

function makeNs(stub: typeof okStub): DurableObjectNamespace {
  return {
    idFromName: (n: string) => ({ toString: () => n }),
    get: () => stub,
  } as unknown as DurableObjectNamespace;
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

let JWK: string;
let db:  MockDb;
let env: PrivateRoomsEnv;

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
  initCalls = [];
  env = {
    GAME_ROOM:       makeNs(okStub),
    DB:              db as unknown as D1Database,
    JWT_PRIVATE_JWK: JWK,
  };
});

describe("private rooms API", () => {
  it("rejects unauthenticated", async () => {
    const r = await createPrivateRoom(
      new Request("https://gw/", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }),
      env,
    );
    expect(r.status).toBe(401);
  });

  it("rejects bad gameType", async () => {
    const tok = await tokenFor("alice");
    const r = await createPrivateRoom(authedReq("POST", "/", tok, { gameType: "chess" }), env);
    expect(r.status).toBe(400);
  });

  it("rejects mahjong with capacity != 4", async () => {
    const tok = await tokenFor("alice");
    const r = await createPrivateRoom(authedReq("POST", "/", tok, { gameType: "mahjong", capacity: 3 }), env);
    expect(r.status).toBe(400);
  });

  it("create returns roomId + joinToken + expiresAt and persists a row", async () => {
    const tok = await tokenFor("alice");
    const r = await createPrivateRoom(authedReq("POST", "/", tok, { gameType: "bigTwo" }), env);
    expect(r.status).toBe(201);
    const body = await r.json() as {
      roomId: string; gameType: string; capacity: number; joinToken: string; expiresAt: number;
    };
    expect(body.gameType).toBe("bigTwo");
    expect(body.capacity).toBe(4);
    expect(body.joinToken).toMatch(/^[A-Za-z0-9_-]{20,24}$/);
    expect(body.expiresAt).toBeGreaterThan(Date.now());

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      token: body.joinToken, game_id: body.roomId,
      game_type: "bigTwo", capacity: 4, created_by: "alice",
    });

    // DO /init was called with the matching gameId.
    expect(initCalls).toHaveLength(1);
    expect(initCalls[0]!.url).toMatch(/\/init$/);
    expect((initCalls[0]!.body as { gameId: string }).gameId).toBe(body.roomId);
  });

  it("does NOT persist a token if DO init fails (no orphan tokens)", async () => {
    env.GAME_ROOM = makeNs(failStub as unknown as typeof okStub);
    const tok = await tokenFor("alice");
    const r = await createPrivateRoom(authedReq("POST", "/", tok, { gameType: "bigTwo" }), env);
    expect(r.status).toBe(500);
    expect(db.rows).toHaveLength(0);
  });

  it("clamps ttlMinutes into [5, 7d]", async () => {
    const tok = await tokenFor("alice");

    // Below floor
    const r1 = await createPrivateRoom(authedReq("POST", "/", tok, { gameType: "bigTwo", ttlMinutes: 1 }), env);
    const b1 = await r1.json() as { expiresAt: number };
    expect(b1.expiresAt - Date.now()).toBeGreaterThan(4 * 60 * 1000); // ≥ 5 min
    expect(b1.expiresAt - Date.now()).toBeLessThan(6 * 60 * 1000);

    // Above ceiling
    const r2 = await createPrivateRoom(authedReq("POST", "/", tok, { gameType: "bigTwo", ttlMinutes: 99999999 }), env);
    const b2 = await r2.json() as { expiresAt: number };
    expect(b2.expiresAt - Date.now()).toBeLessThan(8 * 24 * 60 * 60 * 1000); // ≤ 7 days +ε
  });

  it("resolve returns roomId + meta for a valid token", async () => {
    const tok = await tokenFor("alice");
    const c = await createPrivateRoom(authedReq("POST", "/", tok, { gameType: "texas" }), env);
    const cb = await c.json() as { joinToken: string; roomId: string };

    const r = await resolvePrivateRoom(authedReq("GET", "/", tok), env, cb.joinToken);
    expect(r.status).toBe(200);
    const body = await r.json() as { roomId: string; gameType: string };
    expect(body.roomId).toBe(cb.roomId);
    expect(body.gameType).toBe("texas");
  });

  it("resolve returns 404 for unknown token", async () => {
    const tok = await tokenFor("alice");
    const r = await resolvePrivateRoom(authedReq("GET", "/", tok), env, "no-such-token");
    expect(r.status).toBe(404);
  });

  it("resolve returns 410 for expired token", async () => {
    const tok = await tokenFor("alice");
    db.rows.push({
      token: "expired-tok", game_id: "g1", game_type: "bigTwo", capacity: 4,
      created_by: "alice", created_at: 0, expires_at: Date.now() - 1000,
    });
    const r = await resolvePrivateRoom(authedReq("GET", "/", tok), env, "expired-tok");
    expect(r.status).toBe(410);
  });
});
