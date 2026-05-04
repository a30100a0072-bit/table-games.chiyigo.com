// /src/game/GameEngineAdapter.ts
// 三款遊戲的統一適配層 — DO 只透過 IGameEngine 介面操作，與具體狀態機解耦。   // L2_模組
// processAction 介面語義：違法動作必須 throw Error，落地交由 DO 接收回傳錯誤。 // L3_架構含防禦觀測

import { BigTwoStateMachine } from "./BigTwoStateMachine";
import type { MachineSnapshot } from "./BigTwoStateMachine";
import { MahjongStateMachine } from "./MahjongStateMachine";
import type { MahjongSnapshot } from "./MahjongStateMachine";
import { TexasHoldemStateMachine } from "./TexasHoldemStateMachine";
import type { TexasSnapshot } from "./TexasHoldemStateMachine";
import { getBigTwoBotAction, getMahjongBotAction } from "./BotAI";

import type {
  GameType, PlayerId, PlayerAction, SettlementResult, SettlementReason,
  GameStateView, MahjongStateView, PokerStateView,
} from "../types/game";

/** Sentinel playerId used in spectator views — guaranteed not collidable
 *  with real player ids since user-supplied ids never start with `__`.   */
export const SPECTATOR_PLAYER_ID = "__SPECTATOR__";

/** Bumped whenever a state-machine algorithm changes in a way that
 *  would make an existing snapshot+events sequence diverge on replay
 *  (mahjong fan calc, texas side-pot rules, big two combo ordering).
 *  Replays stamped with an older version still surface the final
 *  settlement, but the client refuses to step through the action list.   */
export const ENGINE_VERSION = 3;

// ──────────────────────────────────────────────
//  統一介面  (L3_架構)
// ──────────────────────────────────────────────

export interface ProcessOutcome {
  settlement: SettlementResult | null;
  /** Set by `autoActionOnTimeout` so the DO can append the actual
   *  action to the replay log. Undefined for explicit `processAction`
   *  calls (the DO already knows the action it passed in).             // L3_架構 */
  appliedAction?: PlayerAction;
}

/**
 * 統一引擎介面：所有遊戲狀態機必須能被 DO 以同一組方法操作。
 * 視角型別在介面層用 `unknown` —— DO 只負責序列化，不解析內容。               // L2_隔離
 */
export interface IGameEngine {
  readonly gameType: GameType;

  /** 違法動作必須 throw（語義與既有 BigTwo `processAction` 一致）。           // L3_邏輯安防 */
  processAction(playerId: PlayerId, action: PlayerAction): ProcessOutcome;

  /** 該玩家的隔離視角；DO 直接透傳給對應 WebSocket。                          // L2_隔離 */
  getView(playerId: PlayerId): unknown;

  /** Spectator view: self is phantom (no hand / no holeCards / no flowers),
   *  every real seat appears as an opponent. DO sends this to read-only
   *  spectator WebSockets.                                                     // L2_隔離 */
  getSpectatorView(): unknown;

  /** Hibernation 持久化快照；型別為 `unknown` 由各實作自我描述。              // L3_架構含防禦觀測 */
  snapshot(): unknown;

  /** 當前行動者 — 用於 turn alarm / Bot 排程。                                // L3_架構含防禦觀測 */
  currentTurn(): PlayerId;

  /** 強制結算（timeout / disconnect）。傳 forfeitPlayerId 將其視為棄局者，
   *  該玩家扣固定罰款、其餘玩家平分。不傳 = 全員退池。                        // L3_架構含防禦觀測 */
  forceSettle(reason: SettlementReason, forfeitPlayerId?: PlayerId): SettlementResult;

  /**
   * Mahjong-only: when reactionDeadlineMs expires, mark all unresolved reactions
   * as pass and commit the highest-priority one. No-op for other engines.    // L3_架構含防禦觀測
   */
  tickReactionDeadline(): ProcessOutcome;

  /**
   * Auto-action when a player's turn timer expires. Keeps the game flowing
   * instead of force-settling: BigTwo passes (or leads minimum), Mahjong
   * discards the just-drawn tile (or most isolated tile), Texas folds.
   * Returns a ProcessOutcome — the DO handles the settlement if any.        // L3_架構含防禦觀測
   */
  autoActionOnTimeout(playerId: PlayerId): ProcessOutcome;

