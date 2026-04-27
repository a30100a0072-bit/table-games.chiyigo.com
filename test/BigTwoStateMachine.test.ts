// /test/BigTwoStateMachine.test.ts
// Unit test suite — pure logic layer only (zero IO).                    // L2_測試

import { describe, it, expect } from "vitest";
import { BigTwoStateMachine } from "../src/game/BigTwoStateMachine";
import type { MachineSnapshot } from "../src/game/BigTwoStateMachine";
import type { Card } from "../src/types/game";

// ── Test fixture helpers ──────────────────────────────────────────────── L2_測試

/** Build a machine from an explicit snapshot so hands are fully deterministic. */
function fromSnap(overrides: Partial<MachineSnapshot> & {
  hands: [string, Card[]][];
}): BigTwoStateMachine {
  const base: MachineSnapshot = {
    gameId:         "game-test",
    roundId:        "round-test",
    phase:          "playing",
    playerIds:      ["p1", "p2"],
    turnIndex:      0,
    lastPlay:       null,
    lastPlayMeta:   null,
    passCount:      0,
    turnDeadlineMs: Date.now() + 30_000,
    isFirstTurn:    true,
    finishOrder:    [],
    ...overrides,
  };
  return BigTwoStateMachine.restore(base);
}

/** 3♣ — always the opening card in Big Two. */
const THREE_CLUBS: Card = { rank: "3", suit: "clubs" };

// ─────────────────────────────────────────────────────────────────────────
// (1) 合法出牌校驗
// ─────────────────────────────────────────────────────────────────────────

