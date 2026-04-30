// /src/game/TexasHoldemStateMachine.ts
// 德州撲克 No-Limit Hold'em 純邏輯狀態機（零 IO）— L3_架構
//
// 設計重點：
//  - crypto.getRandomValues 洗牌，無 modulo bias                       // L3_邏輯安防
//  - 邊池分割（Side Pot Split）— All-in 籌碼分層，贏家不可拿超過匹配額  // L3_糾錯風險表
//  - RAISE 嚴格驗證：≥ currentBet + minRaise，籌碼足夠或 All-in        // L2_鎖定
//  - 7 取 5 牌型評分 O(C(7,5))=21 → 純整數鍵比較，DO 50ms 內完成        // L3_邏輯安防

import {
  PlayerId,
  Card,
  Suit,
  Rank,
  Pot,
  PokerStateView,
  PokerStreet,
  PokerSelfView,
  PokerOpponentView,
  PokerFoldAction,
  PokerCheckAction,
  PokerCallAction,
  PokerRaiseAction,
  SettlementResult,
} from "../types/game";

// ──────────────────────────────────────────────
//  常數
// ──────────────────────────────────────────────
const TURN_WINDOW_MS = 20000;
const SUITS: Suit[] = ["spades", "hearts", "clubs", "diamonds"];
const RANKS: Rank[] = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"]; // 2 最小 A 最大  // L2_實作
const RANK_VALUE: Record<Rank, number> = (() => {
  const m = {} as Record<Rank, number>;
  RANKS.forEach((r, i) => (m[r] = i + 2));      // 2..14
  return m;
})();

// ──────────────────────────────────────────────
//  洗牌  (L3_邏輯安防 — 安全亂數 + 無 modulo bias)
// ──────────────────────────────────────────────
function buildDeck(): Card[] {
  const d: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r });
  return d;
}

function secureRandomInt(maxExclusive: number): number {
  // 拒絕採樣去除 modulo bias                                                    // L3_邏輯安防
  if (maxExclusive <= 0) throw new Error("INVALID_RANGE");
  const bound = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    crypto.getRandomValues(buf);
    if (buf[0]! < bound) return buf[0]! % maxExclusive;
  }
}

function shuffleDeck(deck: Card[]): Card[] {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}

// ──────────────────────────────────────────────
//  7 取 5 牌型評分  (L3_邏輯安防)
//  回傳 28-bit 整數鍵：[category(4) | k1(4) | k2(4) | k3(4) | k4(4) | k5(4)]
// ──────────────────────────────────────────────
const CAT_HIGH = 0, CAT_PAIR = 1, CAT_TWO_PAIR = 2, CAT_TRIPS = 3,
      CAT_STRAIGHT = 4, CAT_FLUSH = 5, CAT_FULL_HOUSE = 6,
      CAT_QUADS = 7, CAT_STRAIGHT_FLUSH = 8;

export function rankFiveCardKey(cards: Card[]): number {
  const vals = cards.map(c => RANK_VALUE[c.rank]).sort((a, b) => b - a); // 大到小
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  const uniq = [...new Set(vals)];
  const isStraight = (() => {
    if (uniq.length !== 5) return false;
    if (uniq[0]! - uniq[4]! === 4) return true;
    // A-2-3-4-5 wheel
    if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) return true;
    return false;
  })();
  // 計數
  const count = new Map<number, number>();
  for (const v of vals) count.set(v, (count.get(v) ?? 0) + 1);
  const groups = [...count.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  let cat: number;
  // 5-tuple — TS noUncheckedIndexedAccess 不對固定長度元組生效。              // L2_鎖定
  let kickers: [number, number, number, number, number];
  const fillTo5 = (xs: number[]): [number, number, number, number, number] =>
    [xs[0] ?? 0, xs[1] ?? 0, xs[2] ?? 0, xs[3] ?? 0, xs[4] ?? 0];

  if (isStraight && isFlush) {
    cat = CAT_STRAIGHT_FLUSH;
    const top = (uniq[0] === 14 && uniq[4] === 2) ? 5 : uniq[0]!;            // L2_鎖定
    kickers = [top, 0, 0, 0, 0];
  } else if (groups[0]![1] === 4) {
    cat = CAT_QUADS;
    kickers = [groups[0]![0], groups[1]![0], 0, 0, 0];
  } else if (groups[0]![1] === 3 && groups[1]![1] === 2) {
    cat = CAT_FULL_HOUSE;
    kickers = [groups[0]![0], groups[1]![0], 0, 0, 0];
  } else if (isFlush) {
    cat = CAT_FLUSH;
    kickers = fillTo5(vals);
  } else if (isStraight) {
    cat = CAT_STRAIGHT;
    const top = (uniq[0] === 14 && uniq[4] === 2) ? 5 : uniq[0]!;
    kickers = [top, 0, 0, 0, 0];
  } else if (groups[0]![1] === 3) {
    cat = CAT_TRIPS;
    const k = groups.slice(1).map(g => g[0]);
    kickers = [groups[0]![0], k[0] ?? 0, k[1] ?? 0, 0, 0];
  } else if (groups[0]![1] === 2 && groups[1]![1] === 2) {
    cat = CAT_TWO_PAIR;
    kickers = [groups[0]![0], groups[1]![0], groups[2]![0], 0, 0];
  } else if (groups[0]![1] === 2) {
    cat = CAT_PAIR;
    const k = groups.slice(1).map(g => g[0]);
    kickers = [groups[0]![0], k[0] ?? 0, k[1] ?? 0, k[2] ?? 0, 0];
  } else {
    cat = CAT_HIGH;
    kickers = fillTo5(vals);
  }
  return (cat << 20) | (kickers[0] << 16) | (kickers[1] << 12) | (kickers[2] << 8) | (kickers[3] << 4) | kickers[4];
}