  /** Multi-hand only: advance to the next hand after a non-final settlement.
   *  Engines without multi-hand support throw `MULTIHAND_NOT_SUPPORTED`.
   *  Caller passes the next hand's distinct gameId/roundId so the chip
   *  ledger's UNIQUE(player_id, game_id, reason) doesn't collapse.
   *  Caller must observe `settlement.matchOver === false` first.            // L3_架構含防禦觀測 */
  startNextHand(prevWinnerId: PlayerId | null, isDraw: boolean, nextGameId?: string, nextRoundId?: string): void;
}

// ──────────────────────────────────────────────
//  Big Two Adapter
// ──────────────────────────────────────────────

class BigTwoEngine implements IGameEngine {
  readonly gameType: GameType = "bigTwo";
  private m: BigTwoStateMachine;
  constructor(m: BigTwoStateMachine) { this.m = m; }

  processAction(playerId: PlayerId, action: PlayerAction): ProcessOutcome {
    // Big Two 只接 PlayAction / PassAction；其它型別在此被拒。                 // L3_邏輯安防
    if (action.type !== "play" && action.type !== "pass")
      throw new Error("illegal action type for bigTwo");
    const r = this.m.processAction(playerId, action);
    return { settlement: r.settlement ?? null };
  }
  getView(playerId: PlayerId)             { return this.m.getView(playerId); }
  getSpectatorView(): GameStateView {
    const ids   = (this.m.snapshot() as MachineSnapshot).playerIds;
    const seat  = this.m.getView(ids[0]!);
    return {
      ...seat,
      self: { playerId: SPECTATOR_PLAYER_ID, hand: [], cardCount: 0 },
      opponents: [
        { playerId: seat.self.playerId, cardCount: seat.self.cardCount },
        ...seat.opponents,
      ],
    };
  }
  snapshot()                              { return this.m.snapshot(); }
  currentTurn(): PlayerId                 {
    // Big Two 視角的 currentTurn 對所有玩家相同；隨手取首位查詢即可。         // L2_模組
    const ids = (this.m.snapshot() as MachineSnapshot).playerIds;
    return this.m.getView(ids[0]!).currentTurn;
  }
  forceSettle(reason: SettlementReason, _forfeitPlayerId?: PlayerId): SettlementResult {
    if (reason === "lastCardPlayed") throw new Error("invalid forceSettle reason");
    // Big Two 既有結算邏輯已用「剩餘手牌張數」當 scoreDelta，棄局者本來就會
    // 因為手裡牌多而扣多分，無需額外 penalty；忽略 forfeitPlayerId 參數。     // L2_實作
    return this.m.forceSettle(reason);
  }
  tickReactionDeadline(): ProcessOutcome { return { settlement: null }; }     // bigTwo no-op

  // BigTwo timeout 自動動作：能 pass 就 pass，否則用 BotAI 替他出牌。       // L2_實作
  // 開局 (isFirstTurn) 與 lead phase (lastPlay === null) 不能 pass。         // L2_實作
  autoActionOnTimeout(playerId: PlayerId): ProcessOutcome {
    const snap = this.m.snapshot() as MachineSnapshot;
    const view = this.m.getView(playerId);
    const canPass = view.lastPlay !== null && !snap.isFirstTurn;
    if (canPass) {
      const r = this.m.processAction(playerId, { type: "pass" });
      return { settlement: r.settlement ?? null, appliedAction: { type: "pass" } };
    }
    const action = getBigTwoBotAction(view, view.self.hand);
    const r = this.m.processAction(playerId, action);
    return { settlement: r.settlement ?? null, appliedAction: action };
  }
  startNextHand(): void { throw new Error("MULTIHAND_NOT_SUPPORTED"); }
}

// ──────────────────────────────────────────────
//  Mahjong Adapter
// ──────────────────────────────────────────────

class MahjongEngine implements IGameEngine {
  readonly gameType: GameType = "mahjong";
  private m: MahjongStateMachine;
  constructor(m: MahjongStateMachine) { this.m = m; }

