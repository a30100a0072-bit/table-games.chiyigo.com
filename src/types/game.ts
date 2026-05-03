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

// 三款遊戲統一識別碼，用於 Lobby 路由 / DO 初始化 / 客戶端旗標。            // L2_模組
export type GameType = "bigTwo" | "mahjong" | "texas";

export const GAME_TYPES: readonly GameType[] = ["bigTwo", "mahjong", "texas"] as const;
export function isGameType(x: unknown): x is GameType {
  return typeof x === "string" && (GAME_TYPES as readonly string[]).includes(x);
}

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

/** 玩家送往 Worker 的動作意圖聯合型別（Big Two + Mahjong + Texas Hold'em）*/
export type PlayerAction =
  | PlayAction
  | PassAction
  | MahjongDiscardAction
  | MahjongChowAction
  | MahjongPongAction
  | MahjongKongAction
  | MahjongHuAction
  | MahjongPassAction
  | PokerFoldAction
  | PokerCheckAction
  | PokerCallAction
  | PokerRaiseAction;

// ──────────────────────────────────────────────
//  1c. Texas Hold'em Action (L2_實作)
// ──────────────────────────────────────────────

export interface PokerFoldAction {
  type: "fold";                       // 棄牌                        // L2_實作
}
export interface PokerCheckAction {
  type: "check";                      // 過牌（無人加注時）          // L2_實作
}
export interface PokerCallAction {
  type: "call";                       // 跟注至當前最高注              // L2_實作
}
export interface PokerRaiseAction {
  type: "raise";
  raiseAmount: number;                // 加注後該玩家總投入該街的籌碼 // L2_鎖定
                                      // 必須 ≥ currentBet + minRaise // L2_鎖定
}

// ──────────────────────────────────────────────
//  1b. Mahjong Tile + Action  (L3_邏輯安防)
// ──────────────────────────────────────────────

/** 台灣 16 張麻將牌種 — m=萬 p=筒 s=條 z=字(1東2南3西4北5中6發7白) */
// "m"/"p"/"s" = number suits 1–9; "z" = honors 1–7 (E/S/W/N/中/發/白);
// "f" = flowers/seasons 1–8, never enter the active hand (auto-replaced).
export type MahjongSuit = "m" | "p" | "s" | "z" | "f";

export interface MahjongTile {
  suit: MahjongSuit;
  rank: number;            // m/p/s: 1–9；z: 1–7  // L2_鎖定
}

/** 海底牌 = 牌牆剩餘張數（不暴露牌面）           // L2_隔離 */
export interface WallView {
  remaining: number;
}

/** 已亮出的副露（吃碰槓）— 全 player 可見       // L2_隔離 */
export type MeldKind = "chow" | "pong" | "kong_exposed" | "kong_concealed";

export interface ExposedMeld {
  kind: MeldKind;
  tiles: MahjongTile[];
  fromPlayerId?: PlayerId; // 來源（碰/槓/吃對象）
}

export interface MahjongDiscardAction {
  type: "discard";
  tile: MahjongTile;       // 必須是手中真實存在的牌            // L2_隔離
}

export interface MahjongChowAction {
  type: "chow";
  tiles: [MahjongTile, MahjongTile, MahjongTile]; // 必含對手剛打出的牌 // L2_隔離
}

export interface MahjongPongAction {
  type: "pong";
  tile: MahjongTile;       // 對手剛打的牌；自身須有 ≥2 同牌      // L2_隔離
}

export interface MahjongKongAction {
  type: "kong";
  tile: MahjongTile;       // 明槓 / 暗槓 / 加槓 由 SM 判定        // L2_隔離
  source: "exposed" | "concealed" | "added";
}

export interface MahjongHuAction {
  type: "hu";
  selfDrawn: boolean;      // true=自摸，false=食胡(榮和)        // L3_邏輯安防
}

export interface MahjongPassAction {
  type: "mj_pass";         // 不吃不碰不胡，過水                  // L3_架構
}

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
//  2b. MahjongStateView (L2_隔離 + L3_架構)
// ──────────────────────────────────────────────

/** 等待視窗階段 — 有人打牌後收集吃碰槓胡反應             // L3_架構 */
export type MahjongPhase =
  | "dealing"
  | "playing"             // 當前回合者抽牌→打牌中
  | "pending_reactions"   // 收集其他玩家對剛打牌的反應      // L3_架構
  | "between_hands"       // 多局賽事：本局已 settle，等待下一局 startNextHand
  | "settled";

export interface MahjongSelfView {
  playerId: PlayerId;
  hand: MahjongTile[];                 // 本人完整門前清       // L2_隔離
  exposed: ExposedMeld[];              // 本人已吃碰槓
  flowers: MahjongTile[];              // 花牌（MVP 可空陣列）
  /** 離胡步數（-1 已胡 / 0 聽牌 / ≥1 距聽張數）。狀態機已替本人算好。 // L2_隔離 */
  shanten: number;
  /** 聽牌時可胡的張集合；非聽牌時為空陣列。每張只列一次。 // L2_隔離 */
  winningTiles: MahjongTile[];
}

