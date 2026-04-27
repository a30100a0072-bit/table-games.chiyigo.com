// /test/GameEngineAdapter.test.ts
// Adapter 層整合測試 — 確保 IGameEngine 統一介面對三款狀態機行為一致。       // L2_測試

import { describe, it, expect } from "vitest";
import { createEngine, restoreEngine } from "../src/game/GameEngineAdapter";
import type { GameType } from "../src/types/game";

const PLAYERS = ["p1", "p2", "p3", "p4"];

// ─────────────────────────────────────────────────────────────────────────
// (1) createEngine 三款遊戲皆能成功初始化
// ─────────────────────────────────────────────────────────────────────────

describe("createEngine 工廠", () => {
  for (const gt of ["bigTwo", "mahjong", "texas"] as GameType[]) {
    it(`${gt} 初始化後 currentTurn 與 view 可用`, () => {
      const e = createEngine({ gameType: gt, gameId: "g", roundId: "r", playerIds: PLAYERS });
      expect(e.gameType).toBe(gt);
      const turn = e.currentTurn();
      expect(PLAYERS).toContain(turn);                                       // L2_測試
      const view = e.getView("p1");
      expect(view).toBeDefined();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// (2) snapshot → restore 往返保持狀態（DO Hibernation 關鍵路徑）
// ─────────────────────────────────────────────────────────────────────────

describe("snapshot / restore 往返", () => {
  for (const gt of ["bigTwo", "mahjong", "texas"] as GameType[]) {
    it(`${gt} restore 後 view 與原引擎一致`, () => {
      const e1 = createEngine({ gameType: gt, gameId: "g", roundId: "r", playerIds: PLAYERS });
      const snap = e1.snapshot();
      // JSON 往返模擬 DO storage 序列化                                     // L3_架構含防禦觀測
      const persisted = JSON.parse(JSON.stringify(snap));
      const e2 = restoreEngine(gt, persisted);

      expect(e2.currentTurn()).toBe(e1.currentTurn());
      expect(JSON.stringify(e2.getView("p1"))).toBe(JSON.stringify(e1.getView("p1")));
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// (3) forceSettle — DO timeout/disconnect 路徑
// ─────────────────────────────────────────────────────────────────────────

describe("forceSettle", () => {
  for (const gt of ["bigTwo", "mahjong", "texas"] as GameType[]) {
    it(`${gt} forceSettle('timeout') 產出合法 SettlementResult`, () => {
      const e = createEngine({ gameType: gt, gameId: "g", roundId: "r", playerIds: PLAYERS });
      const s = e.forceSettle("timeout");
      expect(s.reason).toBe("timeout");
      expect(s.gameId).toBe("g");
      expect(s.players).toHaveLength(PLAYERS.length);                        // L3_架構
      expect(PLAYERS).toContain(s.winnerId);
    });

    it(`${gt} forceSettle 拒絕 'lastCardPlayed' 理由`, () => {
      const e = createEngine({ gameType: gt, gameId: "g", roundId: "r", playerIds: PLAYERS });
      expect(() => e.forceSettle("lastCardPlayed")).toThrow();               // L3_邏輯安防
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// (4) 跨遊戲動作型別防呆 — 引擎拒絕不屬於該遊戲的 action
// ─────────────────────────────────────────────────────────────────────────

describe("processAction 動作型別防呆", () => {
  it("bigTwo 拒絕 mahjong/texas 動作", () => {
    const e = createEngine({ gameType: "bigTwo", gameId: "g", roundId: "r", playerIds: PLAYERS });
    expect(() => e.processAction("p1", { type: "fold" })).toThrow();          // L3_邏輯安防
    expect(() => e.processAction("p1", { type: "mj_pass" })).toThrow();
  });
  it("mahjong 拒絕 texas/bigTwo 動作", () => {
    const e = createEngine({ gameType: "mahjong", gameId: "g", roundId: "r", playerIds: PLAYERS });
    expect(() => e.processAction("p1", { type: "fold" })).toThrow();          // L3_邏輯安防
    expect(() => e.processAction("p1", { type: "pass" })).toThrow();
  });
  it("texas 拒絕 bigTwo/mahjong 動作", () => {
    const e = createEngine({ gameType: "texas", gameId: "g", roundId: "r", playerIds: PLAYERS });
    expect(() => e.processAction("p1", { type: "pass" })).toThrow();          // L3_邏輯安防
    expect(() => e.processAction("p1", { type: "mj_pass" })).toThrow();
  });
});