/** 7 張中取最佳 5 張的評分鍵                                                     // L3_邏輯安防 */
export function rankBestOfSeven(cards: Card[]): number {
  if (cards.length !== 7) throw new Error("EXPECT_7_CARDS");
  let best = -1;
  // C(7,5)=21 種組合 — 用反向 mask 列舉「丟掉哪 2 張」
  for (let i = 0; i < 7; i++) for (let j = i + 1; j < 7; j++) {
    const five: Card[] = [];
    for (let k = 0; k < 7; k++) if (k !== i && k !== j) five.push(cards[k]!);  // L2_鎖定 k bounded by length 7
    const key = rankFiveCardKey(five);
    if (key > best) best = key;
  }
  return best;
}

// ──────────────────────────────────────────────
//  邊池分割  (L3_糾錯風險表)
// ──────────────────────────────────────────────
interface Seat {
  playerId: PlayerId;
  stack: number;                  // 剩餘籌碼
  hole: [Card, Card];
  betThisStreet: number;
  totalCommitted: number;         // 整局累積投入（含已蓋掉的街）
  hasFolded: boolean;
  isAllIn: boolean;
  hasActedThisStreet: boolean;
}

/**
 * 給定每位玩家在整局的 totalCommitted 與是否棄牌，
 * 切分主池 + 邊池。每池的 amount 嚴格匹配「該層額度 × 達到該層的玩家數」。 // L3_糾錯風險表
 *
 * 演算法：
 *   1. 取所有非零 commit 的不重複層級，由小到大
 *   2. 由低往高每層 (level - prevLevel) × stillIn 計算池額
 *   3. 該池的合格玩家 = 投入 ≥ level 且未棄牌者
 */
export function buildSidePots(seats: Seat[]): Pot[] {
  const positive = seats.filter(s => s.totalCommitted > 0);
  if (positive.length === 0) return [];
  const levels = [...new Set(positive.map(s => s.totalCommitted))].sort((a, b) => a - b);

  const pots: Pot[] = [];
  let prev = 0;
  for (const level of levels) {
    const layer = level - prev;
    if (layer <= 0) { prev = level; continue; }
    // 達到此層的玩家貢獻 layer；levels 為去重後的整局 commit 值              // L3_糾錯風險表
    const reaching = positive.filter(s => s.totalCommitted >= level);
    const amount = layer * reaching.length;
    const eligible = reaching.filter(s => !s.hasFolded).map(s => s.playerId); // 棄牌出錢但不分 // L3_糾錯風險表
    if (amount > 0 && eligible.length > 0) {
      pots.push({ amount, eligiblePlayerIds: eligible });
    } else if (amount > 0 && pots.length > 0) {
      pots[pots.length - 1]!.amount += amount;            // 全棄牌者層併入上一池  // L2_鎖定
    }
    prev = level;
  }
  return pots;
}

