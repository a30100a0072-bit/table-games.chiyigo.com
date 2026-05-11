// Bot self-play arena for Mahjong — fairness regression. Mirrors
// heartsArena.test.ts but drives the reaction phase (multiple seats may
// owe a pong/chow/hu/pass before the SM commits the highest-priority
// declaration and the turn advances).
//
// Dealer seat (bankerIdx=0 hardcoded by the SM ctor) gets one extra draw
// and acts first — a real positional edge. To isolate seat fairness from
// dealer-position bias we rotate which named bot sits in slot 0 across
// matches so each bot is dealer in 1/4 of trials.
//
// Bot-vs-bot draws (wall exhaustion with no hu) are common because the
// shanten-gated meld heuristic prefers menqing; drawExhaustion stamps
// winnerId = players[0] as a placeholder with scoreDelta all 0. Treating
// those as wins for slot 0 would skew the test, so we detect by
// scoreDelta and skip — fairness is measured over completed wins only.

import { describe, expect, it } from "vitest";
import { MahjongStateMachine } from "../src/game/MahjongStateMachine";
import { getMahjongBotAction } from "../src/game/BotAI";

const SEATS = ["BOT_1", "BOT_2", "BOT_3", "BOT_4"] as const;

function rotate(arr: readonly string[], n: number): string[] {
  return [...arr.slice(n), ...arr.slice(0, n)];
}

function playOneMatch(seed: number, seats: readonly string[]): string | null {
  const sm = new MahjongStateMachine(`g${seed}`, `r${seed}`, [...seats]);

  // Loose ceiling: 4×~18 discards + reactions ≈ 300 actions for a full
  // wall; 4000 absorbs reaction-storm pathological hands.                  // L3_邏輯安防
  for (let i = 0; i < 4000; i++) {
    const probe = sm.viewFor(seats[0]!);
    const phase = probe.phase;

    if (phase === "playing") {
      const actor = sm.currentTurn();
      const view = sm.viewFor(actor);
      const action = getMahjongBotAction(view);
      const r = sm.process(actor, action as never);
      if (!r.ok) throw new Error(`play illegal @${i} (${actor}): ${r.error}`);
      if (r.settlement) {
        const isDraw = r.settlement.players.every(p => p.scoreDelta === 0);
        return isDraw ? null : r.settlement.winnerId;
      }
      continue;
    }

    if (phase === "pending_reactions") {
      // Drive seats one at a time; SM only commits after every awaited
      // seat has declared. Bot is reactor-aware (checks
      // awaitingReactionsFrom internally) so we can safely loop.
      const actor = probe.awaitingReactionsFrom[0];
      if (!actor) throw new Error("pending_reactions but no awaitees");
      const view = sm.viewFor(actor);
      const action = getMahjongBotAction(view);
      let r = sm.process(actor, action as never);
      // getMahjongBotAction may suggest a chow when the actor isn't the
      // discarder's next-seat (the SM rejects with ONLY_NEXT_PLAYER_CAN_CHOW).
      // Production papers over this via reactionDeadline → tickReactionDeadline
      // collapse to mj_pass; we mirror that here so the arena measures
      // *fairness*, not a known bot-AI mis-suggestion.                       // L2_實作
      if (!r.ok && action.type === "chow") {
        r = sm.process(actor, { type: "mj_pass" } as never);
      }
      if (!r.ok) throw new Error(`react illegal @${i} (${actor}): ${r.error}`);
      if (r.settlement) {
        const isDraw = r.settlement.players.every(p => p.scoreDelta === 0);
        return isDraw ? null : r.settlement.winnerId;
      }
      continue;
    }

    if (phase === "settled" || phase === "between_hands") {
      // targetHands defaults to 1 → settlement returns matchOver and we
      // exit above. Reaching here means an unhandled terminal — bail.
      throw new Error(`unexpected terminal phase "${phase}"`);
    }

    throw new Error(`unexpected phase "${phase}" at action ${i}`);
  }
  throw new Error("mahjong match did not finish in 4000 actions");
}

describe("Bot self-play arena — Mahjong", () => {
  // Mahjong is the heaviest SM here — shanten enumeration runs on every
  // discard decision, so a self-play hand averages ~250ms. N=120 with
  // a 180s test timeout lands comfortably and still gives a tight enough
  // binomial CI to flag a seat that wins >40% / <10%.                      // L3_邏輯安防
  it("after N completed matches, every seat wins between 10% and 40%", { timeout: 180_000 }, () => {
    const N = 120;
    const wins: Record<string, number> = { BOT_1: 0, BOT_2: 0, BOT_3: 0, BOT_4: 0 };
    let draws = 0;
    for (let i = 0; i < N; i++) {
      const seats = rotate(SEATS, i % 4);
      const w = playOneMatch(i, seats);
      if (w === null) draws++;
      else wins[w]!++;
    }
    const completed = N - draws;
    if (completed < 30) throw new Error(`too few completed matches: ${completed}/${N}`);

    for (const seat of SEATS) {
      const rate = wins[seat]! / completed;
      expect(rate).toBeGreaterThan(0.10);
      expect(rate).toBeLessThan(0.40);
    }
    expect(Object.values(wins).reduce((s, v) => s + v, 0) + draws).toBe(N);
  });
});
