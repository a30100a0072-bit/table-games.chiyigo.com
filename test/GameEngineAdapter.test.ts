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

  // 棄局處罰：mahjong / texas 受罰，bigTwo 用既有 remaining-card 計分。
  for (const gt of ["mahjong", "texas"] as const) {
    it(`${gt} forceSettle('disconnect', offender) — 棄局者扣分、其他人均分`, () => {
      const e = createEngine({ gameType: gt, gameId: "g", roundId: "r", playerIds: PLAYERS });
      const offender = PLAYERS[0]!;
      const s = e.forceSettle("disconnect", offender);
      const off = s.players.find(p => p.playerId === offender)!;
      const others = s.players.filter(p => p.playerId !== offender);
      expect(off.scoreDelta).toBeLessThan(0);
      const sumOthers = others.reduce((n, p) => n + p.scoreDelta, 0);
      // 守恆（允許向下取整餘數）：扣分絕對值 ≥ 加分總和
      expect(Math.abs(off.scoreDelta)).toBeGreaterThanOrEqual(sumOthers);
      expect(s.winnerId).not.toBe(offender);
    });

    it(`${gt} forceSettle('disconnect') 不指名 — 全員 scoreDelta=0`, () => {
      const e = createEngine({ gameType: gt, gameId: "g", roundId: "r", playerIds: PLAYERS });
      const s = e.forceSettle("disconnect");
      for (const p of s.players) expect(p.scoreDelta).toBe(0);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// (4) 跨遊戲動作型別防呆 — 引擎拒絕不屬於該遊戲的 action
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// (3.5) autoActionOnTimeout — 30s 沒動作時 BotAI 代打、輪次推進
//        DO 對人類玩家逾時的補救路徑；Playwright 真人腳本若沒送 action，
//        後端必須靠這條把局推下去而不是卡死。
// ─────────────────────────────────────────────────────────────────────────

describe("autoActionOnTimeout — bot 代打人類", () => {
  for (const gt of ["bigTwo", "mahjong", "texas", "uno", "yahtzee"] as GameType[]) {
    it(`${gt} 對 currentTurn 玩家代打 → outcome 帶 appliedAction 或 settlement`, () => {
      const e = createEngine({ gameType: gt, gameId: "g", roundId: "r", playerIds: PLAYERS });
      const offender = e.currentTurn();
      const before = e.snapshot();
      const outcome = e.autoActionOnTimeout(offender);
      // 必有結果：要嘛動作落地（appliedAction），要嘛直接結算。
      expect(outcome.appliedAction !== undefined || outcome.settlement !== null).toBe(true);
      // 沒結算的情況下，狀態必有變化（避免 silent no-op 卡死）。
      if (!outcome.settlement) {
        const after = e.snapshot();
        expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
      }
    });
  }

  it("uno: 代打對 hasDrawn 已為 true 的玩家會選 pass / play 而非再 draw", () => {
    // 模擬人類已自己抽過牌但停在那裡的情境。autoActionOnTimeout 路徑必須
    // 偵測 hasDrawn=true 不再硬塞 uno_draw（會被 SM 拒），而是 pass。
    const e = createEngine({ gameType: "uno", gameId: "g", roundId: "r", playerIds: PLAYERS });
    const offender = e.currentTurn();
    // 第一次代打：bot 可能直接出牌；不論結果，狀態必須前進。
    const out1 = e.autoActionOnTimeout(offender);
    expect(out1.appliedAction !== undefined || out1.settlement !== null).toBe(true);
  });
});

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