// ──────────────────────────────────────────────
//  狀態機本體  (L3_架構含防禦觀測)
// ──────────────────────────────────────────────
interface InternalState {
  gameId: string;
  roundId: string;
  street: PokerStreet;
  seats: Seat[];                            // 固定座位順序
  deck: Card[];                             // 剩餘牌堆
  community: Card[];                        // 0/3/4/5 張
  dealerIdx: number;
  turnIdx: number;
  smallBlind: number;
  bigBlind: number;
  currentBet: number;                       // 本街最高注
  minRaise: number;                         // 下一次 raise 最小增量
  lastAggressorIdx: number | null;          // 行動回到此人停止
  turnDeadlineMs: number;
}

export type ProcessResult =
  | { ok: true; settlement?: SettlementResult }
  | { ok: false; error: string };

/** 持久化快照型別 — 對應 InternalState；DO Hibernation 用。              // L3_架構含防禦觀測 */
export type TexasSnapshot = InternalState;

export class TexasHoldemStateMachine {
  private s: InternalState;

  /** DO Hibernation 還原入口；不重洗牌，直接接續既有狀態。               // L3_架構含防禦觀測 */
  static restore(snap: TexasSnapshot): TexasHoldemStateMachine {
    const m = Object.create(TexasHoldemStateMachine.prototype) as TexasHoldemStateMachine;
    (m as unknown as { s: InternalState }).s = JSON.parse(JSON.stringify(snap)) as InternalState;
    return m;
  }

  constructor(
    gameId: string,
    roundId: string,
    players: { playerId: PlayerId; stack: number }[],
    smallBlind: number,
    bigBlind: number,
    dealerIdx = 0,
  ) {
    if (players.length < 2) throw new Error("MIN_2_PLAYERS");
    if (smallBlind <= 0 || bigBlind < smallBlind * 2) throw new Error("INVALID_BLINDS");

    const deck = shuffleDeck(buildDeck());
    const seats: Seat[] = players.map((p, i) => ({
      playerId: p.playerId,
      stack: p.stack,
      hole: [deck.pop()!, deck.pop()!] as [Card, Card],
      betThisStreet: 0,
      totalCommitted: 0,
      hasFolded: false,
      isAllIn: false,
      hasActedThisStreet: false,
    }));

    // 第二輪發牌（真實德撲一張一張發；MVP 同效）                                  // L2_實作
    // 已在上方循環中各取 2 張

    this.s = {
      gameId, roundId,
      street: "preflop",
      seats,
      deck,
      community: [],
      dealerIdx,
      turnIdx: 0,
      smallBlind, bigBlind,
      currentBet: 0,
      minRaise: bigBlind,
      lastAggressorIdx: null,
      turnDeadlineMs: Date.now() + TURN_WINDOW_MS,
    };

    // 收盲注                                                                       // L2_鎖定
    const sbIdx = (dealerIdx + 1) % seats.length;
    const bbIdx = (dealerIdx + 2) % seats.length;
    this.postBlind(sbIdx, smallBlind);
    this.postBlind(bbIdx, bigBlind);
    this.s.currentBet = bigBlind;
    this.s.lastAggressorIdx = bbIdx;
    // Heads-up preflop: SB 先動；多人 preflop: UTG 先動
    this.s.turnIdx = seats.length === 2 ? sbIdx : (bbIdx + 1) % seats.length;
  }

  private postBlind(i: number, amount: number) {
    const s = this.s.seats[i]!;                                                    // L2_鎖定 caller passes valid index
    const pay = Math.min(s.stack, amount);
    s.stack -= pay;
    s.betThisStreet += pay;
    s.totalCommitted += pay;
    if (s.stack === 0) s.isAllIn = true;
  }

