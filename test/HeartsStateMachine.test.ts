// /test/HeartsStateMachine.test.ts
// Hearts state-machine tests. PR 2.2 covers deal + pass phase +
// snapshot/restore. PR 2.3 adds trick play / legality / per-hand settle
// (incl. Shoot the Moon). Multi-hand cycle + final settle land in PR 2.4.
//                                                                          // L2_測試

import { describe, it, expect } from "vitest";
import {
  HeartsStateMachine, passDirectionFor, heartsCardPoints, isPointCard,
  computeLegalPlays,
} from "../src/game/HeartsStateMachine";
import type { HeartsSnapshot } from "../src/game/HeartsStateMachine";
import type { Card, PlayerId } from "../src/types/game";

const PIDS = ["p0", "p1", "p2", "p3"];

// ── Fixture helpers ──────────────────────────────────────────────────── L2_測試

/** Empty hands / no scores / fresh maps; lets each test override what it
 *  cares about. Phase defaults to "passing" with all 4 pendingPasses=null. */
function blankSnap(overrides: Partial<HeartsSnapshot> = {}): HeartsSnapshot {
  const base: HeartsSnapshot = {
    gameId:           "g",
    roundId:          "r",
    phase:            "passing",
    playerIds:        [...PIDS],
    handIndex:        0,
    hands:            PIDS.map(p => [p, []] as [string, Card[]]),
    pendingPasses:    PIDS.map(p => [p, null] as [string, [Card, Card, Card] | null]),
    currentTrick:     [],
    heartsBroken:     false,
    takenTricks:      PIDS.map(p => [p, []] as [string, Card[]]),
    turnIndex:        0,
    cumulativeScores: PIDS.map(p => [p, 0] as [string, number]),
    turnDeadlineMs:   Date.now() + 30_000,
    winnerId:         null,
  };
  return { ...base, ...overrides };
}

/** Build a 52-card deck pre-sorted by suit so we can hand fixed hands to
 *  each player for deterministic pass tests.                              */
function suitRun(suit: Card["suit"]): Card[] {
  const ranks: Card["rank"][] = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
  return ranks.map(rank => ({ suit, rank }));
}

// ── Helpers ──────────────────────────────────────────────────────────── L2_測試

function pidsInHand(m: HeartsStateMachine, pid: string): Card[] {
  return m.viewFor(pid).self.hand;
}

// ── Pure helpers ─────────────────────────────────────────────────────── L2_測試

describe("Hearts pure helpers", () => {
  it("passDirectionFor cycles left/right/across/none", () => {
    expect(passDirectionFor(0)).toBe("left");
    expect(passDirectionFor(1)).toBe("right");
    expect(passDirectionFor(2)).toBe("across");
    expect(passDirectionFor(3)).toBe("none");
    expect(passDirectionFor(4)).toBe("left");
    expect(passDirectionFor(7)).toBe("none");
  });

  it("heartsCardPoints: ♥ = 1, ♠Q = 13, others 0", () => {
    expect(heartsCardPoints({ suit: "hearts",   rank: "2" })).toBe(1);
    expect(heartsCardPoints({ suit: "hearts",   rank: "A" })).toBe(1);
    expect(heartsCardPoints({ suit: "spades",   rank: "Q" })).toBe(13);
    expect(heartsCardPoints({ suit: "spades",   rank: "K" })).toBe(0);
    expect(heartsCardPoints({ suit: "clubs",    rank: "A" })).toBe(0);
    expect(heartsCardPoints({ suit: "diamonds", rank: "A" })).toBe(0);
  });

  it("isPointCard flags ♥ and ♠Q only", () => {
    expect(isPointCard({ suit: "hearts", rank: "3" })).toBe(true);
    expect(isPointCard({ suit: "spades", rank: "Q" })).toBe(true);
    expect(isPointCard({ suit: "spades", rank: "K" })).toBe(false);
    expect(isPointCard({ suit: "clubs", rank: "2" })).toBe(false);
  });
});

// ── Constructor: deal + initial phase ────────────────────────────────── L2_測試

