// /src/game/YahtzeeStateMachine.ts
// Pure Yahtzee logic — zero IO. Mirrors BigTwo/Uno SM pattern.       // L2_模組
// Each player gets 13 turns; per turn 3 rolls; must score into one of
// 13 slots after rolling. Match ends when all 13 × N slots are filled.
// Standard scoring + upper-bonus 35 (>= 63) + yahtzee bonus 100 each.

import type {
  PlayerId, DieFace, DiceTuple, HeldTuple,
  YahtzeeSlot, Scorecard, YahtzeePhase,
  YahtzeeRollAction, YahtzeeScoreAction,
  YahtzeeStateView, YahtzeeSettlementDetail,
  SettlementResult, PlayerSettlement, SettlementReason,
} from "../types/game";
import { YAHTZEE_SLOTS } from "../types/game";

const TURN_TIMEOUT_MS = 30_000;

// ─── Cryptographic die roll ────────────────────────────────────── L3_邏輯安防
function secureDie(): DieFace {
  const buf = new Uint32Array(1);
  const limit = 4_294_967_292;   // 2^32 - (2^32 mod 6)
  let v: number;
  do { crypto.getRandomValues(buf); v = buf[0]!; } while (v >= limit);
  return ((v % 6) + 1) as DieFace;
}

const PLACEHOLDER_DICE: DiceTuple = [1, 1, 1, 1, 1];
const NO_HELD: HeldTuple = [false, false, false, false, false];

// ─── Scoring ────────────────────────────────────────────────────── L2_實作
// Pure score-of-dice for each slot; called at score time + by Bot for EV.
export function scoreSlot(dice: DiceTuple, slot: YahtzeeSlot): number {
  const counts = countFaces(dice);
  const total = dice.reduce((a, b) => a + b, 0);

  switch (slot) {
    case "ones":   return counts[1] * 1;
    case "twos":   return counts[2] * 2;
    case "threes": return counts[3] * 3;
    case "fours":  return counts[4] * 4;
    case "fives":  return counts[5] * 5;
    case "sixes":  return counts[6] * 6;
    case "threeKind": return Object.values(counts).some(n => n >= 3) ? total : 0;
    case "fourKind":  return Object.values(counts).some(n => n >= 4) ? total : 0;
    case "fullHouse": {
      const vals = Object.values(counts);
      return vals.includes(3) && vals.includes(2) ? 25 : 0;
    }
    case "smallStraight": return hasStraight(dice, 4) ? 30 : 0;
    case "largeStraight": return hasStraight(dice, 5) ? 40 : 0;
    case "yahtzee":  return Object.values(counts).some(n => n === 5) ? 50 : 0;
    case "chance":   return total;
  }
}

function countFaces(dice: DiceTuple): Record<DieFace, number> {
  const c: Record<DieFace, number> = { 1:0, 2:0, 3:0, 4:0, 5:0, 6:0 };
  for (const d of dice) c[d]++;
  return c;
}

/** Has a `len`-length consecutive run? Standard small/large straight check. */
function hasStraight(dice: DiceTuple, len: 4 | 5): boolean {
  const set = new Set<DieFace>(dice);
  if (len === 5) {
    return (set.has(1) && set.has(2) && set.has(3) && set.has(4) && set.has(5)) ||
           (set.has(2) && set.has(3) && set.has(4) && set.has(5) && set.has(6));
  }
  // len === 4
  const hasRun4 = (a: DieFace) =>
    set.has(a) && set.has((a + 1) as DieFace) &&
    set.has((a + 2) as DieFace) && set.has((a + 3) as DieFace);
  return hasRun4(1) || hasRun4(2) || hasRun4(3);
}

// ─── Bonus calculation ─────────────────────────────────────────── L2_實作
const UPPER_SLOTS: readonly YahtzeeSlot[] = ["ones","twos","threes","fours","fives","sixes"];
const UPPER_BONUS_THRESHOLD = 63;
const UPPER_BONUS = 35;

