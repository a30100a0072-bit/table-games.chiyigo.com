// Shared game types — mirrored from src/types/game.ts (no CF-specific APIs).

export type GameType = "bigTwo" | "mahjong" | "texas";

export const GAME_TYPES: readonly GameType[] = ["bigTwo", "mahjong", "texas"] as const;
export const GAME_LABEL: Record<GameType, string> = {
  bigTwo:  "大老二",
  mahjong: "台灣 16 張麻將",
  texas:   "德州撲克",
};

// ─── Big Two ─────────────────────────────────────────────────────────────────
export type Suit = "spades" | "hearts" | "clubs" | "diamonds";
export type Rank = "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K" | "A" | "2";
export type PlayerId = string;

export interface Card { suit: Suit; rank: Rank; }

export type ComboType =
  | "single" | "pair" | "triple"
  | "straight" | "flush" | "fullHouse" | "fourOfAKind" | "straightFlush";

export interface PlayAction  { type: "play"; cards: Card[]; combo: ComboType; }
export interface PassAction  { type: "pass"; }

export interface SelfView     { playerId: PlayerId; hand: Card[]; cardCount: number; }
export interface OpponentView { playerId: PlayerId; cardCount: number; }
export interface LastPlay     { playerId: PlayerId; cards: Card[]; combo: ComboType; }
export type RoundPhase = "waiting" | "playing" | "settled";

export interface GameStateView {
  gameId:         string;
  roundId:        string;
  phase:          RoundPhase;
  self:           SelfView;
  opponents:      OpponentView[];
  currentTurn:    PlayerId;
  lastPlay:       LastPlay | null;
  passCount:      number;
  turnDeadlineMs: number;
}

// ─── Mahjong ─────────────────────────────────────────────────────────────────
export type MahjongSuit = "m" | "p" | "s" | "z";
export interface MahjongTile { suit: MahjongSuit; rank: number; }

export type MeldKind = "chow" | "pong" | "kong_exposed" | "kong_concealed";
export interface ExposedMeld {
  kind: MeldKind;
  tiles: MahjongTile[];
  fromPlayerId?: PlayerId;
}

export type MahjongPhase = "dealing" | "playing" | "pending_reactions" | "settled";

export interface MahjongSelfView {
  playerId: PlayerId;
  hand: MahjongTile[];
  exposed: ExposedMeld[];
  flowers: MahjongTile[];
}
export interface MahjongOpponentView {
  playerId: PlayerId;
  handCount: number;
  exposed: ExposedMeld[];
  flowersCount: number;
}
export interface MahjongLastDiscard { playerId: PlayerId; tile: MahjongTile; }

export interface MahjongStateView {
  gameId: string;
  roundId: string;
  phase: MahjongPhase;
  self: MahjongSelfView;
  opponents: MahjongOpponentView[];
  wall: { remaining: number };
  currentTurn: PlayerId;
  lastDiscard: MahjongLastDiscard | null;
  awaitingReactionsFrom: PlayerId[];
  reactionDeadlineMs: number;
  turnDeadlineMs: number;
}

export interface MahjongDiscardAction { type: "discard"; tile: MahjongTile; }
export interface MahjongChowAction    { type: "chow"; tiles: [MahjongTile, MahjongTile, MahjongTile]; }
export interface MahjongPongAction    { type: "pong"; tile: MahjongTile; }
export interface MahjongKongAction    { type: "kong"; tile: MahjongTile; source: "exposed" | "concealed" | "added"; }
export interface MahjongHuAction      { type: "hu"; selfDrawn: boolean; }
export interface MahjongPassAction    { type: "mj_pass"; }

// ─── Texas Hold'em ───────────────────────────────────────────────────────────
export type PokerStreet = "preflop" | "flop" | "turn" | "river" | "showdown" | "settled";

export interface Pot { amount: number; eligiblePlayerIds: PlayerId[]; }

export interface PokerSelfView {
  playerId: PlayerId;
  holeCards: [Card, Card];
  stack: number;
  betThisStreet: number;
  totalCommitted: number;
  hasFolded: boolean;
  isAllIn: boolean;
}
export interface PokerOpponentView {
  playerId: PlayerId;
  stack: number;
  betThisStreet: number;
  totalCommitted: number;
  hasFolded: boolean;
  isAllIn: boolean;
}
export interface PokerStateView {
  gameId: string;
  roundId: string;
  street: PokerStreet;
  self: PokerSelfView;
  opponents: PokerOpponentView[];
  communityCards: Card[];
  pots: Pot[];
  currentBet: number;
  minRaise: number;
  bigBlind: number;
  smallBlind: number;
  dealerIdx: number;
  currentTurn: PlayerId;
  turnDeadlineMs: number;
}

export interface PokerFoldAction  { type: "fold"; }
export interface PokerCheckAction { type: "check"; }
export interface PokerCallAction  { type: "call"; }
export interface PokerRaiseAction { type: "raise"; raiseAmount: number; }

// ─── Unified PlayerAction (matches backend) ──────────────────────────────────
export type PlayerAction =
  | PlayAction | PassAction
  | MahjongDiscardAction | MahjongChowAction | MahjongPongAction
  | MahjongKongAction | MahjongHuAction | MahjongPassAction
  | PokerFoldAction | PokerCheckAction | PokerCallAction | PokerRaiseAction;

// ─── Settlement (shared) ─────────────────────────────────────────────────────
export type SettlementReason = "lastCardPlayed" | "timeout" | "disconnect";
export interface PlayerSettlement {
  playerId:       PlayerId;
  finalRank:      number;
  remainingCards: Card[];
  scoreDelta:     number;
}
export interface SettlementResult {
  gameId:      string;
  roundId:     string;
  finishedAt:  number;
  reason:      SettlementReason;
  players:     PlayerSettlement[];
  winnerId:    PlayerId;
}

// ─── Discriminated union for any state-view payload ──────────────────────────
export type AnyStateView = GameStateView | MahjongStateView | PokerStateView;