  processAction(playerId: PlayerId, action: PlayerAction): ProcessOutcome {
    const t = action.type;
    if (t !== "discard" && t !== "chow" && t !== "pong" && t !== "kong" && t !== "hu" && t !== "mj_pass")
      throw new Error("illegal action type for mahjong");
    const r = this.m.process(playerId, action);
    if (!r.ok) throw new Error(r.error);                                       // L3_邏輯安防
    return { settlement: r.settlement ?? null };
  }
  getView(playerId: PlayerId)             { return this.m.viewFor(playerId); }
  getSpectatorView(): MahjongStateView {
    const snap = this.m.snapshot() as MahjongSnapshot;
    const seat = this.m.viewFor(snap.players[0]!.playerId);
    return {
      ...seat,
      self: {
        playerId: SPECTATOR_PLAYER_ID,
        hand: [], exposed: [], flowers: [],
        shanten: 10, winningTiles: [],
      },
      opponents: [
        {
          playerId: seat.self.playerId,
          handCount: seat.self.hand.length,
          exposed: seat.self.exposed,
          flowersCount: seat.self.flowers.length,
        },
        ...seat.opponents,
      ],
    };
  }
  snapshot()                              { return this.m.snapshot(); }
  currentTurn(): PlayerId                 { return this.m.currentTurn(); }
  forceSettle(reason: SettlementReason, forfeitPlayerId?: PlayerId): SettlementResult {
    if (reason === "lastCardPlayed") throw new Error("invalid forceSettle reason");
    return this.m.forceSettle(reason, forfeitPlayerId);
  }
  tickReactionDeadline(): ProcessOutcome {
    const r = this.m.forceResolveReactions();
    if (!r.ok) throw new Error(r.error);                                       // L3_邏輯安防
    return { settlement: r.settlement ?? null };
  }

  // Mahjong timeout 自動動作：在 playing phase 從手牌中挑最孤立的牌打出。   // L2_實作
  // pending_reactions 已由 tickReactionDeadline 處理，這裡只處理 playing。   // L2_實作
  autoActionOnTimeout(playerId: PlayerId): ProcessOutcome {
    const view = this.m.viewFor(playerId);
    if (view.phase !== "playing" || view.currentTurn !== playerId) {
      return { settlement: null };
    }
    const hand = view.self.hand;
    if (hand.length === 0) return { settlement: null };
    // 用 BotAI 的同款啟發式挑最該丟的牌（孤字優先）
    const action = getMahjongBotAction(view);
    if (action.type === "discard" || action.type === "hu") {
      const r = this.m.process(playerId, action);
      if (!r.ok) throw new Error(r.error);
      return { settlement: r.settlement ?? null, appliedAction: action };
    }
    // 兜底：直接丟手牌第一張
    const fallback = { type: "discard" as const, tile: hand[0]! };
    const r = this.m.process(playerId, fallback);
    if (!r.ok) throw new Error(r.error);
    return { settlement: r.settlement ?? null, appliedAction: fallback };
  }
  startNextHand(prevWinnerId: PlayerId | null, isDraw: boolean, nextGameId?: string, nextRoundId?: string): void {
    const snap = this.m.snapshot() as MahjongSnapshot;
    const winnerIdx = prevWinnerId
      ? snap.players.findIndex(p => p.playerId === prevWinnerId)
      : null;
    this.m.startNextHand(winnerIdx === -1 ? null : winnerIdx, isDraw, nextGameId, nextRoundId);
  }
}

// ──────────────────────────────────────────────
//  Texas Hold'em Adapter
// ──────────────────────────────────────────────

class TexasEngine implements IGameEngine {
  readonly gameType: GameType = "texas";
  private m: TexasHoldemStateMachine;
  constructor(m: TexasHoldemStateMachine) { this.m = m; }

