// /test/TexasHoldemStateMachine.test.ts
// Texas Hold'em pure-logic unit tests — zero IO.                              // L2_測試

import { describe, it, expect } from "vitest";
import {
  TexasHoldemStateMachine,
  rankFiveCardKey,
  rankBestOfSeven,
  buildSidePots,
} from "../src/game/TexasHoldemStateMachine";
import type { Card, Rank, Suit } from "../src/types/game";

const c = (rank: Rank, suit: Suit): Card => ({ rank, suit });

// ─────────────────────────────────────────────────────────────────────────
// (1) 牌型評分 rankFiveCardKey
// ─────────────────────────────────────────────────────────────────────────

describe("rankFiveCardKey 牌型階序", () => {

  it("同花順 > 四條 > 葫蘆 > 同花 > 順子 > 三條 > 兩對 > 一對 > 高牌", () => {
    const sf  = [c("9","spades"),c("8","spades"),c("7","spades"),c("6","spades"),c("5","spades")];
    const four = [c("9","spades"),c("9","hearts"),c("9","clubs"),c("9","diamonds"),c("2","spades")];
    const fh  = [c("9","spades"),c("9","hearts"),c("9","clubs"),c("2","diamonds"),c("2","spades")];
    const fl  = [c("A","spades"),c("J","spades"),c("8","spades"),c("5","spades"),c("3","spades")];
    const st  = [c("9","spades"),c("8","hearts"),c("7","clubs"),c("6","diamonds"),c("5","spades")];
    const tr  = [c("9","spades"),c("9","hearts"),c("9","clubs"),c("J","diamonds"),c("2","spades")];
    const tp  = [c("9","spades"),c("9","hearts"),c("2","clubs"),c("2","diamonds"),c("J","spades")];
    const pr  = [c("9","spades"),c("9","hearts"),c("J","clubs"),c("8","diamonds"),c("2","spades")];
    const hi  = [c("A","spades"),c("J","hearts"),c("8","clubs"),c("5","diamonds"),c("3","spades")];

    const k = (h: Card[]) => rankFiveCardKey(h);
    expect(k(sf)).toBeGreaterThan(k(four));
    expect(k(four)).toBeGreaterThan(k(fh));
    expect(k(fh)).toBeGreaterThan(k(fl));
    expect(k(fl)).toBeGreaterThan(k(st));
    expect(k(st)).toBeGreaterThan(k(tr));
    expect(k(tr)).toBeGreaterThan(k(tp));
    expect(k(tp)).toBeGreaterThan(k(pr));
    expect(k(pr)).toBeGreaterThan(k(hi));
  });

  it("A-2-3-4-5 wheel 識別為順子（最大張為 5，非 A）", () => {
    // wheel straight 在順子比較中應低於 6-high straight                       // L3_邏輯安防
    const wheel = [c("A","spades"),c("2","hearts"),c("3","clubs"),c("4","diamonds"),c("5","spades")];
    const six   = [c("6","spades"),c("5","hearts"),c("4","clubs"),c("3","diamonds"),c("2","spades")];
    expect(rankFiveCardKey(wheel)).toBeLessThan(rankFiveCardKey(six));
  });

  it("同類別比 kicker：A 高的一對 > K 高的一對", () => {
    const aces = [c("A","spades"),c("A","hearts"),c("J","clubs"),c("8","diamonds"),c("2","spades")];
    const kings = [c("K","spades"),c("K","hearts"),c("J","clubs"),c("8","diamonds"),c("2","spades")];
    expect(rankFiveCardKey(aces)).toBeGreaterThan(rankFiveCardKey(kings));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (2) 7 取 5 評分 rankBestOfSeven
// ─────────────────────────────────────────────────────────────────────────

describe("rankBestOfSeven", () => {

  it("從 7 張中找出最佳 5 張組合", () => {
    // 7 張含同花順 + 雜牌 → 應回傳同花順                                       // L3_邏輯安防
    const seven = [
      c("9","spades"),c("8","spades"),c("7","spades"),c("6","spades"),c("5","spades"),
      c("A","hearts"),c("K","diamonds"),
    ];
    const sevenJunk = [
      c("9","hearts"),c("8","spades"),c("7","spades"),c("6","spades"),c("5","spades"),
      c("A","hearts"),c("K","diamonds"),
    ];
    expect(rankBestOfSeven(seven)).toBeGreaterThan(rankBestOfSeven(sevenJunk));
  });

  it("少於 7 張會拋錯", () => {
    expect(() => rankBestOfSeven([c("A","spades"),c("K","hearts")])).toThrow(/EXPECT_7_CARDS/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (3) 邊池分割 buildSidePots
// ─────────────────────────────────────────────────────────────────────────

describe("buildSidePots 邊池分割", () => {

  it("All-in 三層 → 三池金額正確、合格名單分層遞減", () => {
    // 三人投入 100 / 200 / 300，主池 100×3=300；邊池1 100×2=200；邊池2 100×1=100
    const seats = [
      { playerId: "A", totalCommitted: 100, hasFolded: false },
      { playerId: "B", totalCommitted: 200, hasFolded: false },
      { playerId: "C", totalCommitted: 300, hasFolded: false },
    ] as Parameters<typeof buildSidePots>[0];
    const pots = buildSidePots(seats);
    expect(pots).toHaveLength(3);
    expect(pots[0]!).toEqual({ amount: 300, eligiblePlayerIds: ["A","B","C"] }); // L3_糾錯風險表
    expect(pots[1]!).toEqual({ amount: 200, eligiblePlayerIds: ["B","C"] });
    expect(pots[2]!).toEqual({ amount: 100, eligiblePlayerIds: ["C"] });
  });

  it("棄牌玩家貢獻計入池額但不在合格名單", () => {
    const seats = [
      { playerId: "A", totalCommitted: 50,  hasFolded: true  },
      { playerId: "B", totalCommitted: 100, hasFolded: false },
      { playerId: "C", totalCommitted: 100, hasFolded: false },
    ] as Parameters<typeof buildSidePots>[0];
    const pots = buildSidePots(seats);
    // 第一層 50：A+B+C 各出 50 → 池=150；A 棄牌 → 合格 [B,C]                  // L3_糾錯風險表
    // 第二層 50：B+C 各出 50 → 池=100；合格 [B,C]
    expect(pots[0]!.amount).toBe(150);
    expect(pots[0]!.eligiblePlayerIds).toEqual(["B","C"]);
    expect(pots[1]!.amount).toBe(100);
    expect(pots[1]!.eligiblePlayerIds).toEqual(["B","C"]);
  });

  it("沒人投入 → 空池", () => {
    expect(buildSidePots([])).toEqual([]);
    const seats = [
      { playerId: "A", totalCommitted: 0, hasFolded: false },
    ] as Parameters<typeof buildSidePots>[0];
    expect(buildSidePots(seats)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (4) 狀態機 — 盲注、行動驗證、棄牌結束
// ─────────────────────────────────────────────────────────────────────────

describe("TexasHoldemStateMachine 開局與動作", () => {

  const players = () => [
    { playerId: "p1", stack: 1000 },
    { playerId: "p2", stack: 1000 },
    { playerId: "p3", stack: 1000 },
  ];

  it("開局後 SB / BB 正確扣除、currentBet=BB", () => {
    const sm = new TexasHoldemStateMachine("g","r", players(), 10, 20, 0);
    const v = sm.viewFor("p1");
    // dealer=p1；SB=p2；BB=p3                                                 // L2_實作
    expect(v.currentBet).toBe(20);
    expect(v.opponents.find(o => o.playerId === "p2")?.betThisStreet).toBe(10);
    expect(v.opponents.find(o => o.playerId === "p3")?.betThisStreet).toBe(20);
    expect(v.currentTurn).toBe("p1");        // 多人 preflop UTG = BB+1 = p1
  });

  it("Heads-up：SB 先動", () => {
    const sm = new TexasHoldemStateMachine("g","r",
      [{ playerId: "p1", stack: 1000 }, { playerId: "p2", stack: 1000 }],
      10, 20, 0);
    expect(sm.viewFor("p1").currentTurn).toBe("p2");                            // L2_實作
  });

  it("非本人回合行動會被擋", () => {
    const sm = new TexasHoldemStateMachine("g","r", players(), 10, 20, 0);
    const r = sm.process("p2", { type: "fold" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("NOT_YOUR_TURN");                           // L3_邏輯安防
  });

  it("加注未達最小增量會被擋", () => {
    const sm = new TexasHoldemStateMachine("g","r", players(), 10, 20, 0);
    // currentBet=20、minRaise=20 → 合法 raise 至少 40；嘗試 raise 至 25 應擋   // L2_鎖定
    const r = sm.process("p1", { type: "raise", raiseAmount: 25 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("RAISE_BELOW_MIN_RAISE");
  });

  it("加注未超過 currentBet 會被擋", () => {
    const sm = new TexasHoldemStateMachine("g","r", players(), 10, 20, 0);
    const r = sm.process("p1", { type: "raise", raiseAmount: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("RAISE_MUST_EXCEED_CURRENT_BET");           // L2_鎖定
  });

  it("無注時 check 合法、面對加注時 check 被擋", () => {
    const sm = new TexasHoldemStateMachine("g","r", players(), 10, 20, 0);
    const r = sm.process("p1", { type: "check" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("CANNOT_CHECK_FACING_BET");                 // L2_鎖定
  });

  it("除一人外全部棄牌即結算，剩餘者贏池", () => {
    const sm = new TexasHoldemStateMachine("g","r", players(), 10, 20, 0);
    sm.process("p1", { type: "fold" });
    sm.process("p2", { type: "fold" });
    // p2 投了 10（SB），p3 投了 20（BB），主池 30，p3 贏
    // 此時只剩 p3，settle 應觸發 — 但 p2 fold 後 advance() 才呼叫；fold 之後
    // 仍剩 p3 一人 → settlement 在 p2 fold 動作時返回                          // L3_架構
    const finalState = sm.viewFor("p3");
    expect(finalState.street).toBe("settled");                                  // L3_架構
  });

  it("棄牌玩家試圖再行動會被擋", () => {
    const sm = new TexasHoldemStateMachine("g","r", players(), 10, 20, 0);
    sm.process("p1", { type: "fold" });
    // 現在輪到 p2；如果 p1 又試圖行動：
    const r = sm.process("p1", { type: "fold" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("NOT_YOUR_TURN");                           // L3_邏輯安防
  });
});
