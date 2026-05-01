// /test/liveRooms.test.ts
// LobbyDO live-room registry — register / unregister / list.

import { describe, expect, it, beforeEach } from "vitest";
import { LobbyDO } from "../src/api/lobby";
import type { LobbyEnv } from "../src/api/lobby";

class MockStorage {
  store = new Map<string, unknown>();
  async get<T = unknown>(key: string): Promise<T | undefined> { return this.store.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
  async deleteAll(): Promise<void> { this.store.clear(); }
  async setAlarm() {}
  async deleteAlarm() {}
}
class MockDoState {
  storage = new MockStorage();
  blockedOn: Promise<unknown> = Promise.resolve();
  blockConcurrencyWhile<T>(fn: () => T | Promise<T>): Promise<T> {
    const p = Promise.resolve(fn());
    this.blockedOn = p;
    return p;
  }
}

const env: LobbyEnv = {
  LOBBY_DO:        {} as DurableObjectNamespace,
  GAME_ROOM:       {} as DurableObjectNamespace,
  MATCH_KV:        {} as KVNamespace,
  DB:              {} as D1Database,
  JWT_PRIVATE_JWK: "{}",
};

let store: MockDoState;
beforeEach(() => { store = new MockDoState(); });

function makeDO(): LobbyDO {
  return new LobbyDO(store as unknown as DurableObjectState, env);
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://l.local${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("LobbyDO live-room registry", () => {
  it("registers a live room and returns it from /live", async () => {
    const lobby = makeDO();
    await lobby.fetch(req("POST", "/register-live", {
      roomId: "room-1", gameType: "bigTwo", playerCount: 3, capacity: 4, startedAt: 1000,
    }));
    const list = await (await lobby.fetch(req("GET", "/live"))).json() as { rooms: unknown[] };
    expect(list.rooms).toHaveLength(1);
    expect((list.rooms[0] as { roomId: string }).roomId).toBe("room-1");
  });

  it("unregister removes a previously registered room", async () => {
    const lobby = makeDO();
    await lobby.fetch(req("POST", "/register-live", {
      roomId: "room-1", gameType: "texas", playerCount: 4, capacity: 4, startedAt: 1000,
    }));
    await lobby.fetch(req("POST", "/unregister-live", { roomId: "room-1" }));
    const list = await (await lobby.fetch(req("GET", "/live"))).json() as { rooms: unknown[] };
    expect(list.rooms).toHaveLength(0);
  });

  it("rejects payload without roomId or with bad gameType", async () => {
    const lobby = makeDO();
    expect((await lobby.fetch(req("POST", "/register-live", { gameType: "bigTwo" }))).status).toBe(400);
    expect((await lobby.fetch(req("POST", "/register-live", { roomId: "x", gameType: "zelda" }))).status).toBe(400);
    expect((await lobby.fetch(req("POST", "/unregister-live", {}))).status).toBe(400);
  });

  it("re-registering the same roomId overwrites the entry (no duplicates)", async () => {
    const lobby = makeDO();
    await lobby.fetch(req("POST", "/register-live", {
      roomId: "room-1", gameType: "bigTwo", playerCount: 1, capacity: 4, startedAt: 1000,
    }));
    await lobby.fetch(req("POST", "/register-live", {
      roomId: "room-1", gameType: "bigTwo", playerCount: 4, capacity: 4, startedAt: 2000,
    }));
    const list = await (await lobby.fetch(req("GET", "/live"))).json() as { rooms: { playerCount: number }[] };
    expect(list.rooms).toHaveLength(1);
    expect(list.rooms[0]!.playerCount).toBe(4);
  });

  it("registry survives a fresh DO instance via persisted storage", async () => {
    const a = makeDO();
    await store.blockedOn;
    await a.fetch(req("POST", "/register-live", {
      roomId: "persisted", gameType: "mahjong", playerCount: 2, capacity: 4, startedAt: 5000,
    }));
    // Same store, new instance — hydrate path must restore liveRooms.
    const b = makeDO();
    await store.blockedOn;   // wait for the new instance's hydrate to settle
    const list = await (await b.fetch(req("GET", "/live"))).json() as { rooms: { roomId: string }[] };
    expect(list.rooms.find(r => r.roomId === "persisted")).toBeDefined();
  });
});
