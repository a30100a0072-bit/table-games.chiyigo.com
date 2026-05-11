// /src/game/HeartsStateMachine.ts
// Pure Hearts (紅心大戰) logic — zero IO. Mirrors BigTwo/Uno pattern.        // L2_模組
// Rules (classic American Hearts):
//   - 4 players fixed; standard 52-card deck; 13 cards each.                // L2_實作
//   - Per-hand cycle:
//       1. passing phase: each player submits 3 cards (direction rotates
//          left/right/across/none by handIndex % 4); when all 4 submit
//          simultaneously, swap. Hand 4 (idx%4===3) skips passing.          // L2_實作
//       2. playing phase: 13 tricks. ♣2 holder leads first trick. Must
//          follow suit; first trick may not drop points (♥ or ♠Q) unless
//          forced; ♥ may not be led until "broken" (or all-♥ hand).         // L3_邏輯安防
//       3. per-hand settle: each ♥ = 1pt, ♠Q = 13pt; Shoot the Moon (one
//          player takes all 26) reverses to 0 for shooter, +26 for others. // L2_實作
//   - Final settle: when any cumulativeScores >= 100, lowest total wins;
//     chip pot is zero-sum (winner = sum of others' losses, by rank).
//
// PR 2.2 scope (this file revision):
//   ✓ deck / shuffle / deal
//   ✓ constructor + passing phase + ♣2 transition
//   ✓ snapshot / restore (covers half-pass mid-state)
//   ✓ viewFor (passing phase + minimal playing-phase shell)
//   ✗ trick play / legality / per-hand settle  (PR 2.3)
//   ✗ multi-hand cycle / Shoot the Moon / forceSettle  (PR 2.4)

import type {
  PlayerId, Card, Suit, Rank,
  HeartsPhase, HeartsPassAction, HeartsPlayAction,
  HeartsStateView, HeartsSelfView, HeartsOpponentView,
  HeartsTrickPlay, HeartsPassDirection, HeartsSettlementDetail,
  SettlementResult, SettlementReason, PlayerSettlement,
} from "../types/game";

// ─── Chip distribution constants ─────────────────────────────────── L2_鎖定
// Final match settle (>=100 cumulative): rank-1 +300, ranks 2-4 each -100.
// Mirrors Yahtzee's fixed-pot model — keeps wallet ledger predictable
// across games. ANTE = 100 per seat, so the pot equals 4 antes minus
// rank-1's own ante (winner net +300 vs entry +400 - 100 ante).
const FINAL_WINNER_GAIN = 300;
const FINAL_LOSER_LOSS  = 100;
// Forfeit (timeout / disconnect): -200 / +200 fixed pot. Same contract as
// Uno post-ship harmonisation (commit 2e7dab5, ENGINE_VERSION 4→5).      // L2_鎖定
const FORFEIT_PENALTY = 200;

const RANKS: readonly Rank[] = [
  "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A",
];
const SUITS: readonly Suit[] = ["clubs", "diamonds", "spades", "hearts"];
const HAND_SIZE = 13;
const PLAYER_COUNT = 4;
const TURN_TIMEOUT_MS = 30_000;

// ─── Deck construction ──────────────────────────────────────────── L2_模組

function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push({ suit, rank });
  }
  return deck;
}

// ─── Cryptographic shuffle (same as BigTwo / Uno) ───────────────── L3_邏輯安防

function secureBelow(n: number): number {
  const UINT32_MAX = 2 ** 32;
  const limit = UINT32_MAX - (UINT32_MAX % n);
  const buf = new Uint32Array(1);
  let v: number;
  do { crypto.getRandomValues(buf); v = buf[0]!; } while (v >= limit);
  return v % n;
}

function secureShuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = secureBelow(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ─── Card helpers ───────────────────────────────────────────────── L2_實作

function sameCard(a: Card, b: Card): boolean {
  return a.suit === b.suit && a.rank === b.rank;
}

function isClub2(c: Card): boolean {
  return c.suit === "clubs" && c.rank === "2";
}

/** Hearts (♥) or ♠Q — these are "point cards" used by the first-trick
 *  no-points rule. ♠Q is 13 pts; each ♥ is 1 pt.                            // L2_實作 */
export function isPointCard(c: Card): boolean {
  if (c.suit === "hearts") return true;
  if (c.suit === "spades" && c.rank === "Q") return true;
  return false;
}

/** Point value of a single card (only point cards score). Used by per-hand
 *  scorer in PR 2.3; exported for tests.                                     // L2_實作 */
export function heartsCardPoints(c: Card): number {
  if (c.suit === "hearts") return 1;
  if (c.suit === "spades" && c.rank === "Q") return 13;
  return 0;
}

/** Pass direction by hand index (0=left, 1=right, 2=across, 3=none).        // L2_隔離 */
export function passDirectionFor(handIndex: number): HeartsPassDirection {
  const m = ((handIndex % 4) + 4) % 4;
  return m === 0 ? "left" : m === 1 ? "right" : m === 2 ? "across" : "none";
}

/** For seat index `from`, who receives their pass given the direction.
 *  Seat order is fixed in playerIds[]; "left" = next seat (wrap), "right"
 *  = previous seat, "across" = +2 seats.                                     // L2_實作 */
function recipientIdx(from: number, dir: HeartsPassDirection): number {
  if (dir === "left")   return (from + 1) % PLAYER_COUNT;
  if (dir === "right")  return (from + PLAYER_COUNT - 1) % PLAYER_COUNT;
  if (dir === "across") return (from + 2) % PLAYER_COUNT;
  return from; // "none" should not be called; defensive return
}

// ─── Internal mutable state ─────────────────────────────────────── L2_模組

interface InternalState {
  gameId:           string;
  roundId:          string;
  phase:            HeartsPhase;
  playerIds:        PlayerId[];                 // length 4, fixed seating
  handIndex:        number;                     // 0..n; per-hand counter
  hands:            Map<PlayerId, Card[]>;
  /** Pass-phase buffer; null = that seat has not submitted yet. Cleared
   *  to empty Map when phase leaves "passing". Surviving the transition
   *  through snapshot/restore is critical — see PR 2.2 acceptance.        */
  pendingPasses:    Map<PlayerId, [Card, Card, Card] | null>;
  // ── Playing-phase fields (populated in PR 2.3; carried in state now
  // so snapshot/restore shape is stable across PRs) ────────────────
  currentTrick:     HeartsTrickPlay[];          // up to 4 entries
  heartsBroken:     boolean;
  takenTricks:      Map<PlayerId, Card[]>;      // accumulated this hand
  turnIndex:        number;                     // 0..3; current actor
  cumulativeScores: Map<PlayerId, number>;      // cross-hand totals
  turnDeadlineMs:   number;
  winnerId:         PlayerId | null;            // final winner (≥100 trigger)
}

// ─── Snapshot ───────────────────────────────────────────────────── L3_架構含防禦觀測

export interface HeartsSnapshot {
  gameId:           string;
  roundId:          string;
  phase:            HeartsPhase;
  playerIds:        PlayerId[];
  handIndex:        number;
  hands:            [PlayerId, Card[]][];
  pendingPasses:    [PlayerId, [Card, Card, Card] | null][];
  currentTrick:     HeartsTrickPlay[];
  heartsBroken:     boolean;
  takenTricks:      [PlayerId, Card[]][];
  turnIndex:        number;
  cumulativeScores: [PlayerId, number][];
  turnDeadlineMs:   number;
  winnerId:         PlayerId | null;
  /** Per-hand cache from finalizeHand(); cleared by startNextHand (PR 2.4). */
  lastHandScores?:  [PlayerId, number][] | null;
  lastShooter?:     PlayerId | null;
}

// ─── Result type ────────────────────────────────────────────────── L2_模組

export interface HeartsProcessResult { ok: true;  settlement: SettlementResult | null; }
export interface HeartsProcessError  { ok: false; error: string; }
export type HeartsProcessOutcome = HeartsProcessResult | HeartsProcessError;

type HeartsActionInput = HeartsPassAction | HeartsPlayAction;

// ─── Public class ───────────────────────────────────────────────── L3_代碼附資源清單
// Resource manifest:
//   ✓ crypto.getRandomValues (shuffle)
//   ✗ no fetch / DB / WS

export class HeartsStateMachine {

  private readonly s: InternalState;

  constructor(gameId: string, roundId: string, playerIds: PlayerId[]) {
    if (playerIds.length !== PLAYER_COUNT)
      throw new RangeError("hearts requires exactly 4 players");
    if (new Set(playerIds).size !== playerIds.length)
      throw new Error("duplicate player IDs");

    const handIndex = 0;
    const dir = passDirectionFor(handIndex);

    // Shuffle + deal 13 each.
    const deck = secureShuffle(buildDeck());
    const hands = new Map<PlayerId, Card[]>();
    for (let i = 0; i < playerIds.length; i++) {
      hands.set(playerIds[i]!, deck.slice(i * HAND_SIZE, (i + 1) * HAND_SIZE));
    }

    // Phase selection: skip passing entirely on hand 4 (idx%4===3).
    const phase: HeartsPhase = dir === "none" ? "playing" : "passing";

    const pendingPasses = new Map<PlayerId, [Card, Card, Card] | null>();
    if (phase === "passing") for (const pid of playerIds) pendingPasses.set(pid, null);

    // In playing phase, ♣2 leads; in passing phase, set turnIndex to the
    // first un-passed seat (initial: seat 0). turnIndex during passing is
    // only used by `currentTurn()` for bot dispatch — humans can submit
    // their pass any time regardless of turnIndex.
    const turnIndex = phase === "playing"
      ? indexOfClub2(playerIds, hands)
      : 0;

    const takenTricks = new Map<PlayerId, Card[]>();
    for (const pid of playerIds) takenTricks.set(pid, []);

    const cumulativeScores = new Map<PlayerId, number>();
    for (const pid of playerIds) cumulativeScores.set(pid, 0);

    this.s = {
      gameId, roundId,
      phase,
      playerIds,
      handIndex,
      hands,
      pendingPasses,
      currentTrick:   [],
      heartsBroken:   false,
      takenTricks,
      turnIndex,
      cumulativeScores,
      turnDeadlineMs: Date.now() + TURN_TIMEOUT_MS,
      winnerId:       null,
    };
  }

  // ── Public entry ────────────────────────────────────────────────── L3_邏輯安防

  /** Returns ok with optional settlement on success, or `{ok:false, error}`
   *  on rejection. `processAction` in the engine adapter wraps this and
   *  throws on errors so the DO can surface them to clients.                */
  process(actorId: PlayerId, action: HeartsActionInput): HeartsProcessOutcome {
    const s = this.s;
    if (s.phase === "settled") return err("ROUND_SETTLED");
    if (!s.playerIds.includes(actorId)) return err("UNKNOWN_PLAYER");

    if (action.type === "hearts_pass") {
      if (s.phase !== "passing") return err("NOT_PASSING_PHASE");
      return this.applyPass(actorId, action);
    }
    if (action.type === "hearts_play") {
      if (s.phase !== "playing") return err("NOT_PLAYING_PHASE");
      return this.applyPlay(actorId, action);
    }
    return err("UNKNOWN_ACTION");
  }

  // ── Passing phase ───────────────────────────────────────────────── L3_邏輯安防

  private applyPass(actorId: PlayerId, action: HeartsPassAction): HeartsProcessOutcome {
    const s = this.s;

    // Already submitted?
    const existing = s.pendingPasses.get(actorId);
    if (existing === undefined) return err("ACTOR_NOT_IN_PASS_LIST");
    if (existing !== null)      return err("ALREADY_PASSED");

    const picks = action.cards;
    if (!Array.isArray(picks) || picks.length !== 3) return err("PASS_MUST_BE_3_CARDS");

    // No duplicates within the pick.
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        if (sameCard(picks[i]!, picks[j]!)) return err("DUPLICATE_PASS_CARD");
      }
    }

    // Each picked card must exist in actor's current hand.
    const hand = s.hands.get(actorId)!;
    const picked: Card[] = [];
    const remaining: Card[] = [...hand];
    for (const want of picks) {
      const idx = remaining.findIndex(c => sameCard(c, want));
      if (idx < 0) return err("CARD_NOT_IN_HAND");
      picked.push(remaining.splice(idx, 1)[0]!);
    }

    // Stash the picked cards; do NOT yet remove from hand — the swap is
    // simultaneous when all 4 submit. We snapshot the picked cards into
    // pendingPasses so restore can rebuild the state mid-pass.
    s.pendingPasses.set(actorId, [picked[0]!, picked[1]!, picked[2]!]);
    s.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;

    // Move turnIndex to the next un-passed seat (for bot dispatch).
    this.advancePassTurnIndex();

    // If all 4 submitted, commit the swap and transition.
    const allIn = [...s.pendingPasses.values()].every(v => v !== null);
    if (allIn) this.commitPassAndStartPlay();

    return ok();
  }

  /** Move turnIndex to the next seat in seat order whose pendingPasses
   *  entry is still null. If everyone has passed, leaves turnIndex where
   *  it was (commitPassAndStartPlay will overwrite it).                   */
  private advancePassTurnIndex(): void {
    const s = this.s;
    for (let step = 1; step <= PLAYER_COUNT; step++) {
      const idx = (s.turnIndex + step) % PLAYER_COUNT;
      const pid = s.playerIds[idx]!;
      if (s.pendingPasses.get(pid) === null) {
        s.turnIndex = idx;
        return;
      }
    }
  }

  /** All 4 submitted: swap simultaneously per direction, set up playing
   *  phase, find ♣2 holder, set turnIndex.                                 // L3_邏輯安防 */
  private commitPassAndStartPlay(): void {
    const s = this.s;
    const dir = passDirectionFor(s.handIndex);
    if (dir === "none") {
      // Shouldn't be reachable — hand 4 starts in playing phase directly.
      throw new Error("commitPass called with passDirection=none");
    }

    // Remove the picked cards from each donor's hand and stage them for
    // their recipient. Apply atomically — no donor sees partial state.
    const incoming = new Map<PlayerId, Card[]>();
    for (const pid of s.playerIds) incoming.set(pid, []);

    for (let i = 0; i < PLAYER_COUNT; i++) {
      const donorId = s.playerIds[i]!;
      const picks = s.pendingPasses.get(donorId)!;
      if (!picks) continue;
      const donorHand = s.hands.get(donorId)!;
      for (const pick of picks) {
        const idx = donorHand.findIndex(c => sameCard(c, pick));
        if (idx < 0) {
          // Defensive: should be impossible (validated at applyPass).
          throw new Error("HEARTS_INTERNAL: picked card missing on commit");
        }
        donorHand.splice(idx, 1);
      }
      const recipientId = s.playerIds[recipientIdx(i, dir)]!;
      incoming.get(recipientId)!.push(...picks);
    }

    for (const [pid, cards] of incoming) {
      s.hands.get(pid)!.push(...cards);
    }

    // Clear pass bookkeeping and flip phase.
    s.pendingPasses = new Map();
    s.phase = "playing";
    s.turnIndex = indexOfClub2(s.playerIds, s.hands);
    s.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;
  }

  // ── Playing phase ───────────────────────────────────────────────── L3_邏輯安防

  private applyPlay(actorId: PlayerId, action: HeartsPlayAction): HeartsProcessOutcome {
    const s = this.s;
    const expected = s.playerIds[s.turnIndex]!;
    if (actorId !== expected) return err("NOT_YOUR_TURN");

    const card = action.card;
    const hand = s.hands.get(actorId)!;
    const cardIdx = hand.findIndex(c => sameCard(c, card));
    if (cardIdx < 0) return err("CARD_NOT_IN_HAND");

    const isFirst = isFirstTrick(s);
    const legal = computeLegalPlays(hand, s.currentTrick, s.heartsBroken, isFirst);
    if (!legal.some(c => sameCard(c, card))) return err("ILLEGAL_PLAY");

    // Remove from hand and append to currentTrick.
    hand.splice(cardIdx, 1);
    s.currentTrick.push({ playerId: actorId, card });
    if (card.suit === "hearts") s.heartsBroken = true;

    // Trick still in progress?
    if (s.currentTrick.length < PLAYER_COUNT) {
      s.turnIndex = (s.turnIndex + 1) % PLAYER_COUNT;
      s.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;
      return ok();
    }

    // Trick complete — determine winner and transfer take.
    const winnerIdx = trickWinnerIdx(s.currentTrick, s.playerIds);
    const winnerPid = s.playerIds[winnerIdx]!;
    const taken = s.takenTricks.get(winnerPid)!;
    for (const play of s.currentTrick) taken.push(play.card);
    s.currentTrick = [];
    s.turnIndex = winnerIdx;
    s.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;

    // Hand complete?
    const completedTricks = totalTaken(s) / PLAYER_COUNT;
    if (completedTricks >= 13) {
      const settlement = this.finalizeHand();
      return { ok: true, settlement };
    }

    return ok();
  }

  /** End-of-hand bookkeeping: compute per-hand points, detect Shoot the
   *  Moon, apply to cumulativeScores, then emit a SettlementResult.
   *  Intermediate hands return matchOver=false with scoreDelta=0; the
   *  match-final hand (any cumulative ≥100) carries the chip pot.        // L3_邏輯安防 */
  private finalizeHand(): SettlementResult {
    const s = this.s;
    const raw: Record<PlayerId, number> = {};
    for (const pid of s.playerIds) {
      const taken = s.takenTricks.get(pid) ?? [];
      raw[pid] = taken.reduce((sum, c) => sum + heartsCardPoints(c), 0);
    }

    // Shoot the Moon: if any single player took 26 of 26 points, flip:
    // that player scores 0, others get +26 each. Classic-only (no half-
    // moon variants).                                                        // L2_實作
    const shooter = s.playerIds.find(p => raw[p] === 26) ?? null;
    const handScores: Record<PlayerId, number> = {};
    if (shooter) {
      for (const pid of s.playerIds) handScores[pid] = pid === shooter ? 0 : 26;
    } else {
      for (const pid of s.playerIds) handScores[pid] = raw[pid] ?? 0;
    }

    for (const pid of s.playerIds) {
      const prev = s.cumulativeScores.get(pid) ?? 0;
      s.cumulativeScores.set(pid, prev + (handScores[pid] ?? 0));
    }

    // Cache last-hand bookkeeping (also surface via snapshot for restore).
    this.lastHandScores = handScores;
    this.lastShooter = shooter;

    // Match-over: anyone hit ≥100 cumulative after this hand. Final
    // ranking is by cumulative ASC (low = good in Hearts).
    const cumulative: Record<PlayerId, number> = {};
    for (const [pid, n] of s.cumulativeScores) cumulative[pid] = n;
    const matchOver = s.playerIds.some(p => (cumulative[p] ?? 0) >= 100);
    const finalRanking = matchOver
      ? [...s.playerIds].sort((a, b) => (cumulative[a] ?? 0) - (cumulative[b] ?? 0))
      : null;

    s.phase = matchOver ? "settled" : "between_hands";
    s.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;
    if (matchOver) s.winnerId = finalRanking![0]!;

    // scoreDelta: intermediate hands all 0 (chip movement saved for the
    // final hand). Match-final hand: rank 1 +300, ranks 2-4 each -100.
    const deltas: Record<PlayerId, number> = {};
    for (const pid of s.playerIds) deltas[pid] = 0;
    if (matchOver) {
      const winnerId = finalRanking![0]!;
      deltas[winnerId] = FINAL_WINNER_GAIN;
      for (const pid of s.playerIds) {
        if (pid !== winnerId) deltas[pid] = -FINAL_LOSER_LOSS;
      }
    }

    // players[] — ordered by per-hand rank (low score first) for natural
    // display. finalRank is 1-based.
    const ordered = [...s.playerIds].sort((a, b) => (handScores[a] ?? 0) - (handScores[b] ?? 0));
    const players: PlayerSettlement[] = ordered.map((pid, i) => ({
      playerId:       pid,
      finalRank:      i + 1,
      remainingCards: [],     // Card[] type; per-hand scores carried via heartsDetail
      scoreDelta:     deltas[pid] ?? 0,
    }));

    const heartsDetail: HeartsSettlementDetail = {
      handScores: { ...handScores },
      cumulativeScores: { ...cumulative },
      shotTheMoonBy: shooter,
      finalRanking,
    };

    const winnerId = matchOver ? finalRanking![0]! : ordered[0]!;

    return {
      gameId:     s.gameId,
      roundId:    s.roundId,
      finishedAt: Date.now(),
      reason:     "lastCardPlayed",
      players,
      winnerId,
      heartsDetail,
      matchOver,
    };
  }

  // ── Multi-hand cycle ────────────────────────────────────────────── L3_邏輯安防

  /** Advance to the next hand. Valid only when phase === "between_hands"
   *  (i.e. the previous hand finalized but the match is not over). Reshuffles
   *  + redeals, resets per-hand flags, enters passing (or playing if the
   *  new handIndex skips passing).                                           // L3_邏輯安防 */
  startNextHand(nextRoundId?: string): void {
    const s = this.s;
    if (s.phase !== "between_hands") {
      throw new Error("HEARTS_INVALID_STATE: startNextHand requires phase=between_hands");
    }

    s.handIndex += 1;
    if (nextRoundId) s.roundId = nextRoundId;

    const deck = secureShuffle(buildDeck());
    s.hands = new Map();
    for (let i = 0; i < s.playerIds.length; i++) {
      s.hands.set(s.playerIds[i]!, deck.slice(i * HAND_SIZE, (i + 1) * HAND_SIZE));
    }

    const dir = passDirectionFor(s.handIndex);
    if (dir === "none") {
      s.phase = "playing";
      s.pendingPasses = new Map();
      s.turnIndex = indexOfClub2(s.playerIds, s.hands);
    } else {
      s.phase = "passing";
      s.pendingPasses = new Map();
      for (const pid of s.playerIds) s.pendingPasses.set(pid, null);
      s.turnIndex = 0;
    }

    s.currentTrick = [];
    s.heartsBroken = false;
    s.takenTricks = new Map();
    for (const pid of s.playerIds) s.takenTricks.set(pid, []);
    s.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;
    this.lastHandScores = null;
    this.lastShooter = null;
  }

  /** Per-hand bookkeeping cached after finalizeHand() for engine-adapter
   *  consumption (heartsDetail payload). Cleared by PR 2.4 startNextHand.   // L2_隔離 */
  private lastHandScores: Record<PlayerId, number> | null = null;
  private lastShooter: PlayerId | null = null;

  /** Most recent finalized hand's scores (null before any hand completes). */
  getLastHandScores(): Record<PlayerId, number> | null {
    return this.lastHandScores ? { ...this.lastHandScores } : null;
  }
  /** Shooter of the last hand (null if no Shoot the Moon). */
  getLastShooter(): PlayerId | null { return this.lastShooter; }

  // ── Read accessors ──────────────────────────────────────────────── L2_隔離

  /** During passing phase: returns the first seat (in seat order) that
   *  has not yet submitted. Lets bot dispatch ping un-passed bots one
   *  at a time. Humans submit asynchronously (process() accepts any
   *  pid with a null pending slot).                                      // L2_隔離 */
  currentTurn(): PlayerId {
    const s = this.s;
    return s.playerIds[s.turnIndex]!;
  }

  phase(): HeartsPhase { return this.s.phase; }
  handIndex(): number { return this.s.handIndex; }

  /** Cumulative scores snapshot (cross-hand). */
  cumulativeScoresMap(): Record<PlayerId, number> {
    const out: Record<PlayerId, number> = {};
    for (const [pid, n] of this.s.cumulativeScores) out[pid] = n;
    return out;
  }

  // ── View projection ─────────────────────────────────────────────── L2_隔離

  viewFor(playerId: PlayerId): HeartsStateView {
    const s = this.s;
    const phase = s.phase;
    const dir = passDirectionFor(s.handIndex);

    const myHand = s.hands.get(playerId) ?? [];
    const myTaken = s.takenTricks.get(playerId) ?? [];
    const myPass = s.pendingPasses.get(playerId) ?? null;

    const self: HeartsSelfView = {
      playerId,
      hand: [...myHand],
      cardCount: myHand.length,
      takenCount: myTaken.length,
      myPass: myPass,
    };

    const opponents: HeartsOpponentView[] = s.playerIds
      .filter(p => p !== playerId)
      .map(p => ({
        playerId: p,
        cardCount: (s.hands.get(p) ?? []).length,
        takenCount: (s.takenTricks.get(p) ?? []).length,
        hasPassed: phase === "passing" ? s.pendingPasses.get(p) != null : false,
      }));

    const cumulativeScores: Record<PlayerId, number> = {};
    for (const [pid, n] of s.cumulativeScores) cumulativeScores[pid] = n;

    // legalCards: SM-side filter — follow-suit / first-trick no-points /
    // heartsBroken gate all enforced. Frontend dim non-legal cards.        // L3_邏輯安防
    const legalCards: Card[] = phase === "playing" && s.playerIds[s.turnIndex] === playerId
      ? computeLegalPlays(myHand, s.currentTrick, s.heartsBroken, isFirstTrick(s))
      : [];

    return {
      gameId: s.gameId,
      roundId: s.roundId,
      phase,
      self,
      opponents,
      handIndex: s.handIndex,
      passDirection: dir,
      heartsBroken: s.heartsBroken,
      currentTrick: [...s.currentTrick],
      cumulativeScores,
      legalCards,
      currentTurn: s.playerIds[s.turnIndex]!,
      turnDeadlineMs: s.turnDeadlineMs,
    };
  }

  /** Spectator view: phantom self (no hand / no pending pass), every real
   *  seat surfaces as opponent. Same shape used by BigTwo / Uno.            // L2_隔離 */
  spectatorView(spectatorId: PlayerId): HeartsStateView {
    const s = this.s;
    const phase = s.phase;
    const self: HeartsSelfView = {
      playerId: spectatorId,
      hand: [],
      cardCount: 0,
      takenCount: 0,
      myPass: null,
    };
    const opponents: HeartsOpponentView[] = s.playerIds.map(p => ({
      playerId: p,
      cardCount: (s.hands.get(p) ?? []).length,
      takenCount: (s.takenTricks.get(p) ?? []).length,
      hasPassed: phase === "passing" ? s.pendingPasses.get(p) != null : false,
    }));
    const cumulativeScores: Record<PlayerId, number> = {};
    for (const [pid, n] of s.cumulativeScores) cumulativeScores[pid] = n;
    return {
      gameId: s.gameId,
      roundId: s.roundId,
      phase,
      self,
      opponents,
      handIndex: s.handIndex,
      passDirection: passDirectionFor(s.handIndex),
      heartsBroken: s.heartsBroken,
      currentTrick: [...s.currentTrick],
      cumulativeScores,
      legalCards: [],
      currentTurn: s.playerIds[s.turnIndex]!,
      turnDeadlineMs: s.turnDeadlineMs,
    };
  }

  // ── Force-settle ────────────────────────────────────────────────── L3_架構含防禦觀測

  /** Forfeit / timeout / disconnect settlement. Fixed -200 to the forfeit
   *  player, +200 to the winner (lowest cumulative among non-forfeiters),
   *  others 0. If no forfeitPlayerId provided, lowest cumulative wins; if
   *  tied, the first such seat in seat order. Always carries heartsDetail
   *  with the latest cumulative + null finalRanking (the match did not
   *  reach a natural conclusion).                                            // L3_邏輯安防 */
  forceSettle(reason: SettlementReason, forfeitPlayerId?: PlayerId): SettlementResult {
    const s = this.s;

    const cumulative: Record<PlayerId, number> = {};
    for (const [pid, n] of s.cumulativeScores) cumulative[pid] = n;

    let winnerId: PlayerId;
    if (forfeitPlayerId && s.playerIds.includes(forfeitPlayerId)) {
      const candidates = s.playerIds.filter(p => p !== forfeitPlayerId);
      candidates.sort((a, b) => (cumulative[a] ?? 0) - (cumulative[b] ?? 0));
      winnerId = candidates[0]!;
    } else {
      const sorted = [...s.playerIds].sort((a, b) => (cumulative[a] ?? 0) - (cumulative[b] ?? 0));
      winnerId = sorted[0]!;
    }

    const deltas: Record<PlayerId, number> = {};
    for (const pid of s.playerIds) deltas[pid] = 0;
    if (forfeitPlayerId && s.playerIds.includes(forfeitPlayerId)) {
      deltas[forfeitPlayerId] = -FORFEIT_PENALTY;
      deltas[winnerId] = FORFEIT_PENALTY;
    }
    // No forfeit (rare path: e.g. clean shutdown without a forfeiter) →
    // all deltas remain 0; players[] still surfaces winner by rank.

    // Order players: winner first, then by cumulative ASC.
    const ordered = [
      winnerId,
      ...s.playerIds
        .filter(p => p !== winnerId)
        .sort((a, b) => (cumulative[a] ?? 0) - (cumulative[b] ?? 0)),
    ];
    const players: PlayerSettlement[] = ordered.map((pid, i) => ({
      playerId:       pid,
      finalRank:      i + 1,
      remainingCards: [],
      scoreDelta:     deltas[pid] ?? 0,
    }));

    const heartsDetail: HeartsSettlementDetail = {
      handScores: this.lastHandScores ? { ...this.lastHandScores } : {},
      cumulativeScores: { ...cumulative },
      shotTheMoonBy: this.lastShooter,
      finalRanking: null,
    };

    s.phase = "settled";
    s.winnerId = winnerId;

    return {
      gameId:     s.gameId,
      roundId:    s.roundId,
      finishedAt: Date.now(),
      reason,
      players,
      winnerId,
      heartsDetail,
      matchOver:  true,
    };
  }

  // ── Snapshot / restore ──────────────────────────────────────────── L3_架構含防禦觀測

  snapshot(): HeartsSnapshot {
    const { s } = this;
    return {
      gameId:           s.gameId,
      roundId:          s.roundId,
      phase:            s.phase,
      playerIds:        [...s.playerIds],
      handIndex:        s.handIndex,
      hands:            [...s.hands.entries()].map(([pid, h]) => [pid, [...h]] as [PlayerId, Card[]]),
      pendingPasses:    [...s.pendingPasses.entries()]
        .map(([pid, v]) => [pid, v === null ? null : [v[0], v[1], v[2]] as [Card, Card, Card]] as [PlayerId, [Card, Card, Card] | null]),
      currentTrick:     s.currentTrick.map(p => ({ playerId: p.playerId, card: { ...p.card } })),
      heartsBroken:     s.heartsBroken,
      takenTricks:      [...s.takenTricks.entries()].map(([pid, h]) => [pid, [...h]] as [PlayerId, Card[]]),
      turnIndex:        s.turnIndex,
      cumulativeScores: [...s.cumulativeScores.entries()],
      turnDeadlineMs:   s.turnDeadlineMs,
      winnerId:         s.winnerId,
      lastHandScores:   this.lastHandScores ? Object.entries(this.lastHandScores) : null,
      lastShooter:      this.lastShooter,
    };
  }

  static restore(snap: HeartsSnapshot): HeartsStateMachine {
    const m = Object.create(HeartsStateMachine.prototype) as HeartsStateMachine;
    (m as unknown as { s: InternalState }).s = {
      gameId:           snap.gameId,
      roundId:          snap.roundId,
      phase:            snap.phase,
      playerIds:        [...snap.playerIds],
      handIndex:        snap.handIndex,
      hands:            new Map(snap.hands),
      pendingPasses:    new Map(snap.pendingPasses),
      currentTrick:     snap.currentTrick.map(p => ({ playerId: p.playerId, card: { ...p.card } })),
      heartsBroken:     snap.heartsBroken,
      takenTricks:      new Map(snap.takenTricks),
      turnIndex:        snap.turnIndex,
      cumulativeScores: new Map(snap.cumulativeScores),
      turnDeadlineMs:   snap.turnDeadlineMs,
      winnerId:         snap.winnerId,
    };
    (m as unknown as { lastHandScores: Record<PlayerId, number> | null }).lastHandScores =
      snap.lastHandScores ? Object.fromEntries(snap.lastHandScores) : null;
    (m as unknown as { lastShooter: PlayerId | null }).lastShooter = snap.lastShooter ?? null;
    return m;
  }
}

