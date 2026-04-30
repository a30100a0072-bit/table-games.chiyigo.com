// /src/game/BotAI.ts
// Stateless bot decision engines for all three games — zero IO, bounded by hand size. // L3_架構含防禦觀測
//
// Big Two   — greedy beats for 1/2/3-card combos + C(n,5) enumeration for 5-card beats.
// Mahjong   — tile-isolation heuristic for discards; always-Hu for reactions; pass on chow/pong/kong.
// Texas H'em — Chen formula preflop push/fold/call; category + simple pot-odds postflop.
//
// All branches must terminate within DO 50ms CPU budget. Hand sizes are bounded by      // L3_邏輯安防
// game rules (≤13 cards Big Two, 17 tiles Mahjong, 7 cards Texas), so all enumerations
// are constant-time at runtime.

import type {
  Card, Rank, Suit, ComboType,
  PlayerAction, GameStateView,
  MahjongTile, MahjongStateView,
  PokerStateView,
} from "../types/game";

import { detectCombo, cardVal } from "./BigTwoStateMachine";
import { canWin } from "./MahjongStateMachine";
import { rankFiveCardKey } from "./TexasHoldemStateMachine";

// ════════════════════════════════════════════════════════════════════════════
//  Big Two
// ════════════════════════════════════════════════════════════════════════════

const RANK_IDX_BT: Readonly<Record<Rank, number>> = {
  "3":0,"4":1,"5":2,"6":3,"7":4,
  "8":5,"9":6,"10":7,"J":8,"Q":9,"K":10,"A":11,"2":12,
} as const;

function sortAsc(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => cardVal(a) - cardVal(b));
}

const FIVE_TYPES: ReadonlySet<ComboType> = new Set([
  "straight", "flush", "fullHouse", "fourOfAKind", "straightFlush",
]);

/** Enumerate all C(n,5) 5-card subsets and return all valid combos with their scores. */
function* enumFiveCardCombos(hand: Card[]): Generator<{ cards: Card[]; score: number }> {
  const n = hand.length;
  if (n < 5) return;
  // Index-based enumeration; bounded by C(13,5) = 1287.                      // L3_邏輯安防
  const idx = [0, 1, 2, 3, 4];
  while (true) {
    const subset = idx.map(i => hand[i]!);
    const meta = detectCombo(subset);
    if (meta) yield { cards: subset, score: meta.score };
    // advance like odometer
    let k = 4;
    while (k >= 0 && idx[k]! === n - 5 + k) k--;
    if (k < 0) break;
    idx[k]!++;
    for (let j = k + 1; j < 5; j++) idx[j] = idx[j - 1]! + 1;
  }
}

function beatNTuple(hand: Card[], wantSize: 1 | 2 | 3, minScore: number): Card[] | null {
  if (wantSize === 1) {
    for (const c of hand) if (cardVal(c) > minScore) return [c];
    return null;
  }
  // pair / triple — group by rank, take lowest-suit subset that beats.        // L3_邏輯安防
  const groups = new Map<Rank, Card[]>();
  for (const c of hand) {
    const g = groups.get(c.rank) ?? [];
    g.push(c);
    groups.set(c.rank, g);
  }
  for (const cards of groups.values()) {
    if (cards.length >= wantSize) {
      const combo = cards.slice(0, wantSize);
      const top = combo.reduce((m, c) => Math.max(m, cardVal(c)), -1);
      if (top > minScore) return combo;
    }
  }
  return null;
}

/** Lead-mode: pick the lowest-scoring 5-card combo we can form (no minScore). */
function leadFiveCard(hand: Card[]): { cards: Card[]; combo: ComboType } | null {
  let best: { cards: Card[]; combo: ComboType; score: number } | null = null;
  for (const { cards, score } of enumFiveCardCombos(hand)) {
    if (!best || score < best.score) {
      const meta = detectCombo(cards)!;
      best = { cards, combo: meta.type, score };
    }
  }
  return best ? { cards: best.cards, combo: best.combo } : null;
}