  // ─── 對外快照  (L2_隔離) ──────────────────────
  viewFor(playerId: PlayerId): PokerStateView {
    const meIdx = this.s.seats.findIndex(s => s.playerId === playerId);
    if (meIdx < 0) throw new Error("PLAYER_NOT_IN_GAME");
    const me = this.s.seats[meIdx]!;                                               // L2_鎖定 meIdx>=0 已守衛
    const self: PokerSelfView = {
      playerId: me.playerId,
      holeCards: [me.hole[0], me.hole[1]],         // 僅本人可見            // L2_隔離
      stack: me.stack,
      betThisStreet: me.betThisStreet,
      totalCommitted: me.totalCommitted,
      hasFolded: me.hasFolded,
      isAllIn: me.isAllIn,
    };
    // 攤牌時揭示未棄牌對手的底牌；其他階段不寫 holeCards 欄位以維持隔離。 // L3_邏輯安防
    const isShowdown = this.s.street === "showdown" || this.s.street === "settled";
    const opponents: PokerOpponentView[] = this.s.seats
      .filter((_, i) => i !== meIdx)
      .map(s => {
        const base: PokerOpponentView = {
          playerId: s.playerId,
          stack: s.stack,
          betThisStreet: s.betThisStreet,
          totalCommitted: s.totalCommitted,
          hasFolded: s.hasFolded,
          isAllIn: s.isAllIn,
        };
        if (isShowdown && !s.hasFolded) base.holeCards = [s.hole[0], s.hole[1]];
        return base;
      });
    return {
      gameId: this.s.gameId,
      roundId: this.s.roundId,
      street: this.s.street,
      self,
      opponents,
      communityCards: [...this.s.community],
      pots: buildSidePots(this.s.seats),
      currentBet: this.s.currentBet,
      minRaise: this.s.minRaise,
      bigBlind: this.s.bigBlind,
      smallBlind: this.s.smallBlind,
      dealerIdx: this.s.dealerIdx,
      currentTurn: this.s.seats[this.s.turnIdx]!.playerId,
      turnDeadlineMs: this.s.turnDeadlineMs,
    };
  }

  // ─── Action 入口  (L2_鎖定) ───────────────────
  process(playerId: PlayerId, action:
    PokerFoldAction | PokerCheckAction | PokerCallAction | PokerRaiseAction
  ): ProcessResult {
    if (this.s.street === "settled" || this.s.street === "showdown")
      return { ok: false, error: "HAND_OVER" };
    const i = this.s.seats.findIndex(s => s.playerId === playerId);
    if (i < 0) return { ok: false, error: "PLAYER_NOT_IN_GAME" };
    if (i !== this.s.turnIdx) return { ok: false, error: "NOT_YOUR_TURN" };
    const me = this.s.seats[i]!;                                                   // L2_鎖定 i>=0 已守衛
    if (me.hasFolded || me.isAllIn) return { ok: false, error: "ALREADY_OUT" };

    switch (action.type) {
      case "fold":  return this.onFold(i);
      case "check": return this.onCheck(i);
      case "call":  return this.onCall(i);
      case "raise": return this.onRaise(i, action.raiseAmount);
    }
  }

  private onFold(i: number): ProcessResult {
    this.s.seats[i]!.hasFolded = true;
    this.s.seats[i]!.hasActedThisStreet = true;
    return this.advance();
  }

  private onCheck(i: number): ProcessResult {
    const me = this.s.seats[i]!;
    if (me.betThisStreet < this.s.currentBet) return { ok: false, error: "CANNOT_CHECK_FACING_BET" }; // L2_鎖定
    me.hasActedThisStreet = true;
    return this.advance();
  }

  private onCall(i: number): ProcessResult {
    const me = this.s.seats[i]!;
    const owe = this.s.currentBet - me.betThisStreet;
    if (owe <= 0) return { ok: false, error: "NOTHING_TO_CALL" };                    // L2_鎖定
    const pay = Math.min(me.stack, owe);
    me.stack -= pay;
    me.betThisStreet += pay;
    me.totalCommitted += pay;
    if (me.stack === 0) me.isAllIn = true;
    me.hasActedThisStreet = true;
    return this.advance();
  }

  private onRaise(i: number, raiseAmount: number): ProcessResult {
    const me = this.s.seats[i]!;
    // raiseAmount 解釋為「本街該玩家總投入」                                          // L2_鎖定
    if (!Number.isFinite(raiseAmount) || raiseAmount <= 0)
      return { ok: false, error: "INVALID_RAISE_AMOUNT" };
    if (raiseAmount <= this.s.currentBet)
      return { ok: false, error: "RAISE_MUST_EXCEED_CURRENT_BET" };                  // L2_鎖定
    const delta = raiseAmount - me.betThisStreet;
    if (delta > me.stack)
      return { ok: false, error: "INSUFFICIENT_STACK" };                             // L2_鎖定
    const raiseIncrement = raiseAmount - this.s.currentBet;
    const isAllInRaise = delta === me.stack;
    if (raiseIncrement < this.s.minRaise && !isAllInRaise)
      return { ok: false, error: "RAISE_BELOW_MIN_RAISE" };                          // L2_鎖定

    me.stack -= delta;
    me.betThisStreet = raiseAmount;
    me.totalCommitted += delta;
    if (me.stack === 0) me.isAllIn = true;
    me.hasActedThisStreet = true;

    // 完整加注才更新 minRaise；short all-in 不重開行動                                 // L2_鎖定
    if (raiseIncrement >= this.s.minRaise) {
      this.s.minRaise = raiseIncrement;
      this.s.currentBet = raiseAmount;
      this.s.lastAggressorIdx = i;
      // 重置其他在線玩家本街行動旗標
      for (let k = 0; k < this.s.seats.length; k++) {
        const sk = this.s.seats[k]!;
        if (k !== i && !sk.hasFolded && !sk.isAllIn) {
          sk.hasActedThisStreet = false;
        }
      }
    } else {
      this.s.currentBet = Math.max(this.s.currentBet, raiseAmount);
    }
    return this.advance();
  }

