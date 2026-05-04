// Bot self-play arena for Yahtzee — fairness regression.

import { describe, expect, it } from "vitest";
import { YahtzeeStateMachine } from "../src/game/YahtzeeStateMachine";
import { getYahtzeeBotAction } from "../src/game/BotAI";

const SEATS = ["BOT_1", "BOT_2", "BOT_3", "BOT_4"] as const;

function playOneMatch(seed: number): string {
  const sm = new YahtzeeStateMachine(`g${seed}`, `r${seed}`, [...SEATS]);
  // Each player has 13 turns × 3 rolls + 1 score = 4 actions/turn → ~208
  // actions for a full match. 800 ceiling is very loose.                  // L3_邏輯安防
  for (let i = 0; i < 800; i++) {
    const view = sm.viewFor(sm.currentTurn());
    const action = getYahtzeeBotAction(view);
    const r = sm.process(sm.currentTurn(), action as never);
    if (!r.ok) throw new Error(`bot illegal action @${i}: ${r.error}`);
    if (r.settlement) return r.settlement.winnerId;
  }
  throw new Error("yahtzee match did not finish in 800 actions");
}

describe("Bot self-play arena — Yahtzee", () => {
  it("after N matches, every seat wins between 10% and 40%", () => {
    // Yahtzee is dice-driven so per-seat variance is wider than card games.
    // Loose window prevents flakes; still catches "seat 1 wins 70%".
    const N = 200;
    const wins: Record<string, number> = { BOT_1: 0, BOT_2: 0, BOT_3: 0, BOT_4: 0 };
    for (let i = 0; i < N; i++) wins[playOneMatch(i)]!++;
    for (const seat of SEATS) {
      const rate = wins[seat]! / N;
      expect(rate).toBeGreaterThan(0.10);
      expect(rate).toBeLessThan(0.40);
    }
    expect(Object.values(wins).reduce((s, v) => s + v, 0)).toBe(N);
  });
});
