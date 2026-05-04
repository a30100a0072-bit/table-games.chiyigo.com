// /src/game/UnoStateMachine.ts
// Pure Uno logic — zero IO. Mirrors BigTwoStateMachine pattern.   // L2_模組
// Rules: standard 108-card deck, 2-4 players, 7-card opening, no
// stacking on Draw2/WildDraw4, no UNO! shout penalty.            // L2_實作

import type {
  PlayerId, UnoCard, UnoColor, UnoValue,
  UnoPlayAction, UnoDrawAction, UnoPassAction,
  UnoStateView, UnoLastPlay, UnoPhase,
  SettlementResult, PlayerSettlement, SettlementReason,
  UnoSettlementDetail,
} from "../types/game";

const COLORS: readonly UnoColor[] = ["red", "yellow", "green", "blue"];
const HAND_SIZE = 7;
const TURN_TIMEOUT_MS = 30_000;

// ─── Deck construction ──────────────────────────────────────────── L2_模組
// Standard Uno: 4 colors × (1×0 + 2×each of 1-9 + 2×Skip + 2×Reverse + 2×Draw2)
// + 4×Wild + 4×WildDraw4 = 108 cards.
function buildDeck(): UnoCard[] {
  const deck: UnoCard[] = [];
  for (const color of COLORS) {
    deck.push({ color, value: 0 });
    for (let v = 1 as UnoValue; (v as number) <= 9; v = ((v as number) + 1) as UnoValue) {
      deck.push({ color, value: v });
      deck.push({ color, value: v });
    }
    for (const action of ["skip", "reverse", "draw2"] as const) {
      deck.push({ color, value: action });
      deck.push({ color, value: action });
    }
  }
  for (let i = 0; i < 4; i++) deck.push({ value: "wild" });
  for (let i = 0; i < 4; i++) deck.push({ value: "wild_draw4" });
  return deck;
}

// ─── Cryptographic shuffle (same as BigTwo) ─────────────────────── L3_邏輯安防
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

// ─── Card scoring (settlement) ──────────────────────────────────── L2_實作
export function unoCardPoints(c: UnoCard): number {
  if (typeof c.value === "number") return c.value;
  if (c.value === "wild" || c.value === "wild_draw4") return 50;
  return 20;  // skip / reverse / draw2
}

// ─── Legality check ─────────────────────────────────────────────── L3_邏輯安防
/** Can `card` be played on top of (`topValue`, `currentColor`)?
 *  - wild / wild_draw4: always legal (declaredColor required)
 *  - color match: legal
 *  - value match: legal (numbers and action-card values both)
 */
export function canPlay(card: UnoCard, topValue: UnoValue, currentColor: UnoColor): boolean {
  if (card.value === "wild" || card.value === "wild_draw4") return true;
  if (card.color === currentColor) return true;
  if (card.value === topValue) return true;
  return false;
}

// ─── Internal mutable state ─────────────────────────────────────── L2_模組

interface InternalState {
  gameId:         string;
  roundId:        string;
  phase:          UnoPhase;
  playerIds:      PlayerId[];
  hands:          Map<PlayerId, UnoCard[]>;
  drawPile:       UnoCard[];   // index n-1 = top of pile
  discardPile:    UnoCard[];   // index n-1 = top of discard
  currentColor:   UnoColor;    // active color (wild's declaredColor goes here)
  direction:      1 | -1;
  turnIndex:      number;
  hasDrawn:       boolean;     // current player drew this turn but hasn't decided yet
  pendingDraw:    number;      // 0 / 2 / 4 — applied to next-up player on their turn enter
  turnDeadlineMs: number;
  winnerId:       PlayerId | null;
}

// ─── Snapshot ───────────────────────────────────────────────────── L3_架構含防禦觀測