/** Find the lowest-scoring 5-card combo that beats minScore. PASS-equivalent if none. */
function beatFiveCard(hand: Card[], minScore: number): { cards: Card[]; combo: ComboType } | null {
  let best: { cards: Card[]; combo: ComboType; score: number } | null = null;
  for (const { cards, score } of enumFiveCardCombos(hand)) {
    if (score <= minScore) continue;
    if (!best || score < best.score) {
      const meta = detectCombo(cards)!;
      best = { cards, combo: meta.type, score };
    }
  }
  return best ? { cards: best.cards, combo: best.combo } : null;
}

/** Lead-mode lowest playable subset when bot controls the trick.            // L3_邏輯安防
 *  Endgame hold: never lead with a "2" unless it's the only option, since
 *  2s are the highest cards in Big Two and are best saved for closing
 *  tricks against opponents. Pairs/triples of 2 are also avoided. */
function pickLead(hand: Card[]): { cards: Card[]; combo: ComboType } {
  const sorted = sortAsc(hand);
  // Opening turn 3♣ rule: if 3♣ is present, lead with it (machine enforces). // L3_邏輯安防
  const threeClub = sorted.find(c => c.rank === "3" && c.suit === "clubs");
  if (threeClub) return { cards: [threeClub], combo: "single" };

  const rankCount = new Map<Rank, number>();
  for (const c of sorted) rankCount.set(c.rank, (rankCount.get(c.rank) ?? 0) + 1);

  // Tier 1 — isolated card that isn't a 2 (best lead: small loss).            // L3_邏輯安防
  const isolatedNon2 = sorted.find(c => rankCount.get(c.rank) === 1 && c.rank !== "2");
  if (isolatedNon2) return { cards: [isolatedNon2], combo: "single" };

  // Tier 2 — any isolated card (only 2s are isolated; we'd burn a 2 either way).
  const isolated = sorted.find(c => rankCount.get(c.rank) === 1);
  if (isolated) return { cards: [isolated], combo: "single" };

  // Tier 3 — every card is part of a multi; dump the lowest non-2 if possible.
  const lowestNon2 = sorted.find(c => c.rank !== "2");
  return { cards: [lowestNon2 ?? sorted[0]!], combo: "single" };
}

export function getBigTwoBotAction(view: GameStateView, botHand: Card[]): PlayerAction {
  const sorted = sortAsc(botHand);
  const { lastPlay } = view;

  if (lastPlay === null) {
    // Aggressive lead: when controlling the trick with ≥6 cards left,
    // dump a 5-card combo if we have one — burns through the hand fast
    // and forces opponents into reactive play. Falls back to pickLead.
    if (sorted.length >= 6) {
      const five = leadFiveCard(sorted);
      if (five) return { type: "play", cards: five.cards, combo: five.combo };
    }
    const lead = pickLead(sorted);
    return { type: "play", cards: lead.cards, combo: lead.combo };
  }

  const lastMeta = detectCombo(lastPlay.cards);
  if (!lastMeta) return { type: "pass" };                                    // L3_邏輯安防

  if (lastPlay.combo === "single") {
    const c = beatNTuple(sorted, 1, lastMeta.score);
    if (c) return { type: "play", cards: c, combo: "single" };
    return { type: "pass" };
  }
  if (lastPlay.combo === "pair") {
    const c = beatNTuple(sorted, 2, lastMeta.score);
    if (c) return { type: "play", cards: c, combo: "pair" };
    return { type: "pass" };
  }
  if (lastPlay.combo === "triple") {
    const c = beatNTuple(sorted, 3, lastMeta.score);
    if (c) return { type: "play", cards: c, combo: "triple" };
    return { type: "pass" };
  }
  if (FIVE_TYPES.has(lastPlay.combo)) {
    const beat = beatFiveCard(sorted, lastMeta.score);
    if (beat) return { type: "play", cards: beat.cards, combo: beat.combo };
    return { type: "pass" };
  }
  return { type: "pass" };
}

/** Backwards-compatible alias for callers that still use the old name. */
export const getBotAction = getBigTwoBotAction;

// ════════════════════════════════════════════════════════════════════════════
//  Mahjong
// ════════════════════════════════════════════════════════════════════════════

function tileIndex(t: MahjongTile): number {
  switch (t.suit) {
    case "m": return 0 + (t.rank - 1);
    case "p": return 9 + (t.rank - 1);
    case "s": return 18 + (t.rank - 1);
    case "z": return 27 + (t.rank - 1);
  }
}

