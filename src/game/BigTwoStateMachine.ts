// /src/game/BigTwoStateMachine.ts
// Pure Big Two logic — zero IO allowed (no fetch / DB / WebSocket). // L2_模組

import type {
  Card, Suit, Rank, PlayerId, ComboType,
  PlayerAction,
  GameStateView, LastPlay,
  RoundPhase, SettlementResult, PlayerSettlement, SettlementReason,
} from "../types/game";

// ─── Ordering tables ──────────────────────────────────────────────── L2_模組

const RANK_IDX: Readonly<Record<Rank, number>> = {
  "3":0,"4":1,"5":2,"6":3,"7":4,
  "8":5,"9":6,"10":7,"J":8,"Q":9,"K":10,"A":11,"2":12,
} as const;

const SUIT_IDX: Readonly<Record<Suit, number>> = {
  clubs: 0, diamonds: 1, hearts: 2, spades: 3,
} as const;

const ALL_SUITS: readonly Suit[] = ["clubs","diamonds","hearts","spades"];
const ALL_RANKS: readonly Rank[] = ["3","4","5","6","7","8","9","10","J","Q","K","A","2"];
const TURN_TIMEOUT_MS = 30_000;

// ─── Card primitives ──────────────────────────────────────────────── L2_模組

const cardVal   = (c: Card): number => RANK_IDX[c.rank] * 4 + SUIT_IDX[c.suit];
const cardKey   = (c: Card): string => `${c.rank}|${c.suit}`;
const sortByVal = (cards: Card[]): Card[] => [...cards].sort((a, b) => cardVal(a) - cardVal(b));

function indexCards(cards: Card[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cards) m.set(cardKey(c), (m.get(cardKey(c)) ?? 0) + 1);
  return m;
}

// ─── Combo detection & scoring ────────────────────────────────────── L3_邏輯安防

export interface ComboMeta { type: ComboType; score: number; }

// Tier base: 5-card combos occupy the high bands; non-5-card combos use raw cardVal.
// Tier ordering: straight(0) < flush(1) < fullHouse(2) < fourOfAKind(3) < straightFlush(4)
const FIVE_BASE = 10_000;
const FIVE_TIER: Readonly<Record<string, number>> = {
  straight: 0, flush: 1, fullHouse: 2, fourOfAKind: 3, straightFlush: 4,
} as const;

function detectCombo(raw: Card[]): ComboMeta | null {
  if (raw.length === 0 || raw.length > 5) return null;    // L3_邏輯安防
  const s = sortByVal(raw);

  if (s.length === 1) return { type: "single", score: cardVal(s[0]) };

  if (s.length === 2) {
    if (s[0].rank !== s[1].rank) return null;             // L3_邏輯安防
    return { type: "pair", score: cardVal(s[1]) };
  }

  if (s.length === 3) {
    if (!s.every(c => c.rank === s[0].rank)) return null; // L3_邏輯安防
    return { type: "triple", score: cardVal(s[2]) };
  }

  if (s.length === 4) return null; // 4-card plays illegal in Big Two // L3_邏輯安防

  return detectFiveCard(s);
}

function detectFiveCard(s: Card[]): ComboMeta | null {
  const rIdxs    = s.map(c => RANK_IDX[c.rank]);
  const isFlush  = s.every(c => c.suit === s[0].suit);
  const allDist  = new Set(s.map(c => c.rank)).size === 5;
  // Linear rank table ensures no wrap-around straights (2 is index 12, too far from 3). // L3_邏輯安防
  const isStraight = allDist && rIdxs[4] - rIdxs[0] === 4;

  const groups = new Map<Rank, number>();
  for (const c of s) groups.set(c.rank, (groups.get(c.rank) ?? 0) + 1);
  const counts = [...groups.values()].sort((a, b) => b - a);

  if (isFlush && isStraight) {
    return { type: "straightFlush",
      score: FIVE_TIER.straightFlush * FIVE_BASE + cardVal(s[4]) };
  }
  if (counts[0] === 4) {
    const r = [...groups.entries()].find(([, n]) => n === 4)![0];
    return { type: "fourOfAKind",
      score: FIVE_TIER.fourOfAKind * FIVE_BASE + RANK_IDX[r] * 4 };
  }
  if (counts[0] === 3 && counts[1] === 2) {
    const r = [...groups.entries()].find(([, n]) => n === 3)![0];
    return { type: "fullHouse",
      score: FIVE_TIER.fullHouse * FIVE_BASE + RANK_IDX[r] * 4 };
  }
  if (isFlush) {
    // Higher suit wins; tie-break by highest rank. // L3_邏輯安防
    const suitScore = SUIT_IDX[s[0].suit];
    return { type: "flush",
      score: FIVE_TIER.flush * FIVE_BASE + suitScore * 100 + rIdxs[4] };
  }
  if (isStraight) {
    return { type: "straight",
      score: FIVE_TIER.straight * FIVE_BASE + cardVal(s[4]) };
  }
  return null; // L3_邏輯安防
}