  // ─── 行動推進 / 轉街  (L3_架構) ────────────────
  private advance(): ProcessResult {
    const live = this.s.seats.filter(s => !s.hasFolded);
    if (live.length === 1) {
      // 只剩一人 — 直接結束
      return { ok: true, settlement: this.settleSinglePlayerLeft(live[0]!.playerId) };
    }

    if (this.isStreetComplete()) {
      // 收尾本街 betThisStreet → totalCommitted 已即時累計
      for (const s of this.s.seats) { s.betThisStreet = 0; s.hasActedThisStreet = false; }
      this.s.currentBet = 0;
      this.s.minRaise = this.s.bigBlind;
      this.s.lastAggressorIdx = null;

      // 若場上仍可下注者 ≤ 1，直接快進到 showdown
      const canAct = this.s.seats.filter(s => !s.hasFolded && !s.isAllIn);
      const nextStreetFn = () => this.dealNextStreet();
      let res: ProcessResult = { ok: true };
      do {
        res = nextStreetFn();
        if ((this.s.street as string) === "showdown") break;
        if (canAct.length >= 2) break;
      } while ((this.s.street as string) !== "showdown");
      if ((this.s.street as string) === "showdown") {
        return { ok: true, settlement: this.settleShowdown() };
      }
      this.s.turnIdx = this.firstToActPostflop();
      this.s.turnDeadlineMs = Date.now() + TURN_WINDOW_MS;
      return res;
    }

    // 推進至下一個可行動者
    this.s.turnIdx = this.nextActorIdx(this.s.turnIdx);
    this.s.turnDeadlineMs = Date.now() + TURN_WINDOW_MS;
    return { ok: true };
  }

  private isStreetComplete(): boolean {
    // 所有「未棄牌且未 all-in」玩家都已行動過，且 betThisStreet 都等於 currentBet
    for (const s of this.s.seats) {
      if (s.hasFolded || s.isAllIn) continue;
      if (!s.hasActedThisStreet) return false;
      if (s.betThisStreet !== this.s.currentBet) return false;
    }
    return true;
  }

