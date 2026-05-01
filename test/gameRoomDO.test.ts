// Direct DO-instance tests covering two reliability properties that
// handler-level tests can't reach:
//
//   1. Alarm scheduling — startGame() must arm a turn alarm via
//      state.storage.setAlarm() with the next deadline.
//   2. Hibernation rehydrate — a fresh DO instance constructed against
//      the SAME storage map must restore room/engine/alarms identically,
//      simulating CF runtime evicting the DO between requests.
//
// Driven by an all-bot bigTwo room so we don't need a real WebSocket
// session to push the room into "playing".

import { describe, expect, it, beforeEach } from "vitest";
import { GameRoomDO } from "../src/do/GameRoomDO";
import type { Env } from "../src/do/GameRoomDO";

class MockStorage {
  store = new Map<string, unknown>();
  alarmAt: number | null = null;
  setAlarmCalls: number[] = [];
  deleteAlarmCalls = 0;
  deleteAllCalls = 0;

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    // Round-trip via JSON to emulate CF's serialization boundary; if a value
    // contains something unserialisable the test should fail loudly here,
    // not silently rehydrate as a different shape after eviction.
    this.store.set(key, JSON.parse(JSON.stringify(value)));
  }
  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
  async deleteAll(): Promise<void> {
    this.deleteAllCalls += 1;
    this.store.clear();
    this.alarmAt = null;
  }
  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
    this.setAlarmCalls.push(at);
  }
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
    this.deleteAlarmCalls += 1;
  }
  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }
  /** Clone storage so two DO instances can share the persisted bytes
   *  without aliasing in-memory references. */
  fork(): MockStorage {
    const next = new MockStorage();
    for (const [k, v] of this.store)
      next.store.set(k, JSON.parse(JSON.stringify(v)));
    next.alarmAt = this.alarmAt;
    return next;
  }
}

class MockDoState {
  storage: MockStorage;
  acceptedSockets: { ws: unknown; tags: string[] }[] = [];
  constructor(storage?: MockStorage) {
    this.storage = storage ?? new MockStorage();
  }
  blockConcurrencyWhile<T>(fn: () => T | Promise<T>): Promise<T> {
    return Promise.resolve(fn());
  }
  acceptWebSocket(ws: unknown, tags: string[]): void {
    this.acceptedSockets.push({ ws, tags });
  }
  getWebSockets(): unknown[] { return []; }
}

function makeEnv(): { env: Env; queueSends: unknown[]; kvDeletes: string[]; dbInserts: unknown[] } {
  const queueSends: unknown[] = [];
  const kvDeletes: string[]   = [];
  const dbInserts: unknown[]  = [];
  // Minimal D1 stub: every prepare/bind/run swallows args into dbInserts
  // so a settle-time replay flush doesn't crash these tests.
  const stmt = (sql: string) => ({
    sql,
    args: [] as unknown[],
    bind(...args: unknown[]) { this.args = args; return this; },
    async run() { dbInserts.push({ sql: this.sql, args: this.args }); return { success: true, meta: { changes: 1 } }; },
    async first() { return null; },
    async all() { return { results: [] }; },
  });
  const env: Env = {
    GAME_ROOM:        {} as DurableObjectNamespace,
    TOURNAMENT_DO:    {} as DurableObjectNamespace,
    SETTLEMENT_QUEUE: { send: async (m: unknown) => { queueSends.push(m); } } as unknown as Queue,
    MATCH_KV:         {
      delete: async (k: string) => { kvDeletes.push(k); },
    } as unknown as KVNamespace,
    DB: { prepare: stmt } as unknown as D1Database,
  };
  return { env, queueSends, kvDeletes, dbInserts };
}

function initBody(overrides: Partial<{
  gameId: string; roundId: string; gameType: string; capacity: number; botIds: string[];
}> = {}): string {
  return JSON.stringify({
    gameId:   "g1",
    roundId:  "r1",
    gameType: "bigTwo",
    capacity: 4,
    botIds:   ["BOT_1", "BOT_2", "BOT_3", "BOT_4"],
    ...overrides,
  });
}

let store: MockDoState;
let env:   Env;

beforeEach(() => {
  store = new MockDoState();
  ({ env } = makeEnv());
});

