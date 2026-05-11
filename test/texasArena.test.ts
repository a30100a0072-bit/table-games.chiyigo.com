// Bot self-play arena for Texas Hold'em — fairness regression. Mirrors
// botArena.test.ts (Big Two) but rotates dealerIdx so the button visits
// every seat equally — without rotation, BB+1 (UTG) would be locked into
// the worst pre-flop position every match and the seat-fairness signal
// would conflate with real positional EV.
//
// Single hand per match. Stacks are reset each match; `winnerId` is the
// main-pot taker per the SM. Math.random shuffles aren't seeded — over
// 240 hands the binomial noise still lets a real asymmetry (a bot that
// systematically over-folds from one seat, for instance) blow the CI.

import { describe, expect, it } from "vitest";
import { TexasHoldemStateMachine } from "../src/game/TexasHoldemStateMachine";
import { getTexasBotAction } from "../src/game/BotAI";

const SEATS = ["BOT_1", "BOT_2", "BOT_3", "BOT_4"] as const;
const START_STACK = 1000;
const SB = 5;
const BB = 10;

function playOneMatch(seed: number, dealerIdx: number): string {
  const sm = new TexasHoldemStateMachine(
    `g${seed}`,
    `r${seed}`,
    SEATS.map(playerId => ({ playerId, stack: START_STACK })),
    SB,
    BB,
    dealerIdx,
  );
  // Worst case: 4 streets × 4 players × a few re-raises ≈ 50 actions;
  // 400 ceiling is generous.                                              // L3_邏輯安防
  for (let i = 0; i < 400; i++) {
    const actor = sm.currentTurn();
    const view = sm.viewFor(actor);
    const action = getTexasBotAction(view);
    const r = sm.process(actor, action as never);
    if (!r.ok) throw new Error(`bot illegal action @${i} (${actor}): ${r.error}`);
    if (r.settlement) return r.settlement.winnerId;
  }
  throw new Error("texas hand did not finish in 400 actions");
}

describe("Bot self-play arena — Texas Hold'em", () => {
  it("after N matches with rotating dealer, every seat wins between 15% and 35%", () => {
    const N = 240;
    const wins: Record<string, number> = { BOT_1: 0, BOT_2: 0, BOT_3: 0, BOT_4: 0 };
    for (let i = 0; i < N; i++) {
      // Dealer cycles 0→1→2→3 so each seat is BTN/SB/BB/UTG equally.
      wins[playOneMatch(i, i % 4)]!++;
    }
    for (const seat of SEATS) {
      const rate = wins[seat]! / N;
      expect(rate).toBeGreaterThan(0.15);
      expect(rate).toBeLessThan(0.35);
    }
    expect(Object.values(wins).reduce((s, v) => s + v, 0)).toBe(N);
  });
});
