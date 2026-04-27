// /test/MahjongStateMachine.test.ts
// Mahjong pure-logic unit tests — zero IO, deterministic via injected RNG.    // L2_測試

import { describe, it, expect } from "vitest";
import { MahjongStateMachine, canWin } from "../src/game/MahjongStateMachine";
import type { MahjongTile } from "../src/types/game";

// ── Tile helpers ─────────────────────────────────────────────────────────── L2_測試
const m = (rank: number): MahjongTile => ({ suit: "m", rank });
const p = (rank: number): MahjongTile => ({ suit: "p", rank });
const s = (rank: number): MahjongTile => ({ suit: "s", rank });
const z = (rank: number): MahjongTile => ({ suit: "z", rank });

/** Mulberry32 — deterministic seed for reproducible wall.                    // L2_測試 */
function seededRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// (1) 胡牌判定 canWin — 純函式
// ─────────────────────────────────────────────────────────────────────────

describe("canWin 胡牌判定", () => {

  it("17 張：5 副順子 + 1 對 → 胡", () => {
    // m123 m456 p123 p789 s234 + ZZ (中中)                                  // L2_測試
    const hand: MahjongTile[] = [
      m(1), m(2), m(3),
      m(4), m(5), m(6),
      p(1), p(2), p(3),
      p(7), p(8), p(9),
      s(2), s(3), s(4),
      z(5), z(5),
    ];
    expect(canWin(hand, 0)).toBe(true);
  });

  it("17 張：4 副刻 + 1 順 + 1 對 → 胡", () => {
    const hand: MahjongTile[] = [
      m(1), m(1), m(1),
      m(5), m(5), m(5),
      p(2), p(2), p(2),
      s(7), s(7), s(7),
      s(2), s(3), s(4),
      z(1), z(1),
    ];
    expect(canWin(hand, 0)).toBe(true);
  });

  it("17 張只有對子無法湊出 5 副 → 不胡", () => {
    // 全是對子，但拼不出順/刻                                                // L3_邏輯安防
    const hand: MahjongTile[] = [
      m(1), m(1), m(3), m(3), m(5), m(5),
      p(2), p(2), p(4), p(4), p(6), p(6),
      s(8), s(8), z(1), z(1), z(3),
    ];
    expect(canWin(hand, 0)).toBe(false);
  });

  it("含副露：2 副副露 + 11 張 + 對 = 胡", () => {
    // exposed=2 → 還需 3 副 + 1 對                                           // L2_測試
    // 11 張：m234 m567 p123 + 中中
    const hand: MahjongTile[] = [
      m(2), m(3), m(4),
      m(5), m(6), m(7),
      p(1), p(2), p(3),
      z(5), z(5),
    ];
    expect(canWin(hand, 2)).toBe(true);
  });

  it("總張數錯誤直接拒絕（防偽造）", () => {
    expect(canWin([m(1), m(2)], 0)).toBe(false);                              // L3_邏輯安防
  });

  it("字牌不可成順子，僅可成刻", () => {
    // 4 副順子 (m/p/s) + 字牌 z123 不能成順 → 必須失敗                       // L3_邏輯安防
    const hand: MahjongTile[] = [
      m(1), m(2), m(3),
      m(4), m(5), m(6),
      p(1), p(2), p(3),
      p(4), p(5), p(6),
      z(1), z(2), z(3),
      z(7), z(7),
    ];
    expect(canWin(hand, 0)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (2) 狀態機初始化與基本動作
// ─────────────────────────────────────────────────────────────────────────

describe("MahjongStateMachine 初始化", () => {

  it("4 人入局後莊家 17 張、其餘 16 張", () => {
    const sm = new MahjongStateMachine("g1", "r1", ["p1", "p2", "p3", "p4"], seededRng(42));
    expect(sm.viewFor("p1").self.hand).toHaveLength(17);                      // L2_測試
    expect(sm.viewFor("p2").self.hand).toHaveLength(16);
    expect(sm.viewFor("p3").self.hand).toHaveLength(16);
    expect(sm.viewFor("p4").self.hand).toHaveLength(16);
    expect(sm.viewFor("p1").currentTurn).toBe("p1");
  });

  it("非 4 人開局直接拋錯", () => {
    expect(() => new MahjongStateMachine("g", "r", ["p1", "p2", "p3"]))
      .toThrow(/MJ_REQUIRES_4_PLAYERS/);                                      // L3_邏輯安防
  });

  it("視角隔離：對手不暴露 hand 牌面", () => {
    const sm = new MahjongStateMachine("g1", "r1", ["p1", "p2", "p3", "p4"], seededRng(7));
    const opp = sm.viewFor("p2").opponents.find(o => o.playerId === "p1")!;
    expect(opp.handCount).toBe(17);                                            // L2_隔離
    expect((opp as { hand?: unknown }).hand).toBeUndefined();
  });
});

describe("MahjongStateMachine 動作分派", () => {

  it("非本人回合打牌會被擋", () => {
    const sm = new MahjongStateMachine("g1", "r1", ["p1", "p2", "p3", "p4"], seededRng(1));
    const handP2 = sm.viewFor("p2").self.hand;
    const r = sm.process("p2", { type: "discard", tile: handP2[0]! });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("NOT_YOUR_TURN");                          // L3_邏輯安防
  });

  it("打不在手中的牌會被擋", () => {
    const sm = new MahjongStateMachine("g1", "r1", ["p1", "p2", "p3", "p4"], seededRng(1));
    // 偽造一張 p1 手裡幾乎不可能恰好沒有的牌組合 → 用 z(7) 之外的字牌可能存在；
    // 改用直接驗證：找一張不在 p1 手中的牌
    const handP1 = sm.viewFor("p1").self.hand;
    const allRanks = [m(1), m(2), m(3), m(4), m(5), m(6), m(7), m(8), m(9)];
    const notInHand = allRanks.find(t => !handP1.some(h => h.suit === t.suit && h.rank === t.rank));
    if (!notInHand) return;        // 極端洗牌情況下跳過
    const r = sm.process("p1", { type: "discard", tile: notInHand });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("TILE_NOT_IN_HAND");                       // L2_隔離
  });

  it("打牌後進入 pending_reactions 且莊家不在等待名單", () => {
    const sm = new MahjongStateMachine("g1", "r1", ["p1", "p2", "p3", "p4"], seededRng(99));
    const handP1 = sm.viewFor("p1").self.hand;
    const r = sm.process("p1", { type: "discard", tile: handP1[0]! });
    expect(r.ok).toBe(true);
    const view = sm.viewFor("p2");
    expect(view.phase).toBe("pending_reactions");                              // L3_架構
    expect(view.lastDiscard?.playerId).toBe("p1");
    expect(view.awaitingReactionsFrom).toEqual(
      expect.arrayContaining(["p2", "p3", "p4"]),
    );
    expect(view.awaitingReactionsFrom).not.toContain("p1");
  });

  it("全員 pass 後輪到下家摸牌", () => {
    const sm = new MahjongStateMachine("g1", "r1", ["p1", "p2", "p3", "p4"], seededRng(123));
    const handP1 = sm.viewFor("p1").self.hand;
    sm.process("p1", { type: "discard", tile: handP1[0]! });
    sm.process("p2", { type: "mj_pass" });
    sm.process("p3", { type: "mj_pass" });
    sm.process("p4", { type: "mj_pass" });
    const view = sm.viewFor("p2");
    expect(view.phase).toBe("playing");                                        // L3_架構
    expect(view.currentTurn).toBe("p2");
    expect(view.self.hand.length).toBe(17);   // p2 摸了一張
  });

  it("forceResolveReactions 把未回應者視為 pass", () => {
    const sm = new MahjongStateMachine("g1", "r1", ["p1", "p2", "p3", "p4"], seededRng(55));
    const handP1 = sm.viewFor("p1").self.hand;
    sm.process("p1", { type: "discard", tile: handP1[0]! });
    const r = sm.forceResolveReactions();
    expect(r.ok).toBe(true);
    expect(sm.viewFor("p1").phase).toBe("playing");                            // L3_架構
    expect(sm.viewFor("p1").currentTurn).toBe("p2");
  });
});
