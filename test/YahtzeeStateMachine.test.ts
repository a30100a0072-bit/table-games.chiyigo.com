// /test/YahtzeeStateMachine.test.ts — pure-logic tests.                  // L2_測試

import { describe, it, expect } from "vitest";
import {
  YahtzeeStateMachine, scoreSlot, computeUpperBonus, computeBaseTotal,
} from "../src/game/YahtzeeStateMachine";
import type { YahtzeeSnapshot } from "../src/game/YahtzeeStateMachine";
import type { DiceTuple, Scorecard } from "../src/types/game";
import { YAHTZEE_SLOTS } from "../src/types/game";

function emptyCard(): Scorecard {
  const c = {} as Scorecard;
  for (const s of YAHTZEE_SLOTS) c[s] = null;
  return c;
}

function fromSnap(overrides: Partial<YahtzeeSnapshot>): YahtzeeStateMachine {
  const base: YahtzeeSnapshot = {
    gameId: "g", roundId: "r",
    phase: "rolling",
    playerIds: ["p1", "p2"],
    scorecards: [["p1", emptyCard()], ["p2", emptyCard()]],
    yahtzeeBonus: [["p1", 0], ["p2", 0]],
    dice: [1, 1, 1, 1, 1],
    held: [false, false, false, false, false],
    rollsLeft: 3,
    turnNumber: 0,
    totalTurns: 26,
    turnDeadlineMs: Date.now() + 30_000,
    ...overrides,
  };
  return YahtzeeStateMachine.restore(base);
}

describe("scoreSlot", () => {
  it("upper section counts faces", () => {
    expect(scoreSlot([1, 1, 2, 3, 6], "ones")).toBe(2);
    expect(scoreSlot([2, 2, 2, 3, 6], "twos")).toBe(6);
    expect(scoreSlot([6, 6, 6, 6, 6], "sixes")).toBe(30);
  });
  it("threeKind: requires >=3 same; sums all dice", () => {
    expect(scoreSlot([3, 3, 3, 4, 5], "threeKind")).toBe(18);
    expect(scoreSlot([3, 3, 4, 4, 5], "threeKind")).toBe(0);
  });
  it("fourKind: requires >=4 same", () => {
    expect(scoreSlot([5, 5, 5, 5, 2], "fourKind")).toBe(22);
    expect(scoreSlot([5, 5, 5, 4, 2], "fourKind")).toBe(0);
  });
  it("fullHouse: triple + pair = 25", () => {
    expect(scoreSlot([3, 3, 3, 6, 6], "fullHouse")).toBe(25);
    expect(scoreSlot([3, 3, 3, 3, 6], "fullHouse")).toBe(0);
  });
  it("smallStraight: any 4 consecutive = 30", () => {
    expect(scoreSlot([1, 2, 3, 4, 6], "smallStraight")).toBe(30);
    expect(scoreSlot([2, 3, 4, 5, 1], "smallStraight")).toBe(30);
    expect(scoreSlot([3, 4, 5, 6, 1], "smallStraight")).toBe(30);
    expect(scoreSlot([1, 2, 3, 5, 6], "smallStraight")).toBe(0);
  });
  it("largeStraight: 1-5 or 2-6 = 40", () => {
    expect(scoreSlot([1, 2, 3, 4, 5], "largeStraight")).toBe(40);
    expect(scoreSlot([2, 3, 4, 5, 6], "largeStraight")).toBe(40);
    expect(scoreSlot([1, 2, 3, 4, 6], "largeStraight")).toBe(0);
  });
  it("yahtzee: all 5 same = 50", () => {
    expect(scoreSlot([4, 4, 4, 4, 4], "yahtzee")).toBe(50);
    expect(scoreSlot([4, 4, 4, 4, 5], "yahtzee")).toBe(0);
  });
  it("chance: sum all dice", () => {
    expect(scoreSlot([1, 2, 3, 4, 5], "chance")).toBe(15);
    expect(scoreSlot([6, 6, 6, 6, 6], "chance")).toBe(30);
  });
});

describe("upper bonus", () => {
  it("63+ in upper grants 35", () => {
    const card = emptyCard();
    card.ones = 3; card.twos = 6; card.threes = 9;
    card.fours = 12; card.fives = 15; card.sixes = 18;   // total 63
    expect(computeUpperBonus(card)).toBe(35);
  });
  it("62 in upper grants 0", () => {
    const card = emptyCard();
    card.ones = 3; card.twos = 6; card.threes = 9;
    card.fours = 12; card.fives = 14; card.sixes = 18;   // 62
    expect(computeUpperBonus(card)).toBe(0);
  });
});