describe("Hearts constructor", () => {
  it("rejects non-4-player rooms", () => {
    expect(() => new HeartsStateMachine("g", "r", ["p0", "p1", "p2"]))
      .toThrow(/4 players/i);
    expect(() => new HeartsStateMachine("g", "r", ["p0", "p1", "p2", "p3", "p4"]))
      .toThrow(/4 players/i);
  });

  it("rejects duplicate player IDs", () => {
    expect(() => new HeartsStateMachine("g", "r", ["p0", "p0", "p2", "p3"]))
      .toThrow(/duplicate/i);
  });

  it("deals 13 cards to each seat, 52 total, no duplicates", () => {
    const m = new HeartsStateMachine("g", "r", PIDS);
    const all: Card[] = [];
    for (const pid of PIDS) {
      const hand = pidsInHand(m, pid);
      expect(hand.length).toBe(13);
      all.push(...hand);
    }
    expect(all.length).toBe(52);
    const seen = new Set(all.map(c => `${c.suit}/${c.rank}`));
    expect(seen.size).toBe(52);
  });

  it("starts in passing phase on hand 0", () => {
    const m = new HeartsStateMachine("g", "r", PIDS);
    const v = m.viewFor(PIDS[0]!);
    expect(v.phase).toBe("passing");
    expect(v.passDirection).toBe("left");
    expect(v.handIndex).toBe(0);
    expect(v.heartsBroken).toBe(false);
    // No one has passed yet.
    for (const opp of v.opponents) expect(opp.hasPassed).toBe(false);
    expect(v.self.myPass).toBeNull();
  });
});

// ── Passing phase ────────────────────────────────────────────────────── L2_測試

