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
} from "../types/game";

// ──────────────────────────────────────────────
//  統一介面  (L3_架構)
// ──────────────────────────────────────────────

export interface ProcessOutcome {
  settlement: SettlementResult | null;
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
      return { settlement: r.settlement ?? null };
    }
    const action = getBigTwoBotAction(view, view.self.hand);
    const r = this.m.processAction(playerId, action);
    return { settlement: r.settlement ?? null };
  }
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
      return { settlement: r.settlement ?? null };
    }
    // 兜底：直接丟手牌第一張
    const r = this.m.process(playerId, { type: "discard", tile: hand[0]! });
    if (!r.ok) throw new Error(r.error);
    return { settlement: r.settlement ?? null };
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
    return { settlement: r.settlement ?? null };
  }
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
}

export function createEngine(opts: CreateEngineOptions): IGameEngine {
  switch (opts.gameType) {
    case "bigTwo":
      return new BigTwoEngine(new BigTwoStateMachine(opts.gameId, opts.roundId, opts.playerIds));
    case "mahjong":
      return new MahjongEngine(new MahjongStateMachine(opts.gameId, opts.roundId, opts.playerIds));
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
  }
}