export function computeUpperBonus(card: Scorecard): number {
  let sum = 0;
  for (const s of UPPER_SLOTS) sum += card[s] ?? 0;
  return sum >= UPPER_BONUS_THRESHOLD ? UPPER_BONUS : 0;
}

/** Sum of all 13 slots + upper bonus. Yahtzee bonus is tracked
 *  separately on the state since it accumulates on extra-yahtzee plays.   */
export function computeBaseTotal(card: Scorecard): number {
  let sum = 0;
  for (const s of YAHTZEE_SLOTS) sum += card[s] ?? 0;
  return sum + computeUpperBonus(card);
}

// ─── Internal state ────────────────────────────────────────────── L2_模組

interface InternalState {
  gameId:         string;
  roundId:        string;
  phase:          YahtzeePhase;
  playerIds:      PlayerId[];
  scorecards:     Map<PlayerId, Scorecard>;
  /** 100-point bonuses earned for additional yahtzees (per player). */
  yahtzeeBonus:   Map<PlayerId, number>;
  dice:           DiceTuple;
  held:           HeldTuple;
  rollsLeft:      0 | 1 | 2 | 3;
  turnNumber:     number;       // 0 .. totalTurns-1
  totalTurns:     number;       // playerIds.length × 13
  turnDeadlineMs: number;
}

// ─── Snapshot ──────────────────────────────────────────────────── L3_架構含防禦觀測

export interface YahtzeeSnapshot {
  gameId:         string;
  roundId:        string;
  phase:          YahtzeePhase;
  playerIds:      PlayerId[];
  scorecards:     [PlayerId, Scorecard][];
  yahtzeeBonus:   [PlayerId, number][];
  dice:           DiceTuple;
  held:           HeldTuple;
  rollsLeft:      0 | 1 | 2 | 3;
  turnNumber:     number;
  totalTurns:     number;
  turnDeadlineMs: number;
}

// ─── Result ────────────────────────────────────────────────────── L2_模組

export interface YahtzeeProcessResult { ok: true; settlement: SettlementResult | null; }
export interface YahtzeeProcessError  { ok: false; error: string; }
export type YahtzeeProcessOutcome = YahtzeeProcessResult | YahtzeeProcessError;

// ─── Public class ──────────────────────────────────────────────── L3_代碼附資源清單
// Resource manifest:
//   ✓ crypto.getRandomValues (dice rolls)
//   ✗ no fetch / DB / WS

function emptyScorecard(): Scorecard {
  const c = {} as Scorecard;
  for (const s of YAHTZEE_SLOTS) c[s] = null;
  return c;
}

export class YahtzeeStateMachine {

  private readonly s: InternalState;

  constructor(gameId: string, roundId: string, playerIds: PlayerId[]) {
    if (playerIds.length < 2 || playerIds.length > 4)
      throw new RangeError("yahtzee player count must be 2-4");
    if (new Set(playerIds).size !== playerIds.length)
      throw new Error("duplicate player IDs");

    const scorecards = new Map<PlayerId, Scorecard>();
    const yahtzeeBonus = new Map<PlayerId, number>();
    for (const pid of playerIds) {
      scorecards.set(pid, emptyScorecard());
      yahtzeeBonus.set(pid, 0);
    }

    this.s = {
      gameId, roundId,
      phase: "rolling",
      playerIds,
      scorecards,
      yahtzeeBonus,
      dice: PLACEHOLDER_DICE,
      held: [...NO_HELD] as HeldTuple,
      rollsLeft: 3,
      turnNumber: 0,
      totalTurns: playerIds.length * 13,
      turnDeadlineMs: Date.now() + TURN_TIMEOUT_MS,
    };
  }

  // ── Public entry ────────────────────────────────────────────────── L3_邏輯安防

