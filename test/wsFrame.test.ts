// Unit tests for the WS envelope validator. Per-action validation lives
// in the state machines; we only assert the envelope guarantees here.

import { describe, expect, it } from "vitest";
import { parseIncomingFrame } from "../src/utils/wsFrame";

describe("parseIncomingFrame", () => {
  it("accepts a sync frame", () => {
    const r = parseIncomingFrame(JSON.stringify({ type: "sync" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.frame.kind).toBe("sync");
  });

  it("accepts a well-formed action frame", () => {
    const r = parseIncomingFrame(JSON.stringify({
      gameId: "g1", playerId: "p1", seq: 7, action: { type: "pass" },
    }));
    expect(r.ok).toBe(true);
    if (r.ok && r.frame.kind === "action") {
      expect(r.frame.frame.seq).toBe(7);
      expect(r.frame.frame.action.type).toBe("pass");
    }
  });

  it("rejects invalid JSON", () => {
    const r = parseIncomingFrame("{not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid JSON");
  });

  it("rejects non-object root", () => {
    const r = parseIncomingFrame("[]");
    expect(r.ok).toBe(false);
  });

  it("rejects non-numeric seq", () => {
    const r = parseIncomingFrame(JSON.stringify({
      gameId: "g1", playerId: "p1", seq: "banana", action: { type: "pass" },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/seq/);
  });

  it("rejects negative or non-integer seq", () => {
    expect(parseIncomingFrame(JSON.stringify({
      gameId: "g", playerId: "p", seq: -1, action: { type: "pass" },
    })).ok).toBe(false);
    expect(parseIncomingFrame(JSON.stringify({
      gameId: "g", playerId: "p", seq: 1.5, action: { type: "pass" },
    })).ok).toBe(false);
  });

  it("rejects null action", () => {
    const r = parseIncomingFrame(JSON.stringify({
      gameId: "g", playerId: "p", seq: 0, action: null,
    }));
    expect(r.ok).toBe(false);
  });

  it("rejects unknown action type", () => {
    const r = parseIncomingFrame(JSON.stringify({
      gameId: "g", playerId: "p", seq: 0, action: { type: "drop_table" },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/action type/);
  });

  it("rejects non-string gameId / playerId", () => {
    expect(parseIncomingFrame(JSON.stringify({
      gameId: 1, playerId: "p", seq: 0, action: { type: "pass" },
    })).ok).toBe(false);
    expect(parseIncomingFrame(JSON.stringify({
      gameId: "g", playerId: 1, seq: 0, action: { type: "pass" },
    })).ok).toBe(false);
  });

  it("accepts all known action types", () => {
    const types = [
      "play", "pass", "discard", "chow", "pong", "kong", "hu", "mj_pass",
      "fold", "check", "call", "raise",
    ];
    for (const type of types) {
      const r = parseIncomingFrame(JSON.stringify({
        gameId: "g", playerId: "p", seq: 0, action: { type },
      }));
      expect(r.ok, `action ${type} should parse`).toBe(true);
    }
  });
});