// ─── Private helpers ────────────────────────────────────────────── L2_實作

function indexOfClub2(playerIds: PlayerId[], hands: Map<PlayerId, Card[]>): number {
  for (let i = 0; i < playerIds.length; i++) {
    const hand = hands.get(playerIds[i]!);
    if (!hand) continue;
    if (hand.some(isClub2)) return i;
  }
  throw new Error("HEARTS_INTERNAL: ♣2 missing from all hands");
}

/** Standard rank ordering — Hearts uses 2 (low) … A (high). */
const RANK_VALUE: Record<Rank, number> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
  "J": 11, "Q": 12, "K": 13, "A": 14,
};

/** Total cards in all takenTricks (= completed tricks × 4). */
function totalTaken(s: InternalState): number {
  let n = 0;
  for (const t of s.takenTricks.values()) n += t.length;
  return n;
}

function isFirstTrick(s: InternalState): boolean {
  return totalTaken(s) === 0;
}

/** Winner index within playerIds[] for a completed 4-card trick.
 *  Highest card of the led suit takes the trick.                            // L3_邏輯安防 */
function trickWinnerIdx(trick: HeartsTrickPlay[], playerIds: PlayerId[]): number {
  const ledSuit = trick[0]!.card.suit;
  let bestVal = -1;
  let bestPid: PlayerId = trick[0]!.playerId;
  for (const play of trick) {
    if (play.card.suit !== ledSuit) continue;
    const v = RANK_VALUE[play.card.rank];
    if (v > bestVal) { bestVal = v; bestPid = play.playerId; }
  }
  return playerIds.indexOf(bestPid);
}

