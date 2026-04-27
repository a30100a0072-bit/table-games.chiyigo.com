// /test/BotAI.test.ts
// Unit tests for the three game bots — pure functions, no IO.                    // L2_測試

import { describe, it, expect } from "vitest";
import {
  getBigTwoBotAction,
  getMahjongBotAction,
  getTexasBotAction,
} from "../src/game/BotAI";
import type {
  Card, GameStateView, MahjongStateView, MahjongTile, PokerStateView,
} from "../src/types/game";

// ════════════════════════════════════════════════════════════════════════════
//  Big Two
// ════════════════════════════════════════════════════════════════════════════

function bigTwoView(over: Partial<GameStateView> = {}): GameStateView {
  return {
    gameId: "g", roundId: "r", phase: "playing",
    self: { playerId: "BOT_1", hand: [], cardCount: 0 },
    opponents: [],
    currentTurn: "BOT_1",
    lastPlay: null,
    passCount: 0,
    turnDeadlineMs: Date.now() + 30_000,
    ...over,
  };
}

describe("Big Two bot", () => {
  it("opens with 3♣ when present (table clear)", () => {
    const hand: Card[] = [
      { rank: "3", suit: "clubs" },
      { rank: "5", suit: "hearts" },
      { rank: "K", suit: "diamonds" },
    ];
    const v = bigTwoView({ self: { playerId: "BOT_1", hand, cardCount: hand.length } });
    const a = getBigTwoBotAction(v, hand);
    expect(a.type).toBe("play");
    if (a.type === "play") {
      expect(a.combo).toBe("single");
      expect(a.cards[0]).toEqual({ rank: "3", suit: "clubs" });
    }
  });

  it("beats a single 5♦ with the smallest beating card (6♥)", () => {
    const hand: Card[] = [
      { rank: "6", suit: "hearts" },     // smallest beat
      { rank: "K", suit: "spades" },
      { rank: "2", suit: "clubs" },
    ];
    const v = bigTwoView({
      lastPlay: { playerId: "p2", cards: [{ rank: "5", suit: "diamonds" }], combo: "single" },
      self: { playerId: "BOT_1", hand, cardCount: hand.length },
    });
    const a = getBigTwoBotAction(v, hand);
    expect(a.type).toBe("play");
    if (a.type === "play") {
      expect(a.cards).toEqual([{ rank: "6", suit: "hearts" }]);
    }
  });

  it("PASSes when no card can beat the table", () => {
    const hand: Card[] = [
      { rank: "3", suit: "clubs" },
      { rank: "4", suit: "hearts" },
    ];
    const v = bigTwoView({
      lastPlay: { playerId: "p2", cards: [{ rank: "2", suit: "spades" }], combo: "single" },
      self: { playerId: "BOT_1", hand, cardCount: hand.length },
    });
    expect(getBigTwoBotAction(v, hand).type).toBe("pass");
  });

  it("beats a 5-card flush with a straight flush from a mixed hand", () => {
    // Table: 6♣7♣9♣10♣K♣ flush. Bot has 3-7 of clubs (straight flush).            // L3_邏輯安防
    const hand: Card[] = [
      { rank: "3", suit: "clubs" },
      { rank: "4", suit: "clubs" },
      { rank: "5", suit: "clubs" },
      { rank: "6", suit: "clubs" },
      { rank: "7", suit: "clubs" },
      { rank: "9", suit: "hearts" },
      { rank: "J", suit: "diamonds" },
    ];
    const tableFlush: Card[] = [
      { rank: "6", suit: "diamonds" },
      { rank: "7", suit: "diamonds" },
      { rank: "9", suit: "diamonds" },
      { rank: "10", suit: "diamonds" },
      { rank: "K", suit: "diamonds" },
    ];
    const v = bigTwoView({
      lastPlay: { playerId: "p2", cards: tableFlush, combo: "flush" },
      self: { playerId: "BOT_1", hand, cardCount: hand.length },
    });
    const a = getBigTwoBotAction(v, hand);
    expect(a.type).toBe("play");
    if (a.type === "play") {
      expect(a.combo).toBe("straightFlush");
      expect(a.cards).toHaveLength(5);
      // All clubs, ranks 3..7
      const ranks = a.cards.map(c => c.rank).sort();
      expect(ranks).toEqual(["3", "4", "5", "6", "7"]);
    }
  });

  it("PASSes when 5-card combo is on table and bot has no 5-card combo at all", () => {
    const hand: Card[] = [
      { rank: "3", suit: "clubs" },
      { rank: "5", suit: "hearts" },
      { rank: "9", suit: "diamonds" },
      { rank: "K", suit: "spades" },
    ];
    const v = bigTwoView({
      lastPlay: {
        playerId: "p2",
        cards: [
          { rank: "5", suit: "spades" },
          { rank: "5", suit: "hearts" },
          { rank: "5", suit: "diamonds" },
          { rank: "9", suit: "clubs" },
          { rank: "9", suit: "spades" },
        ],
        combo: "fullHouse",
      },
      self: { playerId: "BOT_1", hand, cardCount: hand.length },
    });
    expect(getBigTwoBotAction(v, hand).type).toBe("pass");
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Mahjong
// ════════════════════════════════════════════════════════════════════════════

const m = (rank: number): MahjongTile => ({ suit: "m", rank });
const p = (rank: number): MahjongTile => ({ suit: "p", rank });
const s = (rank: number): MahjongTile => ({ suit: "s", rank });
const z = (rank: number): MahjongTile => ({ suit: "z", rank });

function mahjongView(over: Partial<MahjongStateView> & {
  hand: MahjongTile[];
  phase: MahjongStateView["phase"];
}): MahjongStateView {
  return {
    gameId: "g", roundId: "r",
    phase: over.phase,
    self: {
      playerId: "BOT_1",
      hand: over.hand,
      exposed: [],
      flowers: [],
    },
    opponents: [],
    wall: { remaining: 50 },
    currentTurn: over.currentTurn ?? "BOT_1",
    lastDiscard: over.lastDiscard ?? null,
    awaitingReactionsFrom: over.awaitingReactionsFrom ?? [],
    reactionDeadlineMs: over.reactionDeadlineMs ?? 0,
    turnDeadlineMs: over.turnDeadlineMs ?? Date.now() + 15_000,
  };
}

describe("Mahjong bot", () => {
  it("declares self-drawn hu when 17 tiles already make a winning hand", () => {
    // 5 chows + 1 pair + drawn → 17 tiles                                          // L2_測試
    const hand: MahjongTile[] = [
      m(1), m(2), m(3),
      m(4), m(5), m(6),
      p(1), p(2), p(3),
      p(7), p(8), p(9),
      s(2), s(3), s(4),
      z(5), z(5),
    ];
    const v = mahjongView({ phase: "playing", hand });
    const a = getMahjongBotAction(v);
    expect(a.type).toBe("hu");
    if (a.type === "hu") expect(a.selfDrawn).toBe(true);
  });

  it("declares food-hu when discard completes a winning hand", () => {
    // 16 tiles missing only z(5) to complete the pair                              // L2_測試
    const hand: MahjongTile[] = [
      m(1), m(2), m(3),
      m(4), m(5), m(6),
      p(1), p(2), p(3),
      p(7), p(8), p(9),
      s(2), s(3), s(4),
      z(5),
    ];
    const v = mahjongView({
      phase: "pending_reactions",
      hand,
      currentTurn: "p2",
      lastDiscard: { playerId: "p2", tile: z(5) },
      awaitingReactionsFrom: ["BOT_1"],
    });
    const a = getMahjongBotAction(v);
    expect(a.type).toBe("hu");
    if (a.type === "hu") expect(a.selfDrawn).toBe(false);
  });

  it("passes on a discard that does not complete a winning hand", () => {
    const hand: MahjongTile[] = Array.from({ length: 16 }, (_, i) => m(((i % 9) + 1)));
    const v = mahjongView({
      phase: "pending_reactions",
      hand,
      currentTurn: "p2",
      lastDiscard: { playerId: "p2", tile: z(7) },     // unrelated honor
      awaitingReactionsFrom: ["BOT_1"],
    });
    expect(getMahjongBotAction(v).type).toBe("mj_pass");
  });

  it("discards an isolated honor tile before a connected suited tile", () => {
    // 17 tiles: clearly-not-winning hand with one lone honor and otherwise connected suited groups // L3_邏輯安防
    const hand: MahjongTile[] = [
      z(7),                                  // lone honor — should be discarded
      m(1), m(2), m(3),
      m(4), m(5), m(6),
      p(1), p(2), p(3),
      p(4), p(5), p(6),
      s(7), s(8), s(9),
      s(2),
    ];
    const v = mahjongView({ phase: "playing", hand });
    const a = getMahjongBotAction(v);
    expect(a.type).toBe("discard");
    if (a.type === "discard") {
      expect(a.tile).toEqual(z(7));
    }
  });

  it("returns mj_pass defensively when called outside a valid action context", () => {
    const hand: MahjongTile[] = [m(1)];
    const v = mahjongView({
      phase: "pending_reactions",
      hand,
      currentTurn: "p3",
      lastDiscard: { playerId: "p3", tile: m(9) },
      awaitingReactionsFrom: ["someoneElse"],          // bot not in waiting list
    });
    expect(getMahjongBotAction(v).type).toBe("mj_pass");
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Texas Hold'em
// ════════════════════════════════════════════════════════════════════════════

function texasView(over: Partial<PokerStateView> & {
  hole: [Card, Card];
  street: PokerStateView["street"];
}): PokerStateView {
  return {
    gameId: "g", roundId: "r",
    street: over.street,
    self: {
      playerId: "BOT_1",
      holeCards: over.hole,
      stack: 1000,
      betThisStreet: 0,
      totalCommitted: 0,
      hasFolded: false,
      isAllIn: false,
      ...((over.self ?? {}) as object),
    },
    opponents: over.opponents ?? [],
    communityCards: over.communityCards ?? [],
    pots: over.pots ?? [{ amount: 30, eligiblePlayerIds: ["BOT_1", "p2"] }],
    currentBet: over.currentBet ?? 0,
    minRaise: over.minRaise ?? 20,
    bigBlind: over.bigBlind ?? 20,
    smallBlind: over.smallBlind ?? 10,
    dealerIdx: over.dealerIdx ?? 0,
    currentTurn: over.currentTurn ?? "BOT_1",
    turnDeadlineMs: over.turnDeadlineMs ?? Date.now() + 20_000,
  };
}

describe("Texas Hold'em bot", () => {
  it("raises pre-flop with pocket aces", () => {
    const v = texasView({
      street: "preflop",
      hole: [{ rank: "A", suit: "spades" }, { rank: "A", suit: "hearts" }],
      currentBet: 20,
      self: { betThisStreet: 0 } as PokerStateView["self"],
    });
    const a = getTexasBotAction(v);
    expect(a.type).toBe("raise");
    if (a.type === "raise") {
      expect(a.raiseAmount).toBeGreaterThan(20);
    }
  });

  it("folds 7-2 offsuit pre-flop when facing a bet", () => {
    const v = texasView({
      street: "preflop",
      hole: [{ rank: "7", suit: "clubs" }, { rank: "2", suit: "diamonds" }],
      currentBet: 60,                            // facing a raise
      self: { betThisStreet: 20 } as PokerStateView["self"],
    });
    expect(getTexasBotAction(v).type).toBe("fold");
  });

  it("checks pre-flop trash when no bet to call", () => {
    const v = texasView({
      street: "preflop",
      hole: [{ rank: "7", suit: "clubs" }, { rank: "2", suit: "diamonds" }],
      currentBet: 20,
      self: { betThisStreet: 20 } as PokerStateView["self"],   // already matched (BB walks)
    });
    expect(getTexasBotAction(v).type).toBe("check");
  });

  it("raises post-flop when holding trips", () => {
    const v = texasView({
      street: "flop",
      hole: [{ rank: "9", suit: "spades" }, { rank: "9", suit: "hearts" }],
      communityCards: [
        { rank: "9", suit: "diamonds" },
        { rank: "K", suit: "clubs" },
        { rank: "2", suit: "spades" },
      ],
      currentBet: 0,
      self: { betThisStreet: 0 } as PokerStateView["self"],
    });
    const a = getTexasBotAction(v);
    expect(a.type).toBe("raise");
  });

  it("folds high-card trash post-flop facing a large bet", () => {
    const v = texasView({
      street: "river",
      hole: [{ rank: "7", suit: "clubs" }, { rank: "2", suit: "diamonds" }],
      communityCards: [
        { rank: "K", suit: "spades" },
        { rank: "Q", suit: "hearts" },
        { rank: "9", suit: "diamonds" },
        { rank: "5", suit: "clubs" },
        { rank: "3", suit: "hearts" },
      ],
      currentBet: 200,
      self: { betThisStreet: 0 } as PokerStateView["self"],
      pots: [{ amount: 100, eligiblePlayerIds: ["BOT_1", "p2"] }],
    });
    expect(getTexasBotAction(v).type).toBe("fold");
  });
});