describe("Hearts passing phase", () => {
  /** Fresh fixture: 4 fixed hands (one full suit each) so card ownership
   *  is unambiguous when testing pass swaps. p0=clubs, p1=diamonds,
   *  p2=spades, p3=hearts. ♣2 is in p0's hand → after passing, whoever
   *  ends with ♣2 leads. handIndex=0 ⇒ direction=left.                    */
  function fixedHandsFixture(handIndex = 0): HeartsStateMachine {
    return HeartsStateMachine.restore(blankSnap({
      handIndex,
      hands: [
        ["p0", suitRun("clubs")],
        ["p1", suitRun("diamonds")],
        ["p2", suitRun("spades")],
        ["p3", suitRun("hearts")],
      ],
    }));
  }

  it("rejects pass with wrong card count", () => {
    const m = fixedHandsFixture();
    const r = m.process("p0", {
      type: "hearts_pass",
      cards: [
        { suit: "clubs", rank: "2" },
        { suit: "clubs", rank: "3" },
      ] as unknown as [Card, Card, Card],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/3_CARDS/);
  });

  it("rejects pass with duplicate cards", () => {
    const m = fixedHandsFixture();
    const dup: Card = { suit: "clubs", rank: "2" };
    const r = m.process("p0", { type: "hearts_pass", cards: [dup, dup, { suit: "clubs", rank: "3" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/DUPLICATE/);
  });

  it("rejects pass containing a card not in hand", () => {
    const m = fixedHandsFixture();
    const r = m.process("p0", {
      type: "hearts_pass",
      cards: [
        { suit: "clubs",   rank: "2" },
        { suit: "diamonds",rank: "2" },        // not in p0 (clubs only)
        { suit: "clubs",   rank: "3" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/CARD_NOT_IN_HAND/);
  });

  it("rejects double-pass by same player", () => {
    const m = fixedHandsFixture();
    const cards: [Card, Card, Card] = [
      { suit: "clubs", rank: "2" },
      { suit: "clubs", rank: "3" },
      { suit: "clubs", rank: "4" },
    ];
    expect(m.process("p0", { type: "hearts_pass", cards }).ok).toBe(true);
    const r = m.process("p0", { type: "hearts_pass", cards });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ALREADY_PASSED/);
  });

  it("first three submissions do NOT transition out of passing", () => {
    const m = fixedHandsFixture();
    m.process("p0", { type: "hearts_pass", cards: [
      { suit: "clubs", rank: "2" }, { suit: "clubs", rank: "3" }, { suit: "clubs", rank: "4" },
    ]});
    m.process("p1", { type: "hearts_pass", cards: [
      { suit: "diamonds", rank: "2" }, { suit: "diamonds", rank: "3" }, { suit: "diamonds", rank: "4" },
    ]});
    m.process("p2", { type: "hearts_pass", cards: [
      { suit: "spades", rank: "2" }, { suit: "spades", rank: "3" }, { suit: "spades", rank: "4" },
    ]});
    expect(m.viewFor("p0").phase).toBe("passing");
    // The three who passed should not be holding cards mid-pass — they
    // remain in hand until simultaneous commit.
    expect(pidsInHand(m, "p0").length).toBe(13);
    expect(pidsInHand(m, "p1").length).toBe(13);
    expect(pidsInHand(m, "p2").length).toBe(13);
  });

  it("after all 4 submit, hands swap per direction=left and phase flips to playing", () => {
    const m = fixedHandsFixture();
    // direction=left ⇒ pi passes to p((i+1)%4)
    const passes: Record<string, [Card, Card, Card]> = {
      p0: [{ suit: "clubs",    rank: "2" }, { suit: "clubs",    rank: "3" }, { suit: "clubs",    rank: "4" }],
      p1: [{ suit: "diamonds", rank: "2" }, { suit: "diamonds", rank: "3" }, { suit: "diamonds", rank: "4" }],
      p2: [{ suit: "spades",   rank: "2" }, { suit: "spades",   rank: "3" }, { suit: "spades",   rank: "4" }],
      p3: [{ suit: "hearts",   rank: "2" }, { suit: "hearts",   rank: "3" }, { suit: "hearts",   rank: "4" }],
    };
    for (const pid of PIDS) {
      const r = m.process(pid, { type: "hearts_pass", cards: passes[pid]! });
      expect(r.ok).toBe(true);
    }

    const v0 = m.viewFor("p0");
    expect(v0.phase).toBe("playing");

    // p0 lost clubs 2/3/4 and gained hearts 2/3/4 (from p3 passing left to p0).
    const p0Suits = pidsInHand(m, "p0").map(c => c.suit).sort();
    // p0 originally 13 clubs; donated 3 clubs (2/3/4), received 3 hearts.
    const clubCount = p0Suits.filter(s => s === "clubs").length;
    const heartCount = p0Suits.filter(s => s === "hearts").length;
    expect(clubCount).toBe(10);
    expect(heartCount).toBe(3);

    // ♣2 went from p0 to p1 (left neighbour). p1 should lead. currentTurn
    // points at p1.
    expect(v0.currentTurn).toBe("p1");

    // All hands remain at 13.
    for (const pid of PIDS) expect(pidsInHand(m, pid).length).toBe(13);
  });

  it("hand 4 (handIndex%4===3) skips passing phase entirely", () => {
    // Use restore with handIndex=3 so passDirection=none. The constructor
    // is hardcoded to handIndex=0; the production multi-hand cycle (PR 2.4)
    // will call startNextHand to advance.
    //
    // Build a snapshot where 4 hands exist and phase=playing directly.
    const snap = blankSnap({
      handIndex: 3,
      phase: "playing",
      hands: [
        ["p0", suitRun("clubs")],
        ["p1", suitRun("diamonds")],
        ["p2", suitRun("spades")],
        ["p3", suitRun("hearts")],
      ],
      pendingPasses: [],
    });
    const m = HeartsStateMachine.restore(snap);
    const v = m.viewFor("p0");
    expect(v.phase).toBe("playing");
    expect(v.passDirection).toBe("none");
  });

  it("rejects hearts_play during passing phase", () => {
    const m = new HeartsStateMachine("g", "r", PIDS);
    const r = m.process(PIDS[0]!, { type: "hearts_play", card: { suit: "clubs", rank: "2" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/NOT_PLAYING_PHASE/);
  });

  it("rejects hearts_pass once already in playing phase", () => {
    const m = HeartsStateMachine.restore(blankSnap({
      phase: "playing",
      hands: [
        ["p0", suitRun("clubs")],
        ["p1", suitRun("diamonds")],
        ["p2", suitRun("spades")],
        ["p3", suitRun("hearts")],
      ],
      pendingPasses: [],
    }));
    const r = m.process("p0", { type: "hearts_pass", cards: [
      { suit: "clubs", rank: "2" }, { suit: "clubs", rank: "3" }, { suit: "clubs", rank: "4" },
    ]});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/NOT_PASSING_PHASE/);
  });
});

// ── Snapshot / restore ───────────────────────────────────────────────── L2_測試

describe("Hearts snapshot / restore", () => {
  it("round-trips a fresh game", () => {
    const m = new HeartsStateMachine("g", "r", PIDS);
    const snap = m.snapshot();
    const m2 = HeartsStateMachine.restore(snap);
    // Same hands across both instances (deep equal-by-cards).
    for (const pid of PIDS) {
      expect(m2.viewFor(pid).self.hand).toEqual(m.viewFor(pid).self.hand);
    }
    expect(m2.viewFor(PIDS[0]!).phase).toBe(m.viewFor(PIDS[0]!).phase);
  });

  it("preserves mid-pass state — 3 submitted, 1 outstanding (the critical case)", () => {
    const m = HeartsStateMachine.restore(blankSnap({
      hands: [
        ["p0", suitRun("clubs")],
        ["p1", suitRun("diamonds")],
        ["p2", suitRun("spades")],
        ["p3", suitRun("hearts")],
      ],
    }));
    const passes: Record<string, [Card, Card, Card]> = {
      p0: [{ suit: "clubs",    rank: "2" }, { suit: "clubs",    rank: "3" }, { suit: "clubs",    rank: "4" }],
      p1: [{ suit: "diamonds", rank: "2" }, { suit: "diamonds", rank: "3" }, { suit: "diamonds", rank: "4" }],
      p2: [{ suit: "spades",   rank: "2" }, { suit: "spades",   rank: "3" }, { suit: "spades",   rank: "4" }],
    };
    for (const pid of ["p0","p1","p2"]) {
      m.process(pid, { type: "hearts_pass", cards: passes[pid]! });
    }
    // Snapshot in the middle.
    const snap = m.snapshot();
    const m2 = HeartsStateMachine.restore(snap);

    // p3 still owes a pass; phase still passing.
    expect(m2.viewFor("p3").phase).toBe("passing");
    expect(m2.viewFor("p3").self.myPass).toBeNull();
    // p0/p1/p2 are recorded as having passed.
    const opps = m2.viewFor("p3").opponents;
    const p0Opp = opps.find(o => o.playerId === "p0")!;
    const p1Opp = opps.find(o => o.playerId === "p1")!;
    const p2Opp = opps.find(o => o.playerId === "p2")!;
    expect(p0Opp.hasPassed).toBe(true);
    expect(p1Opp.hasPassed).toBe(true);
    expect(p2Opp.hasPassed).toBe(true);

    // p3 submits last after restore — pass commits and phase flips.
    const r = m2.process("p3", { type: "hearts_pass", cards: [
      { suit: "hearts", rank: "2" }, { suit: "hearts", rank: "3" }, { suit: "hearts", rank: "4" },
    ]});
    expect(r.ok).toBe(true);
    expect(m2.viewFor("p3").phase).toBe("playing");
    // p1 holds ♣2 after left-pass swap; should lead.
    expect(m2.viewFor("p3").currentTurn).toBe("p1");
  });
});

// ── Trick play / legality ────────────────────────────────────────────── L2_測試

describe("Hearts computeLegalPlays", () => {
  const C = (suit: Card["suit"], rank: Card["rank"]): Card => ({ suit, rank });

  it("leading the first trick: only ♣2 is legal", () => {
    const hand: Card[] = [C("clubs","2"), C("clubs","5"), C("hearts","A")];
    const legal = computeLegalPlays(hand, [], false, true);
    expect(legal).toEqual([C("clubs","2")]);
  });

  it("leading later trick with !heartsBroken: ♥ is dimmed when alternatives exist", () => {
    const hand: Card[] = [C("clubs","5"), C("hearts","A"), C("diamonds","Q")];
    const legal = computeLegalPlays(hand, [], false, false);
    expect(legal).toEqual([C("clubs","5"), C("diamonds","Q")]);
  });

  it("leading: heartsBroken allows ♥", () => {
    const hand: Card[] = [C("clubs","5"), C("hearts","A")];
    const legal = computeLegalPlays(hand, [], true, false);
    expect(legal).toEqual(hand);
  });

  it("leading: all-♥ hand can lead ♥ even before broken", () => {
    const hand: Card[] = [C("hearts","2"), C("hearts","K")];
    const legal = computeLegalPlays(hand, [], false, false);
    expect(legal).toEqual(hand);
  });

  it("following: must follow suit if able", () => {
    const trick = [{ playerId: "p1", card: C("clubs","2") }];
    const hand: Card[] = [C("clubs","7"), C("hearts","A"), C("spades","Q")];
    const legal = computeLegalPlays(hand, trick, false, true);
    expect(legal).toEqual([C("clubs","7")]);
  });

  it("first trick following: cannot drop ♥ or ♠Q on a void", () => {
    const trick = [{ playerId: "p1", card: C("clubs","2") }];
    const hand: Card[] = [
      C("diamonds","9"), C("hearts","A"), C("spades","Q"),
    ];
    const legal = computeLegalPlays(hand, trick, false, true);
    // Must dump a non-point card.
    expect(legal).toEqual([C("diamonds","9")]);
  });

  it("first trick void with all-points hand: forced to play a point", () => {
    const trick = [{ playerId: "p1", card: C("clubs","2") }];
    const hand: Card[] = [C("hearts","A"), C("spades","Q"), C("hearts","9")];
    const legal = computeLegalPlays(hand, trick, false, true);
    // No non-point card available — any becomes legal.
    expect(legal).toEqual(hand);
  });

  it("first trick following the led suit cannot drop ♠Q if alternatives in suit exist", () => {
    // Edge case: led=spades on first trick (impossible in real play since
    // ♣2 leads, but the rule is symmetric across led suits). If we have
    // ♠Q + ♠K, only ♠K is legal.
    const trick = [{ playerId: "p1", card: C("spades","2") }];
    const hand: Card[] = [C("spades","Q"), C("spades","K")];
    const legal = computeLegalPlays(hand, trick, false, true);
    expect(legal).toEqual([C("spades","K")]);
  });
});

describe("Hearts trick play", () => {
  /** Build a playing-phase fixture with handcrafted 13-card hands so the
   *  trick winner / rule paths are deterministic. ♣2 is in p0 → p0 leads. */
  function playFixture(opts: {
    hands: [PlayerId, Card[]][];
    heartsBroken?: boolean;
    handIndex?: number;
    takenTricks?: [PlayerId, Card[]][];
    turnIndex?: number;
    cumulativeScores?: [PlayerId, number][];
  }): HeartsStateMachine {
    return HeartsStateMachine.restore(blankSnap({
      phase: "playing",
      hands: opts.hands,
      pendingPasses: [],
      heartsBroken: opts.heartsBroken ?? false,
      handIndex: opts.handIndex ?? 0,
      takenTricks: opts.takenTricks ?? PIDS.map(p => [p, []]),
      turnIndex: opts.turnIndex ?? 0,
      cumulativeScores: opts.cumulativeScores ?? PIDS.map(p => [p, 0]),
    }));
  }

  it("rejects leading anything other than ♣2 on first trick", () => {
    const m = playFixture({
      hands: [
        ["p0", [{ suit: "clubs", rank: "2" }, { suit: "clubs", rank: "5" }]],
        ["p1", [{ suit: "clubs", rank: "3" }]],
        ["p2", [{ suit: "clubs", rank: "4" }]],
        ["p3", [{ suit: "diamonds", rank: "2" }]],
      ],
    });
    const r = m.process("p0", { type: "hearts_play", card: { suit: "clubs", rank: "5" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/ILLEGAL_PLAY/);
  });

  it("rejects play out of turn", () => {
    const m = playFixture({
      hands: [
        ["p0", [{ suit: "clubs", rank: "2" }]],
        ["p1", [{ suit: "clubs", rank: "3" }]],
        ["p2", [{ suit: "clubs", rank: "4" }]],
        ["p3", [{ suit: "diamonds", rank: "2" }]],
      ],
    });
    const r = m.process("p1", { type: "hearts_play", card: { suit: "clubs", rank: "3" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/NOT_YOUR_TURN/);
  });

  it("rejects play of card not in hand", () => {
    const m = playFixture({
      hands: [
        ["p0", [{ suit: "clubs", rank: "2" }]],
        ["p1", [{ suit: "clubs", rank: "3" }]],
        ["p2", [{ suit: "clubs", rank: "4" }]],
        ["p3", [{ suit: "diamonds", rank: "2" }]],
      ],
    });
    const r = m.process("p0", { type: "hearts_play", card: { suit: "diamonds", rank: "A" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/CARD_NOT_IN_HAND/);
  });

  it("completes a trick: highest of led suit takes, winner leads next", () => {
    const m = playFixture({
      hands: [
        ["p0", [{ suit: "clubs", rank: "2" }, { suit: "diamonds", rank: "A" }]],
        ["p1", [{ suit: "clubs", rank: "K" }, { suit: "diamonds", rank: "2" }]],
        ["p2", [{ suit: "clubs", rank: "5" }, { suit: "diamonds", rank: "3" }]],
        ["p3", [{ suit: "clubs", rank: "10" }, { suit: "diamonds", rank: "4" }]],
      ],
    });
    expect(m.process("p0", { type: "hearts_play", card: { suit: "clubs", rank: "2" } }).ok).toBe(true);
    expect(m.process("p1", { type: "hearts_play", card: { suit: "clubs", rank: "K" } }).ok).toBe(true);
    expect(m.process("p2", { type: "hearts_play", card: { suit: "clubs", rank: "5" } }).ok).toBe(true);
    expect(m.process("p3", { type: "hearts_play", card: { suit: "clubs", rank: "10" } }).ok).toBe(true);

    const v = m.viewFor("p0");
    expect(v.currentTrick.length).toBe(0);
    expect(v.currentTurn).toBe("p1");  // p1 played ♣K, highest of clubs
    // p1's takenCount is 4
    const p1Opp = v.opponents.find(o => o.playerId === "p1")!;
    expect(p1Opp.takenCount).toBe(4);
  });

  it("playing ♥ sets heartsBroken", () => {
    // Set up where p0 voids on clubs trick and plays a ♥.
    const m = playFixture({
      hands: [
        ["p0", [{ suit: "clubs", rank: "2" }, { suit: "hearts", rank: "5" }]],
        ["p1", [{ suit: "clubs", rank: "3" }, { suit: "diamonds", rank: "2" }]],
        ["p2", [{ suit: "clubs", rank: "4" }, { suit: "diamonds", rank: "3" }]],
        ["p3", [{ suit: "clubs", rank: "5" }, { suit: "diamonds", rank: "4" }]],
      ],
    });
    // Trick 1: clubs run, p3 wins (♣5 highest among 2/3/4/5).
    m.process("p0", { type: "hearts_play", card: { suit: "clubs", rank: "2" } });
    m.process("p1", { type: "hearts_play", card: { suit: "clubs", rank: "3" } });
    m.process("p2", { type: "hearts_play", card: { suit: "clubs", rank: "4" } });
    m.process("p3", { type: "hearts_play", card: { suit: "clubs", rank: "5" } });

    expect(m.viewFor("p0").heartsBroken).toBe(false);

    // Trick 2: p3 leads diamonds; p0 voids and plays ♥5 (legal since
    // not first trick + void).
    m.process("p3", { type: "hearts_play", card: { suit: "diamonds", rank: "4" } });
    m.process("p0", { type: "hearts_play", card: { suit: "hearts", rank: "5" } });
    expect(m.viewFor("p0").heartsBroken).toBe(true);
  });
});

describe("Hearts hand finalize + Shoot the Moon", () => {
  /** Drive a fully scripted 13-trick hand from `restore`. Used by the
   *  Moon and per-hand scoring tests. Each test specifies the plays in
   *  order; this helper just runs them.                                     */
  function runScript(
    m: HeartsStateMachine,
    plays: { pid: PlayerId; card: Card }[],
  ): void {
    for (const { pid, card } of plays) {
      const r = m.process(pid, { type: "hearts_play", card });
      if (!r.ok) throw new Error(`unexpected reject: ${r.error} at ${pid} ${card.suit}/${card.rank}`);
    }
  }

  /** A scripted hand where p0 takes every trick. ♣2 is in p0's hand; p0
   *  leads. Hands: p0 = clubs 2-A, p1 = diamonds 2-A, p2 = spades 2-A,
   *  p3 = hearts 2-A. Each trick p0 leads a club; everyone else dumps
   *  their lowest. p0 wins every trick → all 26 points → Shoot the Moon. */
  it("Shoot the Moon: shooter scores 0, others +26", () => {
    const m = HeartsStateMachine.restore(blankSnap({
      phase: "playing",
      pendingPasses: [],
      hands: [
        ["p0", suitRun("clubs")],
        ["p1", suitRun("diamonds")],
        ["p2", suitRun("spades")],
        ["p3", suitRun("hearts")],
      ],
    }));

    // Build script: 13 tricks; p0 always leads ♣rank; followers void on clubs
    // so they play their lowest of own suit (which is the only suit they
    // have). Trick 1 first-trick-no-points rule allows non-point cards;
    // p3 has only ♥ so forced to play ♥ on trick 1.
    const ranks: Card["rank"][] = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
    const plays: { pid: PlayerId; card: Card }[] = [];
    for (let i = 0; i < 13; i++) {
      plays.push({ pid: "p0", card: { suit: "clubs",    rank: ranks[i]! } });
      plays.push({ pid: "p1", card: { suit: "diamonds", rank: ranks[i]! } });
      plays.push({ pid: "p2", card: { suit: "spades",   rank: ranks[i]! } });
      plays.push({ pid: "p3", card: { suit: "hearts",   rank: ranks[i]! } });
    }
    runScript(m, plays);

    expect(m.viewFor("p0").phase).toBe("between_hands");
    const hs = m.getLastHandScores();
    expect(hs).not.toBeNull();
    expect(hs!.p0).toBe(0);
    expect(hs!.p1).toBe(26);
    expect(hs!.p2).toBe(26);
    expect(hs!.p3).toBe(26);
    expect(m.getLastShooter()).toBe("p0");

    // Cumulative scores reflect the moon flip.
    expect(m.cumulativeScoresMap()).toEqual({ p0: 0, p1: 26, p2: 26, p3: 26 });
  });

  it("split-hand scoring: per-hand points sum to 26 (no moon)", () => {
    // Configure final state by restore at "almost end of hand": 12 tricks
    // taken with a known distribution, and the 13th trick set up so it
    // completes the hand cleanly.
    const taken: [PlayerId, Card[]][] = [
      ["p0", [{ suit: "hearts", rank: "2" }, { suit: "hearts", rank: "3" }]],   // 2 pts
      ["p1", [{ suit: "hearts", rank: "4" }, { suit: "hearts", rank: "5" },
              { suit: "hearts", rank: "6" }, { suit: "hearts", rank: "7" }]],   // 4 pts
      ["p2", [{ suit: "spades", rank: "Q" }, { suit: "hearts", rank: "8" },
              { suit: "hearts", rank: "9" }, { suit: "hearts", rank: "10" }]],  // 13+3 = 16 pts
      ["p3", [{ suit: "hearts", rank: "J" }, { suit: "hearts", rank: "Q" },
              { suit: "hearts", rank: "K" }, { suit: "hearts", rank: "A" }]],   // 4 pts
    ];
    // The 12 tricks above used 14 cards across 4 piles (2+4+4+4 = 14).
    // Pad each pile with non-point filler so total = 12*4 = 48 cards.
    const filler: Card = { suit: "diamonds", rank: "2" }; // placeholder; not scoring
    const fillerCards = (n: number): Card[] => Array.from({ length: n }, () => ({ ...filler }));
    taken[0]![1].push(...fillerCards(10));  // 2 → 12
    taken[1]![1].push(...fillerCards(8));   // 4 → 12
    taken[2]![1].push(...fillerCards(8));   // 4 → 12
    taken[3]![1].push(...fillerCards(8));   // 4 → 12
    // Total now 48. Last trick (4 cards) will be played; set up plain
    // diamonds run so it doesn't change point totals. p0 currently leads
    // (turnIndex=0).
    const m = HeartsStateMachine.restore(blankSnap({
      phase: "playing",
      pendingPasses: [],
      hands: [
        ["p0", [{ suit: "diamonds", rank: "A" }]],
        ["p1", [{ suit: "diamonds", rank: "K" }]],
        ["p2", [{ suit: "diamonds", rank: "Q" }]],
        ["p3", [{ suit: "diamonds", rank: "J" }]],
      ],
      takenTricks: taken,
      heartsBroken: true,
      turnIndex: 0,
    }));

    // Last trick — p0 leads ♦A, sweeps.
    m.process("p0", { type: "hearts_play", card: { suit: "diamonds", rank: "A" } });
    m.process("p1", { type: "hearts_play", card: { suit: "diamonds", rank: "K" } });
    m.process("p2", { type: "hearts_play", card: { suit: "diamonds", rank: "Q" } });
    m.process("p3", { type: "hearts_play", card: { suit: "diamonds", rank: "J" } });

    expect(m.viewFor("p0").phase).toBe("between_hands");
    const hs = m.getLastHandScores()!;
    const total = hs.p0! + hs.p1! + hs.p2! + hs.p3!;
    expect(total).toBe(26);  // no moon → raw distribution preserved
    expect(hs).toEqual({ p0: 2, p1: 4, p2: 16, p3: 4 });
    expect(m.getLastShooter()).toBeNull();
  });
});

// Help TypeScript: confirm PlayerId import is used (suppress unused warn).
const _pid: PlayerId = "x"; void _pid;