// Returns null if `next` legally beats `prev`, or an error string otherwise. // L3_邏輯安防
function checkBeats(next: ComboMeta, prev: ComboMeta): string | null {
  const FIVE = new Set<ComboType>(["straight","flush","fullHouse","fourOfAKind","straightFlush"]);
  const nF = FIVE.has(next.type);
  const pF = FIVE.has(prev.type);
  if (nF !== pF)
    return `category mismatch: ${next.type} cannot beat ${prev.type}`;  // L3_邏輯安防
  if (!nF && next.type !== prev.type)
    return `must continue with ${prev.type}, got ${next.type}`;          // L3_邏輯安防
  if (next.score <= prev.score)
    return "played combo is not stronger than the current table";         // L3_邏輯安防
  return null;
}

// ─── Cryptographically-secure shuffle ────────────────────────────── L3_邏輯安防

function secureBelow(n: number): number {
  // Rejection sampling eliminates modulo bias present in `% n` alone. // L3_邏輯安防
  const UINT32_MAX = 2 ** 32;
  const limit = UINT32_MAX - (UINT32_MAX % n);
  const buf = new Uint32Array(1);
  let v: number;
  do {
    crypto.getRandomValues(buf); // Math.random is FORBIDDEN here     // L3_邏輯安防
    v = buf[0];
  } while (v >= limit);
  return v % n;
}

function secureShuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = secureBelow(i + 1);  // L3_邏輯安防
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDeck(): Card[] {
  const d: Card[] = [];
  for (const suit of ALL_SUITS) for (const rank of ALL_RANKS) d.push({ suit, rank });
  return d;
}

// ─── Internal mutable state ───────────────────────────────────────── L2_模組

interface InternalState {
  gameId:         string;
  roundId:        string;
  phase:          RoundPhase;
  playerIds:      PlayerId[];
  hands:          Map<PlayerId, Card[]>;
  turnIndex:      number;
  lastPlay:       LastPlay   | null;
  lastPlayMeta:   ComboMeta  | null;
  passCount:      number;
  turnDeadlineMs: number;
  isFirstTurn:    boolean;      // 3♣ constraint still active      // L3_邏輯安防
  finishOrder:    PlayerId[];   // first-out → last-out
}

// ─── Serialisable snapshot (for DO hibernation) ──────────────────── L3_架構含防禦觀測

export interface MachineSnapshot {
  gameId:         string;
  roundId:        string;
  phase:          RoundPhase;
  playerIds:      PlayerId[];
  hands:          [PlayerId, Card[]][];  // Map<PlayerId, Card[]> serialised as entries
  turnIndex:      number;
  lastPlay:       LastPlay   | null;
  lastPlayMeta:   ComboMeta  | null;
  passCount:      number;
  turnDeadlineMs: number;
  isFirstTurn:    boolean;
  finishOrder:    PlayerId[];
}

// ─── Public API ───────────────────────────────────────────────────── L3_代碼附資源清單
// Resource manifest (compile-time guarantee of zero external I/O):
//   ✓ Web Crypto API  → crypto.getRandomValues (shuffle only)
//   ✗ fetch / HTTP
//   ✗ D1 / KV / R2
//   ✗ WebSocket send
// Caller layer (Durable Object) owns all I/O.              // L3_代碼附資源清單

export interface ProcessResult {
  /** Lazily build the perspective-isolated view for any player ID. */
  viewFor:    (playerId: PlayerId) => GameStateView;
  settlement: SettlementResult | null;
}

export class BigTwoStateMachine {

  private readonly s: InternalState;

