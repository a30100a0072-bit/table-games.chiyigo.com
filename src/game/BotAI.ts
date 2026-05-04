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
  UnoCard, UnoColor, UnoStateView,
  YahtzeeStateView, YahtzeeSlot, DiceTuple, HeldTuple,
} from "../types/game";
import { YAHTZEE_SLOTS } from "../types/game";
import { canPlay as canPlayUno, unoCardPoints } from "./UnoStateMachine";
import { scoreSlot } from "./YahtzeeStateMachine";

import { detectCombo, cardVal } from "./BigTwoStateMachine";
import { canWin } from "./MahjongStateMachine";
import { rankFiveCardKey } from "./TexasHoldemStateMachine";
import { mahjongShanten, mahjongTileIndex, tilesToCounts, countWinningOuts } from "./MahjongShanten";
import type { MahjongSuit } from "../types/game";

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
function pickLead(hand: Card[], opponentMinCount: number = Infinity): { cards: Card[]; combo: ComboType } {
  const sorted = sortAsc(hand);
  // Opening turn 3♣ rule: if 3♣ is present, lead with it (machine enforces). // L3_邏輯安防
  const threeClub = sorted.find(c => c.rank === "3" && c.suit === "clubs");
  if (threeClub) return { cards: [threeClub], combo: "single" };

  // Endgame "single-shot win" — when the entire hand forms exactly one
  // legal combo, dumping it ends the game in our favour if opponents
  // can't beat it. This beats the previous behaviour of leading one
  // card from a pair-of-the-last-2: that path was strictly worse, since
  // it gave any opponent a free chance to beat the lower card and leave
  // us holding the higher one as a single (still beatable by a 2 we
  // don't control).                                                          // L3_邏輯安防
  if (sorted.length === 2 && sorted[0]!.rank === sorted[1]!.rank) {
    return { cards: sorted, combo: "pair" };
  }
  if (sorted.length === 3 && sorted[0]!.rank === sorted[1]!.rank && sorted[1]!.rank === sorted[2]!.rank) {
    return { cards: sorted, combo: "triple" };
  }
  if (sorted.length === 5) {
    const meta = detectCombo(sorted);
    if (meta && FIVE_TYPES.has(meta.type)) {
      return { cards: sorted, combo: meta.type };
    }
  }

  // Threat lead: an opponent with exactly 1 card wins the trick on
  // their next turn unless we play something they can't beat. Their 1
  // card can only beat us as a single, so leading our HIGHEST single
  // gives them the fewest beats. Skipped when our hand is shorter than
  // 3 — at 2 cards we're already in our own endgame and the
  // single-shot branch above handles it; below that pickLead isn't
  // even called.                                                             // L3_邏輯安防
  if (opponentMinCount === 1 && sorted.length >= 3) {
    const highest = sorted[sorted.length - 1]!;
    return { cards: [highest], combo: "single" };
  }

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
    const opponentMinCount = view.opponents.length > 0
      ? Math.min(...view.opponents.map(o => o.cardCount))
      : Infinity;

    // Aggressive lead: when controlling the trick with ≥6 cards left,
    // dump a 5-card combo if we have one — burns through the hand fast
    // and forces opponents into reactive play. Falls back to pickLead.
    //
    // BUT skip when we still hold 3♣: that's an unambiguous "first turn
    // of the match" signal (only the 3♣ holder is scheduled for the
    // opening play, and they MUST include 3♣). leadFiveCard might
    // pick a combo that excludes 3♣ and the SM rejects it. Defer to
    // pickLead which always leads with 3♣ when present.                  // L3_邏輯安防
    const stillHolds3Clubs = sorted.some(c => c.rank === "3" && c.suit === "clubs");
    if (sorted.length >= 6 && !stillHolds3Clubs) {
      const five = leadFiveCard(sorted);
      if (five) return { type: "play", cards: five.cards, combo: five.combo };
    }
    const lead = pickLead(sorted, opponentMinCount);
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
    // "f" flowers are auto-replaced by the state machine and never reach
    // the bot's view; this branch is unreachable in practice.
    case "f": return -1;
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

/** Pick a discard by computing each candidate's resulting shanten.            // L3_邏輯安防
 *
 *  Score key (lower wins):
 *    KONG_DANGER (10M)   — discarding feeds an opponent's pong → kong upgrade
 *    + shanten × 100K    — primary: how close we still are to win
 *    − outs    × 100     — tiebreak: more winning tiles remaining = better wait
 *    SOFT_DANGER (50K)   — opponent has ≥3 exposed melds in this tile's suit
 *                          (they're imminent and likely waiting in-suit)
 *    + isolation utility — final tiebreak: prefer dropping low-connectivity tiles
 *
 *  Soft-danger threshold is intentionally conservative (≥3 exposed melds);
 *  earlier signals are too noisy to act on without folding too much value. */
function pickDiscardTile(
  hand: MahjongTile[],
  opponentExposed: readonly (readonly { kind: string; tiles: MahjongTile[] }[])[] = [],
  exposedSelf: number = 0,
): MahjongTile {
  const counts = new Uint8Array(34);
  for (const t of hand) counts[tileIndex(t)]!++;

  const dangerTileIndices = new Set<number>();           // kong-feed (hard)
  const imminentSuits = new Set<MahjongSuit>();          // opponent ≥3 exposed
  for (const melds of opponentExposed) {
    for (const m of melds) {
      if (m.kind === "pong" && m.tiles[0]) {
        dangerTileIndices.add(tileIndex(m.tiles[0]));
      }
    }
    if (melds.length >= 3) {
      for (const m of melds) {
        const t0 = m.tiles[0];
        if (t0 && t0.suit !== "f") imminentSuits.add(t0.suit);
      }
    }
  }
  const softDangerTileIndices = new Set<number>();
  if (imminentSuits.size > 0) {
    for (let i = 0; i < 34; i++) {
      const suit: MahjongSuit =
        i < 9 ? "m" : i < 18 ? "p" : i < 27 ? "s" : "z";
      if (imminentSuits.has(suit)) softDangerTileIndices.add(i);
    }
  }

  // Per-discard cache: shanten + outs share the same simulation step.        // L2_實作
  const cache = new Map<number, { sh: number; outs: number }>();
  const evalDiscard = (idx: number): { sh: number; outs: number } => {
    const cached = cache.get(idx);
    if (cached) return cached;
    counts[idx]!--;
    const sh = mahjongShanten(counts, exposedSelf);
    // Only compute outs when tenpai post-discard — outs only meaningful then,
    // and skipping the inner loop keeps the per-tile cost down.              // L3_邏輯安防
    const outs = sh === 0 ? countWinningOuts(counts, exposedSelf) : 0;
    counts[idx]!++;
    const v = { sh, outs };
    cache.set(idx, v);
    return v;
  };

  let bestI = 0;
  let bestKey = Infinity;
  for (let i = 0; i < hand.length; i++) {
    const idx = tileIndex(hand[i]!);
    const { sh, outs } = evalDiscard(idx);
    const iso = tileUtility(counts, idx);
    // shanten dominates × 100K; outs subtract (×100, capped to ~33 outs ≤ 3300).
    let key = sh * 100_000 - outs * 100 + iso;
    if (softDangerTileIndices.has(idx)) key += 50_000;
    if (dangerTileIndices.has(idx))     key += 10_000_000;
    if (key < bestKey) { bestKey = key; bestI = i; }
  }
  return hand[bestI]!;
}

export function getMahjongBotAction(view: MahjongStateView): PlayerAction {
  const myId = view.self.playerId;

  // ── Reaction phase: bot decides hu / pong / chow / pass ──────────────── L3_架構
  if (view.phase === "pending_reactions" && view.awaitingReactionsFrom.includes(myId)) {
    const ld = view.lastDiscard;
    if (ld) {
      // 1) Hu wins everything if we can.
      const candidate = [...view.self.hand, ld.tile];
      if (canWin(candidate, view.self.exposed.length)) {
        return { type: "hu", selfDrawn: false };
      }

      const sameCount = view.self.hand.filter(t =>
        t.suit === ld.tile.suit && t.rank === ld.tile.rank).length;

      // 2a) Kong-instead-of-pong: if we already hold 3, kong is strictly
      //     better — we use one extra tile (3 vs 2) but gain a replacement
      //     draw and 1 fan. Holding 3 also means those tiles weren't part
      //     of a pair candidate (a pair only has 2 of same), so the meld
      //     never breaks an unrelated wait shape.                            // L3_邏輯安防
      if (sameCount >= 3) {
        return { type: "kong", tile: ld.tile, source: "exposed" };
      }

      // 2b/3) Pong / Chow only if it strictly reduces shanten — taking a meld
      //       commits us (loses menqing fan, exposes information). The
      //       isolation heuristic was a crude proxy; comparing shanten before
      //       vs after the meld answers the underlying question directly.    // L2_實作
      const handCounts = tilesToCounts(view.self.hand);
      const exposedCount = view.self.exposed.length;
      const baseShanten = mahjongShanten(handCounts, exposedCount);

      // After taking a meld: 2 tiles leave the hand and the meld becomes
      // exposed (exposedCount + 1). The dropped tiles depend on meld type.
      const evalMeld = (removeIdx: readonly number[]): number => {
        for (const i of removeIdx) handCounts[i]!--;
        const s = mahjongShanten(handCounts, exposedCount + 1);
        for (const i of removeIdx) handCounts[i]!++;
        return s;
      };

      const ldIdx = mahjongTileIndex(ld.tile.suit, ld.tile.rank);

      if (sameCount >= 2 && ldIdx >= 0) {
        if (evalMeld([ldIdx, ldIdx]) < baseShanten) {
          return { type: "pong", tile: ld.tile };
        }
      }

      if (ld.tile.suit !== "z") {
        const r = ld.tile.rank;
        const same = view.self.hand.filter(t => t.suit === ld.tile.suit);
        const at = (rk: number) => same.find(t => t.rank === rk);
        const windows: [number, number][] = [[r - 2, r - 1], [r - 1, r + 1], [r + 1, r + 2]];
        for (const [a, b] of windows) {
          const ta = at(a); const tb = at(b);
          if (ta && tb) {
            const ia = mahjongTileIndex(ta.suit, ta.rank);
            const ib = mahjongTileIndex(tb.suit, tb.rank);
            if (evalMeld([ia, ib]) < baseShanten) {
              return { type: "chow", tiles: [ta, tb, ld.tile] };
            }
          }
        }
      }
    }
    // Default: keep menqing.                                                 // L3_邏輯安防
    return { type: "mj_pass" };
  }

  // ── Playing phase: bot must discard (or self-drawn hu) ───────────────── L3_架構
  if (view.phase === "playing" && view.currentTurn === myId) {
    if (canWin(view.self.hand, view.self.exposed.length)) {
      return { type: "hu", selfDrawn: true };
    }
    return { type: "discard", tile: pickDiscardTile(view.self.hand, view.opponents.map(o => o.exposed), view.self.exposed.length) };
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

/** True iff hand contains an open-ended straight draw — four consecutive
 *  ranks where neither end is the deck's bookend (no A-2-3-4 or J-Q-K-A,
 *  since those have only 4 outs / one side). True OESD has 8 outs and
 *  ≈32% equity over two streets, justifying the same call-cheap rule
 *  as a flush draw.                                                          // L3_邏輯安防 */
function hasOpenEndedStraightDraw(cards: Card[]): boolean {
  const r2v: Readonly<Record<Rank, number>> = {
    "2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,"10":10,"J":11,"Q":12,"K":13,"A":14,
  };
  const set = new Set(cards.map(c => r2v[c.rank]));
  // Slide a 4-wide window over rank values 3..12 (both ends open: low-1
  // and high+1 must both lie in the legal 2..14 range).
  for (let lo = 3; lo <= 11; lo++) {
    if (set.has(lo) && set.has(lo + 1) && set.has(lo + 2) && set.has(lo + 3)) {
      // lo-1 ≥ 2 and lo+4 ≤ 14 by the loop bounds — both sides open.
      return true;
    }
  }
  return false;
}

/** True when our `cat===3` trips comes from a paired or tripped board and
 *  our playing kicker is easily dominated by any villain holding the same
 *  trip rank with a higher kicker. Sets (pocket pair + 1 board match) are
 *  immune — both our hole cards make the trips, kicker is the top remaining
 *  card. The dangerous shapes are:                                            // L3_邏輯安防
 *    - paired board + 1 hole match: kicker = our other hole; weak if < J
 *    - trips on board (3 of a rank in community): kicker = top hole; weak < K */
function tripsKickerWeak(hole: [Card, Card], community: Card[]): boolean {
  const all = [...hole, ...community];
  const counts = new Map<Rank, number>();
  for (const c of all) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);

  let tripRank: Rank | null = null;
  let tripVal = -1;
  for (const [r, n] of counts) {
    if (n >= 3 && RANK_VAL_TX[r] > tripVal) { tripRank = r; tripVal = RANK_VAL_TX[r]; }
  }
  if (!tripRank) return false;

  const boardOfTrip = community.filter(c => c.rank === tripRank).length;
  const holeOfTrip  = hole.filter(c => c.rank === tripRank).length;

  // Set (pocket pair + 1 board match) — kicker irrelevant.
  if (holeOfTrip === 2) return false;

  // Paired board + 1 hole card → kicker = our other hole card.
  if (holeOfTrip === 1 && boardOfTrip === 2) {
    const kickerVal = hole[0].rank === tripRank
      ? RANK_VAL_TX[hole[1].rank]
      : RANK_VAL_TX[hole[0].rank];
    return kickerVal < 11;        // < J
  }

  // Trips on board — kicker = our highest hole card.
  if (boardOfTrip >= 3) {
    const holeHi = Math.max(RANK_VAL_TX[hole[0].rank], RANK_VAL_TX[hole[1].rank]);
    return holeHi < 13;           // < K
  }

  return false;
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

  // ── Pre-flop: Chen-formula buckets, with position adjustment ─────────── L2_實作
  // Position offset from dealer (0 = button, total-1 = UTG). UTG acts
  // first preflop with no info → tighten by 1pt. Button + BB act with
  // most info / closing power → loosen by 1pt. SB and middle stay flat.
  if (view.street === "preflop") {
    const total  = view.opponents.length + 1;
    const offset = ((me.seatIdx - view.dealerIdx) + total) % total;
    const adj    = (offset === 0)         ? -1   // button (late)
                : (offset === total - 1)  ? +1   // UTG (early)
                : (offset === 2 && total >= 4) ? -1  // BB-style closing seat
                : 0;

    const score = chenScore(me.holeCards);
    if (score >= 9 + adj) {
      return buildRaise() ?? (canCheck ? { type: "check" } : (owe <= me.stack ? { type: "call" } : { type: "fold" }));
    }
    if (score >= 7 + adj) {
      return canCheck ? { type: "check" } : (owe <= me.stack ? { type: "call" } : { type: "fold" });
    }
    if (score >= 5 + adj) {
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

  // Trips or better → value-bet aggressively, except paired/tripped-board
  // trips where our kicker is dominated: flat-call instead of raise.       // L2_實作
  if (cat >= 3) {
    if (cat === 3 && tripsKickerWeak(me.holeCards, view.communityCards)) {
      if (canCheck) return { type: "check" };
      const potTotal = view.pots.reduce((s, p) => s + p.amount, 0);
      const callOdds = owe / (potTotal + owe);
      return callOdds <= 0.5 ? { type: "call" } : { type: "fold" };
    }
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
  if (canCheck) {
    // Occasional river bluff: when checked-around to us at the river with
    // garbage, ~12% of the time fire a small probe. Determinism is hashed
    // off (gameId, currentBet, holeCards) so the same situation always
    // produces the same answer — replays still match settlements.        // L3_邏輯安防
    if (view.street === "river") {
      const seed = bluffSeed(view.gameId, me.holeCards);
      if (seed < 0.12) {
        const r = buildRaise();
        if (r) return r;
      }
    }
    return { type: "check" };
  }
  if (hasFlushDraw(avail) || hasOpenEndedStraightDraw(avail)) {
    const potTotal = view.pots.reduce((s, p) => s + p.amount, 0);
    const callOdds = owe / (potTotal + owe);
    if (callOdds <= 0.20) return { type: "call" };
  }
  return { type: "fold" };
}

/** Cheap deterministic [0,1) hash from gameId + cards. Avoids Math.random
 *  so the bot's decision is reproducible from a snapshot. */
function bluffSeed(gameId: string, hole: [Card, Card]): number {
  const s = gameId + hole.map(c => c.rank + c.suit[0]).join("");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

// ════════════════════════════════════════════════════════════════════════════
//  Uno
// ════════════════════════════════════════════════════════════════════════════
//
// Heuristic priorities (descending):
//   1. If hand is empty after this play we win → play any legal card.
//   2. If any opponent has ≤2 cards: prefer offensive action (skip/draw2/wd4
//      pointed at the next-up player) > color-change wild > number cards.
//   3. Otherwise: dump high-point cards first (numbers high → action → wild)
//      to minimise loss if someone else goes out before us.
//   4. Wild color declared = color we hold the most of.
//   5. If nothing is legal → uno_draw, then play drawn card if it's legal,
//      otherwise uno_pass.

function pickWildColor(hand: UnoCard[]): UnoColor {
  const counts: Record<UnoColor, number> = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const c of hand) if (c.color) counts[c.color]++;
  let best: UnoColor = "red"; let max = -1;
  for (const c of ["red", "yellow", "green", "blue"] as UnoColor[]) {
    if (counts[c] > max) { max = counts[c]; best = c; }
  }
  return best;
}

function isOffensive(c: UnoCard): boolean {
  return c.value === "skip" || c.value === "draw2" || c.value === "wild_draw4";
}

export function getUnoBotAction(view: UnoStateView): PlayerAction {
  const hand = view.self.hand;
  const top = view.topDiscard.card;
  const topValue = top.value;
  const color = view.currentColor;

  const legal = hand.filter(c => canPlayUno(c, topValue, color));

  if (legal.length === 0) {
    if (!view.hasDrawn) return { type: "uno_draw" };
    // Drew already, still nothing legal (hasDrawn=true means we just drew this turn).
    // Try the freshly-drawn card (last in hand).
    const last = hand[hand.length - 1]!;
    if (last && canPlayUno(last, topValue, color)) {
      return last.value === "wild" || last.value === "wild_draw4"
        ? { type: "uno_play", card: last, declaredColor: pickWildColor(hand) }
        : { type: "uno_play", card: last };
    }
    return { type: "uno_pass" };
  }

  // Identify the next-up opponent's hand size.
  const n = view.opponents.length + 1;
  const myIdx = [view.self.playerId, ...view.opponents.map(o => o.playerId)]
    .indexOf(view.self.playerId);
  void myIdx;
  const nextOpp = view.opponents[0];   // opponents[] is already in seat order from self+1
  const nextLow = nextOpp ? nextOpp.cardCount <= 2 : false;
  void n;

  let chosen: UnoCard;
  if (nextLow) {
    // Prefer offensive cards.
    const offensive = legal.filter(isOffensive);
    if (offensive.length > 0) {
      // pick highest-point offensive (wild_draw4 > draw2 > skip)
      offensive.sort((a, b) => unoCardPoints(b) - unoCardPoints(a));
      chosen = offensive[0]!;
    } else {
      // Fall back to a wild color-change to mess them up.
      const wild = legal.find(c => c.value === "wild");
      chosen = wild ?? this_dumpHighest(legal);
    }
  } else {
    chosen = this_dumpHighest(legal);
  }

  if (chosen.value === "wild" || chosen.value === "wild_draw4") {
    return { type: "uno_play", card: chosen, declaredColor: pickWildColor(hand) };
  }
  return { type: "uno_play", card: chosen };
}

function this_dumpHighest(legal: UnoCard[]): UnoCard {
  // Save wilds for emergencies; dump high numbers / actions first.
  const nonWild = legal.filter(c => c.value !== "wild" && c.value !== "wild_draw4");
  const pool = nonWild.length > 0 ? nonWild : legal;
  const sorted = [...pool].sort((a, b) => unoCardPoints(b) - unoCardPoints(a));
  return sorted[0]!;
}

// ════════════════════════════════════════════════════════════════════════════
//  Yahtzee
// ════════════════════════════════════════════════════════════════════════════
//
// Strategy:
//   - First two rolls: keep dice that match an open high-value target.
//     Priorities (descending):
//       1. Yahtzee (5 of a kind) if 4-of-kind already present
//       2. Large/Small straight if dice contain 4-run
//       3. Full house if pair + triple present
//       4. n-of-a-kind: keep the most-frequent face
//   - On final roll: pick highest-EV open slot.
//   - Slot selection prefers: yahtzee > 4kind > 3kind > full house >
//     L straight > S straight > upper-section (face >=3) > chance >
//     fill 0 in lowest-cost upper slot.

function pickHeldForReroll(dice: DiceTuple, openSlots: YahtzeeSlot[]): HeldTuple {
  // Count faces.
  const counts: Record<number, number> = {};
  for (const d of dice) counts[d] = (counts[d] ?? 0) + 1;
  const sortedFaces = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const topFace = Number(sortedFaces[0]![0]);
  const topCount = sortedFaces[0]![1];

  // If we have 4+ same and yahtzee slot is open, hold them all.
  if (topCount >= 4 && openSlots.includes("yahtzee")) {
    return dice.map(d => d === topFace) as HeldTuple;
  }

  // Look for straight progress.
  const set = new Set(dice);
  const wantsLargeStraight = openSlots.includes("largeStraight");
  const wantsSmallStraight = openSlots.includes("smallStraight");
  if (wantsLargeStraight || wantsSmallStraight) {
    // count how many of [1,2,3,4,5] or [2,3,4,5,6] we have
    const seq1 = [1, 2, 3, 4, 5].filter(n => set.has(n as 1)).length;
    const seq2 = [2, 3, 4, 5, 6].filter(n => set.has(n as 1)).length;
    if (seq1 >= 4 || seq2 >= 4) {
      // hold the consecutive subset
      const target = seq1 >= seq2 ? new Set([1, 2, 3, 4, 5]) : new Set([2, 3, 4, 5, 6]);
      const used = new Set<number>();
      return dice.map(d => {
        if (target.has(d) && !used.has(d)) { used.add(d); return true; }
        return false;
      }) as HeldTuple;
    }
  }

  // Default: hold the most-frequent face.
  return dice.map(d => d === topFace) as HeldTuple;
}

function pickBestSlot(dice: DiceTuple, openSlots: YahtzeeSlot[]): YahtzeeSlot {
  // Priority order — pick first open slot that gives best score.
  const PRIORITY: readonly YahtzeeSlot[] = [
    "yahtzee", "largeStraight", "smallStraight", "fullHouse",
    "fourKind", "threeKind",
    "sixes", "fives", "fours", "threes", "twos", "ones",
    "chance",
  ];
  // First pass: any priority slot that gives a non-zero score.
  for (const slot of PRIORITY) {
    if (!openSlots.includes(slot)) continue;
    if (scoreSlot(dice, slot) > 0) return slot;
  }
  // Second pass: dump-zero into the cheapest still-open slot.
  // Prefer dumping into low-value upper section over yahtzee/straight slots.
  const DUMP_ORDER: readonly YahtzeeSlot[] = [
    "ones", "twos", "threes", "fours", "fives", "sixes",
    "yahtzee", "largeStraight", "smallStraight",
    "fourKind", "threeKind", "fullHouse", "chance",
  ];
  for (const slot of DUMP_ORDER) {
    if (openSlots.includes(slot)) return slot;
  }
  // Should be unreachable if SM is consistent (settle triggers when card full).
  return openSlots[0]!;
}

export function getYahtzeeBotAction(view: YahtzeeStateView): PlayerAction {
  const card = view.self.scorecard;
  const open = YAHTZEE_SLOTS.filter(s => card[s] === null);

  if (view.rollsLeft === 3) {
    // First roll of turn — always roll all five.
    return { type: "yz_roll", held: [false, false, false, false, false] };
  }
  if (view.rollsLeft >= 1) {
    // Decide whether to roll again or score now.
    // If current dice already give a Yahtzee and yahtzee slot open → score.
    if (scoreSlot(view.dice, "yahtzee") === 50 && open.includes("yahtzee")) {
      return { type: "yz_score", slot: "yahtzee" };
    }
    // If current dice give a large straight and slot open → score.
    if (scoreSlot(view.dice, "largeStraight") === 40 && open.includes("largeStraight")) {
      return { type: "yz_score", slot: "largeStraight" };
    }
    // Otherwise reroll, holding promising dice.
    const held = pickHeldForReroll(view.dice, open);
    return { type: "yz_roll", held };
  }
  // No rolls left — must score.
  return { type: "yz_score", slot: pickBestSlot(view.dice, open) };
}
