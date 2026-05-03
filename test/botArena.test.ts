// Bot self-play arena: run all-bot Big Two matches and assert that no
// seat enjoys an outsized win rate. Catches dealer-bias / asymmetric
// heuristic regressions where the bot's logic accidentally favours a
// specific position. Pure SM driver — no DO/WS/D1.                        // L3_架構含防禦觀測
//
// Big Two only for v1. Texas seeding hooks aren't injected (the SM uses
// Math.random inside shuffleDeck), so adding it here would couple us to
// global RNG mocking. Mahjong's reaction phase is heavier to drive
// in-process; both can graduate later if the asymmetry signal proves
// useful.

import { describe, expect, it } from "vitest";
import { BigTwoStateMachine } from "../src/game/BigTwoStateMachine";
import { getBigTwoBotAction } from "../src/game/BotAI";

const SEATS = ["BOT_1", "BOT_2", "BOT_3", "BOT_4"] as const;

function playOneMatch(): string {
  const sm = new BigTwoStateMachine("g", "r", [...SEATS]);
  // Bounded loop: every action either drops cards or passes; an absurd
  // ceiling that real play never hits.                                 // L3_邏輯安防
  for (let i = 0; i < 800; i++) {
    const snap = sm.snapshot();
    const actor = snap.playerIds[snap.turnIndex]!;
    const view = sm.getView(actor);
    const hand = view.self.hand;
    const action = getBigTwoBotAction(view, hand);
    const r = sm.processAction(actor, action);
    if (r.settlement) return r.settlement.winnerId;
  }
  throw new Error("match did not finish in 800 actions");
}

describe("Bot self-play arena — Big Two", () => {
  it("after N matches, every seat wins between 15% and 35%", () => {
    const N = 240;          // SE ≈ √(0.25·0.75/240) ≈ 0.028 → 95% CI ~ ±0.055
    const wins: Record<string, number> = { BOT_1: 0, BOT_2: 0, BOT_3: 0, BOT_4: 0 };
    for (let i = 0; i < N; i++) {
      const w = playOneMatch();
      wins[w] = (wins[w] ?? 0) + 1;
    }
    // Each seat should be close to 25%. Bound it loose enough to absorb
    // the binomial noise of N=240 trials without flaking, tight enough
    // to catch real asymmetry. A bot favouring one seat would push that
    // seat's rate well past 35%.                                       // L3_邏輯安防
    for (const seat of SEATS) {
      const rate = wins[seat]! / N;
      expect(rate).toBeGreaterThan(0.15);
      expect(rate).toBeLessThan(0.35);
    }
    // Sanity: rates sum to 1 (every match has exactly one winner).
    expect(Object.values(wins).reduce((s, v) => s + v, 0)).toBe(N);
  });
});
