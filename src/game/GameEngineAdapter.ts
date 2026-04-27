// /src/game/GameEngineAdapter.ts
// 三款遊戲的統一適配層 — DO 只透過 IGameEngine 介面操作，與具體狀態機解耦。   // L2_模組
// processAction 介面語義：違法動作必須 throw Error，落地交由 DO 接收回傳錯誤。 // L3_架構含防禦觀測

import { BigTwoStateMachine } from "./BigTwoStateMachine";
import type { MachineSnapshot } from "./BigTwoStateMachine";
import { MahjongStateMachine } from "./MahjongStateMachine";
import type { MahjongSnapshot } from "./MahjongStateMachine";
import { TexasHoldemStateMachine } from "./TexasHoldemStateMachine";
import type { TexasSnapshot } from "./TexasHoldemStateMachine";

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

  /** 強制結算（timeout / disconnect）。                                       // L3_架構含防禦觀測 */
  forceSettle(reason: SettlementReason): SettlementResult;

  /**
   * Mahjong-only: when reactionDeadlineMs expires, mark all unresolved reactions
   * as pass and commit the highest-priority one. No-op for other engines.    // L3_架構含防禦觀測
   */
  tickReactionDeadline(): ProcessOutcome;
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
  forceSettle(reason: SettlementReason): SettlementResult {
    if (reason === "lastCardPlayed") throw new Error("invalid forceSettle reason");
    return this.m.forceSettle(reason);
  }
  tickReactionDeadline(): ProcessOutcome { return { settlement: null }; }     // bigTwo no-op
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
  forceSettle(reason: SettlementReason): SettlementResult {
    if (reason === "lastCardPlayed") throw new Error("invalid forceSettle reason");
    return this.m.forceSettle(reason);
  }
  tickReactionDeadline(): ProcessOutcome {
    const r = this.m.forceResolveReactions();
    if (!r.ok) throw new Error(r.error);                                       // L3_邏輯安防
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
  forceSettle(reason: SettlementReason): SettlementResult {
    if (reason === "lastCardPlayed") throw new Error("invalid forceSettle reason");
    return this.m.forceSettle(reason);
  }
  tickReactionDeadline(): ProcessOutcome { return { settlement: null }; }     // texas no-op
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
