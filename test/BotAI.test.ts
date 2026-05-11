// /test/BotAI.test.ts
// Unit tests for the three game bots — pure functions, no IO.                    // L2_測試

import { describe, it, expect } from "vitest";
import {
  getBigTwoBotAction,
  getMahjongBotAction,
  getTexasBotAction,
  getHeartsBotAction,
} from "../src/game/BotAI";
import type {
  Card, GameStateView, MahjongStateView, MahjongTile, PokerStateView,
  HeartsStateView, HeartsTrickPlay, PlayerId,
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

  // Endgame "single-shot win" leads — the entire hand IS the combo,
  // so dumping it ends the game immediately if nobody beats it.
  it("leads the pair when hand is exactly two cards of the same rank", () => {
    const hand: Card[] = [
      { rank: "K", suit: "hearts" },
      { rank: "K", suit: "spades" },
    ];
    const v = bigTwoView({ self: { playerId: "BOT_1", hand, cardCount: 2 } });
    const a = getBigTwoBotAction(v, hand);
    expect(a.type).toBe("play");
    if (a.type !== "play") return;
    expect(a.combo).toBe("pair");
    expect(a.cards).toHaveLength(2);
  });

  it("leads the triple when hand is exactly three cards of the same rank", () => {
    const hand: Card[] = [
      { rank: "9", suit: "hearts" },
      { rank: "9", suit: "spades" },
      { rank: "9", suit: "diamonds" },
    ];
    const v = bigTwoView({ self: { playerId: "BOT_1", hand, cardCount: 3 } });
    const a = getBigTwoBotAction(v, hand);
    expect(a.type).toBe("play");
    if (a.type !== "play") return;
    expect(a.combo).toBe("triple");
    expect(a.cards).toHaveLength(3);
  });

  it("leads the 5-card combo when hand is exactly a valid 5", () => {
    // 4-5-6-7-8 straight (no 3♣ to trigger the opening rule).
    const hand: Card[] = [
      { rank: "4", suit: "hearts" },
      { rank: "5", suit: "spades" },
      { rank: "6", suit: "diamonds" },
      { rank: "7", suit: "clubs" },
      { rank: "8", suit: "hearts" },
    ];
    const v = bigTwoView({ self: { playerId: "BOT_1", hand, cardCount: 5 } });
    const a = getBigTwoBotAction(v, hand);
    expect(a.type).toBe("play");
    if (a.type !== "play") return;
    expect(a.cards).toHaveLength(5);
    expect(a.combo).toBe("straight");
  });

  it("leads the highest single when an opponent has exactly 1 card left", () => {
    // 3-card hand 5/9/K with opp on 1 card → play K to deny their winning trick.
    const hand: Card[] = [
      { rank: "5", suit: "hearts" },
      { rank: "9", suit: "spades" },
      { rank: "K", suit: "diamonds" },
    ];
    const v = bigTwoView({
      self: { playerId: "BOT_1", hand, cardCount: 3 },
      opponents: [
        { playerId: "p2", cardCount: 1, exposedMelds: [], flowerCount: 0 } as never,
        { playerId: "p3", cardCount: 5, exposedMelds: [], flowerCount: 0 } as never,
      ],
    });
    const a = getBigTwoBotAction(v, hand);
    expect(a.type).toBe("play");
    if (a.type !== "play") return;
    expect(a.cards).toEqual([{ rank: "K", suit: "diamonds" }]);
    expect(a.combo).toBe("single");
  });

  it("ignores threat heuristic when no opponent is at 1 card", () => {
    // Same hand; opp at 5 cards → falls through to isolated-non-2 (lowest), here 5♥.
    const hand: Card[] = [
      { rank: "5", suit: "hearts" },
      { rank: "9", suit: "spades" },
      { rank: "K", suit: "diamonds" },
    ];
    const v = bigTwoView({
      self: { playerId: "BOT_1", hand, cardCount: 3 },
      opponents: [
        { playerId: "p2", cardCount: 5, exposedMelds: [], flowerCount: 0 } as never,
      ],
    });
    const a = getBigTwoBotAction(v, hand);
    expect(a.type).toBe("play");
    if (a.type !== "play") return;
    expect(a.cards).toEqual([{ rank: "5", suit: "hearts" }]);
  });

  it("falls back to single lead when 2-card hand isn't a pair", () => {
    const hand: Card[] = [
      { rank: "9", suit: "hearts" },
      { rank: "K", suit: "spades" },
    ];
    const v = bigTwoView({ self: { playerId: "BOT_1", hand, cardCount: 2 } });
    const a = getBigTwoBotAction(v, hand);
    expect(a.type).toBe("play");
    if (a.type !== "play") return;
    expect(a.combo).toBe("single");
    expect(a.cards).toEqual([{ rank: "9", suit: "hearts" }]);  // smallest non-2
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
      shanten: 0,
      winningTiles: [],
    },
    opponents: over.opponents ?? [],
    wall: { remaining: 50 },
    currentTurn: over.currentTurn ?? "BOT_1",
    lastDiscard: over.lastDiscard ?? null,
    seatOrder: over.seatOrder ?? ["p4", "BOT_1", "p2", "p3"],   // p4→BOT_1 ⇒ BOT_1 是 p4 下家（吃合法） // L2_測試
    awaitingReactionsFrom: over.awaitingReactionsFrom ?? [],
    kongUpgradeInProgress: over.kongUpgradeInProgress ?? false,
    reactionDeadlineMs: over.reactionDeadlineMs ?? 0,
    turnDeadlineMs: over.turnDeadlineMs ?? Date.now() + 15_000,
    match: over.match ?? { handNumber: 1, targetHands: 1, dealerIdx: 0, bankerStreak: 0 },
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

  it("kong-upgrades the discard when already holding 3 of the same tile", () => {
    // Hand has 3× s(5) + 13 other tiles. Opponent discards s(5) — kong is
    // strictly better than pong (uses all 4, gains replacement draw + 1 fan).
    const hand: MahjongTile[] = [
      s(5), s(5), s(5),               // the kong-able trio
      m(1), m(2), m(3),
      p(1), p(2), p(3),
      p(7), p(8), p(9),
      z(1),
    ];
    const v = mahjongView({
      phase: "pending_reactions",
      hand,
      currentTurn: "p2",
      lastDiscard: { playerId: "p2", tile: s(5) },
      awaitingReactionsFrom: ["BOT_1"],
    });
    const a = getMahjongBotAction(v);
    expect(a.type).toBe("kong");
    if (a.type !== "kong") return;
    expect(a.tile).toEqual(s(5));
    expect(a.source).toBe("exposed");
  });

  it("avoids discarding a tile that would let an opponent kong-upgrade", () => {
    // Bot's only "isolated" tile is z(7). An opponent has an exposed pong of
    // z(7), so discarding it would feed a kong (gain a tile + 1 fan). With
    // the danger penalty, the bot picks the next-most-isolated instead — s(2).
    const hand: MahjongTile[] = [
      z(7),                                  // would normally be the isolated discard
      m(1), m(2), m(3),
      m(4), m(5), m(6),
      p(1), p(2), p(3),
      p(4), p(5), p(6),
      s(7), s(8), s(9),
      s(2),                                  // next-best: lone within suited s
    ];
    const v = mahjongView({
      phase: "playing",
      hand,
      opponents: [
        {
          playerId: "p2", handCount: 13,
          exposed: [{ kind: "pong", tiles: [z(7), z(7), z(7)] }],
          flowers: [],
        } as never,
      ],
    });
    const a = getMahjongBotAction(v);
    expect(a.type).toBe("discard");
    if (a.type !== "discard") return;
    // We don't pin which non-z(7) tile gets discarded — only that it isn't z(7).
    expect(a.tile).not.toEqual(z(7));
  });

  it("pongs a discard when it strictly reduces shanten", () => {
    // 16-tile hand: pair of m(5) + lots of isolated junk. Pong-ing m(5)
    // converts a partial pair (1 progress) into a complete set (2 progress)
    // while consuming 2 tiles → shanten drops by 1.
    const hand: MahjongTile[] = [
      m(5), m(5),                            // the pair to pong
      m(1), p(2), p(7), s(3), s(6), s(9),
      z(1), z(2), z(3), z(4), z(5), z(6), z(7), p(4),
    ];
    const v = mahjongView({
      phase: "pending_reactions",
      hand,
      currentTurn: "p2",
      lastDiscard: { playerId: "p2", tile: m(5) },
      awaitingReactionsFrom: ["BOT_1"],
    });
    expect(getMahjongBotAction(v).type).toBe("pong");
  });

  it("passes on a pong that would worsen shanten (sacrifices the only pair)", () => {
    // Tenpai hand: 4 complete chows + pair s(3)s(3) + partial s(7)s(8).
    // Ponging s(3) consumes the pair → lose pair claim, gain a set we
    // already had progress for; shanten goes 0 → 1. Bot should pass.
    const hand: MahjongTile[] = [
      m(1), m(2), m(3),
      m(4), m(5), m(6),
      m(7), m(8), m(9),
      p(1), p(2), p(3),
      s(3), s(3),                                  // the only pair
      s(7), s(8),                                  // partial chow draw
    ];
    const v = mahjongView({
      phase: "pending_reactions",
      hand,
      currentTurn: "p2",
      lastDiscard: { playerId: "p2", tile: s(3) },
      awaitingReactionsFrom: ["BOT_1"],
    });
    expect(getMahjongBotAction(v).type).toBe("mj_pass");
  });

  it("avoids discarding into the suit of an opponent with ≥3 exposed melds", () => {
    // Opponent has 3 exposed pongs all in 'p' (pin) — imminent threat in p suit.
    // Bot's hand has two equally-isolated candidates: p(2) and z(7) (both lone).
    // Without defensive discard the bot might pick either; with soft-danger
    // suit penalty it should prefer z(7).
    const hand: MahjongTile[] = [
      p(2),                                  // soft-danger (p suit)
      z(7),                                  // safe honor
      m(1), m(2), m(3),
      m(4), m(5), m(6),
      m(7), m(8), m(9),
      s(1), s(2), s(3),
      s(7), s(8),
    ];
    const v = mahjongView({
      phase: "playing",
      hand,
      opponents: [
        {
          playerId: "p2", handCount: 7,
          exposed: [
            { kind: "pong", tiles: [p(1), p(1), p(1)] },
            { kind: "pong", tiles: [p(5), p(5), p(5)] },
            { kind: "pong", tiles: [p(9), p(9), p(9)] },
          ],
          flowers: [],
        } as never,
      ],
    });
    const a = getMahjongBotAction(v);
    expect(a.type).toBe("discard");
    if (a.type !== "discard") return;
    expect(a.tile).toEqual(z(7));
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

  it("passes on a chow window when bot isn't the discarder's next seat", () => {
    // BOT_1 holds s(4) s(5) which would normally chow s(6). With default
    // seatOrder [p4, BOT_1, p2, p3] the next seat after p3 is p4 (not
    // BOT_1), so a chow attempt would be rejected by ONLY_NEXT_PLAYER_CAN_CHOW.
    // The bot must pass instead.                                          // L3_邏輯安防
    const hand: MahjongTile[] = [
      s(4), s(5),
      m(1), m(2), m(3), m(4), m(5), m(6), m(7), m(8), m(9),
      p(1), p(2), p(3), z(1), z(2),
    ];
    const v = mahjongView({
      phase: "pending_reactions",
      hand,
      currentTurn: "p3",
      lastDiscard: { playerId: "p3", tile: s(6) },     // p3 → next is p4, not BOT_1
      awaitingReactionsFrom: ["BOT_1"],
    });
    expect(getMahjongBotAction(v).type).toBe("mj_pass");
  });

  it("passes during a chiang-kong window even when pong would otherwise reduce shanten", () => {
    // Same setup as the pong-reduces-shanten test, but with
    // kongUpgradeInProgress=true. SM only allows hu / pass in a chiang-kong
    // window; everything else is rejected. Hu is not possible here so the
    // bot must pass.                                                       // L3_邏輯安防
    const hand: MahjongTile[] = [
      m(5), m(5),
      m(1), p(2), p(7), s(3), s(6), s(9),
      z(1), z(2), z(3), z(4), z(5), z(6), z(7), p(4),
    ];
    const v = mahjongView({
      phase: "pending_reactions",
      hand,
      currentTurn: "p2",
      lastDiscard: { playerId: "p2", tile: m(5) },
      awaitingReactionsFrom: ["BOT_1"],
      kongUpgradeInProgress: true,
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
      seatIdx: 0,                          // default: button (late position)
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

  it("calls preflop with a marginal hand from the button (late position) that it'd fold from UTG", () => {
    // KQ offsuit Chen score: hi=13 → baseHi=8, gap=0, kicker bonus 0 → 8 (un-suited).
    // With +1 raise threshold (UTG, score≥10) → falls into score≥8, but UTG sees
    // 8 < 7+1=8 strictly? 8 >= 8 → call. Hmm. Let me pick a hand that splits
    // cleanly: KJ offsuit (Chen ≈ 6) — adj-1 button calls (≥6), adj+1 UTG folds
    // unless cheap. We force a non-cheap call price (3 BB) so UTG falls through.
    const hole: [Card, Card] = [
      { rank: "K", suit: "hearts" },
      { rank: "J", suit: "spades" },
    ];
    const baseV = texasView({
      street: "preflop",
      hole,
      currentBet: 60,
      bigBlind: 20,
      // 3 BB raise — too pricy for UTG marginal but a button can still call (score ≥ 5+(-1)=4).
      self: { betThisStreet: 0, seatIdx: 0 } as PokerStateView["self"],   // button
      opponents: [
        { playerId: "p2" } as never,
        { playerId: "p3" } as never,
        { playerId: "p4" } as never,
      ],
      dealerIdx: 0,
    });
    const buttonAction = getTexasBotAction(baseV);
    expect(buttonAction.type).toBe("call");

    // Same hand from UTG (offset = total - 1 = 3): tighten by +1 → score 6 < 7+1
    // and < 9+1; falls to "marginal score≥5+1=6" branch but owe (60) > 1.5*BB (30) → fold.
    const utgV: PokerStateView = {
      ...baseV,
      self: { ...baseV.self, seatIdx: 3 },
    };
    const utgAction = getTexasBotAction(utgV);
    expect(utgAction.type).toBe("fold");
  });

  it("calls a cheap bet on the flop with an open-ended straight draw", () => {
    // Hole 6♣ 7♦ + flop 5♥ 8♠ K♣ → 5-6-7-8 OESD (8 outs: 4 / 9).
    // Pot 100, owe 20 → 20/120 = 0.167 < 0.20 threshold.
    const v = texasView({
      street: "flop",
      hole: [{ rank: "6", suit: "clubs" }, { rank: "7", suit: "diamonds" }],
      communityCards: [
        { rank: "5", suit: "hearts" },
        { rank: "8", suit: "spades" },
        { rank: "K", suit: "clubs" },
      ],
      currentBet: 20,
      self: { betThisStreet: 0 } as PokerStateView["self"],
      pots: [{ amount: 100, eligiblePlayerIds: ["BOT_1", "p2"] }],
    });
    expect(getTexasBotAction(v).type).toBe("call");
  });

  it("does not raise paired-board trips with a weak kicker (K-K-7 + K-4)", () => {
    // Board pairs Ks; we have K-4 → trips Ks with kicker 4. Anyone with K-X
    // where X>4 dominates us. Bot should call, not fire a raise.
    const v = texasView({
      street: "flop",
      hole: [{ rank: "K", suit: "clubs" }, { rank: "4", suit: "diamonds" }],
      communityCards: [
        { rank: "K", suit: "spades" },
        { rank: "K", suit: "hearts" },
        { rank: "7", suit: "diamonds" },
      ],
      currentBet: 20,
      self: { betThisStreet: 0 } as PokerStateView["self"],
      pots: [{ amount: 100, eligiblePlayerIds: ["BOT_1", "p2"] }],
    });
    expect(getTexasBotAction(v).type).toBe("call");
  });

  it("still raises paired-board trips when kicker is strong (K-K-7 + K-A)", () => {
    // K-A has the nut kicker — no domination concern, value-bet.
    const v = texasView({
      street: "flop",
      hole: [{ rank: "K", suit: "clubs" }, { rank: "A", suit: "diamonds" }],
      communityCards: [
        { rank: "K", suit: "spades" },
        { rank: "K", suit: "hearts" },
        { rank: "7", suit: "diamonds" },
      ],
      currentBet: 0,
      self: { betThisStreet: 0 } as PokerStateView["self"],
    });
    expect(getTexasBotAction(v).type).toBe("raise");
  });

  it("does not raise trips-on-board (9-9-9-K-2) when our hole is small (Q-J)", () => {
    // Three 9s on board → everyone has trips. Kicker is top-of-hole; Q-J both
    // < K so we have no edge. Bot should check rather than raise into a board
    // that can hide AK / AA / KK / pocket pairs.
    const v = texasView({
      street: "river",
      hole: [{ rank: "Q", suit: "clubs" }, { rank: "J", suit: "diamonds" }],
      communityCards: [
        { rank: "9", suit: "spades" },
        { rank: "9", suit: "hearts" },
        { rank: "9", suit: "diamonds" },
        { rank: "K", suit: "clubs" },
        { rank: "2", suit: "spades" },
      ],
      currentBet: 0,
      self: { betThisStreet: 0 } as PokerStateView["self"],
    });
    expect(getTexasBotAction(v).type).toBe("check");
  });

  it("folds a one-sided straight draw at the bottom (A-2-3-4) — only 4 outs", () => {
    // Hole A♣ 2♦ + flop 3♥ 4♠ K♣ → A-2-3-4 needs a 5; one-sided.
    // Bot's hasOpenEndedStraightDraw excludes wheel-side draws, so this
    // path falls through to fold against any non-zero bet.
    const v = texasView({
      street: "flop",
      hole: [{ rank: "A", suit: "clubs" }, { rank: "2", suit: "diamonds" }],
      communityCards: [
        { rank: "3", suit: "hearts" },
        { rank: "4", suit: "spades" },
        { rank: "K", suit: "clubs" },
      ],
      currentBet: 20,
      self: { betThisStreet: 0 } as PokerStateView["self"],
      pots: [{ amount: 100, eligiblePlayerIds: ["BOT_1", "p2"] }],
    });
    expect(getTexasBotAction(v).type).toBe("fold");
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  Hearts
// ════════════════════════════════════════════════════════════════════════════

function C(suit: Card["suit"], rank: Card["rank"]): Card { return { suit, rank }; }

function heartsView(over: Partial<HeartsStateView> & { self: HeartsStateView["self"] }): HeartsStateView {
  const PIDS: PlayerId[] = ["p0", "p1", "p2", "p3"];
  return {
    gameId: "g", roundId: "r",
    phase: over.phase ?? "playing",
    self: over.self,
    opponents: over.opponents ?? PIDS.filter(p => p !== over.self.playerId).map(p => ({
      playerId: p, cardCount: 0, takenCount: 0, hasPassed: false,
    })),
    handIndex: over.handIndex ?? 0,
    passDirection: over.passDirection ?? "left",
    heartsBroken: over.heartsBroken ?? false,
    currentTrick: over.currentTrick ?? [],
    cumulativeScores: over.cumulativeScores ?? { p0: 0, p1: 0, p2: 0, p3: 0 },
    legalCards: over.legalCards ?? over.self.hand,
    currentTurn: over.currentTurn ?? over.self.playerId,
    turnDeadlineMs: over.turnDeadlineMs ?? Date.now() + 30_000,
  };
}

describe("Hearts bot — pass phase", () => {
  it("always dumps ♠Q when held", () => {
    const hand: Card[] = [
      C("spades","Q"), C("clubs","3"), C("clubs","4"), C("clubs","5"),
      C("diamonds","6"), C("diamonds","7"), C("diamonds","8"), C("diamonds","9"),
      C("hearts","2"), C("hearts","3"), C("hearts","4"), C("hearts","5"), C("hearts","6"),
    ];
    const v = heartsView({ phase: "passing", self: { playerId: "p0", hand, cardCount: 13, takenCount: 0, myPass: null } });
    const a = getHeartsBotAction(v);
    expect(a.type).toBe("hearts_pass");
    if (a.type !== "hearts_pass") return;
    expect(a.cards.some(c => c.suit === "spades" && c.rank === "Q")).toBe(true);
  });

  it("prefers to dump high hearts over low off-suit cards", () => {
    const hand: Card[] = [
      C("clubs","2"), C("clubs","3"), C("clubs","4"), C("clubs","5"),
      C("diamonds","2"), C("diamonds","3"), C("diamonds","4"), C("diamonds","5"),
      C("hearts","A"), C("hearts","K"), C("hearts","Q"),
      C("spades","2"), C("spades","3"),
    ];
    const v = heartsView({ phase: "passing", self: { playerId: "p0", hand, cardCount: 13, takenCount: 0, myPass: null } });
    const a = getHeartsBotAction(v);
    expect(a.type).toBe("hearts_pass");
    if (a.type !== "hearts_pass") return;
    // Top 3 by danger: ♥A, ♥K, ♥Q
    const picked = new Set(a.cards.map(c => `${c.suit}/${c.rank}`));
    expect(picked.has("hearts/A")).toBe(true);
    expect(picked.has("hearts/K")).toBe(true);
    expect(picked.has("hearts/Q")).toBe(true);
  });

  it("dumps high ♠ (A/K) above Q when no ♠Q in hand (avoid capturing ♠Q later)", () => {
    const hand: Card[] = [
      C("spades","A"), C("spades","K"), C("spades","2"), C("spades","3"),
      C("clubs","2"), C("clubs","3"), C("clubs","4"),
      C("diamonds","2"), C("diamonds","3"), C("diamonds","4"),
      C("hearts","2"), C("hearts","3"), C("hearts","4"),
    ];
    const v = heartsView({ phase: "passing", self: { playerId: "p0", hand, cardCount: 13, takenCount: 0, myPass: null } });
    const a = getHeartsBotAction(v);
    if (a.type !== "hearts_pass") throw new Error("expected hearts_pass");
    const picked = new Set(a.cards.map(c => `${c.suit}/${c.rank}`));
    // ♠A, ♠K are the top two; third is some ♥ (danger 40+rank vs ♠2/3 at 0).
    expect(picked.has("spades/A")).toBe(true);
    expect(picked.has("spades/K")).toBe(true);
  });
});

describe("Hearts bot — play phase", () => {
  it("leading: plays lowest non-point card", () => {
    const hand: Card[] = [C("clubs","2"), C("clubs","K"), C("diamonds","9")];
    const v = heartsView({
      self: { playerId: "p0", hand, cardCount: 3, takenCount: 0, myPass: null },
      legalCards: hand,  // heartsBroken=false but no ♥ in hand, all legal
    });
    const a = getHeartsBotAction(v);
    expect(a.type).toBe("hearts_play");
    if (a.type !== "hearts_play") return;
    expect(a.card).toEqual(C("clubs","2"));
  });

  it("following: ducks below trick high — plays highest below", () => {
    // Trick has ♣K played. We hold ♣2, ♣5, ♣J — all under K.
    // Highest below K is ♣J → play ♣J (offload the highest safely).
    const hand: Card[] = [C("clubs","2"), C("clubs","5"), C("clubs","J")];
    const trick: HeartsTrickPlay[] = [{ playerId: "p1", card: C("clubs","K") }];
    const v = heartsView({
      self: { playerId: "p0", hand, cardCount: 3, takenCount: 0, myPass: null },
      currentTrick: trick,
      legalCards: hand,
    });
    const a = getHeartsBotAction(v);
    if (a.type !== "hearts_play") throw new Error("expected hearts_play");
    expect(a.card).toEqual(C("clubs","J"));
  });

  it("following forced over-cut: plays lowest in-suit when only above-high available", () => {
    // Trick has ♣5 played. We hold only ♣J, ♣K — both above 5.
    // Forced to over-cut; play lowest (♣J).
    const hand: Card[] = [C("clubs","J"), C("clubs","K")];
    const trick: HeartsTrickPlay[] = [{ playerId: "p1", card: C("clubs","5") }];
    const v = heartsView({
      self: { playerId: "p0", hand, cardCount: 2, takenCount: 0, myPass: null },
      currentTrick: trick,
      legalCards: hand,
    });
    const a = getHeartsBotAction(v);
    if (a.type !== "hearts_play") throw new Error("expected hearts_play");
    expect(a.card).toEqual(C("clubs","J"));
  });

  it("void in led suit: dumps ♠Q when held", () => {
    const hand: Card[] = [C("spades","Q"), C("hearts","2"), C("diamonds","A")];
    const trick: HeartsTrickPlay[] = [{ playerId: "p1", card: C("clubs","K") }];
    const v = heartsView({
      self: { playerId: "p0", hand, cardCount: 3, takenCount: 0, myPass: null },
      currentTrick: trick,
      legalCards: hand,
      heartsBroken: true,
    });
    const a = getHeartsBotAction(v);
    if (a.type !== "hearts_play") throw new Error("expected hearts_play");
    expect(a.card).toEqual(C("spades","Q"));
  });

  it("void in led suit: no ♠Q → dumps highest ♥", () => {
    const hand: Card[] = [C("hearts","2"), C("hearts","A"), C("diamonds","9")];
    const trick: HeartsTrickPlay[] = [{ playerId: "p1", card: C("clubs","K") }];
    const v = heartsView({
      self: { playerId: "p0", hand, cardCount: 3, takenCount: 0, myPass: null },
      currentTrick: trick,
      legalCards: hand,
      heartsBroken: true,
    });
    const a = getHeartsBotAction(v);
    if (a.type !== "hearts_play") throw new Error("expected hearts_play");
    expect(a.card).toEqual(C("hearts","A"));
  });

  it("void in led suit + no points: dumps highest off-suit", () => {
    const hand: Card[] = [C("diamonds","2"), C("diamonds","K"), C("spades","5")];
    const trick: HeartsTrickPlay[] = [{ playerId: "p1", card: C("clubs","Q") }];
    const v = heartsView({
      self: { playerId: "p0", hand, cardCount: 3, takenCount: 0, myPass: null },
      currentTrick: trick,
      legalCards: hand,
    });
    const a = getHeartsBotAction(v);
    if (a.type !== "hearts_play") throw new Error("expected hearts_play");
    expect(a.card).toEqual(C("diamonds","K"));
  });

  it("avoids leading ♠Q when other options exist", () => {
    // legalCards has ♠Q + ♦5; lead should be ♦5 not ♠Q.
    const hand: Card[] = [C("spades","Q"), C("diamonds","5")];
    const v = heartsView({
      self: { playerId: "p0", hand, cardCount: 2, takenCount: 0, myPass: null },
      legalCards: hand,
      heartsBroken: true,
    });
    const a = getHeartsBotAction(v);
    if (a.type !== "hearts_play") throw new Error("expected hearts_play");
    expect(a.card).toEqual(C("diamonds","5"));
  });
});
