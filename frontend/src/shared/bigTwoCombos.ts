// Big Two combo enumeration for the quick-pick UI.
// Pure functions: given a hand, return ordered candidate combos of a given
// type (lowest first). The server is still the authority on legality vs.
// the last play — these helpers only assist card selection.

import type { Card, ComboType } from "./types";

export type QuickComboType = "pair" | "straight" | "fullHouse" | "fourOfAKind" | "straightFlush";

const RANK_ORDER = ["3","4","5","6","7","8","9","10","J","Q","K","A","2"] as const;
const SUITS      = ["diamonds","clubs","hearts","spades"] as const;

const rankVal = (r: string) => RANK_ORDER.indexOf(r as typeof RANK_ORDER[number]);
const suitVal = (s: string) => ({ diamonds: 0, clubs: 1, hearts: 2, spades: 3 }[s] ?? 0);
const cardVal = (c: Card) => rankVal(c.rank) * 4 + suitVal(c.suit);

function groupByRank(hand: Card[]): Map<typeof RANK_ORDER[number], Card[]> {
  const m = new Map<typeof RANK_ORDER[number], Card[]>();
  for (const c of hand) {
    const list = m.get(c.rank) ?? [];
    list.push(c);
    m.set(c.rank, list);
  }
  for (const [, list] of m) list.sort((a, b) => suitVal(a.suit) - suitVal(b.suit));
  return m;
}

function groupBySuit(hand: Card[]): Map<typeof SUITS[number], Card[]> {
  const m = new Map<typeof SUITS[number], Card[]>();
  for (const c of hand) {
    const list = m.get(c.suit) ?? [];
    list.push(c);
    m.set(c.suit, list);
  }
  for (const [, list] of m) list.sort((a, b) => rankVal(a.rank) - rankVal(b.rank));
  return m;
}

function maxVal(cards: Card[]): number {
  return cards.reduce((m, c) => Math.max(m, cardVal(c)), -1);
}

// ── Pair ────────────────────────────────────────────────────────────────
// One option per rank with ≥2 cards: pick the two lowest-suit cards so the
// combo is the smallest possible at that rank.
function enumPairs(hand: Card[]): Card[][] {
  const out: Card[][] = [];
  const groups = groupByRank(hand);
  for (const r of RANK_ORDER) {
    const g = groups.get(r);
    if (g && g.length >= 2) out.push([g[0], g[1]]);
  }
  return out;
}

// ── Straight (5 sequential ranks, mixed suits allowed) ────────────────
// For each window of 5 consecutive ranks where every rank exists in hand,
// emit one option using the lowest-suit card per rank.
function enumStraights(hand: Card[]): Card[][] {
  const out: Card[][] = [];
  const groups = groupByRank(hand);
  for (let i = 0; i + 4 < RANK_ORDER.length; i++) {
    const window = RANK_ORDER.slice(i, i + 5);
    const picks: Card[] = [];
    let ok = true;
    for (const r of window) {
      const g = groups.get(r);
      if (!g || g.length === 0) { ok = false; break; }
      picks.push(g[0]);
    }
    if (ok) out.push(picks);
  }
  return out;
}

// ── Full house (3 + 2) ──────────────────────────────────────────────────
function enumFullHouses(hand: Card[]): Card[][] {
  const out: Card[][] = [];
  const groups = groupByRank(hand);
  const triples: typeof RANK_ORDER[number][] = [];
  const pairs:   typeof RANK_ORDER[number][] = [];
  for (const r of RANK_ORDER) {
    const g = groups.get(r);
    if (!g) continue;
    if (g.length >= 3) triples.push(r);
    if (g.length >= 2) pairs.push(r);
  }
  for (const tr of triples) {
    for (const pr of pairs) {
      if (pr === tr) continue;
      const tg = groups.get(tr)!; const pg = groups.get(pr)!;
      out.push([tg[0], tg[1], tg[2], pg[0], pg[1]]);
    }
  }
  // Sort by triple rank (the canonical full-house comparator).
  return out.sort((a, b) => rankVal(a[0].rank) - rankVal(b[0].rank));
}

// ── Four of a kind (4 + 1 kicker) ──────────────────────────────────────
function enumFourOfAKind(hand: Card[]): Card[][] {
  const out: Card[][] = [];
  const groups = groupByRank(hand);
  for (const r of RANK_ORDER) {
    const g = groups.get(r);
    if (!g || g.length < 4) continue;
    const kicker = hand
      .filter(c => c.rank !== r)
      .sort((a, b) => cardVal(a) - cardVal(b))[0];
    if (!kicker) continue;
    out.push([g[0], g[1], g[2], g[3], kicker]);
  }
  return out;
}

// ── Straight flush (5 sequential same-suit) ─────────────────────────────
function enumStraightFlushes(hand: Card[]): Card[][] {
  const out: Card[][] = [];
  const bySuit = groupBySuit(hand);
  for (const cards of bySuit.values()) {
    if (cards.length < 5) continue;
    const ranks = new Set(cards.map(c => c.rank));
    for (let i = 0; i + 4 < RANK_ORDER.length; i++) {
      const window = RANK_ORDER.slice(i, i + 5);
      if (window.every(r => ranks.has(r))) {
        const picks = window.map(r => cards.find(c => c.rank === r)!);
        out.push(picks);
      }
    }
  }
  return out.sort((a, b) => maxVal(a) - maxVal(b));
}

const ENUMERATORS: Record<QuickComboType, (hand: Card[]) => Card[][]> = {
  pair:          enumPairs,
  straight:      enumStraights,
  fullHouse:     enumFullHouses,
  fourOfAKind:   enumFourOfAKind,
  straightFlush: enumStraightFlushes,
};

export const COMBO_OF: Record<QuickComboType, ComboType> = {
  pair: "pair", straight: "straight", fullHouse: "fullHouse",
  fourOfAKind: "fourOfAKind", straightFlush: "straightFlush",
};

/** Enumerate all candidate combos of `type` from `hand`, lowest first. */
export function findCombos(hand: Card[], type: QuickComboType): Card[][] {
  return ENUMERATORS[type](hand);
}