export interface UnoSnapshot {
  gameId:         string;
  roundId:        string;
  phase:          UnoPhase;
  playerIds:      PlayerId[];
  hands:          [PlayerId, UnoCard[]][];
  drawPile:       UnoCard[];
  discardPile:    UnoCard[];
  currentColor:   UnoColor;
  direction:      1 | -1;
  turnIndex:      number;
  hasDrawn:       boolean;
  pendingDraw:    number;
  turnDeadlineMs: number;
  winnerId:       PlayerId | null;
}

// ─── Result type ────────────────────────────────────────────────── L2_模組

export interface UnoProcessResult {
  ok: true;
  settlement: SettlementResult | null;
}
export interface UnoProcessError { ok: false; error: string; }
export type UnoProcessOutcome = UnoProcessResult | UnoProcessError;

type UnoActionInput = UnoPlayAction | UnoDrawAction | UnoPassAction;

// ─── Public class ───────────────────────────────────────────────── L3_代碼附資源清單
// Resource manifest:
//   ✓ crypto.getRandomValues (shuffle)
//   ✗ no fetch / DB / WS

export class UnoStateMachine {

  private readonly s: InternalState;

  constructor(gameId: string, roundId: string, playerIds: PlayerId[]) {
    if (playerIds.length < 2 || playerIds.length > 4)
      throw new RangeError("uno player count must be 2-4");
    if (new Set(playerIds).size !== playerIds.length)
      throw new Error("duplicate player IDs");

    let deck = secureShuffle(buildDeck());
    const hands = new Map<PlayerId, UnoCard[]>();
    for (const pid of playerIds) hands.set(pid, deck.splice(-HAND_SIZE, HAND_SIZE));

    // Flip starter card. Re-shuffle if it lands on a wild — this matches
    // the official rule and keeps the opening color unambiguous.    // L3_邏輯安防
    let starter: UnoCard;
    while (true) {
      starter = deck.pop()!;
      if (starter.value !== "wild" && starter.value !== "wild_draw4") break;
      deck.push(starter);
      deck = secureShuffle(deck);
    }

    let initialDirection: 1 | -1 = 1;
    let turnIndex = 0;
    const n = playerIds.length;

    // First-card effects (excluding wild — re-shuffled above). All effects
    // apply BEFORE play begins, so pendingDraw is fully absorbed here and
    // the player who is up gets a clean turn.                             // L3_邏輯安防
    if (starter.value === "skip") {
      turnIndex = (turnIndex + initialDirection + n) % n;
    } else if (starter.value === "reverse") {
      initialDirection = -1;
      if (n === 2) turnIndex = (turnIndex + initialDirection + n) % n;
      else         turnIndex = (n - 1) % n;
    } else if (starter.value === "draw2") {
      // Player at turnIndex picks up 2 and is skipped.
      const target = playerIds[turnIndex]!;
      for (let i = 0; i < 2; i++) hands.get(target)!.push(deck.pop()!);
      turnIndex = (turnIndex + initialDirection + n) % n;
    }

    this.s = {
      gameId, roundId,
      phase: "playing",
      playerIds,
      hands,
      drawPile:    deck,
      discardPile: [starter],
      currentColor: starter.color!,    // non-wild guaranteed by loop above
      direction:   initialDirection,
      turnIndex,
      hasDrawn:    false,
      pendingDraw: 0,
      turnDeadlineMs: Date.now() + TURN_TIMEOUT_MS,
      winnerId: null,
    };
  }

  // ── Public entry ────────────────────────────────────────────────── L3_邏輯安防

