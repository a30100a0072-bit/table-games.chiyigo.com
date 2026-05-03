// /src/game/MahjongShanten.ts
// Standard regular-hand shanten for Taiwan 16 (target = 5 melds + 1 pair).   // L3_邏輯安防
//
// Shanten = minimum tile changes still needed to reach tenpai-1 (winning).
//   - shanten = -1 → already winning
//   - shanten =  0 → tenpai (1 draw away)
//   - shanten ≥  1 → that many draws-and-discards still required
//
// Used by BotAI's discard scorer: for each candidate discard, recompute
// shanten of the remaining hand and pick the smallest. Tile multiplicity
// (≤ 4 per rank × 34 ranks) and meldsNeeded (≤ 5) bound the search; an
// in-hand bot decision finishes well within DO 50ms CPU budget.            // L3_邏輯安防

import type { MahjongTile, MahjongSuit } from "../types/game";

export const MAHJONG_TILE_SLOTS = 34;
export const MAHJONG_TARGET_MELDS = 5;

export function mahjongTileIndex(suit: MahjongSuit, rank: number): number {
  switch (suit) {
    case "m": return 0 + rank - 1;
    case "p": return 9 + rank - 1;
    case "s": return 18 + rank - 1;
    case "z": return 27 + rank - 1;
    case "f": return -1;          // flowers never reach hand-state from SM
  }
}

export function tilesToCounts(tiles: readonly MahjongTile[]): Uint8Array {
  const c = new Uint8Array(MAHJONG_TILE_SLOTS);
  for (const t of tiles) {
    const i = mahjongTileIndex(t.suit, t.rank);
    if (i >= 0) c[i]!++;
  }
  return c;
}

/** Search over decompositions of `c` to maximize meldProgress, where:
 *    meldProgress = 2 * sets + min(partials, meldsLeft - sets)
 *  Returns the best meldProgress reachable. The pair tile (if any) has
 *  already been removed from `c` by the caller.                              // L2_實作
 *
 *  Recurses position-by-position, skipping empty slots. At each non-empty
 *  position consumes some tiles via one of: pong / chow / partial-pair /
 *  partial-chow (adjacent or 1-gap) / leave-one-isolated.                    // L3_邏輯安防 */
function bestMeldProgress(c: Uint8Array, meldsLeft: number): number {
  // Closed-form: progress = 2s + min(p, meldsLeft - s).
  const score = (sets: number, partials: number): number =>
    2 * sets + Math.min(partials, Math.max(0, meldsLeft - sets));

  const recur = (pos: number, sets: number, partials: number): number => {
    while (pos < MAHJONG_TILE_SLOTS && c[pos] === 0) pos++;
    if (pos >= MAHJONG_TILE_SLOTS) return score(sets, partials);
    if (sets + partials >= meldsLeft + 2) return score(sets, partials); // prune: extra partials don't help much

    const isHonor = pos >= 27;
    const r = pos % 9;
    let best = -1;

    // Pong (3 of same).
    if (c[pos]! >= 3) {
      c[pos]! -= 3;
      const v = recur(pos, sets + 1, partials);
      c[pos]! += 3;
      if (v > best) best = v;
    }
    // Chow (pos, pos+1, pos+2) — numbered suits only.
    if (!isHonor && r <= 6 && c[pos + 1]! > 0 && c[pos + 2]! > 0) {
      c[pos]!--; c[pos + 1]!--; c[pos + 2]!--;
      const v = recur(pos, sets + 1, partials);
      c[pos]!++; c[pos + 1]!++; c[pos + 2]!++;
      if (v > best) best = v;
    }
    // Partial: pair-as-meld-draft (toward pong).
    if (c[pos]! >= 2) {
      c[pos]! -= 2;
      const v = recur(pos, sets, partials + 1);
      c[pos]! += 2;
      if (v > best) best = v;
    }
    // Partial: adjacent chow draw (pos, pos+1).
    if (!isHonor && r <= 7 && c[pos + 1]! > 0) {
      c[pos]!--; c[pos + 1]!--;
      const v = recur(pos, sets, partials + 1);
      c[pos]!++; c[pos + 1]!++;
      if (v > best) best = v;
    }
    // Partial: 1-gap chow draw (pos, pos+2).
    if (!isHonor && r <= 6 && c[pos + 2]! > 0) {
      c[pos]!--; c[pos + 2]!--;
      const v = recur(pos, sets, partials + 1);
      c[pos]!++; c[pos + 2]!++;
      if (v > best) best = v;
    }
    // Leave one tile isolated, advance.
    c[pos]!--;
    const vIso = recur(pos, sets, partials);
    c[pos]!++;
    if (vIso > best) best = vIso;

    return best;
  };

  return recur(0, 0, 0);
}

