// /test/UnoStateMachine.test.ts — pure-logic Uno tests.                  // L2_測試

import { describe, it, expect } from "vitest";
import { UnoStateMachine, canPlay, unoCardPoints } from "../src/game/UnoStateMachine";
import type { UnoSnapshot } from "../src/game/UnoStateMachine";
import type { UnoCard, UnoColor, UnoValue } from "../src/types/game";

const card = (color: UnoColor | undefined, value: UnoValue): UnoCard => ({ color, value });

function fromSnap(overrides: Partial<UnoSnapshot> & { hands: [string, UnoCard[]][]; discardPile: UnoCard[] }): UnoStateMachine {
  const base: UnoSnapshot = {
    gameId: "g", roundId: "r",
    phase: "playing",
    playerIds: ["p1", "p2"],
    hands: [],
    drawPile: [card("red", 1), card("red", 2), card("red", 3)],   // generic stub
    discardPile: [card("red", 0)],
    currentColor: "red",
    direction: 1,
    turnIndex: 0,
    hasDrawn: false,
    pendingDraw: 0,
    turnDeadlineMs: Date.now() + 30_000,
    winnerId: null,
    ...overrides,
  };
  return UnoStateMachine.restore(base);
}

describe("legality", () => {
  it("color match is legal", () => {
    expect(canPlay(card("red", 5), 7, "red")).toBe(true);
  });
  it("value match across colors is legal", () => {
    expect(canPlay(card("blue", 7), 7, "red")).toBe(true);
  });
  it("mismatch on both axes is illegal", () => {
    expect(canPlay(card("blue", 5), 7, "red")).toBe(false);
  });
  it("wild always legal", () => {
    expect(canPlay(card(undefined, "wild"), 7, "red")).toBe(true);
    expect(canPlay(card(undefined, "wild_draw4"), 7, "red")).toBe(true);
  });
});