  processAction(playerId: PlayerId, action: PlayerAction): ProcessOutcome {
    const t = action.type;
    if (t !== "fold" && t !== "check" && t !== "call" && t !== "raise")
      throw new Error("illegal action type for texas");
    const r = this.m.process(playerId, action);
    if (!r.ok) throw new Error(r.error);                                       // L3_邏輯安防
    return { settlement: r.settlement ?? null };
  }
  getView(playerId: PlayerId)             { return this.m.viewFor(playerId); }
  getSpectatorView(): PokerStateView {
    const snap = this.m.snapshot() as TexasSnapshot;
    const seat = this.m.viewFor(snap.seats[0]!.playerId);
    const isShowdown = seat.street === "showdown" || seat.street === "settled";
    return {
      ...seat,
      // Phantom self with empty hole cards. The zero-stack / zero-bet
      // values keep the wire shape stable; UI keys off SPECTATOR_PLAYER_ID.
      self: {
        playerId: SPECTATOR_PLAYER_ID,
        holeCards: [{ suit: "spades", rank: "2" }, { suit: "spades", rank: "2" }],
        stack: 0, betThisStreet: 0, totalCommitted: 0,
        hasFolded: false, isAllIn: false,
        seatIdx: -1,                 // phantom — not a real seat
      },
      opponents: [
        {
          playerId: seat.self.playerId,
          stack: seat.self.stack,
          betThisStreet: seat.self.betThisStreet,
          totalCommitted: seat.self.totalCommitted,
          hasFolded: seat.self.hasFolded,
          isAllIn: seat.self.isAllIn,
          ...(isShowdown && !seat.self.hasFolded ? { holeCards: seat.self.holeCards } : {}),
        },
        ...seat.opponents,
      ],
    };
  }
  snapshot()                              { return this.m.snapshot(); }
  currentTurn(): PlayerId                 { return this.m.currentTurn(); }
  forceSettle(reason: SettlementReason, forfeitPlayerId?: PlayerId): SettlementResult {
    if (reason === "lastCardPlayed") throw new Error("invalid forceSettle reason");
    return this.m.forceSettle(reason, forfeitPlayerId);
  }
  tickReactionDeadline(): ProcessOutcome { return { settlement: null }; }     // texas no-op

  // Texas timeout 自動動作：直接 fold。比 forceSettle 整局溫和，玩家只賠
  // 已下的盲注/跟注，棄牌後遊戲繼續。                                       // L2_實作
  autoActionOnTimeout(playerId: PlayerId): ProcessOutcome {
    const r = this.m.process(playerId, { type: "fold" });
    if (!r.ok) throw new Error(r.error);
    return { settlement: r.settlement ?? null, appliedAction: { type: "fold" } };
  }
  startNextHand(): void { throw new Error("MULTIHAND_NOT_SUPPORTED"); }
}

// ──────────────────────────────────────────────
//  Factory + Restore
// ──────────────────────────────────────────────

export interface CreateEngineOptions {
  gameType: GameType;
  gameId: string;
  roundId: string;
  playerIds: PlayerId[];
  /** Texas 專用 — 預設 SB=10 / BB=20。                                       // L2_實作 */
  smallBlind?: number;
  bigBlind?: number;
  /** Texas 專用 — 預設每人 1000 籌碼。                                       // L2_實作 */
  startingStack?: number;
  /** Mahjong 專用 — 連莊 N 局（預設 1 = 單局）。                              // L2_實作 */
  mahjongTargetHands?: number;
}

export function createEngine(opts: CreateEngineOptions): IGameEngine {
  switch (opts.gameType) {
    case "bigTwo":
      return new BigTwoEngine(new BigTwoStateMachine(opts.gameId, opts.roundId, opts.playerIds));
    case "mahjong":
      return new MahjongEngine(new MahjongStateMachine(
        opts.gameId, opts.roundId, opts.playerIds, undefined, opts.mahjongTargetHands ?? 1,
      ));
    case "texas": {
      const sb    = opts.smallBlind   ?? 10;
      const bb    = opts.bigBlind     ?? 20;
      const stack = opts.startingStack ?? 1000;
      return new TexasEngine(new TexasHoldemStateMachine(
        opts.gameId, opts.roundId,
        opts.playerIds.map(pid => ({ playerId: pid, stack })),
        sb, bb,
      ));
    }
    // uno / yahtzee 已在 GameType union 中佔位（PR 1 infra），尚未實作引擎；
    // GAME_TYPES 不會暴露這兩款給 UI，因此正常路徑不會走到這裡。           // L2_隔離
    case "uno":
    case "yahtzee":
      throw new Error(`Engine not implemented yet for gameType: ${opts.gameType}`);
  }
}

export function restoreEngine(gameType: GameType, snap: unknown): IGameEngine {
  switch (gameType) {
    case "bigTwo":
      return new BigTwoEngine(BigTwoStateMachine.restore(snap as MachineSnapshot));
    case "mahjong":
      return new MahjongEngine(MahjongStateMachine.restore(snap as MahjongSnapshot));
    case "texas":
      return new TexasEngine(TexasHoldemStateMachine.restore(snap as TexasSnapshot));
    case "uno":
    case "yahtzee":
      throw new Error(`restoreEngine not implemented yet for gameType: ${gameType}`);
  }
}
