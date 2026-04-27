// /src/game/BotAI.ts
// Stateless greedy bot decision engine — zero IO, O(N) per call.        // L3_架構含防禦觀測
// N is bounded by hand size (≤ 13), so O(N) = O(1) at runtime.          // L3_邏輯安防

import type { Card, Rank, Suit, ComboType, PlayerAction, GameStateView } from "../types/game";

// ── Card ordering (mirrors BigTwoStateMachine to stay in sync) ──────── L2_實作

const RANK_IDX: Readonly<Record<Rank, number>> = {
  "3":0,"4":1,"5":2,"6":3,"7":4,
  "8":5,"9":6,"10":7,"J":8,"Q":9,"K":10,"A":11,"2":12,
} as const;

const SUIT_IDX: Readonly<Record<Suit, number>> = {
  clubs:0, diamonds:1, hearts:2, spades:3,
} as const;

function cardVal(c: Card): number { return RANK_IDX[c.rank] * 4 + SUIT_IDX[c.suit]; }

/** Sort ascending by card value. Returns a new array; input unchanged. */
function sortAsc(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => cardVal(a) - cardVal(b));
}

/** Score of the highest card in an already-sorted slice. */
function topScore(sorted: Card[]): number { return cardVal(sorted[sorted.length - 1]!); }

// ── O(N) combo-beat finders ───────────────────────────────────────────── L3_邏輯安防
// All finders receive `hand` pre-sorted ascending by cardVal.
// They scan once left-to-right, returning the FIRST (lowest) valid combo.

function beatSingle(hand: Card[], minScore: number): Card[] | null {
  for (const c of hand) {
    if (cardVal(c) > minScore) return [c];      // first card > table wins  // L3_邏輯安防
  }
  return null;
}

function beatPair(hand: Card[], minScore: number): Card[] | null {
  // Build rank → cards map in one O(N) pass.                            // L3_邏輯安防
  // Map insertion order matches sorted order → first valid group = lowest rank.
  const groups = new Map<Rank, Card[]>();
  for (const c of hand) {
    const g = groups.get(c.rank) ?? [];
    g.push(c);
    groups.set(c.rank, g);
  }
  for (const cards of groups.values()) {
    if (cards.length >= 2) {
      const pair = cards.slice(0, 2);           // two lowest suits of this rank
      if (topScore(pair) > minScore) return pair;
    }
  }
  return null;
}

function beatTriple(hand: Card[], minScore: number): Card[] | null {
  const groups = new Map<Rank, Card[]>();
  for (const c of hand) {
    const g = groups.get(c.rank) ?? [];
    g.push(c);
    groups.set(c.rank, g);
  }
  for (const cards of groups.values()) {
    if (cards.length >= 3) {
      const triple = cards.slice(0, 3);
      if (topScore(triple) > minScore) return triple;
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────── L2_實作

/**
 * Pure greedy decision for a bot seat.
 *
 * Strategy:
 *   • Table clear  → play lowest single; if 3♣ is in hand include it
 *     (handles opening-turn 3♣ constraint without knowing isFirstTurn).  // L3_邏輯安防
 *   • Table single / pair / triple → O(N) scan for smallest beating combo.
 *   • Table 5-card combo → PASS (avoids O(N^5) search; safe since the
 *     state machine allows passing on any 5-card round).                  // L3_邏輯安防
 *
 * @param view     Perspective snapshot for this bot (self.hand = full hand).
 * @param botHand  Must equal view.self.hand; passed separately so callers
 *                 can override in tests without reconstructing a full view.
 */
export function getBotAction(view: GameStateView, botHand: Card[]): PlayerAction {
  const sorted = sortAsc(botHand);
  const { lastPlay } = view;

  // ── Table is clear: bot controls the trick ────────────────────────── L3_邏輯安防
  if (lastPlay === null) {
    // If 3♣ is present the opening-turn constraint may apply — always lead with it. // L3_邏輯安防
    const anchor = sorted.find(c => c.rank === "3" && c.suit === "clubs") ?? sorted[0]!; // L2_鎖定 botHand 非空
    return { type: "play", cards: [anchor], combo: "single" };
  }

  // ── Try to beat the current table combo ──────────────────────────── L3_邏輯安防
  const minScore = topScore(sortAsc(lastPlay.cards));
  let played: Card[] | null = null;

  switch (lastPlay.combo as ComboType) {
    case "single":  played = beatSingle(sorted, minScore); break;
    case "pair":    played = beatPair(sorted, minScore);   break;
    case "triple":  played = beatTriple(sorted, minScore); break;
    default:        break; // straight / flush / fullHouse / fourOfAKind / straightFlush → pass // L3_邏輯安防
  }

  if (played) return { type: "play", cards: played, combo: lastPlay.combo };
  return { type: "pass" };
}
