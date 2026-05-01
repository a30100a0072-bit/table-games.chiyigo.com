// Spectator view privacy tests — the redacted view fed to read-only
// spectator WebSockets must not leak any player's private state.

import { describe, expect, it } from "vitest";
import { createEngine, SPECTATOR_PLAYER_ID } from "../src/game/GameEngineAdapter";
import type { GameStateView, MahjongStateView, PokerStateView } from "../src/types/game";

describe("getSpectatorView", () => {
  it("BigTwo: self is phantom with empty hand, all real seats are opponents", () => {
    const eng  = createEngine({ gameType: "bigTwo", gameId: "g", roundId: "r", playerIds: ["a","b","c","d"] });
    const view = eng.getSpectatorView() as GameStateView;

    expect(view.self.playerId).toBe(SPECTATOR_PLAYER_ID);
    expect(view.self.hand).toEqual([]);
    expect(view.self.cardCount).toBe(0);

    const oppIds = view.opponents.map(o => o.playerId).sort();
    expect(oppIds).toEqual(["a","b","c","d"]);
    // OpponentView shape never includes a `hand` field by type contract;
    // double-check at runtime so a refactor can't quietly add one.
    for (const o of view.opponents)
      expect((o as { hand?: unknown }).hand).toBeUndefined();
  });

  it("Mahjong: spectator self has no hand / no exposed / no flowers", () => {
    const eng  = createEngine({ gameType: "mahjong", gameId: "g", roundId: "r", playerIds: ["a","b","c","d"] });
    const view = eng.getSpectatorView() as MahjongStateView;

    expect(view.self.playerId).toBe(SPECTATOR_PLAYER_ID);
    expect(view.self.hand).toEqual([]);
    expect(view.self.exposed).toEqual([]);
    expect(view.self.flowers).toEqual([]);

    const oppIds = view.opponents.map(o => o.playerId).sort();
    expect(oppIds).toEqual(["a","b","c","d"]);
    // Each opponent must surface only counts and exposed melds, never raw tiles.
    for (const o of view.opponents) {
      expect(typeof o.handCount).toBe("number");
      expect(Array.isArray(o.exposed)).toBe(true);
      expect((o as { hand?: unknown }).hand).toBeUndefined();
    }
  });

  it("Texas: spectator self has 0 stack and a placeholder hole; real seats in opponents have no holeCards pre-showdown", () => {
    const eng  = createEngine({ gameType: "texas", gameId: "g", roundId: "r", playerIds: ["a","b","c","d"] });
    const view = eng.getSpectatorView() as PokerStateView;

    expect(view.self.playerId).toBe(SPECTATOR_PLAYER_ID);
    expect(view.self.stack).toBe(0);
    expect(view.self.betThisStreet).toBe(0);

    const oppIds = view.opponents.map(o => o.playerId).sort();
    expect(oppIds).toEqual(["a","b","c","d"]);
    // Pre-showdown street: no real player's hole cards may leak.
    expect(["preflop","flop","turn","river"]).toContain(view.street);
    for (const o of view.opponents)
      expect(o.holeCards).toBeUndefined();
  });
});