  constructor(gameId: string, roundId: string, playerIds: PlayerId[]) {
    if (playerIds.length < 2 || playerIds.length > 4)
      throw new RangeError("player count must be 2–4");              // L3_邏輯安防
    if (new Set(playerIds).size !== playerIds.length)
      throw new Error("duplicate player IDs");                        // L3_邏輯安防

    const deck  = secureShuffle(buildDeck());                        // L3_邏輯安防
    const n     = playerIds.length;
    const base  = Math.floor(52 / n);
    const extra = 52 % n;          // first `extra` seats get one extra card
    const hands = new Map<PlayerId, Card[]>();

    let offset = 0;
    playerIds.forEach((id, i) => {
      const count = base + (i < extra ? 1 : 0);
      hands.set(id, deck.slice(offset, offset + count));
      offset += count;
    });

    // 3♣ is always dealt (52 cards distributed fully); holder goes first.
    const starterIdx = playerIds.findIndex(id =>
      hands.get(id)!.some(c => c.rank === "3" && c.suit === "clubs"),
    );
    if (starterIdx === -1) throw new Error("invariant: 3♣ not dealt"); // L3_邏輯安防

    this.s = {
      gameId, roundId,
      phase:          "playing",
      playerIds,
      hands,
      turnIndex:      starterIdx,
      lastPlay:       null,
      lastPlayMeta:   null,
      passCount:      0,
      turnDeadlineMs: Date.now() + TURN_TIMEOUT_MS,
      isFirstTurn:    true,
      finishOrder:    [],
    };
  }

  // ── Primary entry point ────────────────────────────────────────── L3_邏輯安防

  processAction(actorId: PlayerId, action: PlayerAction): ProcessResult {
    const { s } = this;
    if (s.phase !== "playing")
      throw new Error("game is already settled");                     // L3_邏輯安防
    if (actorId !== s.playerIds[s.turnIndex])
      throw new Error(
        `out-of-turn action: expected ${s.playerIds[s.turnIndex]}, got ${actorId}`,
      );                                                               // L3_邏輯安防

    const settlement = action.type === "pass"
      ? this.applyPass(actorId)
      : this.applyPlay(actorId, action.cards);

    return { viewFor: (pid) => this.buildView(pid), settlement };
  }

  /** Force-settle due to an external event (timeout, disconnect). No IO here. */
  forceSettle(reason: Exclude<SettlementReason, "lastCardPlayed">): SettlementResult {
    if (this.s.phase !== "playing") throw new Error("already settled"); // L3_邏輯安防
    return this.settle(reason);
  }

  getView(playerId: PlayerId): GameStateView { return this.buildView(playerId); }

  // ── Pass ──────────────────────────────────────────────────────────── L3_邏輯安防

  private applyPass(_actorId: PlayerId): SettlementResult | null {
    const { s } = this;
    if (s.lastPlay === null)
      throw new Error("cannot pass while holding table control");     // L3_邏輯安防
    if (s.isFirstTurn)
      throw new Error("cannot pass on the opening turn");             // L3_邏輯安防

    s.passCount++;
    const active = this.activePlayers();

    if (s.passCount >= active.length - 1) {
      // All other active players have passed; original play-owner opens fresh trick.
      const owner = s.lastPlay.playerId;
      s.lastPlay     = null;
      s.lastPlayMeta = null;
      s.passCount    = 0;
      s.turnIndex    = s.playerIds.indexOf(owner);
    } else {
      this.advanceTurn();
    }

    s.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;
    return null;
  }

  // ── Play ──────────────────────────────────────────────────────────── L3_邏輯安防