/**
 * Score how "useful" each tile is in the current hand. Higher = harder to discard.
 *  - copies of self contribute heavily (toward pair → pong)                  // L3_邏輯安防
 *  - same-suit neighbours within ±2 ranks contribute (toward chow)
 *  - honors get no neighbour bonus (cannot form chows)                        // L3_邏輯安防
 */
function tileUtility(counts: Uint8Array, idx: number): number {
  let score = (counts[idx]! - 1) * 1000;          // 0 if singleton, 1000 if pair, 2000 if triplet
  if (idx >= 27) return score;                    // honor → no chow
  const r = idx % 9;
  const base = idx - r;
  for (let d = 1; d <= 2; d++) {
    const w = d === 1 ? 100 : 30;
    if (r - d >= 0) score += counts[base + r - d]! * w;
    if (r + d <= 8) score += counts[base + r + d]! * w;
  }
  return score;
}

/** Pick the most isolated tile to discard. Lone honors leave first.          // L3_邏輯安防 */
function pickDiscardTile(hand: MahjongTile[]): MahjongTile {
  const counts = new Uint8Array(34);
  for (const t of hand) counts[tileIndex(t)]!++;
  let bestI = 0;
  let bestScore = Infinity;
  for (let i = 0; i < hand.length; i++) {
    const score = tileUtility(counts, tileIndex(hand[i]!));
    if (score < bestScore) { bestScore = score; bestI = i; }
  }
  return hand[bestI]!;
}

export function getMahjongBotAction(view: MahjongStateView): PlayerAction {
  const myId = view.self.playerId;

  // ── Reaction phase: bot decides hu / pass on the latest discard ─────── L3_架構
  if (view.phase === "pending_reactions" && view.awaitingReactionsFrom.includes(myId)) {
    const ld = view.lastDiscard;
    if (ld) {
      const candidate = [...view.self.hand, ld.tile];
      if (canWin(candidate, view.self.exposed.length)) {
        return { type: "hu", selfDrawn: false };
      }
    }
    // Conservative: keep menqing → never chow / pong / kong on opponent discards.  // L3_邏輯安防
    return { type: "mj_pass" };
  }

  // ── Playing phase: bot must discard (or self-drawn hu) ───────────────── L3_架構
  if (view.phase === "playing" && view.currentTurn === myId) {
    if (canWin(view.self.hand, view.self.exposed.length)) {
      return { type: "hu", selfDrawn: true };
    }
    return { type: "discard", tile: pickDiscardTile(view.self.hand) };
  }

  // Defensive fallback — DO will guard against scheduling us in wrong phase. // L3_架構含防禦觀測
  return { type: "mj_pass" };
}

// ════════════════════════════════════════════════════════════════════════════
//  Texas Hold'em
// ════════════════════════════════════════════════════════════════════════════

const RANK_VAL_TX: Record<Rank, number> = {
  "2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,"10":10,
  "J":11,"Q":12,"K":13,"A":14,
};

/**
 * Bill Chen formula — quick pre-flop hand-strength estimator.
 *  pair      : max(highCardScore × 2, 5)
 *  high card : highCardScore  (A=10, K=8, Q=7, J=6, otherwise rank/2)
 *  + 2 if suited
 *  - gap penalty (1=0, 2=−1, 3=−2, ≥4=−4)
 *  + 1 straight bonus when low-gap and both ranks ≤ Q
 */
function chenScore(hole: [Card, Card]): number {
  const v1 = RANK_VAL_TX[hole[0].rank];
  const v2 = RANK_VAL_TX[hole[1].rank];
  const hi = Math.max(v1, v2);
  const lo = Math.min(v1, v2);

  const baseHi =
    hi === 14 ? 10 :
    hi === 13 ? 8  :
    hi === 12 ? 7  :
    hi === 11 ? 6  :
    hi / 2;

  let s: number;
  if (v1 === v2) {
    s = Math.max(baseHi * 2, 5);          // pocket pair (e.g., 22 → 5, AA → 20)
  } else {
    s = baseHi;
  }
  if (hole[0].suit === hole[1].suit) s += 2;

  const gap = hi - lo - 1;                // 0 = connected, 1 = 1-gap, etc.
  if (v1 !== v2) {
    if (gap === 0) s += 0;
    else if (gap === 1) s -= 1;
    else if (gap === 2) s -= 2;
    else if (gap >= 3) s -= 4;
    if (gap <= 1 && hi < 12) s += 1;      // straight potential bonus
  }
  return Math.max(0, s);
}

