// Wire-envelope validator for WebSocket frames sent by clients.
// State machines own per-action validation; this layer only ensures the
// envelope shape so DO bookkeeping (seq, playerId match) can't be poisoned
// by malformed JSON like `{seq: "banana"}` or `{action: null}`.

import type { ActionFrame, PlayerAction } from "../types/game";

export type IncomingFrame =
  | { kind: "sync" }
  | { kind: "action"; frame: ActionFrame };

export type FrameParseResult =
  | { ok: true;  frame: IncomingFrame }
  | { ok: false; error: string };

const ACTION_TYPES = new Set<string>([
  "play", "pass",
  "discard", "chow", "pong", "kong", "hu", "mj_pass",
  "fold", "check", "call", "raise",
]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isAction(v: unknown): v is PlayerAction {
  if (!isObj(v)) return false;
  const t = v.type;
  return typeof t === "string" && ACTION_TYPES.has(t);
}

export function parseIncomingFrame(raw: string): FrameParseResult {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, error: "invalid JSON" }; }

  if (!isObj(parsed)) return { ok: false, error: "frame must be an object" };

  if (parsed.type === "sync") return { ok: true, frame: { kind: "sync" } };

  const { gameId, playerId, seq, action } = parsed;
  if (typeof gameId   !== "string") return { ok: false, error: "gameId must be string" };
  if (typeof playerId !== "string") return { ok: false, error: "playerId must be string" };
  if (typeof seq      !== "number" || !Number.isFinite(seq) || !Number.isInteger(seq) || seq < 0)
    return { ok: false, error: "seq must be a non-negative integer" };
  if (!isAction(action)) return { ok: false, error: "unknown action type" };

  return { ok: true, frame: { kind: "action", frame: { gameId, playerId, seq, action } } };
}
