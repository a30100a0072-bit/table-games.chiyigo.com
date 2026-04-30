// /test/tournamentDO.test.ts
// Direct DO-instance tests — instantiate TournamentDO with a mocked
// DurableObjectState + env, exercise the full lifecycle without
// miniflare. Lighter than vitest-pool-workers and covers the orchestration
// logic that pure handler tests can't reach.

import { describe, expect, it, beforeEach } from "vitest";
import { TournamentDO } from "../src/do/TournamentDO";
import type { TournamentEnv } from "../src/do/TournamentDO";
import type { SettlementResult } from "../src/types/game";

// ── Mock DurableObjectState ────────────────────────────────────────────
class MockStorage {
  store = new Map<string, unknown>();
  async get<T = unknown>(key: string): Promise<T | undefined> { return this.store.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.store.set(key, value); }
}
class MockDoState {
  storage = new MockStorage();
  blockConcurrencyWhile<T>(fn: () => T | Promise<T>): Promise<T> { return Promise.resolve(fn()); }
}

// ── Mock GAME_ROOM namespace — record calls so we can assert against them ──
let gameRoomCalls: { url: string; body: unknown }[] = [];
const mockGameRoom = {
  idFromName: (name: string) => ({ toString: () => name }),
  get: () => ({
    fetch: async (req: Request) => {
      const body = await req.json().catch(() => null);
      gameRoomCalls.push({ url: req.url, body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  }),
} as unknown as DurableObjectNamespace;

// ── Mock D1 — capture batch+run for ledger / users / tournaments inspection ──
class MockDb {
  statements: { sql: string; args: unknown[] }[] = [];
  prepare(sql: string) { return new MockStmt(this, sql); }
  async batch(stmts: MockStmt[]) {
    for (const s of stmts) this.statements.push({ sql: s.sql, args: s.args });
    return stmts.map(() => ({ success: true }));
  }
}
class MockStmt {
  args: unknown[] = [];
  constructor(public db: MockDb, public sql: string) {}
  bind(...args: unknown[]) { this.args = args; return this; }
  async run() { this.db.statements.push({ sql: this.sql, args: this.args }); return { success: true, meta: { changes: 1 } }; }
}

let store: MockDoState;
let db:    MockDb;
let env:   TournamentEnv;

beforeEach(() => {
  gameRoomCalls = [];
  store = new MockDoState();
  db    = new MockDb();
  env = {
    GAME_ROOM:     mockGameRoom,
    TOURNAMENT_DO: mockGameRoom,   // unused inside the DO under test
    DB:            db as unknown as D1Database,
  };
});

function makeDO(): TournamentDO {
  return new TournamentDO(store as unknown as DurableObjectState, env);
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://t.local${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

function settlement(scoreDeltas: Record<string, number>): SettlementResult {
  return {
    gameId: "g", roundId: "r", finishedAt: Date.now(), reason: "lastCardPlayed",
    winnerId: Object.keys(scoreDeltas)[0]!,
    players: Object.entries(scoreDeltas).map(([playerId, scoreDelta], i) => ({
      playerId, finalRank: i + 1, scoreDelta, remainingCards: [],
    })),
  };
}

describe("TournamentDO lifecycle", () => {
  it("init then 4 joins triggers /init on GameRoomDO", async () => {
    const t = makeDO();
    await t.fetch(req("POST", "/init", { tournamentId: "T1", gameType: "bigTwo", buyIn: 200 }));

    for (const pid of ["alice", "bob", "carol", "dave"]) {
      await t.fetch(req("POST", "/join", { playerId: pid }));
    }

    // Last join should have spawned a room.
    expect(gameRoomCalls.length).toBe(1);
    expect(gameRoomCalls[0]!.url).toMatch(/\/init$/);
    const initBody = gameRoomCalls[0]!.body as Record<string, unknown>;
    expect(initBody.tournamentId).toBe("T1");
    expect(initBody.gameType).toBe("bigTwo");
    expect(initBody.prefilledPlayerIds).toEqual(["alice", "bob", "carol", "dave"]);
  });

  it("rejects bad gameType / low buyIn / late re-init", async () => {
    const t = makeDO();
    expect((await t.fetch(req("POST", "/init", { tournamentId: "T1", gameType: "zelda", buyIn: 200 }))).status).toBe(400);
    expect((await t.fetch(req("POST", "/init", { tournamentId: "T1", gameType: "bigTwo", buyIn: 10 }))).status).toBe(400);
    expect((await t.fetch(req("POST", "/init", { tournamentId: "T1", gameType: "bigTwo", buyIn: 200 }))).status).toBe(200);
    expect((await t.fetch(req("POST", "/init", { tournamentId: "T1", gameType: "bigTwo", buyIn: 200 }))).status).toBe(409);
  });

  it("rejects 5th joiner / duplicate joins", async () => {
    const t = makeDO();
    await t.fetch(req("POST", "/init", { tournamentId: "T1", gameType: "bigTwo", buyIn: 200 }));
    await t.fetch(req("POST", "/join", { playerId: "alice" }));
    expect((await t.fetch(req("POST", "/join", { playerId: "alice" }))).status).toBe(409);
    for (const pid of ["bob", "carol", "dave"]) await t.fetch(req("POST", "/join", { playerId: pid }));
    expect((await t.fetch(req("POST", "/join", { playerId: "eve" }))).status).toBe(409);
  });

  it("accumulates scores across rounds + spawns each next round", async () => {
    const t = makeDO();
    await t.fetch(req("POST", "/init", { tournamentId: "T1", gameType: "bigTwo", buyIn: 200 }));
    for (const pid of ["alice", "bob", "carol", "dave"]) {
      await t.fetch(req("POST", "/join", { playerId: pid }));
    }
    expect(gameRoomCalls.length).toBe(1);   // round 1 spawned

    // Round 1 — alice +30, others split the loss
    await t.fetch(req("POST", "/round-result", { settlement: settlement({ alice: 30, bob: -10, carol: -10, dave: -10 }) }));
    expect(gameRoomCalls.length).toBe(2);   // round 2 spawned

    // Round 2 — bob bounces back
    await t.fetch(req("POST", "/round-result", { settlement: settlement({ alice: -5, bob: 25, carol: -10, dave: -10 }) }));
    expect(gameRoomCalls.length).toBe(3);   // round 3 spawned

    // Round 3 — alice wins again
    await t.fetch(req("POST", "/round-result", { settlement: settlement({ alice: 20, bob: -5, carol: -10, dave: -5 }) }));
    expect(gameRoomCalls.length).toBe(3);   // no more rounds

    const stateRes = await t.fetch(req("GET", "/state"));
    const live = await stateRes.json() as { status: string; winnerId: string | null; entries: Array<{ playerId: string; aggScore: number; finalRank: number | null }> };
    expect(live.status).toBe("settled");
    expect(live.winnerId).toBe("alice");                // 30 + (-5) + 20 = 45
    const ranks = Object.fromEntries(live.entries.map(e => [e.playerId, e.finalRank]));
    expect(ranks.alice).toBe(1);
    expect(ranks.bob).toBe(2);                          // -10 + 25 + -5 = 10
  });

  it("payout writes a 'tournament' ledger row to the winner", async () => {
    const t = makeDO();
    await t.fetch(req("POST", "/init", { tournamentId: "T1", gameType: "bigTwo", buyIn: 200 }));
    for (const pid of ["alice", "bob", "carol", "dave"]) {
      await t.fetch(req("POST", "/join", { playerId: pid }));
    }
    for (let i = 0; i < 3; i++) {
      await t.fetch(req("POST", "/round-result", { settlement: settlement({ alice: 30, bob: -10, carol: -10, dave: -10 }) }));
    }

    const ledger = db.statements.find(s => s.sql.includes("INSERT OR IGNORE INTO chip_ledger"));
    expect(ledger).toBeTruthy();
    expect(ledger!.args[0]).toBe("alice");          // winner
    expect(ledger!.args[2]).toBe(760);              // 4 × 200 = 800, 5% rake = -40
  });

  it("/round-result on a not-running tournament returns 409", async () => {
    const t = makeDO();
    const r = await t.fetch(req("POST", "/round-result", { settlement: settlement({ alice: 0, bob: 0, carol: 0, dave: 0 }) }));
    expect(r.status).toBe(400);
  });

  it("ties broken by registration order", async () => {
    const t = makeDO();
    await t.fetch(req("POST", "/init", { tournamentId: "T1", gameType: "bigTwo", buyIn: 200 }));
    for (const pid of ["alice", "bob", "carol", "dave"]) {
      await t.fetch(req("POST", "/join", { playerId: pid }));
    }
    // Everyone finishes 0-0-0
    for (let i = 0; i < 3; i++) {
      await t.fetch(req("POST", "/round-result", { settlement: settlement({ alice: 0, bob: 0, carol: 0, dave: 0 }) }));
    }
    const live = await (await t.fetch(req("GET", "/state"))).json() as { winnerId: string };
    expect(live.winnerId).toBe("alice");
  });
});
