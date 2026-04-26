// Shared game types — mirrored from src/types/game.ts (no CF-specific APIs).

export type Suit = "spades" | "hearts" | "clubs" | "diamonds";
export type Rank = "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K" | "A" | "2";
export type PlayerId = string;

export interface Card { suit: Suit; rank: Rank; }

export type ComboType =
  | "single" | "pair" | "triple"
  | "straight" | "flush" | "fullHouse" | "fourOfAKind" | "straightFlush";

export interface PlayAction  { type: "play"; cards: Card[]; combo: ComboType; }
export interface PassAction  { type: "pass"; }
export type PlayerAction = PlayAction | PassAction;

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