export interface MahjongOpponentView {
  playerId: PlayerId;
  handCount: number;                   // 隱藏牌面，僅張數     // L2_隔離
  exposed: ExposedMeld[];              // 副露公開可見         // L2_隔離
  flowersCount: number;
}

export interface MahjongLastDiscard {
  playerId: PlayerId;
  tile: MahjongTile;
}

export interface MahjongStateView {
  gameId: string;
  roundId: string;
  phase: MahjongPhase;

  self: MahjongSelfView;               // 本人視角             // L2_隔離
  opponents: MahjongOpponentView[];    // 對手遮蔽視角         // L2_隔離

  wall: WallView;                      // 海底牌剩餘張數       // L2_隔離
  currentTurn: PlayerId;
  lastDiscard: MahjongLastDiscard | null;

  /** PENDING_REACTIONS 期間，列出仍待回應的玩家             // L3_架構 */
  awaitingReactionsFrom: PlayerId[];
  reactionDeadlineMs: number;          // Unix ms             // L2_鎖定
  turnDeadlineMs: number;
}

// ──────────────────────────────────────────────
//  2c. Texas Hold'em StateView (L2_隔離 + L3_邏輯安防)
// ──────────────────────────────────────────────

export type PokerStreet =
  | "preflop"
  | "flop"
  | "turn"
  | "river"
  | "showdown"
  | "settled";

/** 邊池 — 由 All-in 觸發的籌碼分層；每池僅匹配玩家可分配 // L3_糾錯風險表 */
export interface Pot {
  amount: number;
  eligiblePlayerIds: PlayerId[];       // 可爭奪此池的玩家集合     // L3_糾錯風險表
}

export interface PokerSelfView {
  playerId: PlayerId;
  holeCards: [Card, Card];             // 本人底牌，僅自己看得到   // L2_隔離
  stack: number;                       // 剩餘籌碼
  betThisStreet: number;               // 本街已下注金額
  totalCommitted: number;              // 整局已投入（用於 side pot 結算）
  hasFolded: boolean;
  isAllIn: boolean;
  seatIdx: number;                     // 本人座位索引（莊家位置以 dealerIdx 表示）
}

export interface PokerOpponentView {
  playerId: PlayerId;
  stack: number;
  betThisStreet: number;               // 公開資訊                  // L2_隔離
  totalCommitted: number;
  hasFolded: boolean;
  isAllIn: boolean;
  // 攤牌時揭示對手底牌；只在 street === "showdown" 且該玩家未棄牌
  // 時才會帶值，其他階段一律 undefined（TS 與 server 雙重把關）。  // L3_邏輯安防
  holeCards?: [Card, Card];
}

export interface PokerStateView {
  gameId: string;
  roundId: string;
  street: PokerStreet;

  self: PokerSelfView;                 // 本人視角                  // L2_隔離
  opponents: PokerOpponentView[];      // 對手遮蔽視角              // L2_隔離

  communityCards: Card[];              // 0 / 3 / 4 / 5 張公牌      // L2_實作
  pots: Pot[];                         // 主池在 [0]，邊池依序往後  // L3_糾錯風險表
  currentBet: number;                  // 本街最高注額              // L2_鎖定
  minRaise: number;                    // 下一次 raise 最小增量     // L2_鎖定
  bigBlind: number;
  smallBlind: number;

  dealerIdx: number;                   // 莊家位置
  currentTurn: PlayerId;
  turnDeadlineMs: number;              // Unix ms                   // L2_鎖定
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
  // 麻將獨有：贏家台數明細，純資訊性，前端可顯示。其他遊戲為 undefined。 // L2_實作
  fanDetail?: { fan: number; base: number; detail: string[] };
  /** 多局賽事中間局結算為 false；單局或末局為 true（預設）。DO 收到
   *  matchOver=false 時 ledger 仍照記但不 cleanup，等待下一局。           // L2_鎖定 */
  matchOver?: boolean;
  /** 連莊資訊（多局麻將）：handNumber=當前局、targetHands=總局數、
   *  bankerStreak=本任莊家連莊次數、dealerIdx=莊家座位 idx。前端顯示用。 */
  matchProgress?: {
    handNumber: number;
    targetHands: number;
    dealerIdx: number;
    bankerStreak: number;
  };
}

/** D1 Queue 訊息包裝，對應 Cloudflare Queue Producer 格式 */
export interface SettlementQueueMessage {
  type: "settlement";
  payload: SettlementResult;    // JSON 序列化後推入          // L2_鎖定
}