  private applyPlay(actorId: PlayerId, cards: Card[]): SettlementResult | null {
    const { s } = this;
    const hand = s.hands.get(actorId);
    if (!hand)              throw new Error("unknown actor");          // L3_邏輯安防
    if (cards.length === 0) throw new Error("must play ≥1 card");     // L3_邏輯安防

    // ① Verify every played card physically exists in the player's hand. // L3_邏輯安防
    const handIdx = indexCards(hand);
    for (const c of cards) {
      const k = cardKey(c);
      const n = handIdx.get(k) ?? 0;
      if (n === 0)
        throw new Error(`card not in hand: ${c.rank} of ${c.suit}`);  // L3_邏輯安防
      n > 1 ? handIdx.set(k, n - 1) : handIdx.delete(k);
    }

    // ② Validate combo shape — reject any unrecognised pattern. // L3_邏輯安防
    const meta = detectCombo(cards);
    if (!meta)
      throw new Error(
        `illegal combo: [${cards.map(c => `${c.rank}${c.suit[0]}`).join(",")}]`,
      );                                                               // L3_邏輯安防

    // ③ First turn of the game must include 3♣. // L3_邏輯安防
    if (s.isFirstTurn && !cards.some(c => c.rank === "3" && c.suit === "clubs"))
      throw new Error("opening play must include the 3 of clubs");    // L3_邏輯安防

    // ④ When the table is occupied the new combo must strictly beat it. // L3_邏輯安防
    if (s.lastPlay !== null && s.lastPlayMeta !== null) {
      const err = checkBeats(meta, s.lastPlayMeta);
      if (err) throw new Error(err);                                   // L3_邏輯安防
    }

    // ⑤ Commit: remove played cards from hand.
    const playedIdx = indexCards(cards);
    s.hands.set(actorId, hand.filter(c => {
      const k = cardKey(c);
      const n = playedIdx.get(k) ?? 0;
      if (n > 0) { n > 1 ? playedIdx.set(k, n - 1) : playedIdx.delete(k); return false; }
      return true;
    }));

    s.lastPlay     = { playerId: actorId, cards: [...cards], combo: meta.type };
    s.lastPlayMeta = meta;
    s.passCount    = 0;
    s.isFirstTurn  = false;

    // ⑥ Settle immediately when a player empties their hand.
    if (s.hands.get(actorId)!.length === 0) {
      s.finishOrder.push(actorId);
      return this.settle("lastCardPlayed");
    }

    this.advanceTurn();
    s.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;
    return null;
  }

  // ── Settlement ────────────────────────────────────────────────────── L3_邏輯安防

  private settle(reason: SettlementReason): SettlementResult {
    const { s } = this;
    s.phase = "settled";

    const losers = s.playerIds
      .filter(id => !s.finishOrder.includes(id))
      .sort((a, b) => s.hands.get(a)!.length - s.hands.get(b)!.length); // fewer cards = better rank

    const orderedAll     = [...s.finishOrder, ...losers];
    const totalLostCards = losers.reduce((sum, id) => sum + s.hands.get(id)!.length, 0);

    const players: PlayerSettlement[] = orderedAll.map((id, i) => {
      const remaining = s.hands.get(id) ?? [];
      return {
        playerId:       id,
        finalRank:      i + 1,
        remainingCards: remaining,
        scoreDelta:     i === 0 ? totalLostCards : -remaining.length,
      };
    });

    return {
      gameId:     s.gameId,
      roundId:    s.roundId,
      finishedAt: Date.now(),
      reason,
      players,
      winnerId:   orderedAll[0],
    };
  }

  // ── View builder (perspective isolation) ─────────────────────────── L2_模組

  private buildView(playerId: PlayerId): GameStateView {
    const { s } = this;
    const myHand = s.hands.get(playerId) ?? [];

    return {
      gameId:  s.gameId,
      roundId: s.roundId,
      phase:   s.phase,

      // Own cards fully visible.
      self: { playerId, hand: myHand, cardCount: myHand.length },

      // Opponents: only card count exposed — hand field absent by type contract. // L2_模組
      opponents: s.playerIds
        .filter(id => id !== playerId)
        .map(id => ({ playerId: id, cardCount: s.hands.get(id)?.length ?? 0 })),

      currentTurn:    s.playerIds[s.turnIndex],
      lastPlay:       s.lastPlay,
      passCount:      s.passCount,
      turnDeadlineMs: s.turnDeadlineMs,
    };
  }

  // ── Internal helpers ──────────────────────────────────────────────── L2_模組

  private activePlayers(): PlayerId[] {
    return this.s.playerIds.filter(id => (this.s.hands.get(id)?.length ?? 0) > 0);
  }

  private advanceTurn(): void {
    const { s } = this;
    const n = s.playerIds.length;
    let next = (s.turnIndex + 1) % n;
    // Skip players who have already emptied their hand.
    for (let guard = 0; guard < n; guard++) {
      if ((s.hands.get(s.playerIds[next])?.length ?? 0) > 0) break;
      next = (next + 1) % n;
    }
    s.turnIndex = next;
  }

  // ── Serialisation (required for DO hibernation) ──────────────────── L3_架構含防禦觀測

  snapshot(): MachineSnapshot {
    const { s } = this;
    return { ...s, hands: [...s.hands.entries()] };
  }

  static restore(snap: MachineSnapshot): BigTwoStateMachine {
    const m = Object.create(BigTwoStateMachine.prototype) as BigTwoStateMachine;
    // Bypass constructor to rehydrate private field from persisted snapshot.
    (m as unknown as { s: InternalState }).s = { ...snap, hands: new Map(snap.hands) };
    return m;
  }
}