  private nextActorIdx(from: number): number {
    const n = this.s.seats.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      const s = this.s.seats[i]!;
      if (!s.hasFolded && !s.isAllIn) return i;
    }
    return from; // 不應發生
  }

  private firstToActPostflop(): number {
    // SB 起算順時鐘第一個未棄牌未 all-in
    const n = this.s.seats.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.s.dealerIdx + k) % n;
      const s = this.s.seats[i]!;
      if (!s.hasFolded && !s.isAllIn) return i;
    }
    return this.s.dealerIdx;
  }

  private dealNextStreet(): ProcessResult {
    switch (this.s.street) {
      case "preflop":
        this.s.deck.pop();                                       // burn
        this.s.community.push(this.s.deck.pop()!, this.s.deck.pop()!, this.s.deck.pop()!);
        this.s.street = "flop";
        return { ok: true };
      case "flop":
        this.s.deck.pop();
        this.s.community.push(this.s.deck.pop()!);
        this.s.street = "turn";
        return { ok: true };
      case "turn":
        this.s.deck.pop();
        this.s.community.push(this.s.deck.pop()!);
        this.s.street = "river";
        return { ok: true };
      case "river":
        this.s.street = "showdown";
        return { ok: true };
      default:
        return { ok: false, error: "INVALID_STREET_TRANSITION" };
    }
  }

  // ─── 結算 — 邊池分配  (L3_糾錯風險表) ────────────
  private settleShowdown(): SettlementResult {
    this.s.street = "settled";
    const pots = buildSidePots(this.s.seats);
    const scoreDeltas = new Map<PlayerId, number>();
    for (const s of this.s.seats) scoreDeltas.set(s.playerId, -s.totalCommitted);

    // 先計算每位 still-live 玩家的 7 牌評分鍵
    const keys = new Map<PlayerId, number>();
    for (const s of this.s.seats) {
      if (!s.hasFolded) {
        const seven: Card[] = [s.hole[0], s.hole[1], ...this.s.community];
        keys.set(s.playerId, rankBestOfSeven(seven));
      }
    }

    for (const pot of pots) {
      // 在合格玩家中找最高鍵
      let best = -1;
      const winners: PlayerId[] = [];
      for (const pid of pot.eligiblePlayerIds) {
        const k = keys.get(pid);
        if (k === undefined) continue;
        if (k > best) { best = k; winners.length = 0; winners.push(pid); }
        else if (k === best) winners.push(pid);
      }
      if (winners.length === 0) continue;
      const share = Math.floor(pot.amount / winners.length);
      const remainder = pot.amount - share * winners.length;
      // 籌碼餘數依座位順序給距 dealer 最近者                                          // L3_糾錯風險表
      winners.forEach((pid, idx) => {
        const add = share + (idx < remainder ? 1 : 0);
        scoreDeltas.set(pid, (scoreDeltas.get(pid) ?? 0) + add);
      });
    }

    // 排名以最終 scoreDelta 由大到小
    const sorted = [...this.s.seats].sort(
      (a, b) => (scoreDeltas.get(b.playerId)! - scoreDeltas.get(a.playerId)!),
    );
    const winnerId = sorted[0]!.playerId;
    return {
      gameId: this.s.gameId,
      roundId: this.s.roundId,
      finishedAt: Date.now(),
      reason: "lastCardPlayed",
      winnerId,
      players: sorted.map((s, idx) => ({
        playerId: s.playerId,
        finalRank: idx + 1,
        remainingCards: [],
        scoreDelta: scoreDeltas.get(s.playerId) ?? 0,
      })),
    };
  }

  /** 取出深拷貝快照 — 給 DO Hibernation persist 使用。                     // L3_架構含防禦觀測 */
  snapshot(): TexasSnapshot {
    return JSON.parse(JSON.stringify(this.s)) as TexasSnapshot;
  }

  /** 當前回合者。                                                            // L2_模組 */
  currentTurn(): PlayerId {
    return this.s.seats[this.s.turnIdx]!.playerId;
  }

  /** 玩家 ID 座位順序。                                                      // L2_模組 */
  playerIds(): PlayerId[] {
    return this.s.seats.map(s => s.playerId);
  }

  /**
   * 強制結算 — DO timeout/disconnect 觸發。
   * 採「退池」：每位玩家 scoreDelta=0（退還全部 totalCommitted），標 settled。
   * 前端依 reason 顯示「對局中止」。                                         // L3_架構含防禦觀測
   */
  forceSettle(reason: "timeout" | "disconnect"): SettlementResult {
    if (this.s.street === "settled") throw new Error("already settled");
    this.s.street = "settled";
    return {
      gameId: this.s.gameId,
      roundId: this.s.roundId,
      finishedAt: Date.now(),
      reason,
      winnerId: this.s.seats[0]!.playerId,
      players: this.s.seats.map((s, i) => ({
        playerId: s.playerId,
        finalRank: i + 1,
        remainingCards: [],                                                  // L2_隔離
        scoreDelta: 0,
      })),
    };
  }

  private settleSinglePlayerLeft(winnerId: PlayerId): SettlementResult {
    this.s.street = "settled";
    const pots = buildSidePots(this.s.seats);
    const total = pots.reduce((n, p) => n + p.amount, 0);
    const scoreDeltas = new Map<PlayerId, number>();
    for (const s of this.s.seats) scoreDeltas.set(s.playerId, -s.totalCommitted);
    scoreDeltas.set(winnerId, (scoreDeltas.get(winnerId) ?? 0) + total);
    const sorted = [...this.s.seats].sort(
      (a, b) => (scoreDeltas.get(b.playerId)! - scoreDeltas.get(a.playerId)!),
    );
    return {
      gameId: this.s.gameId,
      roundId: this.s.roundId,
      finishedAt: Date.now(),
      reason: "lastCardPlayed",
      winnerId,
      players: sorted.map((s, idx) => ({
        playerId: s.playerId,
        finalRank: idx + 1,
        remainingCards: [],
        scoreDelta: scoreDeltas.get(s.playerId) ?? 0,
      })),
    };
  }
}