/** Legal plays for `actor` given the in-progress trick.
 *  Rules:
 *   - Leading (trick empty):
 *       · First trick of hand: must play ♣2.
 *       · Else if !heartsBroken AND hand has any non-♥: only non-♥.
 *       · Otherwise (heartsBroken OR hand is all ♥): any card.
 *   - Following (trick non-empty):
 *       · If has any card of led suit: must follow suit.
 *         AND first-trick-no-points rule: if any non-point card of led
 *         suit exists, point cards of led suit are illegal too.
 *       · If void in led suit:
 *         - First trick: can't drop ♥ or ♠Q unless hand is all points.
 *         - Else: any card.
 *  Returns the filtered subset of `hand` (preserves order).                  // L3_邏輯安防 */
export function computeLegalPlays(
  hand: Card[],
  trick: HeartsTrickPlay[],
  heartsBroken: boolean,
  firstTrick: boolean,
): Card[] {
  if (hand.length === 0) return [];

  if (trick.length === 0) {
    // Leading.
    if (firstTrick) {
      const c2 = hand.find(c => isClub2(c));
      return c2 ? [c2] : [];
    }
    if (heartsBroken) return [...hand];
    const nonHearts = hand.filter(c => c.suit !== "hearts");
    return nonHearts.length > 0 ? nonHearts : [...hand];
  }

  // Following.
  const ledSuit = trick[0]!.card.suit;
  const followers = hand.filter(c => c.suit === ledSuit);

  if (followers.length > 0) {
    if (firstTrick) {
      const safeFollowers = followers.filter(c => !isPointCard(c));
      if (safeFollowers.length > 0) return safeFollowers;
    }
    return followers;
  }

  // Void in led suit.
  if (firstTrick) {
    const safe = hand.filter(c => !isPointCard(c));
    if (safe.length > 0) return safe;
  }
  return [...hand];
}

function ok(): HeartsProcessResult { return { ok: true, settlement: null }; }
function err(error: string): HeartsProcessError { return { ok: false, error }; }