  process(actorId: PlayerId, action: YahtzeeRollAction | YahtzeeScoreAction): YahtzeeProcessOutcome {
    const { s } = this;
    if (s.phase !== "rolling") return { ok: false, error: "already settled" };
    const expected = s.playerIds[s.turnNumber % s.playerIds.length]!;
    if (actorId !== expected) return { ok: false, error: `out-of-turn: expected ${expected}, got ${actorId}` };

    try {
      if (action.type === "yz_roll")  return this.applyRoll(action);
      if (action.type === "yz_score") return this.applyScore(actorId, action.slot);
      return { ok: false, error: `unknown action: ${(action as { type: string }).type}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  forceSettle(reason: Exclude<SettlementReason, "lastCardPlayed">, forfeitPlayerId?: PlayerId): SettlementResult {
    if (this.s.phase !== "rolling") throw new Error("already settled");
    return this.settle(reason, forfeitPlayerId);
  }

  viewFor(playerId: PlayerId): YahtzeeStateView {
    const { s } = this;
    return {
      gameId: s.gameId,
      roundId: s.roundId,
      phase: s.phase,
      self: { playerId, scorecard: s.scorecards.get(playerId) ?? emptyScorecard() },
      opponents: s.playerIds.filter(id => id !== playerId).map(id => ({
        playerId: id,
        scorecard: s.scorecards.get(id) ?? emptyScorecard(),
      })),
      dice: s.dice,
      held: s.held,
      rollsLeft: s.rollsLeft,
      turnNumber: s.turnNumber,
      totalTurns: s.totalTurns,
      currentTurn: s.playerIds[s.turnNumber % s.playerIds.length]!,
      turnDeadlineMs: s.turnDeadlineMs,
    };
  }

  currentTurn(): PlayerId {
    return this.s.playerIds[this.s.turnNumber % this.s.playerIds.length]!;
  }

  // ── Action handlers ─────────────────────────────────────────────── L3_邏輯安防

  private applyRoll(action: YahtzeeRollAction): YahtzeeProcessOutcome {
    const { s } = this;
    if (s.rollsLeft === 0) return { ok: false, error: "no rolls left this turn" };
    if (action.held.length !== 5) return { ok: false, error: "held must be length 5" };

    // First roll of a turn: ignore held flags (no dice to keep yet).
    const useHeld: HeldTuple = s.rollsLeft === 3
      ? [false, false, false, false, false]
      : action.held;

    const next: DieFace[] = [];
    for (let i = 0; i < 5; i++) {
      next.push(useHeld[i] ? s.dice[i]! : secureDie());
    }
    s.dice = next as DiceTuple;
    s.held = useHeld;
    s.rollsLeft = (s.rollsLeft - 1) as 0 | 1 | 2;
    return { ok: true, settlement: null };
  }

  private applyScore(actorId: PlayerId, slot: YahtzeeSlot): YahtzeeProcessOutcome {
    const { s } = this;
    if (s.rollsLeft === 3) return { ok: false, error: "must roll at least once before scoring" };
    const card = s.scorecards.get(actorId)!;
    if (card[slot] !== null) return { ok: false, error: `slot ${slot} already filled` };

    const baseScore = scoreSlot(s.dice, slot);
    card[slot] = baseScore;

    // Yahtzee bonus: if dice form a yahtzee AND yahtzee slot is already
    // filled with a non-zero score, +100 bonus (simplified — no Joker rule).
    const isYahtzee = countFaces(s.dice)[1] === 5
      || countFaces(s.dice)[2] === 5 || countFaces(s.dice)[3] === 5
      || countFaces(s.dice)[4] === 5 || countFaces(s.dice)[5] === 5
      || countFaces(s.dice)[6] === 5;
    if (isYahtzee && slot !== "yahtzee" && card.yahtzee && card.yahtzee > 0) {
      s.yahtzeeBonus.set(actorId, (s.yahtzeeBonus.get(actorId) ?? 0) + 100);
    }

    // Advance turn.
    s.turnNumber++;
    s.dice = PLACEHOLDER_DICE;
    s.held = [...NO_HELD] as HeldTuple;
    s.rollsLeft = 3;
    s.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;

    if (s.turnNumber >= s.totalTurns) {
      return { ok: true, settlement: this.settle("lastCardPlayed") };
    }
    return { ok: true, settlement: null };
  }

  // ── Settlement ──────────────────────────────────────────────────── L3_邏輯安防

  private settle(reason: SettlementReason, forfeitPlayerId?: PlayerId): SettlementResult {
    const { s } = this;
    s.phase = "settled";

    const totalsByPlayer: Record<PlayerId, number> = {};
    const upperBonusByPlayer: Record<PlayerId, number> = {};
    const yahtzeeBonusByPlayer: Record<PlayerId, number> = {};
    for (const pid of s.playerIds) {
      const card = s.scorecards.get(pid)!;
      const ub = computeUpperBonus(card);
      const yb = s.yahtzeeBonus.get(pid) ?? 0;
      upperBonusByPlayer[pid] = ub;
      yahtzeeBonusByPlayer[pid] = yb;
      totalsByPlayer[pid] = computeBaseTotal(card) + yb;
    }

    // Rank by total descending; forfeit player goes last regardless.
    const ranked = [...s.playerIds].sort((a, b) => {
      if (a === forfeitPlayerId) return 1;
      if (b === forfeitPlayerId) return -1;
      return totalsByPlayer[b]! - totalsByPlayer[a]!;
    });
    const winnerId = ranked[0]!;

    // Conservative chip distribution: each loser pays a normalized share
    // tied to score gap. Simplified — fixed pot scheme: each non-winner
    // pays 100 chips, winner takes total. Forfeit: winner +200, forfeit
    // -200, others 0 (so disconnect is roughly net-zero for innocents).
    const N = s.playerIds.length;
    const deltas: Record<PlayerId, number> = {};
    for (const pid of s.playerIds) deltas[pid] = 0;

    if (forfeitPlayerId) {
      const FORFEIT = 200;
      deltas[forfeitPlayerId] = -FORFEIT;
      deltas[winnerId] = FORFEIT;
    } else {
      const PER_LOSER = 100;
      for (const pid of s.playerIds) {
        if (pid === winnerId) continue;
        deltas[pid] = -PER_LOSER;
      }
      deltas[winnerId] = PER_LOSER * (N - 1);
    }

    const players: PlayerSettlement[] = ranked.map((pid, i) => ({
      playerId:       pid,
      finalRank:      i + 1,
      remainingCards: [],          // not applicable to Yahtzee
      scoreDelta:     deltas[pid] ?? 0,
    }));

    const detail: YahtzeeSettlementDetail = {
      totalsByPlayer, upperBonusByPlayer, yahtzeeBonusByPlayer,
    };

    return {
      gameId: s.gameId,
      roundId: s.roundId,
      finishedAt: Date.now(),
      reason,
      players,
      winnerId,
      yahtzeeDetail: detail,
    };
  }

  // ── Snapshot / restore ──────────────────────────────────────────── L3_架構含防禦觀測

  snapshot(): YahtzeeSnapshot {
    const { s } = this;
    return {
      gameId: s.gameId,
      roundId: s.roundId,
      phase: s.phase,
      playerIds: s.playerIds,
      scorecards: [...s.scorecards.entries()],
      yahtzeeBonus: [...s.yahtzeeBonus.entries()],
      dice: s.dice,
      held: s.held,
      rollsLeft: s.rollsLeft,
      turnNumber: s.turnNumber,
      totalTurns: s.totalTurns,
      turnDeadlineMs: s.turnDeadlineMs,
    };
  }

  static restore(snap: YahtzeeSnapshot): YahtzeeStateMachine {
    const m = Object.create(YahtzeeStateMachine.prototype) as YahtzeeStateMachine;
    (m as unknown as { s: InternalState }).s = {
      gameId: snap.gameId,
      roundId: snap.roundId,
      phase: snap.phase,
      playerIds: snap.playerIds,
      scorecards: new Map(snap.scorecards),
      yahtzeeBonus: new Map(snap.yahtzeeBonus),
      dice: snap.dice,
      held: snap.held,
      rollsLeft: snap.rollsLeft,
      turnNumber: snap.turnNumber,
      totalTurns: snap.totalTurns,
      turnDeadlineMs: snap.turnDeadlineMs,
    };
    return m;
  }
}
