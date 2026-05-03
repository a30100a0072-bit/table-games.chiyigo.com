import { describe, it, expect } from "vitest";
import { lobbyKey } from "../src/api/lobby";

describe("lobbyKey — multi-hand mahjong bucketing", () => {
  it("returns plain gameType for non-mahjong (any hands ignored)", () => {
    expect(lobbyKey("bigTwo")).toBe("bigTwo");
    expect(lobbyKey("texas")).toBe("texas");
    expect(lobbyKey("bigTwo", 4)).toBe("bigTwo");
  });

  it("returns plain 'mahjong' for single-hand mahjong (default)", () => {
    expect(lobbyKey("mahjong")).toBe("mahjong");
    expect(lobbyKey("mahjong", 1)).toBe("mahjong");
    expect(lobbyKey("mahjong", undefined)).toBe("mahjong");
  });

  it("suffixes ':N' for multi-hand mahjong so each N has its own queue", () => {
    expect(lobbyKey("mahjong", 4)).toBe("mahjong:4");
    expect(lobbyKey("mahjong", 8)).toBe("mahjong:8");
    expect(lobbyKey("mahjong", 16)).toBe("mahjong:16");
  });
});