  process(actorId: PlayerId, action: UnoActionInput): UnoProcessOutcome {
    const { s } = this;
    if (s.phase !== "playing") return { ok: false, error: "already settled" };
    if (actorId !== s.playerIds[s.turnIndex])
      return { ok: false, error: `out-of-turn: expected ${s.playerIds[s.turnIndex]}, got ${actorId}` };

    // Handle pendingDraw before user input: any action other than absorbing
    // the draw is rejected — by spec we just auto-apply the penalty when the
    // turn enters (see advanceTurn). So if pendingDraw > 0 we get here only
    // via SM bug. Sanity: if advanceTurn applied it correctly, pendingDraw
    // is 0 by the time the player acts.
    if (s.pendingDraw !== 0)
      return { ok: false, error: "internal: pendingDraw not cleared before turn" };

    try {
      if (action.type === "uno_play")      return this.applyPlay(actorId, action);
      if (action.type === "uno_draw")      return this.applyDraw(actorId);
      if (action.type === "uno_pass")      return this.applyPass(actorId);
      return { ok: false, error: `unknown action: ${(action as { type: string }).type}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  forceSettle(reason: Exclude<SettlementReason, "lastCardPlayed">, forfeitPlayerId?: PlayerId): SettlementResult {
    if (this.s.phase !== "playing") throw new Error("already settled");
    return this.settle(reason, forfeitPlayerId);
  }

  viewFor(playerId: PlayerId): UnoStateView {
    const { s } = this;
    const hand = s.hands.get(playerId) ?? [];
    const top = s.discardPile[s.discardPile.length - 1]!;
    const topWithColor: UnoCard = { ...top, color: s.currentColor };
    return {
      gameId: s.gameId,
      roundId: s.roundId,
      phase: s.phase,
      self: { playerId, hand, cardCount: hand.length },
      opponents: s.playerIds.filter(id => id !== playerId).map(id => ({
        playerId: id,
        cardCount: s.hands.get(id)?.length ?? 0,
      })),
      topDiscard: {
        playerId: this.lastPlayerId(),
        card: topWithColor,
      },
      currentColor: s.currentColor,
      direction: s.direction,
      drawPileCount: s.drawPile.length,
      currentTurn: s.playerIds[s.turnIndex]!,
      hasDrawn: s.hasDrawn,
      pendingDraw: s.pendingDraw,
      turnDeadlineMs: s.turnDeadlineMs,
    };
  }

  currentTurn(): PlayerId { return this.s.playerIds[this.s.turnIndex]!; }

  // ── Action handlers ─────────────────────────────────────────────── L3_邏輯安防

  private applyPlay(actorId: PlayerId, action: UnoPlayAction): UnoProcessOutcome {
    const { s } = this;
    const hand = s.hands.get(actorId)!;
    const topValue = s.discardPile[s.discardPile.length - 1]!.value;

    // Find a matching card in hand (by color + value, wild has no color).
    const isWild = action.card.value === "wild" || action.card.value === "wild_draw4";
    const handIdx = hand.findIndex(c => {
      if (isWild) return c.color === undefined && c.value === action.card.value;
      return c.color === action.card.color && c.value === action.card.value;
    });
    if (handIdx === -1) return { ok: false, error: "card not in hand" };

    if (!canPlay(action.card, topValue, s.currentColor))
      return { ok: false, error: `illegal: ${describe(action.card)} on ${describe({ color: s.currentColor, value: topValue })}` };

    if (isWild) {
      if (!action.declaredColor || !COLORS.includes(action.declaredColor))
        return { ok: false, error: "wild requires declaredColor" };
    }

    // Commit play.
    hand.splice(handIdx, 1);
    s.discardPile.push(action.card);
    s.currentColor = isWild ? action.declaredColor! : action.card.color!;
    s.hasDrawn = false;

    // Win check before applying card effect (the played card empties hand).
    if (hand.length === 0) {
      s.winnerId = actorId;
      return { ok: true, settlement: this.settle("lastCardPlayed") };
    }

    // Apply card effect.
    const v = action.card.value;
    if (v === "skip") {
      this.advanceTurn(2);   // skip one + advance to next next
    } else if (v === "reverse") {
      s.direction = (s.direction === 1 ? -1 : 1);
      if (s.playerIds.length === 2) this.advanceTurn(2);
      else this.advanceTurn(1);
    } else if (v === "draw2") {
      s.pendingDraw = 2;
      this.advanceTurn(1);
      this.absorbPendingDraw();
      this.advanceTurn(1);
    } else if (v === "wild_draw4") {
      s.pendingDraw = 4;
      this.advanceTurn(1);
      this.absorbPendingDraw();
      this.advanceTurn(1);
    } else {
      this.advanceTurn(1);
    }

    s.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;
    return { ok: true, settlement: null };
  }

  private applyDraw(actorId: PlayerId): UnoProcessOutcome {
    const { s } = this;
    if (s.hasDrawn) return { ok: false, error: "already drew this turn" };
    const c = this.drawOne();
    s.hands.get(actorId)!.push(c);
    s.hasDrawn = true;
    // Player keeps the turn — they may now uno_play (the drawn card if legal,
    // OR any other legal card from their hand) or uno_pass.       // L2_實作
    return { ok: true, settlement: null };
  }

  private applyPass(actorId: PlayerId): UnoProcessOutcome {
    const { s } = this;
    if (!s.hasDrawn) return { ok: false, error: "must draw before passing" };
    void actorId;
    s.hasDrawn = false;
    this.advanceTurn(1);
    s.turnDeadlineMs = Date.now() + TURN_TIMEOUT_MS;
    return { ok: true, settlement: null };
  }

  // ── Internal helpers ────────────────────────────────────────────── L2_模組

  /** Move turnIndex forward by `steps` (each step honors direction). */
  private advanceTurn(steps: number): void {
    const { s } = this;
    const n = s.playerIds.length;
    s.turnIndex = ((s.turnIndex + s.direction * steps) % n + n) % n;
  }

  /** Pull `pendingDraw` cards into the current turn-holder's hand and
   *  clear pendingDraw. Caller is responsible for advancing turn. */
  private absorbPendingDraw(): void {
    const { s } = this;
    const target = s.playerIds[s.turnIndex]!;
    for (let i = 0; i < s.pendingDraw; i++) {
      const c = this.drawOne();
      s.hands.get(target)!.push(c);
    }
    s.pendingDraw = 0;
  }

  /** Draw one card; reshuffle discard pile (excluding top) into draw
   *  pile if empty. If both piles are exhausted, throws (shouldn't
   *  happen with 108-card deck and 4 players × 7 hand). */
  private drawOne(): UnoCard {
    const { s } = this;
    if (s.drawPile.length === 0) {
      if (s.discardPile.length <= 1) throw new Error("deck exhausted");
      // Take everything except the current top, strip wild's declared
      // color (returns to neutral wild), and reshuffle into draw pile.
      const top = s.discardPile.pop()!;
      const recycled: UnoCard[] = s.discardPile.map(c => {
        if (c.value === "wild" || c.value === "wild_draw4") return { value: c.value };
        return c;
      });
      s.discardPile = [top];
      s.drawPile = secureShuffle(recycled);
    }
    return s.drawPile.pop()!;
  }

  private lastPlayerId(): PlayerId {
    // Reverse-step from current turn to find who placed the top card.
    // (Approximate: in the rare opening case where the starter is just
    // the flipped-from-deck card, no one "played" it. We attribute it
    // to the dealer's seat 0 for display purposes.)              // L2_實作
    const { s } = this;
    if (s.discardPile.length === 1) return s.playerIds[0]!;
    const n = s.playerIds.length;
    let idx = ((s.turnIndex - s.direction) % n + n) % n;
    // If the played card was Skip / Reverse / Draw2 / WildDraw4, the
    // turn moved by 2; correct by stepping back one more.
    const top = s.discardPile[s.discardPile.length - 1]!;
    if (top.value === "skip" || top.value === "draw2" || top.value === "wild_draw4")
      idx = ((idx - s.direction) % n + n) % n;
    if (top.value === "reverse" && n === 2)
      idx = ((idx - s.direction) % n + n) % n;
    return s.playerIds[idx]!;
  }

  // ── Settlement ──────────────────────────────────────────────────── L3_邏輯安防

  private settle(reason: SettlementReason, forfeitPlayerId?: PlayerId): SettlementResult {
    const { s } = this;
    s.phase = "settled";

    const pointsByPlayer: Record<PlayerId, number> = {};
    for (const pid of s.playerIds) {
      const hand = s.hands.get(pid) ?? [];
      pointsByPlayer[pid] = hand.reduce((sum, c) => sum + unoCardPoints(c), 0);
    }

    let winnerId: PlayerId;
    if (reason === "lastCardPlayed") {
      winnerId = s.winnerId!;
    } else if (forfeitPlayerId) {
      // Forfeit player ranked last; lowest-point opponent wins.
      const candidates = s.playerIds.filter(p => p !== forfeitPlayerId);
      candidates.sort((a, b) => pointsByPlayer[a]! - pointsByPlayer[b]!);
      winnerId = candidates[0]!;
    } else {
      // Generic timeout / disconnect: lowest hand-points wins.
      const sorted = [...s.playerIds].sort((a, b) => pointsByPlayer[a]! - pointsByPlayer[b]!);
      winnerId = sorted[0]!;
    }

    // Conservation: scoreDelta sums to 0.
    // Winner gains the sum of all losers' hand points; each loser pays
    // their own hand points. Forfeit takes a +50 floor penalty on top.
    const FORFEIT_PENALTY = 50;
    const deltas: Record<PlayerId, number> = {};
    let pot = 0;
    for (const pid of s.playerIds) {
      if (pid === winnerId) continue;
      const base = pointsByPlayer[pid]! + (pid === forfeitPlayerId ? FORFEIT_PENALTY : 0);
      deltas[pid] = -base;
      pot += base;
    }
    deltas[winnerId] = pot;

    // Build players[] sorted: winner first, then by hand points ascending.
    const ordered = [
      winnerId,
      ...s.playerIds
        .filter(p => p !== winnerId)
        .sort((a, b) => pointsByPlayer[a]! - pointsByPlayer[b]!),
    ];
    const players: PlayerSettlement[] = ordered.map((pid, i) => ({
      playerId:       pid,
      finalRank:      i + 1,
      remainingCards: [],          // Card[] type; Uno hand is not Card. unoDetail carries the data.
      scoreDelta:     deltas[pid] ?? 0,
    }));

    return {
      gameId:     s.gameId,
      roundId:    s.roundId,
      finishedAt: Date.now(),
      reason,
      players,
      winnerId,
      unoDetail:  { pointsByPlayer } satisfies UnoSettlementDetail,
    };
  }

  // ── Snapshot / restore ──────────────────────────────────────────── L3_架構含防禦觀測

  snapshot(): UnoSnapshot {
    const { s } = this;
    return {
      gameId: s.gameId,
      roundId: s.roundId,
      phase: s.phase,
      playerIds: s.playerIds,
      hands: [...s.hands.entries()],
      drawPile: [...s.drawPile],
      discardPile: [...s.discardPile],
      currentColor: s.currentColor,
      direction: s.direction,
      turnIndex: s.turnIndex,
      hasDrawn: s.hasDrawn,
      pendingDraw: s.pendingDraw,
      turnDeadlineMs: s.turnDeadlineMs,
      winnerId: s.winnerId,
    };
  }

  static restore(snap: UnoSnapshot): UnoStateMachine {
    const m = Object.create(UnoStateMachine.prototype) as UnoStateMachine;
    (m as unknown as { s: InternalState }).s = {
      gameId: snap.gameId,
      roundId: snap.roundId,
      phase: snap.phase,
      playerIds: snap.playerIds,
      hands: new Map(snap.hands),
      drawPile: snap.drawPile,
      discardPile: snap.discardPile,
      currentColor: snap.currentColor,
      direction: snap.direction,
      turnIndex: snap.turnIndex,
      hasDrawn: snap.hasDrawn,
      pendingDraw: snap.pendingDraw,
      turnDeadlineMs: snap.turnDeadlineMs,
      winnerId: snap.winnerId,
    };
    return m;
  }
}

function describe(c: { color?: UnoColor; value: UnoValue }): string {
  return `${c.color ?? "wild"}/${c.value}`;
}