/** Shanten of the hand (post-discard) with `exposedMelds` already-claimed
 *  melds. Returns -1 (won), 0 (tenpai), 1+ (steps to tenpai).                // L2_實作 */
export function mahjongShanten(handCounts: Uint8Array, exposedMelds: number): number {
  const meldsLeft = MAHJONG_TARGET_MELDS - exposedMelds;
  if (meldsLeft < 0) return Infinity;

  const winProgress = 2 * meldsLeft + 1; // melds × 2 + pair × 1

  // Branch on the pair anchor: try every tile with count ≥ 2 as the pair,
  // plus the "no pair claimed" branch.
  let bestProgress = -1;

  // No pair claimed.
  bestProgress = Math.max(bestProgress, bestMeldProgress(handCounts, meldsLeft) + 0);

  for (let i = 0; i < MAHJONG_TILE_SLOTS; i++) {
    if (handCounts[i]! < 2) continue;
    handCounts[i]! -= 2;
    const m = bestMeldProgress(handCounts, meldsLeft);
    handCounts[i]! += 2;
    const total = m + 1; // pair contributes 1 progress
    if (total > bestProgress) bestProgress = total;
  }

  return winProgress - bestProgress - 1;
}

/** Inverse of `mahjongTileIndex` — recover the tile spec from a 0..33 slot. */
export function indexToTile(idx: number): MahjongTile | null {
  if (idx < 0 || idx >= 34) return null;
  if (idx < 9)  return { suit: "m", rank: (idx + 1) as 1|2|3|4|5|6|7|8|9 };
  if (idx < 18) return { suit: "p", rank: (idx - 9 + 1) as 1|2|3|4|5|6|7|8|9 };
  if (idx < 27) return { suit: "s", rank: (idx - 18 + 1) as 1|2|3|4|5|6|7|8|9 };
  return { suit: "z", rank: (idx - 27 + 1) as 1|2|3|4|5|6|7 };
}

/** Enumerate every tile that, if drawn next, would complete the hand. Returns
 *  empty array when not tenpai (shanten > 0). Each tile listed once.        // L2_實作 */
export function enumerateWinningTiles(
  handCounts: Uint8Array,
  exposedMelds: number,
): MahjongTile[] {
  const out: MahjongTile[] = [];
  for (let i = 0; i < MAHJONG_TILE_SLOTS; i++) {
    if (handCounts[i]! >= 4) continue;          // wall has no more
    handCounts[i]!++;
    const sh = mahjongShanten(handCounts, exposedMelds);
    handCounts[i]!--;
    if (sh === -1) {
      const t = indexToTile(i);
      if (t) out.push(t);
    }
  }
  return out;
}

/** Total winning-tile outs given the wall + opponent exposed view. Counts
 *  remaining copies of each winning tile (4 minus what's already visible).
 *  When `visibleCounts` is omitted, treats only own hand as visible.        // L2_實作 */
export function countWinningOuts(
  handCounts: Uint8Array,
  exposedMelds: number,
  visibleCounts?: Uint8Array,
): number {
  let outs = 0;
  for (let i = 0; i < MAHJONG_TILE_SLOTS; i++) {
    const visible = (visibleCounts?.[i] ?? handCounts[i]!) | 0;
    if (visible >= 4) continue;
    if (handCounts[i]! >= 4) continue;
    handCounts[i]!++;
    const sh = mahjongShanten(handCounts, exposedMelds);
    handCounts[i]!--;
    if (sh === -1) outs += 4 - visible;
  }
  return outs;
}