describe("合法出牌校驗", () => {

  it("首輪含 3♣ 的合法 Single 能成功落桌並推進回合", () => {
    // p1 holds 3♣ + 5♥; p2 holds 4♦ + 7♠.                            // L2_測試
    const m = fromSnap({
      hands: [
        ["p1", [THREE_CLUBS, { rank: "5", suit: "hearts" }]],
        ["p2", [{ rank: "4", suit: "diamonds" }, { rank: "7", suit: "spades" }]],
      ],
    });

    const result = m.processAction("p1", { type: "play", cards: [THREE_CLUBS], combo: "single" });

    // No settlement yet — p1 still has 5♥.
    expect(result.settlement).toBeNull();

    // Turn must have advanced to p2.
    const viewP2 = result.viewFor("p2");
    expect(viewP2.currentTurn).toBe("p2");

    // Table reflects the played card.
    expect(viewP2.lastPlay?.combo).toBe("single");
    expect(viewP2.lastPlay?.cards).toHaveLength(1);

    // Perspective isolation: p2 sees p1 card count, not hand contents.  // L2_隔離
    expect(viewP2.opponents[0]!.cardCount).toBe(1);
    expect((viewP2.opponents[0]! as { hand?: unknown }).hand).toBeUndefined();
  });

  it("非首輪 Pair 能正確壓過桌面較低 Pair", () => {
    // Table shows p2's pair of 4s; p1 (whose turn it now is) has a pair of 7s. // L2_測試
    const m = fromSnap({
      playerIds:   ["p1", "p2"],
      turnIndex:   0,
      isFirstTurn: false,
      lastPlay: {
        playerId: "p2",
        cards:    [{ rank: "4", suit: "clubs" }, { rank: "4", suit: "diamonds" }],
        combo:    "pair",
      },
      lastPlayMeta: { type: "pair", score: 4 },   // cardVal of 4♦ = 5
      hands: [
        ["p1", [
          { rank: "7", suit: "hearts" },
          { rank: "7", suit: "spades" },
          { rank: "9", suit: "diamonds" },   // 保留一張，避免打完即結算   // L2_測試
        ]],
        ["p2", [{ rank: "K", suit: "clubs" }]],
      ],
    });

    const result = m.processAction("p1", {
      type:  "play",
      cards: [{ rank: "7", suit: "hearts" }, { rank: "7", suit: "spades" }],
      combo: "pair",
    });

    expect(result.settlement).toBeNull();
    expect(result.viewFor("p2").lastPlay?.combo).toBe("pair");
    expect(result.viewFor("p1").currentTurn).toBe("p2");
  });

  it("snapshot → restore 往返序列化後狀態完整保留", () => {
    // DO hibernation round-trip: snapshot then restore must yield identical view. // L3_架構含防禦觀測
    const m = fromSnap({
      hands: [
        ["p1", [THREE_CLUBS, { rank: "A", suit: "spades" }]],
        ["p2", [{ rank: "2", suit: "hearts" }, { rank: "K", suit: "diamonds" }]],
      ],
    });

    const snap    = m.snapshot();
    const rebuilt = BigTwoStateMachine.restore(snap);

    expect(rebuilt.getView("p1").self.hand).toEqual(m.getView("p1").self.hand);
    expect(rebuilt.getView("p2").self.hand).toEqual(m.getView("p2").self.hand);
    expect(rebuilt.getView("p1").currentTurn).toBe("p1");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (2) 非法牌型阻擋
// ─────────────────────────────────────────────────────────────────────────

describe("非法牌型阻擋", () => {

  it("4 張牌出牌應被阻擋（大老二無 4 張合法牌型）", () => {
    // Big Two has no 4-card combo class — detectCombo returns null.     // L3_邏輯安防
    const m = fromSnap({
      isFirstTurn: false,
      lastPlay:     null,
      lastPlayMeta: null,
      hands: [
        ["p1", [
          { rank: "5", suit: "clubs" },
          { rank: "5", suit: "diamonds" },
          { rank: "5", suit: "hearts" },
          { rank: "5", suit: "spades" },
        ]],
        ["p2", [{ rank: "2", suit: "spades" }]],
      ],
    });

    expect(() => m.processAction("p1", {
      type:  "play",
      cards: [
        { rank: "5", suit: "clubs" },
        { rank: "5", suit: "diamonds" },
        { rank: "5", suit: "hearts" },
        { rank: "5", suit: "spades" },
      ],
      combo: "fourOfAKind",
    })).toThrow(/illegal combo/i);                                       // L3_邏輯安防
  });

  it("Pair 張數正確但花色不同 rank 的偽 Pair 應被阻擋", () => {
    // Two cards with different ranks cannot form a pair.                // L3_邏輯安防
    const m = fromSnap({
      isFirstTurn: false,
      lastPlay:     null,
      lastPlayMeta: null,
      hands: [
        ["p1", [
          { rank: "6", suit: "clubs" },
          { rank: "7", suit: "diamonds" },
        ]],
        ["p2", [{ rank: "2", suit: "spades" }]],
      ],
    });

    expect(() => m.processAction("p1", {
      type:  "play",
      cards: [{ rank: "6", suit: "clubs" }, { rank: "7", suit: "diamonds" }],
      combo: "pair",
    })).toThrow(/illegal combo/i);                                       // L3_邏輯安防
  });

  it("出不在手牌中的牌應被阻擋", () => {
    // Cards physically absent from hand must be rejected.               // L3_邏輯安防
    const m = fromSnap({
      isFirstTurn: false,
      lastPlay:     null,
      lastPlayMeta: null,
      hands: [
        ["p1", [{ rank: "5", suit: "hearts" }]],
        ["p2", [{ rank: "2", suit: "spades" }]],
      ],
    });

    expect(() => m.processAction("p1", {
      type:  "play",
      cards: [{ rank: "A", suit: "clubs" }], // p1 does not own A♣      // L3_邏輯安防
      combo: "single",
    })).toThrow(/card not in hand/i);
  });

  it("非本人回合出牌應被阻擋", () => {
    // Out-of-turn actions are rejected before any card validation.      // L3_邏輯安防
    const m = fromSnap({
      hands: [
        ["p1", [THREE_CLUBS]],
        ["p2", [{ rank: "4", suit: "diamonds" }]],
      ],
    });

    // turnIndex = 0 → p1's turn; p2 attempting to play should fail.
    expect(() => m.processAction("p2", {
      type:  "play",
      cards: [{ rank: "4", suit: "diamonds" }],
      combo: "single",
    })).toThrow(/out-of-turn/i);
  });

  it("壓不過桌面的牌型應被阻擋", () => {
    // Played single must beat the current single on the table.          // L3_邏輯安防
    const m = fromSnap({
      isFirstTurn: false,
      lastPlay: {
        playerId: "p1",
        cards:    [{ rank: "A", suit: "spades" }],
        combo:    "single",
      },
      lastPlayMeta: { type: "single", score: 11 * 4 + 3 }, // A♠ high score
      hands: [
        ["p2", [{ rank: "5", suit: "clubs" }]],
        ["p1", [{ rank: "K", suit: "hearts" }]],
      ],
      turnIndex: 0,   // p2's turn
      playerIds: ["p2", "p1"],
    });

    expect(() => m.processAction("p2", {
      type:  "play",
      cards: [{ rank: "5", suit: "clubs" }],
      combo: "single",
    })).toThrow(/not stronger/i);                                        // L3_邏輯安防
  });

  it("首輪出牌不含 3♣ 應被阻擋", () => {
    const m = fromSnap({
      hands: [
        ["p1", [THREE_CLUBS, { rank: "5", suit: "hearts" }]],
        ["p2", [{ rank: "4", suit: "diamonds" }]],
      ],
    });

    // p1 tries to play 5♥ without 3♣ on the opening turn.
    expect(() => m.processAction("p1", {
      type:  "play",
      cards: [{ rank: "5", suit: "hearts" }],
      combo: "single",
    })).toThrow(/3 of clubs/i);                                          // L3_邏輯安防
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (3) 遊戲結束與結算觸發
// ─────────────────────────────────────────────────────────────────────────

describe("遊戲結束與結算觸發", () => {

  it("打出最後一張牌時立即觸發 lastCardPlayed 結算", () => {
    // p1 holds only 3♣; playing it wins the round immediately.         // L2_測試
    const m = fromSnap({
      hands: [
        ["p1", [THREE_CLUBS]],
        ["p2", [{ rank: "K", suit: "clubs" }, { rank: "A", suit: "hearts" }]],
      ],
    });

    const { settlement } = m.processAction("p1", {
      type:  "play",
      cards: [THREE_CLUBS],
      combo: "single",
    });

    expect(settlement).not.toBeNull();
    expect(settlement!.reason).toBe("lastCardPlayed");
    expect(settlement!.winnerId).toBe("p1");
    expect(settlement!.players).toHaveLength(2);

    // Winner has rank 1, no remaining cards.
    const winner = settlement!.players.find(p => p.playerId === "p1")!;
    expect(winner.finalRank).toBe(1);
    expect(winner.remainingCards).toHaveLength(0);

    // Loser's scoreDelta is negative (remaining cards count).
    const loser = settlement!.players.find(p => p.playerId === "p2")!;
    expect(loser.scoreDelta).toBeLessThan(0);
    expect(loser.remainingCards).toHaveLength(2);
  });

  it("forceSettle(timeout) 應立即結算並標記正確原因", () => {
    // DO calls forceSettle when the turn alarm fires.                   // L3_架構含防禦觀測
    const m = fromSnap({
      hands: [
        ["p1", [THREE_CLUBS, { rank: "5", suit: "hearts" }]],
        ["p2", [{ rank: "4", suit: "diamonds" }]],
      ],
    });

    const settlement = m.forceSettle("timeout");

    expect(settlement.reason).toBe("timeout");
    expect(settlement.gameId).toBe("game-test");
    expect(settlement.players).toHaveLength(2);
    // After forceSettle the machine is settled; further actions must throw.
    expect(() => m.forceSettle("disconnect")).toThrow(/already settled/i); // L3_邏輯安防
  });

  it("forceSettle(disconnect) 後視角快照 phase 變為 settled", () => {
    const m = fromSnap({
      hands: [
        ["p1", [THREE_CLUBS]],
        ["p2", [{ rank: "2", suit: "spades" }]],
      ],
    });

    m.forceSettle("disconnect");

    expect(m.getView("p1").phase).toBe("settled");
    expect(m.getView("p2").phase).toBe("settled");
  });

  it("勝者 scoreDelta 等於所有敗者剩餘牌張數之和", () => {
    // Score accounting integrity check.                                 // L2_測試
    const m = fromSnap({
      hands: [
        ["p1", [THREE_CLUBS]],               // 0 remaining after win
        ["p2", [
          { rank: "8", suit: "clubs" },
          { rank: "9", suit: "hearts" },
          { rank: "10", suit: "diamonds" },
        ]],
      ],
    });

    const { settlement } = m.processAction("p1", {
      type: "play", cards: [THREE_CLUBS], combo: "single",
    });

    const winner    = settlement!.players.find(p => p.playerId === "p1")!;
    const loserCards = settlement!.players
      .filter(p => p.playerId !== "p1")
      .reduce((sum, p) => sum + p.remainingCards.length, 0);

    expect(winner.scoreDelta).toBe(loserCards);                         // L2_測試
  });
});
