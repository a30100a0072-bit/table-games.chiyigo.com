// Bot self-play arena for Uno — fairness regression. Mirrors botArena.test.ts.

import { describe, expect, it } from "vitest";
import { UnoStateMachine } from "../src/game/UnoStateMachine";
import { getUnoBotAction } from "../src/game/BotAI";

const SEATS = ["BOT_1", "BOT_2", "BOT_3", "BOT_4"] as const;

function playOneMatch(seed: number): string {
  void seed;
  const sm = new UnoStateMachine(`g${seed}`, `r${seed}`, [...SEATS]);
  // Worst case: deck exhausted then reshuffled. Loose ceiling 2000.        // L3_邏輯安防
  for (let i = 0; i < 2000; i++) {
    const view = sm.viewFor(sm.currentTurn());
    const action = getUnoBotAction(view);
    const r = sm.process(sm.currentTurn(), action as never);
    if (!r.ok) throw new Error(`bot illegal action @${i}: ${r.error}`);
    if (r.settlement) return r.settlement.winnerId;
  }
  throw new Error("uno match did not finish in 2000 actions");
}

describe("Bot self-play arena — Uno", () => {
  it("after N matches, every seat wins between 15% and 35%", () => {
    const N = 200;
    const wins: Record<string, number> = { BOT_1: 0, BOT_2: 0, BOT_3: 0, BOT_4: 0 };
    for (let i = 0; i < N; i++) wins[playOneMatch(i)]!++;
    for (const seat of SEATS) {
      const rate = wins[seat]! / N;
      expect(rate).toBeGreaterThan(0.15);
      expect(rate).toBeLessThan(0.35);
    }
    expect(Object.values(wins).reduce((s, v) => s + v, 0)).toBe(N);
  });
});
