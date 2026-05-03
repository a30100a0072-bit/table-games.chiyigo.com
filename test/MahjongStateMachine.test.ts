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

  it("搶槓胡：食胡 + chiangKong → +1 台", () => {
    const r = calcFan({ ...baseOpts, selfDrawn: false, chiangKong: true });
    expect(r.detail).toContain("搶槓");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (6) 進階台 — 狀態機級別整合（搶槓 / 八仙過海 / 七搶一）
// ─────────────────────────────────────────────────────────────────────────

import type { MahjongSnapshot } from "../src/game/MahjongStateMachine";

/** 把麻將狀態機塞到一個已知狀態 — 直接走 restore 路徑，避免重洗牌
 *  仰賴隨機 RNG 才能跑到目標 phase 的曲折測試。                            // L2_測試 */
function withSnapshot(mut: (snap: MahjongSnapshot) => void): MahjongStateMachine {
  const sm = new MahjongStateMachine("g", "r", ["p1", "p2", "p3", "p4"], seededRng(1));
  const snap = sm.snapshot();
  mut(snap);
  return MahjongStateMachine.restore(snap);
}

describe("搶槓 (chiang kong)", () => {
  it("加槓 → 進入 pending_reactions 視窗，未完成 exposed 變更", () => {
    const sm = withSnapshot(st => {
      st.phase = "playing";
      st.turnIdx = 0;
      // p1 已碰過 m5，手中還剩 1 張 m5 可加槓
      st.players[0]!.hand = [m(5), m(1), m(2), m(3), m(4), m(6), m(7), m(8), m(9), p(1), p(2), p(3), p(4), p(5), s(1), s(2), s(3)];
      st.players[0]!.exposed = [{ kind: "pong", tiles: [m(5), m(5), m(5)] }];
      st.drawnThisTurn = m(5);
    });
    const r = sm.process("p1", { type: "kong", source: "added", tile: m(5) });
    expect(r.ok).toBe(true);
    const view = sm.viewFor("p1");
    expect(view.phase).toBe("pending_reactions");
    expect(view.lastDiscard?.tile).toEqual(m(5));
    // 加槓尚未完成 → 仍是 pong
    expect(view.self.exposed[0]!.kind).toBe("pong");
  });

  it("搶槓視窗內所有對手都 pass → 加槓完成、改為 kong_exposed", () => {
    const sm = withSnapshot(st => {
      st.phase = "playing";
      st.turnIdx = 0;
      st.players[0]!.hand = [m(5), m(1), m(2), m(3), m(4), m(6), m(7), m(8), m(9), p(1), p(2), p(3), p(4), p(5), s(1), s(2), s(3)];
      st.players[0]!.exposed = [{ kind: "pong", tiles: [m(5), m(5), m(5)] }];
      st.drawnThisTurn = m(5);
    });
    sm.process("p1", { type: "kong", source: "added", tile: m(5) });
    sm.process("p2", { type: "mj_pass" });
    sm.process("p3", { type: "mj_pass" });
    sm.process("p4", { type: "mj_pass" });
    const view = sm.viewFor("p1");
    expect(view.phase).toBe("playing");
    expect(view.self.exposed[0]!.kind).toBe("kong_exposed");
    expect(view.self.exposed[0]!.tiles).toHaveLength(4);
  });

  it("搶槓視窗內 onPong / onChow 被擋下", () => {
    const sm = withSnapshot(st => {
      st.phase = "playing";
      st.turnIdx = 0;
      st.players[0]!.hand = [m(5), m(1), m(2), m(3), m(4), m(6), m(7), m(8), m(9), p(1), p(2), p(3), p(4), p(5), s(1), s(2), s(3)];
      st.players[0]!.exposed = [{ kind: "pong", tiles: [m(5), m(5), m(5)] }];
      st.drawnThisTurn = m(5);
    });
    sm.process("p1", { type: "kong", source: "added", tile: m(5) });
    const r = sm.process("p2", { type: "pong", tile: m(5) });
    expect(r.ok).toBe(false);
    expect("error" in r && r.error).toBe("ONLY_HU_DURING_CHIANG_KONG");
  });

  it("搶槓視窗內有人能胡 → 食胡 + 搶槓 fan，加槓不完成", () => {
    // p2 持手牌 m1-m9 + p1-p7 共 16 張，差 m5 完成 1 對；p1 加槓 m5 給 p2 食胡
    const sm = withSnapshot(st => {
      st.phase = "playing";
      st.turnIdx = 0;
      st.players[0]!.hand = [m(5), m(1), m(2), m(3), m(4), m(6), m(7), m(8), m(9), p(1), p(2), p(3), p(4), p(5), s(1), s(2), s(3)];
      st.players[0]!.exposed = [{ kind: "pong", tiles: [m(5), m(5), m(5)] }];
      st.drawnThisTurn = m(5);
      // p2 設成 16 張差 m5 即胡的待牌：m123 m456 m789 p123 + m5 配對
      // p2 16 張，差 m5 完成 m456：m123 m4_6 m789 p123 p456 z11 → +m5 = 5 副 + 1 對
      st.players[1]!.hand = [m(1), m(2), m(3), m(4), m(6), m(7), m(8), m(9), p(1), p(2), p(3), p(4), p(5), p(6), z(1), z(1)];
      st.players[1]!.exposed = [];
    });
    sm.process("p1", { type: "kong", source: "added", tile: m(5) });
    sm.process("p2", { type: "hu", selfDrawn: false });
    sm.process("p3", { type: "mj_pass" });
    const r = sm.process("p4", { type: "mj_pass" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.settlement).toBeTruthy();
    if (r.ok && r.settlement) {
      expect(r.settlement.winnerId).toBe("p2");
      expect(r.settlement.fanDetail?.detail).toContain("搶槓");
      // p1 是放槍者
      const p1 = r.settlement.players.find(x => x.playerId === "p1")!;
      expect(p1.scoreDelta).toBeLessThan(0);
    }
    // 加槓沒完成 — exposed 仍是 pong（雖然遊戲已結算）
    const view = sm.viewFor("p1");
    expect(view.self.exposed[0]!.kind).toBe("pong");
  });
});

describe("八仙過海 / 七搶一", () => {
  it("八仙過海：drawer 收到第 8 張花 → 自己贏，三家攤付", () => {
    const f = (rank: number) => ({ suit: "f" as const, rank });
    const sm = withSnapshot(st => {
      // p1 已有 7 花，牌牆首張是第 8 張花，再放一張正常牌讓 drawNonFlower 能停。
      st.players[0]!.flowers = [f(1), f(2), f(3), f(4), f(5), f(6), f(7)];
      st.players[1]!.flowers = [];
      st.players[2]!.flowers = [];
      st.players[3]!.flowers = [];
      // turnIdx=3，下一摸是 p1（順時鐘 (3+1)%4 = 0）
      st.turnIdx = 3;
      st.phase = "pending_reactions";
      st.lastDiscard = { tile: m(1), playerIdx: 3 };
      st.pendingReactions = [
        { playerId: "p1", declared: { kind: "pass" } },
        { playerId: "p2", declared: { kind: "pass" } },
        { playerId: "p4", declared: { kind: "pass" } },
      ];
      // drawNonFlower 從 wall 尾端 pop：把 f(8) 放尾巴讓它先被吸收，再 pop m(2) 給 hand
      st.wall = [m(2), f(8)];
    });
    // 觸發 advanceToNextDraw（forceResolveReactions → all-pass → advance）
    const r = sm.forceResolveReactions();
    expect(r.ok).toBe(true);
    expect(r.ok && r.settlement?.winnerId).toBe("p1");
    expect(r.ok && r.settlement?.fanDetail?.detail).toContain("八仙過海");
  });

  it("七搶一：他人摸到第 8 花 → 持 7 花玩家贏，摸花者付", () => {
    const f = (rank: number) => ({ suit: "f" as const, rank });
    const sm = withSnapshot(st => {
      st.players[0]!.flowers = [f(1), f(2), f(3), f(4), f(5), f(6), f(7)];   // p1 持 7
      st.players[1]!.flowers = [];
      st.players[2]!.flowers = [];
      st.players[3]!.flowers = [];
      // turnIdx=0，下一摸是 p2 (順時鐘 1)
      st.turnIdx = 0;
      st.phase = "pending_reactions";
      st.lastDiscard = { tile: m(1), playerIdx: 0 };
      st.pendingReactions = [
        { playerId: "p2", declared: { kind: "pass" } },
        { playerId: "p3", declared: { kind: "pass" } },
        { playerId: "p4", declared: { kind: "pass" } },
      ];
      // drawNonFlower 從 wall 尾端 pop：把 f(8) 放尾巴讓它先被吸收，再 pop m(2) 給 hand
      st.wall = [m(2), f(8)];
    });
    const r = sm.forceResolveReactions();
    expect(r.ok).toBe(true);
    expect(r.ok && r.settlement?.winnerId).toBe("p1");
    expect(r.ok && r.settlement?.fanDetail?.detail).toContain("七搶一");
    if (r.ok && r.settlement) {
      const p2 = r.settlement.players.find(x => x.playerId === "p2")!;
      expect(p2.scoreDelta).toBeLessThan(0);                                // 摸到第 8 花的 p2 賠
    }
  });
});

describe("多局賽事 / 連莊 N", () => {
  it("ctor 預設 targetHands=1，與單局行為相容", () => {
    const sm = new MahjongStateMachine("g", "r", ["p1", "p2", "p3", "p4"], seededRng(1));
    expect(sm.getTargetHands()).toBe(1);
    expect(sm.getHandNumber()).toBe(1);
    expect(sm.isMatchOver()).toBe(false);
  });

  it("targetHands=2，第一局 hu → matchOver=false + phase=between_hands；第二局 hu → matchOver=true", () => {
    const make = (mut: (snap: MahjongSnapshot) => void): MahjongStateMachine => {
      const sm = new MahjongStateMachine("g", "r", ["p1", "p2", "p3", "p4"], seededRng(1), 2);
      const snap = sm.snapshot();
      mut(snap);
      return MahjongStateMachine.restore(snap, seededRng(2));
    };

    // 第一局：搶槓 hu 模板（p1 加槓 m5、p2 食胡）。改成 targetHands=2。
    const sm = make(st => {
      st.phase = "playing";
      st.turnIdx = 0;
      st.players[0]!.hand = [m(5), m(1), m(2), m(3), m(4), m(6), m(7), m(8), m(9), p(1), p(2), p(3), p(4), p(5), s(1), s(2), s(3)];
      st.players[0]!.exposed = [{ kind: "pong", tiles: [m(5), m(5), m(5)] }];
      st.drawnThisTurn = m(5);
      st.players[1]!.hand = [m(1), m(2), m(3), m(4), m(6), m(7), m(8), m(9), p(1), p(2), p(3), p(4), p(5), p(6), z(1), z(1)];
      st.players[1]!.exposed = [];
    });
    sm.process("p1", { type: "kong", source: "added", tile: m(5) });
    sm.process("p2", { type: "hu", selfDrawn: false });
    sm.process("p3", { type: "mj_pass" });
    const r1 = sm.process("p4", { type: "mj_pass" });
    expect(r1.ok).toBe(true);
    if (!r1.ok || !r1.settlement) throw new Error("expected settlement");
    expect(r1.settlement.matchOver).toBe(false);
    expect(r1.settlement.matchProgress?.handNumber).toBe(1);
    expect(r1.settlement.matchProgress?.targetHands).toBe(2);
    expect(sm.viewFor("p1").phase).toBe("between_hands");
    expect(sm.isMatchOver()).toBe(false);

    // p2 是 winner（idx=1），dealer 是 p1（idx=0）— winner ≠ dealer → 莊家輪轉
    sm.startNextHand(1, false);
    expect(sm.getHandNumber()).toBe(2);
    expect(sm.viewFor("p1").phase).toBe("playing");

    // 第二局：直接造 winning shape，p2 自摸（同一手牌）。
    // 用 forceSettle 結束最後一局，預期 matchOver=true。
    const r2 = sm.forceSettle("disconnect", "p4");
    expect(r2.matchOver).toBe(true);
    expect(r2.matchProgress?.handNumber).toBe(2);
    expect(sm.isMatchOver()).toBe(true);
  });

  it("startNextHand 規則：莊家胡 → 連莊（dealer 不變、bankerStreak++）", () => {
    const sm = new MahjongStateMachine("g", "r", ["p1", "p2", "p3", "p4"], seededRng(1), 3);
    // 強制進入 between_hands 狀態以驗證 startNextHand 純粹的輪轉邏輯
    const snap = sm.snapshot();
    snap.phase = "between_hands";
    snap.dealerIdx = 0;
    snap.bankerStreak = 0;
    snap.handNumber = 1;
    const m2 = MahjongStateMachine.restore(snap, seededRng(2));
    m2.startNextHand(0, false);   // winnerIdx === dealerIdx → 連莊
    const view = m2.viewFor("p1");
    expect(view.currentTurn).toBe("p1");                 // 仍由 p1 莊
  });

  it("startNextHand 規則：非莊家胡 → 莊家輪轉到下一座", () => {
    const sm = new MahjongStateMachine("g", "r", ["p1", "p2", "p3", "p4"], seededRng(1), 3);
    const snap = sm.snapshot();
    snap.phase = "between_hands";
    snap.dealerIdx = 0;
    snap.handNumber = 1;
    const m2 = MahjongStateMachine.restore(snap, seededRng(2));
    m2.startNextHand(2, false);   // winnerIdx=2 ≠ dealerIdx=0 → rotate to 1
    expect(m2.viewFor("p2").currentTurn).toBe("p2");
  });

  it("startNextHand 在 phase ≠ between_hands 時拋錯", () => {
    const sm = new MahjongStateMachine("g", "r", ["p1", "p2", "p3", "p4"], seededRng(1), 2);
    expect(() => sm.startNextHand(0, false)).toThrow();
  });

  it("targetHands 必須是正整數", () => {
    expect(() => new MahjongStateMachine("g", "r", ["p1", "p2", "p3", "p4"], seededRng(1), 0)).toThrow();
    expect(() => new MahjongStateMachine("g", "r", ["p1", "p2", "p3", "p4"], seededRng(1), 1.5)).toThrow();
  });

  it("forceSettle 在多局賽事中也短路為 matchOver=true（不繼續下一局）", () => {
    const sm = new MahjongStateMachine("g", "r", ["p1", "p2", "p3", "p4"], seededRng(1), 4);
    const r = sm.forceSettle("disconnect", "p1");
    expect(r.matchOver).toBe(true);
    expect(sm.isMatchOver()).toBe(true);
  });
});