/** Best 5-card category (0..8) from 5–7 available cards.                     // L3_邏輯安防 */
function bestCategory(cards: Card[]): number {
  if (cards.length < 5) return -1;
  const n = cards.length;
  let bestKey = -1;
  // C(7,5)=21 / C(6,5)=6 / C(5,5)=1
  for (let i = 0; i < n - 4; i++) {
    for (let j = i + 1; j < n - 3; j++) {
      for (let k = j + 1; k < n - 2; k++) {
        for (let l = k + 1; l < n - 1; l++) {
          for (let m = l + 1; m < n; m++) {
            const key = rankFiveCardKey([cards[i]!, cards[j]!, cards[k]!, cards[l]!, cards[m]!]);
            if (key > bestKey) bestKey = key;
          }
        }
      }
    }
  }
  return bestKey >> 20;
}

/** True iff hand contains a 4-card flush draw (4 of one suit). */
function hasFlushDraw(cards: Card[]): boolean {
  const counts: Record<Suit, number> = { spades: 0, hearts: 0, clubs: 0, diamonds: 0 };
  for (const c of cards) counts[c.suit]++;
  return counts.spades >= 4 || counts.hearts >= 4 || counts.clubs >= 4 || counts.diamonds >= 4;
}

export function getTexasBotAction(view: PokerStateView): PlayerAction {
  const me = view.self;
  const owe = Math.max(0, view.currentBet - me.betThisStreet);
  const canCheck = owe === 0;

  // Helper: compute a legal raise target. Returns null if we cannot make a full min-raise. // L2_鎖定
  const buildRaise = (): PlayerAction | null => {
    const target = view.currentBet + Math.max(view.minRaise, view.bigBlind);
    const cost = target - me.betThisStreet;
    if (cost <= 0 || cost > me.stack) return null;
    return { type: "raise", raiseAmount: target };
  };

  // ── Pre-flop: Chen-formula buckets ───────────────────────────────────── L2_實作
  if (view.street === "preflop") {
    const score = chenScore(me.holeCards);
    if (score >= 9) {
      return buildRaise() ?? (canCheck ? { type: "check" } : (owe <= me.stack ? { type: "call" } : { type: "fold" }));
    }
    if (score >= 7) {
      return canCheck ? { type: "check" } : (owe <= me.stack ? { type: "call" } : { type: "fold" });
    }
    if (score >= 5) {
      // Marginal: call only if owe ≤ 1.5 × BB
      if (canCheck) return { type: "check" };
      if (owe <= Math.floor(view.bigBlind * 1.5)) return { type: "call" };
      return { type: "fold" };
    }
    // Trash: fold to any bet, check otherwise
    return canCheck ? { type: "check" } : { type: "fold" };
  }

  // ── Post-flop: hand category + simple pot odds ───────────────────────── L2_實作
  const avail = [me.holeCards[0], me.holeCards[1], ...view.communityCards];
  const cat = bestCategory(avail);

  // Trips or better → value-bet aggressively
  if (cat >= 3) {
    return buildRaise() ?? (canCheck ? { type: "check" } : { type: "call" });
  }
  // Pair / two-pair → see cheap cards, fold to large bets
  if (cat >= 1) {
    if (canCheck) return { type: "check" };
    const potTotal = view.pots.reduce((s, p) => s + p.amount, 0);
    const callOdds = owe / (potTotal + owe);
    if (callOdds <= 0.33) return { type: "call" };
    return { type: "fold" };
  }
  // High card only — call cheap with flush draw, otherwise fold to bet
  if (canCheck) return { type: "check" };
  if (hasFlushDraw(avail)) {
    const potTotal = view.pots.reduce((s, p) => s + p.amount, 0);
    const callOdds = owe / (potTotal + owe);
    if (callOdds <= 0.20) return { type: "call" };
  }
  return { type: "fold" };
}
