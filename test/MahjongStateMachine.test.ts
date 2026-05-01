// /test/MahjongStateMachine.test.ts
// Mahjong pure-logic unit tests — zero IO, deterministic via injected RNG.    // L2_測試

import { describe, it, expect } from "vitest";
import { MahjongStateMachine, canWin, calcFan } from "../src/game/MahjongStateMachine";
import type { MahjongTile, ExposedMeld } from "../src/types/game";

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

// ─────────────────────────────────────────────────────────────────────────
// (5) calcFan — 大眾規則 13 台 (engine_version 2)
// ─────────────────────────────────────────────────────────────────────────

describe("calcFan 大眾規則", () => {
  // 17-tile self-drawn hand: m123 m456 m789 p123 p456 + s7 s7. Plain pinghu.
  const baseHand: MahjongTile[] = [
    m(1), m(2), m(3), m(4), m(5), m(6), m(7), m(8), m(9),
    p(1), p(2), p(3), p(4), p(5), p(6),
    s(7), s(7),
  ];
  const baseOpts = {
    selfDrawn: false,
    menqing: true,
    exposed: [] as ExposedMeld[],
    hand: baseHand,
    winningTile: s(7),
    isBanker: false,
    flowerCount: 0,
  };

  it("莊家 +1 台", () => {
    const r = calcFan({ ...baseOpts, isBanker: true });
    expect(r.detail).toContain("莊家");
    expect(r.fan).toBeGreaterThanOrEqual(1);
  });

  it("花牌每張 +1 台", () => {
    const r = calcFan({ ...baseOpts, flowerCount: 3 });
    expect(r.detail.some(d => d.startsWith("花牌"))).toBe(true);
    // 平胡 0 + 門前清 1 + 花牌×3 = 4
    expect(r.fan).toBe(1 + 3);
  });

  it("小三元：兩龍刻 + 龍對子", () => {
    // m123 m456 + 中刻 + 發刻 + 白對子 + p23 + winning p1
    const hand: MahjongTile[] = [
      m(1), m(2), m(3), m(4), m(5), m(6),
      z(5), z(5), z(5),                  // 中刻
      z(6), z(6), z(6),                  // 發刻
      z(7), z(7),                        // 白對
      p(2), p(3), p(1),                  // 順
    ];
    const r = calcFan({ ...baseOpts, hand, winningTile: p(1) });
    expect(r.detail).toContain("小三元");
    expect(r.detail).not.toContain("大三元");
  });

  it("大三元：三龍刻全有", () => {
    const hand: MahjongTile[] = [
      m(1), m(2), m(3),
      z(5), z(5), z(5),
      z(6), z(6), z(6),
      z(7), z(7), z(7),
      p(2), p(3), p(4),
      s(9), s(9),
    ];
    const r = calcFan({ ...baseOpts, hand, winningTile: s(9) });
    expect(r.detail).toContain("大三元");
    expect(r.detail).not.toContain("小三元");
  });

  it("小四喜：三風刻 + 風對子", () => {
    const hand: MahjongTile[] = [
      z(1), z(1), z(1),                  // 東刻
      z(2), z(2), z(2),                  // 南刻
      z(3), z(3), z(3),                  // 西刻
      z(4), z(4),                        // 北對
      m(1), m(2), m(3),
      s(5), s(5),
    ];
    const r = calcFan({ ...baseOpts, hand, winningTile: s(5) });
    expect(r.detail).toContain("小四喜");
  });

  it("三暗刻：自摸三組手內刻子", () => {
    const hand: MahjongTile[] = [
      m(1), m(1), m(1),
      m(5), m(5), m(5),
      p(2), p(2), p(2),
      s(7), s(8), s(9),
      m(7), m(8), m(9),
      z(6), z(6),
    ];
    const r = calcFan({
      ...baseOpts, hand, winningTile: m(1), selfDrawn: true,
    });
    expect(r.detail).toContain("三暗刻");
  });

  it("食胡時贏牌完成的刻子降級為明刻（不算暗刻）", () => {
    // hand 含 m1 ×3 + m5 ×3，食胡贏牌 m1 → m1 刻子變明刻，只算 1 個暗刻
    // 17 張(食胡時已加贏牌進去): m1×3 m5×3 p2×3 s7 s8 s9 m7 m8 m9 z6 z6
    const hand: MahjongTile[] = [
      m(1), m(1), m(1),
      m(5), m(5), m(5),
      p(2), p(2), p(2),
      s(7), s(8), s(9),
      m(7), m(8), m(9),
      z(6), z(6),
    ];
    const r = calcFan({
      ...baseOpts, hand, winningTile: m(1), selfDrawn: false,
    });
    // 食胡 → m1 刻子降級，剩 m5 + p2 = 2 個暗刻 → 不到 3 暗刻門檻
    expect(r.detail).not.toContain("三暗刻");
  });

  it("全求人：4 副露 + 食胡 + 無暗槓 + hand ≤ 5", () => {
    const exposed: ExposedMeld[] = [
      { kind: "chow", tiles: [m(1), m(2), m(3)] },
      { kind: "pong", tiles: [p(5), p(5), p(5)] },
      { kind: "pong", tiles: [s(7), s(7), s(7)] },
      { kind: "chow", tiles: [m(4), m(5), m(6)] },
    ];
    // 手中: 對子 + 贏牌 = 3 張（食胡時加贏牌進去 = 3）
    const r = calcFan({
      ...baseOpts,
      hand: [z(1), z(1), z(1)],   // 對子 z1 z1 + 贏牌 z1 (進場成第5刻)
      winningTile: z(1),
      exposed,
      menqing: false,
      selfDrawn: false,
    });
    expect(r.detail).toContain("全求人");
  });

  it("海底撈月：自摸 + lastWallDraw", () => {
    const r = calcFan({ ...baseOpts, selfDrawn: true, lastWallDraw: true });
    expect(r.detail).toContain("海底撈月");
  });

  it("河底撈魚：食胡 + lastRiverHu", () => {
    const r = calcFan({ ...baseOpts, selfDrawn: false, lastRiverHu: true });
    expect(r.detail).toContain("河底撈魚");
  });

  it("平胡基本：只有門前清", () => {
    const r = calcFan(baseOpts);
    expect(r.fan).toBe(1);                       // 門前清
    expect(r.detail).toContain("門前清");
    expect(r.detail).toContain("平胡");
  });
});
