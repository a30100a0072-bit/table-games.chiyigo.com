// Shared game types — mirrored from src/types/game.ts (no CF-specific APIs).

/** Sentinel playerId used in spectator views — see backend
 *  src/game/GameEngineAdapter.ts. Frontend keys off this to switch to
 *  read-only UI when a payload arrives with self.playerId === this. */
export const SPECTATOR_PLAYER_ID = "__SPECTATOR__";

export type GameType = "bigTwo" | "mahjong" | "texas" | "uno" | "yahtzee";

export const GAME_TYPES: readonly GameType[] = ["bigTwo", "mahjong", "texas", "uno", "yahtzee"] as const;
export const GAME_LABEL: Record<GameType, string> = {
  bigTwo:  "大老二",
  mahjong: "台灣 16 張麻將",
  texas:   "德州撲克",
  uno:     "Uno",
  yahtzee: "快艇骰子",
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
export type MahjongSuit = "m" | "p" | "s" | "z" | "f";
export interface MahjongTile { suit: MahjongSuit; rank: number; }

export type MeldKind = "chow" | "pong" | "kong_exposed" | "kong_concealed";
export interface ExposedMeld {
  kind: MeldKind;
  tiles: MahjongTile[];
  fromPlayerId?: PlayerId;
}

export type MahjongPhase = "dealing" | "playing" | "pending_reactions" | "between_hands" | "settled";

export interface MahjongSelfView {
  playerId: PlayerId;
  hand: MahjongTile[];
  exposed: ExposedMeld[];
  flowers: MahjongTile[];
  shanten: number;
  winningTiles: MahjongTile[];
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
  match?: {
    handNumber: number;
    targetHands: number;
    dealerIdx: number;
    bankerStreak: number;
  };
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
  holeCards?: [Card, Card];           // 僅 showdown 階段非棄牌玩家才有
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

// ─── Uno ─────────────────────────────────────────────────────────────────────
export type UnoColor = "red" | "yellow" | "green" | "blue";
export type UnoValue =
  | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
  | "skip" | "reverse" | "draw2"
  | "wild" | "wild_draw4";

export interface UnoCard { color?: UnoColor; value: UnoValue; }

export interface UnoPlayAction {
  type: "uno_play";
  card: UnoCard;
  declaredColor?: UnoColor;
}
export interface UnoDrawAction { type: "uno_draw"; }
export interface UnoPassAction { type: "uno_pass"; }

export type UnoPhase = "playing" | "settled";

export interface UnoSelfView {
  playerId: PlayerId;
  hand: UnoCard[];
  cardCount: number;
}
export interface UnoOpponentView {
  playerId: PlayerId;
  cardCount: number;
}
export interface UnoLastPlay { playerId: PlayerId; card: UnoCard; }

export interface UnoStateView {
  gameId: string;
  roundId: string;
  phase: UnoPhase;
  self: UnoSelfView;
  opponents: UnoOpponentView[];
  topDiscard: UnoLastPlay;
  currentColor: UnoColor;
  direction: 1 | -1;
  drawPileCount: number;
  currentTurn: PlayerId;
  hasDrawn: boolean;
  pendingDraw: number;
  turnDeadlineMs: number;
}

export interface UnoSettlementDetail {
  pointsByPlayer: Record<PlayerId, number>;
}

// ─── Yahtzee ─────────────────────────────────────────────────────────────────
export type DieFace = 1 | 2 | 3 | 4 | 5 | 6;
export type DiceTuple = [DieFace, DieFace, DieFace, DieFace, DieFace];
export type HeldTuple = [boolean, boolean, boolean, boolean, boolean];

export type YahtzeeSlot =
  | "ones" | "twos" | "threes" | "fours" | "fives" | "sixes"
  | "threeKind" | "fourKind" | "fullHouse"
  | "smallStraight" | "largeStraight"
  | "yahtzee" | "chance";

export const YAHTZEE_SLOTS: readonly YahtzeeSlot[] = [
  "ones", "twos", "threes", "fours", "fives", "sixes",
  "threeKind", "fourKind", "fullHouse",
  "smallStraight", "largeStraight",
  "yahtzee", "chance",
] as const;

export type Scorecard = Record<YahtzeeSlot, number | null>;

export interface YahtzeeRollAction { type: "yz_roll"; held: HeldTuple; }
export interface YahtzeeScoreAction { type: "yz_score"; slot: YahtzeeSlot; }

export type YahtzeePhase = "rolling" | "settled";

export interface YahtzeeSelfView {
  playerId: PlayerId;
  scorecard: Scorecard;
}
export interface YahtzeeOpponentView {
  playerId: PlayerId;
  scorecard: Scorecard;
}

export interface YahtzeeStateView {
  gameId: string;
  roundId: string;
  phase: YahtzeePhase;
  self: YahtzeeSelfView;
  opponents: YahtzeeOpponentView[];
  dice: DiceTuple;
  held: HeldTuple;
  rollsLeft: 0 | 1 | 2 | 3;
  turnNumber: number;
  totalTurns: number;
  currentTurn: PlayerId;
  turnDeadlineMs: number;
}

export interface YahtzeeSettlementDetail {
  totalsByPlayer: Record<PlayerId, number>;
  upperBonusByPlayer: Record<PlayerId, number>;
  yahtzeeBonusByPlayer: Record<PlayerId, number>;
}

// ─── Unified PlayerAction (matches backend) ──────────────────────────────────
export type PlayerAction =
  | PlayAction | PassAction
  | MahjongDiscardAction | MahjongChowAction | MahjongPongAction
  | MahjongKongAction | MahjongHuAction | MahjongPassAction
  | PokerFoldAction | PokerCheckAction | PokerCallAction | PokerRaiseAction
  | UnoPlayAction | UnoDrawAction | UnoPassAction
  | YahtzeeRollAction | YahtzeeScoreAction;

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
  fanDetail?:  { fan: number; base: number; detail: string[] };
  unoDetail?:  UnoSettlementDetail;
  yahtzeeDetail?: YahtzeeSettlementDetail;
  matchOver?:  boolean;
  matchProgress?: {
    handNumber:        number;
    targetHands:       number;
    dealerIdx:         number;
    bankerStreak:      number;
    cumulativeScores?: Record<PlayerId, number>;
  };
}

// ─── Discriminated union for any state-view payload ──────────────────────────
export type AnyStateView = GameStateView | MahjongStateView | PokerStateView | UnoStateView | YahtzeeStateView;
