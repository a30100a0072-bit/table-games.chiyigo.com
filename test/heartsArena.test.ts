// Bot self-play arena for Hearts — fairness regression. Mirrors
// unoArena.test.ts but accounts for parallel pass phase + multi-hand
// cycle (match runs hands until someone hits 100 cumulative).

import { describe, expect, it } from "vitest";
import { HeartsStateMachine } from "../src/game/HeartsStateMachine";
import { getHeartsBotAction } from "../src/game/BotAI";

const SEATS = ["BOT_1", "BOT_2", "BOT_3", "BOT_4"] as const;

function playOneMatch(seed: number): string {
  const sm = new HeartsStateMachine(`g${seed}`, `r${seed}`, [...SEATS]);

  // Loose ceiling: a typical match is 4-10 hands (≈52 plays each + 4
  // passes); 5000 actions covers pathological deck distributions.        // L3_邏輯安防
  for (let i = 0; i < 5000; i++) {
    const phase = sm.phase();

    if (phase === "passing") {
      // Parallel — pick any seat that still owes a pass.
      let actor: string | null = null;
      for (const seat of SEATS) {
        if (sm.viewFor(seat).self.myPass === null) { actor = seat; break; }
      }
      if (!actor) throw new Error("passing phase but every seat already passed");
      const view = sm.viewFor(actor);
      const action = getHeartsBotAction(view);
      const r = sm.process(actor, action as never);
      if (!r.ok) throw new Error(`pass illegal @${i} (${actor}): ${r.error}`);
      continue;
    }

    if (phase === "playing") {
      const actor = sm.currentTurn();
      const view = sm.viewFor(actor);
      const action = getHeartsBotAction(view);
      const r = sm.process(actor, action as never);
      if (!r.ok) throw new Error(`play illegal @${i} (${actor}): ${r.error}`);
      if (r.settlement) {
        if (r.settlement.matchOver) return r.settlement.winnerId;
        sm.startNextHand();
      }
      continue;
    }

    if (phase === "between_hands") {
      // Defensive: settlement path above already advances; only reached
      // if a hand finalized without a returned settlement (shouldn't).
      sm.startNextHand();
      continue;
    }

    throw new Error(`unexpected phase "${phase}" at action ${i}`);
  }
  throw new Error("hearts match did not finish in 5000 actions");
}

describe("Bot self-play arena — Hearts", () => {
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