describe("flow", () => {
  it("first roll ignores held; advances rollsLeft", () => {
    const m = fromSnap({});
    const r = m.process("p1", { type: "yz_roll", held: [true, true, true, true, true] });
    expect(r.ok).toBe(true);
    expect(m.viewFor("p1").rollsLeft).toBe(2);
  });

  it("score before any roll fails", () => {
    const m = fromSnap({});
    const r = m.process("p1", { type: "yz_score", slot: "chance" });
    expect(r.ok).toBe(false);
  });

  it("score advances turn to next player", () => {
    const m = fromSnap({ rollsLeft: 2, dice: [1, 1, 1, 1, 1] });
    const r = m.process("p1", { type: "yz_score", slot: "ones" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.settlement).toBe(null);
    const v = m.viewFor("p2");
    expect(v.currentTurn).toBe("p2");
    expect(v.rollsLeft).toBe(3);
    expect(v.self.scorecard.ones).toBe(null);
    expect(v.opponents[0]!.scorecard.ones).toBe(5);   // p1's filled slot
  });

  it("rejects scoring an already-filled slot", () => {
    const card = emptyCard();
    card.chance = 20;
    const m = fromSnap({
      rollsLeft: 2,
      dice: [3, 3, 3, 4, 4],
      scorecards: [["p1", card], ["p2", emptyCard()]],
    });
    const r = m.process("p1", { type: "yz_score", slot: "chance" });
    expect(r.ok).toBe(false);
  });

  it("4th roll rejected", () => {
    const m = fromSnap({ rollsLeft: 0 });
    const r = m.process("p1", { type: "yz_roll", held: [true, true, true, true, true] });
    expect(r.ok).toBe(false);
  });

  it("out-of-turn rejected", () => {
    const m = fromSnap({});
    const r = m.process("p2", { type: "yz_roll", held: [false, false, false, false, false] });
    expect(r.ok).toBe(false);
  });
});

describe("settlement", () => {
  it("after totalTurns scores filled, settle returns", () => {
    // Fast-forward to last turn: turnNumber = totalTurns - 1, all slots filled for p1.
    const cardP1: Scorecard = emptyCard();
    const cardP2: Scorecard = emptyCard();
    for (const s of YAHTZEE_SLOTS) {
      if (s !== "chance") cardP1[s] = 0;
      cardP2[s] = 0;
    }
    const m = fromSnap({
      rollsLeft: 2,
      dice: [6, 6, 6, 6, 6],
      turnNumber: 25,    // 0..25, 25 = last turn (p2's 13th)
      totalTurns: 26,
      scorecards: [["p1", cardP1], ["p2", cardP2]],
    });
    // p2 scoring last empty slot (chance) — but p2's chance is already 0.
    // Pick a slot that p1 hasn't filled — chance. p1.chance is null.
    // Actually turnNumber 25 → playerIds[25 % 2] = "p2", but p2's slots
    // are all 0. We need a snapshot where p2 has an unfilled slot.
    const p2Card: Scorecard = emptyCard();
    for (const s of YAHTZEE_SLOTS) {
      if (s !== "chance") p2Card[s] = 0;
    }
    const m2 = fromSnap({
      rollsLeft: 2,
      dice: [6, 6, 6, 6, 6],
      turnNumber: 25,
      totalTurns: 26,
      scorecards: [["p1", cardP1], ["p2", p2Card]],
    });
    const r = m2.process("p2", { type: "yz_score", slot: "chance" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settlement).not.toBe(null);
    expect(r.settlement!.yahtzeeDetail).toBeTruthy();
    // Conservation: deltas sum to 0.
    const sum = r.settlement!.players.reduce((a, p) => a + p.scoreDelta, 0);
    expect(sum).toBe(0);
  });

  it("forceSettle with forfeit assigns penalty", () => {
    const m = fromSnap({});
    const s = m.forceSettle("disconnect", "p1");
    expect(s.winnerId).toBe("p2");
    const p1 = s.players.find(p => p.playerId === "p1")!;
    expect(p1.scoreDelta).toBe(-200);
    const p2 = s.players.find(p => p.playerId === "p2")!;
    expect(p2.scoreDelta).toBe(200);
  });
});

describe("snapshot round-trip", () => {
  it("restore reproduces state", () => {
    const m1 = new YahtzeeStateMachine("g", "r", ["p1", "p2", "p3", "p4"]);
    const snap = m1.snapshot();
    const m2 = YahtzeeStateMachine.restore(snap);
    expect(m2.viewFor("p1")).toEqual(m1.viewFor("p1"));
    expect(m2.snapshot()).toEqual(snap);
  });
});

describe("computeBaseTotal", () => {
  it("sums all 13 slots + upper bonus", () => {
    const card = emptyCard();
    card.ones = 3; card.twos = 6; card.threes = 9;
    card.fours = 12; card.fives = 15; card.sixes = 18;
    card.threeKind = 18; card.fourKind = 22; card.fullHouse = 25;
    card.smallStraight = 30; card.largeStraight = 40;
    card.yahtzee = 50; card.chance = 25;
    // upper sum = 63 → +35 bonus
    // total = 63 + 18 + 22 + 25 + 30 + 40 + 50 + 25 = 273 + 35 = 308
    expect(computeBaseTotal(card)).toBe(308);
  });
});
