import { describe, it, expect } from "vitest";
import type { MahjongTile, MahjongSuit } from "../src/types/game";
import { mahjongShanten, tilesToCounts, enumerateWinningTiles, countWinningOuts, indexToTile } from "../src/game/MahjongShanten";

const t = (suit: MahjongSuit, rank: number): MahjongTile => ({ suit, rank } as MahjongTile);

// Convenience: parse "1m 2m 3m 5p 5p ..." into MahjongTile[].
function hand(spec: string): MahjongTile[] {
  return spec.trim().split(/\s+/).map(s => {
    const rank = parseInt(s.slice(0, -1), 10);
    const suit = s.slice(-1) as MahjongSuit;
    return t(suit, rank);
  });
}

function shanten(spec: string, exposed = 0): number {
  return mahjongShanten(tilesToCounts(hand(spec)), exposed);
}

describe("mahjongShanten — Taiwan 16 (5 melds + 1 pair)", () => {
  it("complete winning hand — 5 melds + pair, shanten = -1", () => {
    // 1m2m3m 4m5m6m 7m8m9m 1p2p3p 4p5p6p + 5s5s = 5 chows + 1 pair, 17 tiles
    expect(shanten("1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 4p 5p 6p 5s 5s")).toBe(-1);
  });

  it("tenpai (1 tile from win): 4 chows + pair + 2-tile partial = 16 tiles, shanten = 0", () => {
    // 1m2m3m 4m5m6m 7m8m9m 1p2p3p + 5p5p (pair) + 7p8p (partial chow draw) = 16
    expect(shanten("1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 5p 5p 7p 8p")).toBe(0);
  });

  it("tenpai with 4 exposed melds (single pair completion only)", () => {
    // 4 melds exposed → meldsLeft = 1. In hand: 1 partial chow + 1 lone tile = 4 tiles.
    // After 1 draw can complete the partial → 1 set. Still need pair. Shanten 0 only if pair exists.
    // Try: pair only in hand, 0 exposed-melds equivalent: handCounts has just a pair (2 tiles).
    // meldsLeft = 1 set + need pair. handCounts = "5p 5p 7p 8p": pair = 5p, partial = 7p8p → tenpai.
    expect(shanten("5p 5p 7p 8p", 4)).toBe(0);
  });

  it("won with all melds exposed and just the pair in hand", () => {
    // 5 exposed melds → meldsLeft = 0. Pair in hand → shanten = -1.
    expect(shanten("5p 5p", 5)).toBe(-1);
  });

  it("isolated honors, no progress", () => {
    // 5 distinct honors, no melds, no partials, no pair. meldsLeft=5, pair miss.
    // progress = 0 → shanten = 2*5+1 - 0 - 1 = 10.
    expect(shanten("1z 2z 3z 4z 5z", 0)).toBe(10);
  });

  it("isolated numbered tiles all 4-apart — no chow draws either", () => {
    expect(shanten("1m 5m 9m", 0)).toBe(10);
  });

  it("recognizes a pair as 1 progress", () => {
    // Just a pair → progress 1 (pair claim). shanten = 11 - 1 - 1 = 9... wait
    // winProgress = 2*5+1 = 11. bestProgress = 1 (pair). shanten = 11 - 1 - 1 = 9.
    expect(shanten("5m 5m", 0)).toBe(9);
  });

  it("recognizes a complete pong as 2 progress", () => {
    // 3 of same → 1 set, no pair. progress = 2. shanten = 11 - 2 - 1 = 8.
    expect(shanten("5m 5m 5m", 0)).toBe(8);
  });

  it("two complete chows + pair", () => {
    // 1m2m3m 4m5m6m 9m9m → 2 sets + pair. progress = 4 + 1 = 5. shanten = 11-5-1 = 5.
    expect(shanten("1m 2m 3m 4m 5m 6m 9m 9m", 0)).toBe(5);
  });

  it("indexToTile is the inverse of tilesToCounts indexing", () => {
    expect(indexToTile(0)).toEqual({ suit: "m", rank: 1 });
    expect(indexToTile(8)).toEqual({ suit: "m", rank: 9 });
    expect(indexToTile(9)).toEqual({ suit: "p", rank: 1 });
    expect(indexToTile(27)).toEqual({ suit: "z", rank: 1 });
    expect(indexToTile(33)).toEqual({ suit: "z", rank: 7 });
    expect(indexToTile(-1)).toBeNull();
    expect(indexToTile(34)).toBeNull();
  });

  it("enumerateWinningTiles returns the pair-completion candidate when tenpai on pair", () => {
    // exposed=1 → meldsLeft=4 → win shape = 4 melds + pair = 14 tiles.
    // Tenpai (13 tiles): 4 chows + 1 lone tile waiting for its pair.
    const tiles = "1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 5s".split(/\s+/).map(s => ({
      suit: s.slice(-1) as "m"|"p"|"s"|"z", rank: parseInt(s.slice(0, -1), 10),
    }));
    const c = tilesToCounts(tiles as never);
    expect(mahjongShanten(c, 1)).toBe(0);
    const wt = enumerateWinningTiles(c, 1);
    expect(wt).toEqual([{ suit: "s", rank: 5 }]);
  });

  it("enumerateWinningTiles is empty when not tenpai", () => {
    const c = tilesToCounts([]);
    expect(enumerateWinningTiles(c, 0)).toEqual([]);
  });

  it("countWinningOuts counts remaining copies (4 minus visible) of each winning tile", () => {
    // Same tenpai shape as above; 1 s5 in hand → 4 - 1 = 3 outs in the wall.
    const tiles = "1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 5s".split(/\s+/).map(s => ({
      suit: s.slice(-1) as "m"|"p"|"s"|"z", rank: parseInt(s.slice(0, -1), 10),
    }));
    const c = tilesToCounts(tiles as never);
    expect(countWinningOuts(c, 1)).toBe(3);
  });

  it("4 chows + pair + 2 isolated, exposed=0 → shanten 1 (one set short)", () => {
    // 16 tiles: 4 chows (12) + pair (9p9p) + isolated (1s, 5s).
    // bestProgress = 2*4 + 1 = 9. winProgress = 11. shanten = 11 - 9 - 1 = 1.
    expect(shanten("1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 9p 9p 1s 5s", 0)).toBe(1);
  });
});