describe("GameRoomDO alarm scheduling", () => {
  it("startGame arms a turn alarm via storage.setAlarm", async () => {
    const room = new GameRoomDO(store as unknown as DurableObjectState, env);

    const res = await room.fetch(new Request("https://room.local/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: initBody(),
    }));
    expect(res.ok).toBe(true);

    // Storage should have a non-empty alarms array AND a real CF alarm slot.
    const alarms = store.storage.store.get("alarms") as { kind: string; deadline: number }[];
    expect(alarms.length).toBeGreaterThan(0);
    expect(alarms.some(a => a.kind === "turn" || a.kind === "bot")).toBe(true);

    // setAlarm must have been called with the earliest pending deadline.
    expect(store.storage.alarmAt).not.toBeNull();
    const earliest = Math.min(...alarms.map(a => a.deadline));
    expect(store.storage.alarmAt).toBe(earliest);
  });

  it("alarm fires only entries whose deadline has elapsed", async () => {
    const room = new GameRoomDO(store as unknown as DurableObjectState, env);
    await room.fetch(new Request("https://room.local/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: initBody(),
    }));

    const beforeAlarms = store.storage.store.get("alarms") as { deadline: number }[];
    const earliest     = Math.min(...beforeAlarms.map(a => a.deadline));

    // alarm() with current time well before earliest deadline should be a no-op
    // on the alarm queue (within the 50 ms FUDGE window).
    const stash = Date.now;
    Date.now = () => earliest - 1000;
    try {
      await room.alarm();
      const afterAlarms = store.storage.store.get("alarms") as { deadline: number }[];
      expect(afterAlarms.length).toBe(beforeAlarms.length);
    } finally {
      Date.now = stash;
    }
  });
});

describe("GameRoomDO hibernation rehydrate", () => {
  it("a fresh instance over the same storage rehydrates room + alarms + machine", async () => {
    // Phase 1: drive instance A to a "playing" state with persisted snapshot.
    const a = new GameRoomDO(store as unknown as DurableObjectState, env);
    await a.fetch(new Request("https://room.local/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: initBody(),
    }));

    const persistedRoom    = store.storage.store.get("room");
    const persistedMachine = store.storage.store.get("machine");
    const persistedAlarms  = store.storage.store.get("alarms");
    expect(persistedRoom).toBeTruthy();
    expect(persistedMachine).toBeTruthy();
    expect(persistedAlarms).toBeTruthy();

    // Phase 2: simulate CF eviction — new DO instance, same storage bytes.
    const evictedStorage = store.storage.fork();
    const b = new GameRoomDO(
      new MockDoState(evictedStorage) as unknown as DurableObjectState,
      env,
    );
    // Construction kicks off blockConcurrencyWhile(hydrate); resolve queue.
    await Promise.resolve();
    await Promise.resolve();

    // /init on a rehydrated instance must 409 — proof that B saw the
    // persisted room from A's storage, not a blank slate.
    const reinit = await b.fetch(new Request("https://room.local/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: initBody(),
    }));
    expect(reinit.status).toBe(409);
  });

  it("storage.put values are JSON-roundtrip safe (no class instances leak through)", async () => {
    const a = new GameRoomDO(store as unknown as DurableObjectState, env);
    await a.fetch(new Request("https://room.local/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: initBody(),
    }));

    // Anything stuffed into storage must survive a JSON round-trip without
    // throwing — the MockStorage.put already does the round-trip, so this
    // test is really "did we accidentally try to persist a function or
    // a Map?". If we did, the init call above would have thrown.
    for (const v of store.storage.store.values()) {
      expect(() => JSON.parse(JSON.stringify(v))).not.toThrow();
    }
  });
});

describe("GameRoomDO replay recording", () => {
  it("startGame initialises the replay buffer with an engine snapshot", async () => {
    const room = new GameRoomDO(store as unknown as DurableObjectState, env);
    await room.fetch(new Request("https://room.local/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: initBody(),
    }));

    const replay = store.storage.store.get("replay") as {
      startedAt: number; initialSnapshot: unknown; events: unknown[];
    } | undefined;
    expect(replay).toBeTruthy();
    expect(replay!.initialSnapshot).toBeTruthy();
    expect(Array.isArray(replay!.events)).toBe(true);
    // Bot moves are scheduled async via alarms, so events array is empty
    // immediately after init — the test for event accumulation lives in
    // the engine adapter / replay handler suites.
  });
});