describe("play / draw / pass flow", () => {
  it("happy play removes card from hand, advances turn, updates color", () => {
    const m = fromSnap({
      hands: [
        ["p1", [card("red", 5), card("blue", 9)]],
        ["p2", [card("green", 2)]],
      ],
      discardPile: [card("red", 0)],
      currentColor: "red",
    });
    const r = m.process("p1", { type: "uno_play", card: card("red", 5) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.settlement).toBe(null);
    const v = m.viewFor("p1");
    expect(v.self.cardCount).toBe(1);
    expect(v.currentColor).toBe("red");
    expect(v.currentTurn).toBe("p2");
  });

  it("rejects card not in hand", () => {
    const m = fromSnap({
      hands: [["p1", [card("red", 5)]], ["p2", [card("green", 2)]]],
      discardPile: [card("red", 0)],
    });
    const r = m.process("p1", { type: "uno_play", card: card("blue", 5) });
    expect(r.ok).toBe(false);
  });

  it("rejects illegal card vs current color/value", () => {
    const m = fromSnap({
      hands: [["p1", [card("blue", 5)]], ["p2", [card("green", 2)]]],
      discardPile: [card("red", 0)],
      currentColor: "red",
    });
    const r = m.process("p1", { type: "uno_play", card: card("blue", 5) });
    expect(r.ok).toBe(false);
  });

  it("draw → pass advances turn, returns drawn card to hand", () => {
    const m = fromSnap({
      hands: [["p1", [card("blue", 9)]], ["p2", [card("green", 2)]]],
      drawPile: [card("yellow", 4)],
      discardPile: [card("red", 0)],
      currentColor: "red",
    });
    const r1 = m.process("p1", { type: "uno_draw" });
    expect(r1.ok).toBe(true);
    expect(m.viewFor("p1").self.cardCount).toBe(2);
    const r2 = m.process("p1", { type: "uno_pass" });
    expect(r2.ok).toBe(true);
    expect(m.viewFor("p1").currentTurn).toBe("p2");
  });

  it("rejects pass without prior draw", () => {
    const m = fromSnap({
      hands: [["p1", [card("blue", 9)]], ["p2", [card("green", 2)]]],
      discardPile: [card("red", 0)],
    });
    const r = m.process("p1", { type: "uno_pass" });
    expect(r.ok).toBe(false);
  });
});

describe("action cards", () => {
  it("skip jumps over next player (3p)", () => {
    const m = fromSnap({
      playerIds: ["p1", "p2", "p3"],
      hands: [
        ["p1", [card("red", "skip"), card("blue", 9)]],
        ["p2", [card("green", 2)]],
        ["p3", [card("yellow", 4)]],
      ],
      discardPile: [card("red", 0)],
      currentColor: "red",
    });
    m.process("p1", { type: "uno_play", card: card("red", "skip") });
    expect(m.viewFor("p1").currentTurn).toBe("p3");
  });

  it("reverse flips direction; in 2P acts like skip", () => {
    const m2 = fromSnap({
      hands: [
        ["p1", [card("red", "reverse"), card("blue", 9)]],
        ["p2", [card("green", 2)]],
      ],
      discardPile: [card("red", 0)],
      currentColor: "red",
    });
    m2.process("p1", { type: "uno_play", card: card("red", "reverse") });
    expect(m2.viewFor("p1").currentTurn).toBe("p1");   // 2P reverse → skip → back to p1
  });

  it("draw2: next player picks up 2 and is skipped", () => {
    const m = fromSnap({
      playerIds: ["p1", "p2", "p3"],
      hands: [
        ["p1", [card("red", "draw2"), card("blue", 9)]],
        ["p2", [card("green", 2)]],
        ["p3", [card("yellow", 4)]],
      ],
      drawPile: [card("blue", 8), card("blue", 7)],
      discardPile: [card("red", 0)],
      currentColor: "red",
    });
    m.process("p1", { type: "uno_play", card: card("red", "draw2") });
    expect(m.viewFor("p2").self.cardCount).toBe(3);
    expect(m.viewFor("p1").currentTurn).toBe("p3");
  });

  it("wild requires declaredColor", () => {
    const m = fromSnap({
      hands: [["p1", [card(undefined, "wild")]], ["p2", [card("green", 2)]]],
      discardPile: [card("red", 0)],
    });
    const r1 = m.process("p1", { type: "uno_play", card: card(undefined, "wild") });
    expect(r1.ok).toBe(false);   // no declaredColor
    const r2 = m.process("p1", { type: "uno_play", card: card(undefined, "wild"), declaredColor: "blue" });
    expect(r2.ok).toBe(true);
    expect(m.viewFor("p1").currentColor).toBe("blue");
  });

  it("wild_draw4: next player picks up 4 and is skipped", () => {
    const m = fromSnap({
      playerIds: ["p1", "p2", "p3"],
      hands: [
        ["p1", [card(undefined, "wild_draw4"), card("blue", 9)]],
        ["p2", [card("green", 2)]],
        ["p3", [card("yellow", 4)]],
      ],
      drawPile: [
        card("blue", 1), card("blue", 2), card("blue", 3), card("blue", 4),
      ],
      discardPile: [card("red", 0)],
      currentColor: "red",
    });
    m.process("p1", { type: "uno_play", card: card(undefined, "wild_draw4"), declaredColor: "blue" });
    expect(m.viewFor("p2").self.cardCount).toBe(5);
    expect(m.viewFor("p1").currentTurn).toBe("p3");
    expect(m.viewFor("p1").currentColor).toBe("blue");
  });
});

describe("settlement", () => {
  it("emptying hand wins; deltas conserve to 0", () => {
    const m = fromSnap({
      hands: [
        ["p1", [card("red", 5)]],
        ["p2", [card("blue", 9), card("green", "skip")]],
      ],
      discardPile: [card("red", 0)],
      currentColor: "red",
    });
    const r = m.process("p1", { type: "uno_play", card: card("red", 5) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.settlement!;
    expect(s.winnerId).toBe("p1");
    const sum = s.players.reduce((a, p) => a + p.scoreDelta, 0);
    expect(sum).toBe(0);
    expect(s.unoDetail!.pointsByPlayer.p2).toBe(9 + 20);
  });

  it("forceSettle with forfeit applies +50 penalty", () => {
    const m = fromSnap({
      hands: [
        ["p1", [card("red", 5), card("blue", 5)]],
        ["p2", [card("blue", 9)]],
      ],
      discardPile: [card("red", 0)],
    });
    const s = m.forceSettle("disconnect", "p1");
    expect(s.winnerId).toBe("p2");
    const p1 = s.players.find(p => p.playerId === "p1")!;
    expect(p1.scoreDelta).toBe(-(10 + 50));   // hand 10 + 50 forfeit
    const sum = s.players.reduce((a, p) => a + p.scoreDelta, 0);
    expect(sum).toBe(0);
  });
});

describe("snapshot round-trip", () => {
  it("restore reproduces state", () => {
    const m1 = new UnoStateMachine("g", "r", ["p1", "p2", "p3", "p4"]);
    const snap = m1.snapshot();
    const m2 = UnoStateMachine.restore(snap);
    expect(m2.viewFor("p1")).toEqual(m1.viewFor("p1"));
    expect(m2.snapshot()).toEqual(snap);
  });
});

describe("scoring helpers", () => {
  it("number cards = face value", () => {
    expect(unoCardPoints(card("red", 0))).toBe(0);
    expect(unoCardPoints(card("blue", 9))).toBe(9);
  });
  it("action cards = 20", () => {
    expect(unoCardPoints(card("red", "skip"))).toBe(20);
    expect(unoCardPoints(card("green", "draw2"))).toBe(20);
  });
  it("wild cards = 50", () => {
    expect(unoCardPoints(card(undefined, "wild"))).toBe(50);
    expect(unoCardPoints(card(undefined, "wild_draw4"))).toBe(50);
  });
});
