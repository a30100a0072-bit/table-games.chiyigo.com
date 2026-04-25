// /src/types/game.ts

// ──────────────────────────────────────────────
//  Primitives
// ──────────────────────────────────────────────

export type Suit = "spades" | "hearts" | "clubs" | "diamonds";
export type Rank = "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K" | "A" | "2";

export interface Card {
  suit: Suit;
  rank: Rank;
}

export type PlayerId = string; // Durable Object id or CF session id

// ──────────────────────────────────────────────
//  1. PlayerAction  (L2_實作)
// ──────────────────────────────────────────────

/** 合法出牌組合型別 */
export type ComboType =
  | "single"
  | "pair"
  | "triple"
  | "straight"       // 5 張順子
  | "flush"
  | "fullHouse"
  | "fourOfAKind"
  | "straightFlush";

export interface PlayAction {
  type: "play";
  cards: Card[];          // 必須非空，且符合 ComboType // L2_實作
  combo: ComboType;       // client 宣告，server 仍需驗證  // L2_實作
}

export interface PassAction {
  type: "pass";           // 無牌可出或選擇 Pass           // L2_實作
}

/** 玩家送往 Worker 的動作意圖聯合型別 */
export type PlayerAction = PlayAction | PassAction;

/** WebSocket 訊框包裝 */
export interface ActionFrame {
  gameId: string;
  playerId: PlayerId;
  seq: number;            // 單調遞增，防重送                // L2_鎖定
  action: PlayerAction;
}

// ──────────────────────────────────────────────
//  2. GameStateView  (L2_隔離)
// ──────────────────────────────────────────────

/**
 * 廣播給單一 Client 的視角快照。
 * 本人底牌完整暴露；對手僅暴露剩餘張數，不含牌面。  // L2_隔離
 */

export interface SelfView {
  playerId: PlayerId;
  hand: Card[];           // 本人完整手牌                   // L2_隔離
  cardCount: number;      // hand.length，方便渲染
}

export interface OpponentView {
  playerId: PlayerId;
  cardCount: number;      // 隱藏牌面，只暴露張數           // L2_隔離
  // hand 故意不存在，TS 型別層強制隔離                      // L2_隔離
}

export interface LastPlay {
  playerId: PlayerId;
  cards: Card[];
  combo: ComboType;
}

export type RoundPhase = "waiting" | "playing" | "settled";

export interface GameStateView {
  gameId: string;
  roundId: string;
  phase: RoundPhase;

  self: SelfView;                       // 接收者本人視角    // L2_隔離
  opponents: OpponentView[];            // 對手遮蔽視角      // L2_隔離

  currentTurn: PlayerId;                // 當前行動者
  lastPlay: LastPlay | null;            // 桌面最後一手牌，null 表示新輪
  passCount: number;                    // 本輪連續 Pass 次數
  turnDeadlineMs: number;               // Unix ms，倒數計時鎖定 // L2_鎖定
}

// ──────────────────────────────────────────────
//  3. SettlementResult  (L2_鎖定)
// ──────────────────────────────────────────────

export type SettlementReason =
  | "lastCardPlayed"    // 正常出完
  | "timeout"           // 超時判負
  | "disconnect";       // 斷線判負

export interface PlayerSettlement {
  playerId: PlayerId;
  finalRank: number;      // 1 = 冠軍，依序遞增              // L2_鎖定
  remainingCards: Card[]; // 結算時手中剩餘，供算分         // L2_鎖定
  scoreDelta: number;     // 正=得分，負=扣分               // L2_鎖定
}

/** 推入 Cloudflare D1 Queue 的結算事件 */
export interface SettlementResult {
  gameId: string;
  roundId: string;
  finishedAt: number;           // Unix ms                  // L2_鎖定
  reason: SettlementReason;
  players: PlayerSettlement[];  // 固定長度 = 房間人數       // L2_鎖定
  winnerId: PlayerId;
}

/** D1 Queue 訊息包裝，對應 Cloudflare Queue Producer 格式 */
export interface SettlementQueueMessage {
  type: "settlement";
  payload: SettlementResult;    // JSON 序列化後推入          // L2_鎖定
}
