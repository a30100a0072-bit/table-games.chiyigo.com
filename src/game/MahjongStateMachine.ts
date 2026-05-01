// /src/game/MahjongStateMachine.ts
// 台灣 16 張麻將純邏輯狀態機（零 IO）— L3_架構
//
// 設計重點：
//  - PENDING_REACTIONS 等待視窗：胡 > 槓/碰 > 吃 嚴格優先級          // L3_架構
//  - 胡牌判定 O(N) 回溯，遞迴深度 ≤ 5（5 副 meld），分支 ≤ 2         // L3_邏輯安防
//  - 所有吃/碰/槓/胡均回查手牌真實擁有，防封包偽造                  // L2_隔離
//  - DO 50ms CPU 預算內必收斂；複雜台數（大四喜等）標 L2_待辦        // L3_邏輯安防
//
// MVP 範圍：基礎平胡 + 自摸 + 門前清；花牌、台數細項以 stub 處理。

import {
  PlayerId,
  MahjongTile,
  MahjongSuit,
  ExposedMeld,
  MahjongStateView,
  MahjongPhase,
  MahjongSelfView,
  MahjongOpponentView,
  MahjongDiscardAction,
  MahjongChowAction,
  MahjongPongAction,
  MahjongKongAction,
  MahjongHuAction,
  MahjongPassAction,
  SettlementResult,
} from "../types/game";

// ──────────────────────────────────────────────
//  常數
// ──────────────────────────────────────────────
const HAND_SIZE = 16;                          // 台灣 16 張
// 斷線/逾時棄局罰款；與 lobby ANTE_BY_GAME.mahjong 對齊。// L2_實作
const MJ_FORFEIT_PENALTY = 100;
const MELDS_NEEDED = 5;                        // 5 副 + 1 對 = 17 張胡牌
const REACTION_WINDOW_MS = 3500;               // 等待視窗 3.5s     // L3_架構
const TURN_WINDOW_MS = 15000;
const SUIT_ORDER: MahjongSuit[] = ["m", "p", "s", "z"];

type Counts = Uint8Array;                      // 34 維計數陣列   // L3_邏輯安防

const TILE_INDEX_COUNT = 34;
function tileIndex(t: MahjongTile): number {
  switch (t.suit) {
    case "m": return 0 + (t.rank - 1);
    case "p": return 9 + (t.rank - 1);
    case "s": return 18 + (t.rank - 1);
    case "z": return 27 + (t.rank - 1);
    case "f": throw new Error("INVARIANT_FLOWER_IN_HAND");      // L2_隔離
  }
}
function isSuited(i: number): boolean { return i < 27; }
function isFlower(t: MahjongTile): boolean { return t.suit === "f"; }

function tilesToCounts(tiles: MahjongTile[]): Counts {
  const c = new Uint8Array(TILE_INDEX_COUNT);
  for (const t of tiles) c[tileIndex(t)]!++;
  return c;
}
function tileEq(a: MahjongTile, b: MahjongTile): boolean {
  return a.suit === b.suit && a.rank === b.rank;
}

// ──────────────────────────────────────────────
//  胡牌判定 — O(N) 回溯  (L3_邏輯安防)
// ──────────────────────────────────────────────
/**
 * 給定 17 張（16 + 取得的 1 張）的計數，問是否可拆成「1 對 + 5 副」。
 * 演算法：枚舉對子 → 對剩餘 15 張貪心抽刻/順子。
 * 上界：對子枚舉 ≤ 34，每次拆解最壞 2^5 = 32 分支 → ≤ 1088 次基本操作。 // L3_邏輯安防
 */
export function canWin(tiles: MahjongTile[], exposedMelds: number = 0): boolean {
  const total = tiles.length + exposedMelds * 3;
  if (total !== HAND_SIZE + 1) return false;          // 必須 17 張等價   // L2_鎖定

  const counts = tilesToCounts(tiles);
  const meldsLeft = MELDS_NEEDED - exposedMelds;

  for (let i = 0; i < TILE_INDEX_COUNT; i++) {
    if (counts[i]! >= 2) {
      counts[i]! -= 2;
      if (canFormMelds(counts, meldsLeft)) {
        counts[i]! += 2;
        return true;
      }
      counts[i]! += 2;
    }
  }
  return false;
}

function canFormMelds(counts: Counts, need: number): boolean {
  if (need === 0) {
    for (let i = 0; i < TILE_INDEX_COUNT; i++) if (counts[i] !== 0) return false;
    return true;
  }
  let i = 0;
  while (i < TILE_INDEX_COUNT && counts[i] === 0) i++;
  if (i >= TILE_INDEX_COUNT) return false;

  // 嘗試刻子（含字牌唯一可能）
  if (counts[i]! >= 3) {
    counts[i]! -= 3;
    if (canFormMelds(counts, need - 1)) { counts[i]! += 3; return true; }
    counts[i]! += 3;
  }
  // 嘗試順子（僅花色牌；rank 1–7）
  if (isSuited(i)) {
    const rank0 = i % 9;
    if (rank0 <= 6 && counts[i + 1]! > 0 && counts[i + 2]! > 0) {
      counts[i]!--; counts[i + 1]!--; counts[i + 2]!--;
      if (canFormMelds(counts, need - 1)) { counts[i]!++; counts[i + 1]!++; counts[i + 2]!++; return true; }
      counts[i]!++; counts[i + 1]!++; counts[i + 2]!++;
    }
  }
  return false;
}

// ──────────────────────────────────────────────
//  台數計算 — 大眾規則 (engine_version 2)
//  涵蓋：平胡 / 自摸 / 門前清 / 清一色 / 字一色 / 大三元 / 大四喜 /
//        小三元 / 小四喜 / 槓上開花 / 三/四/五暗刻 / 全求人 / 花牌 /
//        海底撈月 / 河底撈魚 / 莊家。                                    // L3_架構
//  未實作（需狀態機改動或多局上下文）：搶槓、連莊 N、七搶一、八仙過海。
// ──────────────────────────────────────────────
export interface FanResult {
  base: number;            // 底
  fan: number;             // 台
  detail: string[];
}
export function calcFan(opts: {
  selfDrawn: boolean;
  menqing: boolean;        // 門前清（未吃碰）
  exposed: ExposedMeld[];
  hand: MahjongTile[];     // 含胡牌
  winningTile: MahjongTile; // 用來判定食胡的明刻不算暗刻
  isBanker: boolean;        // 莊家
  flowerCount: number;      // 開局以來收的花牌數
  drewFromKongReplacement?: boolean;
  lastWallDraw?: boolean;   // 海底撈月：自摸取自牌牆最後一張
  lastRiverHu?: boolean;    // 河底撈魚：食胡的牌是牆空後最後一張被打出
  chiangKong?: boolean;     // 搶槓胡：食胡來自他家加槓的牌
}): FanResult {
  const detail: string[] = ["平胡"];
  let fan = 0;

  // 完整牌組（手牌 + 對外副露）— 所有結構性台用得上                       // L2_實作
  const all: MahjongTile[] = [...opts.hand, ...opts.exposed.flatMap(m => m.tiles)];

  // 清一色 / 字一色
  const suits = new Set(all.map(t => t.suit));
  if (suits.size === 1) {
    if (suits.has("z")) { fan += 16; detail.push("字一色"); }
    else                { fan += 8;  detail.push("清一色"); }
  }

  // ─ 三元台（大三元 / 小三元）
  const honorCount = (rank: number) =>
    all.filter(t => t.suit === "z" && t.rank === rank).length;
  const dragonRanks = [5, 6, 7];                    // 中 / 發 / 白
  const dragonTriplets = dragonRanks.filter(r => honorCount(r) >= 3).length;
  const dragonPair     = dragonRanks.some(r => honorCount(r) === 2);
  if (dragonTriplets === 3) {
    fan += 8; detail.push("大三元");
  } else if (dragonTriplets === 2 && dragonPair) {
    fan += 4; detail.push("小三元");
  }

  // ─ 四喜（大四喜 / 小四喜）
  const windRanks = [1, 2, 3, 4];                   // 東 / 南 / 西 / 北
  const windTriplets = windRanks.filter(r => honorCount(r) >= 3).length;
  const windPair     = windRanks.some(r => honorCount(r) === 2);
  if (windTriplets === 4) {
    fan += 16; detail.push("大四喜");
  } else if (windTriplets === 3 && windPair) {
    fan += 8; detail.push("小四喜");
  }

  // ─ 暗刻（三/四/五暗刻）
  // hand 內部 ≥3 同牌 = 暗刻；但若食胡且 winningTile 進到該刻子裡，
  // 該刻子降級為明刻。kong_concealed 永遠算暗刻。                        // L2_實作
  const handCounts = new Map<string, number>();
  for (const t of opts.hand) {
    const k = `${t.suit}-${t.rank}`;
    handCounts.set(k, (handCounts.get(k) ?? 0) + 1);
  }
  const winKey = `${opts.winningTile.suit}-${opts.winningTile.rank}`;
  let concealedTriplets = 0;
  for (const [k, n] of handCounts) {
    if (n >= 3) {
      // 食胡且贏牌就是這張 → 明刻，不算
      if (!opts.selfDrawn && k === winKey) continue;
      concealedTriplets += 1;
    }
  }
  concealedTriplets += opts.exposed.filter(m => m.kind === "kong_concealed").length;
  if (concealedTriplets === 5)      { fan += 8; detail.push("五暗刻"); }
  else if (concealedTriplets === 4) { fan += 5; detail.push("四暗刻"); }
  else if (concealedTriplets === 3) { fan += 2; detail.push("三暗刻"); }

  // ─ 全求人：所有 meld 都來自副露（無暗槓）+ 食胡 + 手牌僅剩對子+贏牌
  // 4 副露 + (2 對子 + 1 贏牌) = 12 + 3 = 15... 實際 16+1=17 含贏牌；
  // 對子 2 + 贏牌 1 = 3，配 4 個 exposed 共 15 不足。標準 16 張 5 副+1 對 =
  // 17 含贏牌；4 副露=12，hand 僅 5 張（4+winning），其中要含 1 對 + 贏牌
  // 進場成第 5 副(刻/順)。換句話說 hand.length === 5 含贏牌、exposed.length === 4、
  // !selfDrawn、無暗槓。                                                  // L2_實作
  const hasConcealedKong = opts.exposed.some(m => m.kind === "kong_concealed");
  if (!opts.selfDrawn && opts.exposed.length === 4 && !hasConcealedKong &&
      opts.hand.length <= 5) {
    fan += 4; detail.push("全求人");
  }

  // ─ 海底 / 河底
  if (opts.selfDrawn  && opts.lastWallDraw) { fan += 1; detail.push("海底撈月"); }
  if (!opts.selfDrawn && opts.lastRiverHu)  { fan += 1; detail.push("河底撈魚"); }

  // ─ 搶槓胡：食胡來自他家加槓的那張牌
  if (opts.chiangKong) { fan += 1; detail.push("搶槓"); }

  // ─ 槓上開花（既有）
  if (opts.drewFromKongReplacement && opts.selfDrawn) {
    fan += 1; detail.push("槓上開花");
  }

  // ─ 自摸 / 門前清 / 門清自摸 / 莊家
  if (opts.selfDrawn) { fan += 1; detail.push("自摸"); }
  if (opts.menqing)   { fan += 1; detail.push("門前清"); }
  if (opts.menqing && opts.selfDrawn) { fan += 1; detail.push("門清自摸"); }
  if (opts.isBanker)  { fan += 1; detail.push("莊家"); }

  // ─ 花牌：每張 +1 台
  if (opts.flowerCount > 0) {
    fan += opts.flowerCount;
    detail.push(`花牌×${opts.flowerCount}`);
  }

  return { base: 1, fan, detail };
}

// ──────────────────────────────────────────────
//  狀態機  (L3_架構含防禦觀測)
// ──────────────────────────────────────────────
interface PlayerState {
  playerId: PlayerId;
  hand: MahjongTile[];
  exposed: ExposedMeld[];
  flowers: MahjongTile[];
}

interface PendingReaction {
  playerId: PlayerId;
  declared?:
    | { kind: "hu" }
    | { kind: "kong"; tile: MahjongTile }
    | { kind: "pong"; tile: MahjongTile }
    | { kind: "chow"; tiles: [MahjongTile, MahjongTile, MahjongTile] }
    | { kind: "pass" };
}

interface InternalState {
  gameId: string;
  roundId: string;
  phase: MahjongPhase;
  players: PlayerState[];                        // 固定 4 人，順時鐘
  wall: MahjongTile[];                           // 牌牆剩餘
  turnIdx: number;                               // 當前行動者索引
  dealerIdx: number;                             // 莊家座位（單局簡化：開局即莊，預設 0） // L2_實作
  lastDiscard: { tile: MahjongTile; playerIdx: number } | null;
  pendingReactions: PendingReaction[];           // L3_架構
  reactionDeadlineMs: number;
  turnDeadlineMs: number;
  drawnThisTurn: MahjongTile | null;             // 本回合剛摸的牌（決定 menqing/自摸）
  drewFromKongReplacement: boolean;              // 補摸自槓尾，下一手胡計「槓上開花」 // L3_架構
  drewLastWallTile: boolean;                     // 本手摸到的是牌牆最後一張 → 海底撈月候補 // L2_實作
  lastDiscardOnEmptyWall: boolean;               // 上一手摸了最後一張後打出 → 河底撈魚候補 // L2_實作
  /** 加槓 進行中 — 開放搶槓反應視窗。null = 普通 lastDiscard 視窗。
   *  搶槓胡 = food-hu on this tile，否則視窗結束後完成槓+補張。           // L2_實作 */
  kongUpgradeContext: { tile: MahjongTile; kongerIdx: number } | null;
}

export type ProcessResult =
  | { ok: true; settlement?: SettlementResult }
  | { ok: false; error: string };

/** 持久化快照型別 — 對應 InternalState 結構，給 DO Hibernation 用。       // L3_架構含防禦觀測 */
export type MahjongSnapshot = InternalState;

export class MahjongStateMachine {
  private s: InternalState;

  /** DO Hibernation 還原入口；不重新洗牌，直接接續既有狀態。              // L3_架構含防禦觀測 */
  static restore(snap: MahjongSnapshot): MahjongStateMachine {
    const m = Object.create(MahjongStateMachine.prototype) as MahjongStateMachine;
    // 深複製避免外部 mutation 污染                                          // L2_隔離
    (m as unknown as { s: InternalState }).s = JSON.parse(JSON.stringify(snap)) as InternalState;
    return m;
  }

  constructor(gameId: string, roundId: string, players: PlayerId[], rng: () => number = Math.random) {
    if (players.length !== 4) throw new Error("MJ_REQUIRES_4_PLAYERS");
    const wall = buildShuffledWall(rng);
    const playerStates: PlayerState[] = players.map((pid, i) => ({
      playerId: pid,
      hand: wall.splice(0, HAND_SIZE),
      exposed: [],
      flowers: [],
    }));
    // 開局補花：每家把手中花牌移到 flowers，從牆頭抽新牌補（可能再花）   // L2_實作
    for (const ps of playerStates) drainFlowers(ps.hand, ps.flowers, wall);

    // 莊家補一張（從牆尾抽，遇花吸收）
    const banker = 0;
    const bankerSeat = playerStates[banker]!;
    let drawn = drawNonFlower(wall, bankerSeat.flowers);
    if (!drawn) throw new Error("WALL_EXHAUSTED_BEFORE_GAME_START");
    bankerSeat.hand.push(drawn);

    this.s = {
      gameId,
      roundId,
      phase: "playing",
      players: playerStates,
      wall,
      turnIdx: banker,
      dealerIdx: banker,
      lastDiscard: null,
      pendingReactions: [],
      reactionDeadlineMs: 0,
      turnDeadlineMs: Date.now() + TURN_WINDOW_MS,
      drawnThisTurn: drawn,
      drewFromKongReplacement: false,
      drewLastWallTile: wall.length === 0,
      lastDiscardOnEmptyWall: false,
      kongUpgradeContext: null,
    };
  }

  // ─── 對外快照 ────────────────────────────────
  viewFor(playerId: PlayerId): MahjongStateView {
    const meIdx = this.s.players.findIndex(p => p.playerId === playerId);
    if (meIdx < 0) throw new Error("PLAYER_NOT_IN_GAME");
    const me = this.s.players[meIdx]!;
    const self: MahjongSelfView = {
      playerId: me.playerId,
      hand: [...me.hand],
      exposed: deepCopyMelds(me.exposed),
      flowers: [...me.flowers],
    };
    const opponents: MahjongOpponentView[] = this.s.players
      .filter((_, i) => i !== meIdx)
      .map(p => ({
        playerId: p.playerId,
        handCount: p.hand.length,                  // 不暴露牌面 // L2_隔離
        exposed: deepCopyMelds(p.exposed),
        flowersCount: p.flowers.length,
      }));
    return {
      gameId: this.s.gameId,
      roundId: this.s.roundId,
      phase: this.s.phase,
      self,
      opponents,
      wall: { remaining: this.s.wall.length },
      currentTurn: this.s.players[this.s.turnIdx]!.playerId,
      lastDiscard: this.s.lastDiscard
        ? { playerId: this.s.players[this.s.lastDiscard.playerIdx]!.playerId, tile: this.s.lastDiscard.tile }
        : null,
      awaitingReactionsFrom: this.s.pendingReactions
        .filter(r => !r.declared).map(r => r.playerId),
      reactionDeadlineMs: this.s.reactionDeadlineMs,
      turnDeadlineMs: this.s.turnDeadlineMs,
    };
  }

  // ─── Action 入口分派  (L2_鎖定) ────────────────
  process(playerId: PlayerId, action:
    | MahjongDiscardAction | MahjongChowAction | MahjongPongAction
    | MahjongKongAction | MahjongHuAction | MahjongPassAction
  ): ProcessResult {
    const idx = this.s.players.findIndex(p => p.playerId === playerId);
    if (idx < 0) return { ok: false, error: "PLAYER_NOT_IN_GAME" };

    switch (action.type) {
      case "discard":  return this.onDiscard(idx, action);
      case "hu":       return this.onHu(idx, action);
      case "kong":     return this.onKong(idx, action);
      case "pong":     return this.onPong(idx, action);
      case "chow":     return this.onChow(idx, action);
      case "mj_pass":  return this.onPass(idx);
    }
  }

  // ─── 打牌 ──────────────────────────────────
  private onDiscard(idx: number, a: MahjongDiscardAction): ProcessResult {
    if (this.s.phase !== "playing") return { ok: false, error: "NOT_PLAYING_PHASE" };
    if (idx !== this.s.turnIdx) return { ok: false, error: "NOT_YOUR_TURN" };
    const me = this.s.players[idx]!;
    const ti = me.hand.findIndex(t => tileEq(t, a.tile));
    if (ti < 0) return { ok: false, error: "TILE_NOT_IN_HAND" };          // L2_隔離
    const exposedTiles = me.exposed.reduce((n, m) => n + (m.kind === "kong_concealed" || m.kind === "kong_exposed" ? 3 : 3), 0);
    if (me.hand.length + exposedTiles !== HAND_SIZE + 1) return { ok: false, error: "MUST_DRAW_OR_REACT_FIRST" }; // L2_鎖定

    me.hand.splice(ti, 1);
    this.s.lastDiscard = { tile: a.tile, playerIdx: idx };
    this.s.drawnThisTurn = null;
    // 若這手是摸了牌牆最後一張之後打出 → 食胡此牌算「河底撈魚」候補。   // L2_實作
    this.s.lastDiscardOnEmptyWall = this.s.drewLastWallTile;
    this.s.drewLastWallTile = false;

    // 進入 PENDING_REACTIONS — 收集其他 3 人意圖   // L3_架構
    this.s.phase = "pending_reactions";
    this.s.pendingReactions = this.s.players
      .map((p, i) => i === idx ? null : { playerId: p.playerId } as PendingReaction)
      .filter((x): x is PendingReaction => x !== null);
    this.s.reactionDeadlineMs = Date.now() + REACTION_WINDOW_MS;

    return { ok: true };
  }

  // ─── 胡（食胡 / 自摸）───────────────────────
  private onHu(idx: number, a: MahjongHuAction): ProcessResult {
    const me = this.s.players[idx]!;
    if (a.selfDrawn) {
      if (this.s.phase !== "playing" || idx !== this.s.turnIdx) return { ok: false, error: "NOT_YOUR_TURN" };
      if (!canWin(me.hand, me.exposed.length)) return { ok: false, error: "NOT_A_WIN" };  // L3_邏輯安防
      return { ok: true, settlement: this.settle(idx, true, null) };
    }
    // 食胡：必須在 PENDING_REACTIONS 且有 lastDiscard
    if (this.s.phase !== "pending_reactions" || !this.s.lastDiscard)
      return { ok: false, error: "NO_PENDING_DISCARD" };
    const reaction = this.s.pendingReactions.find(r => r.playerId === me.playerId);
    if (!reaction) return { ok: false, error: "NOT_AWAITED" };
    const candidate = [...me.hand, this.s.lastDiscard.tile];
    if (!canWin(candidate, me.exposed.length)) return { ok: false, error: "NOT_A_WIN" };  // L3_邏輯安防
    reaction.declared = { kind: "hu" };
    return this.resolveReactions();
  }

  // ─── 槓 ────────────────────────────────────
  private onKong(idx: number, a: MahjongKongAction): ProcessResult {
    const me = this.s.players[idx]!;
    if (a.source === "exposed") {
      if (this.s.phase !== "pending_reactions" || !this.s.lastDiscard) return { ok: false, error: "NO_PENDING_DISCARD" };
      if (this.s.kongUpgradeContext) return { ok: false, error: "ONLY_HU_DURING_CHIANG_KONG" };
      if (!tileEq(this.s.lastDiscard.tile, a.tile)) return { ok: false, error: "TILE_MISMATCH" };
      const ownCount = me.hand.filter(t => tileEq(t, a.tile)).length;
      if (ownCount < 3) return { ok: false, error: "INSUFFICIENT_TILES_FOR_KONG" };       // L2_隔離
      const reaction = this.s.pendingReactions.find(r => r.playerId === me.playerId);
      if (!reaction) return { ok: false, error: "NOT_AWAITED" };
      reaction.declared = { kind: "kong", tile: a.tile };
      return this.resolveReactions();
    }
    // 暗槓 / 加槓 — 必須在自己回合且摸過牌
    if (this.s.phase !== "playing" || idx !== this.s.turnIdx) return { ok: false, error: "NOT_YOUR_TURN" };
    if (a.source === "concealed") {
      const ownCount = me.hand.filter(t => tileEq(t, a.tile)).length;
      if (ownCount < 4) return { ok: false, error: "INSUFFICIENT_TILES_FOR_KONG" };       // L2_隔離
      removeTilesFromHand(me.hand, a.tile, 4);
      me.exposed.push({ kind: "kong_concealed", tiles: Array(4).fill(a.tile) });
      // 嶺上抽
      const replacement = drawNonFlower(this.s.wall, me.flowers);
      if (!replacement) return this.drawExhaustion();
      me.hand.push(replacement);
      this.s.drawnThisTurn = replacement;
      this.s.drewFromKongReplacement = true;
      const flowerSettle = this.checkFlowerTerminal(idx);
      if (flowerSettle) return { ok: true, settlement: flowerSettle };
      return { ok: true };
    }
    // 加槓：手中有 1 張，且 exposed 已有對應 pong；先進搶槓視窗，由
    // commitHighestPriority/forceResolveReactions 決定要走哪條路。
    const ownCount = me.hand.filter(t => tileEq(t, a.tile)).length;
    const targetMeld = me.exposed.find(m => m.kind === "pong" && m.tiles.every(t => tileEq(t, a.tile)));
    if (ownCount < 1 || !targetMeld) return { ok: false, error: "INVALID_ADDED_KONG" };  // L2_隔離

    // 搶槓視窗：用既有 pending_reactions / lastDiscard 機制讓 onHu 食胡能命中此張，
    // 但暫不真正改 exposed/hand — 等視窗結算才真正完成槓。                    // L2_實作
    this.s.kongUpgradeContext = { tile: a.tile, kongerIdx: idx };
    this.s.lastDiscard = { tile: a.tile, playerIdx: idx };
    this.s.phase = "pending_reactions";
    this.s.pendingReactions = this.s.players
      .map((p, i) => i === idx ? null : { playerId: p.playerId } as PendingReaction)
      .filter((x): x is PendingReaction => x !== null);
    this.s.reactionDeadlineMs = Date.now() + REACTION_WINDOW_MS;
    return { ok: true };
  }

  // ─── 碰 ────────────────────────────────────
  private onPong(idx: number, a: MahjongPongAction): ProcessResult {
    if (this.s.phase !== "pending_reactions" || !this.s.lastDiscard) return { ok: false, error: "NO_PENDING_DISCARD" };
    // 搶槓視窗只開放 hu / pass — 不能用碰反搶。                                  // L2_隔離
    if (this.s.kongUpgradeContext) return { ok: false, error: "ONLY_HU_DURING_CHIANG_KONG" };
    if (!tileEq(this.s.lastDiscard.tile, a.tile)) return { ok: false, error: "TILE_MISMATCH" };
    const me = this.s.players[idx]!;
    const ownCount = me.hand.filter(t => tileEq(t, a.tile)).length;
    if (ownCount < 2) return { ok: false, error: "INSUFFICIENT_TILES_FOR_PONG" };          // L2_隔離
    const reaction = this.s.pendingReactions.find(r => r.playerId === me.playerId);
    if (!reaction) return { ok: false, error: "NOT_AWAITED" };
    reaction.declared = { kind: "pong", tile: a.tile };
    return this.resolveReactions();
  }

  // ─── 吃（僅下家可吃）───────────────────────
  private onChow(idx: number, a: MahjongChowAction): ProcessResult {
    if (this.s.phase !== "pending_reactions" || !this.s.lastDiscard) return { ok: false, error: "NO_PENDING_DISCARD" };
    if (this.s.kongUpgradeContext) return { ok: false, error: "ONLY_HU_DURING_CHIANG_KONG" };
    const nextIdx = (this.s.lastDiscard.playerIdx + 1) % 4;
    if (idx !== nextIdx) return { ok: false, error: "ONLY_NEXT_PLAYER_CAN_CHOW" };          // L2_隔離
    const dt = this.s.lastDiscard.tile;
    if (dt.suit === "z") return { ok: false, error: "CANNOT_CHOW_HONORS" };                 // L2_隔離

    const sortedTiles = [...a.tiles].sort((x, y) => x.rank - y.rank);
    if (!sortedTiles.every(t => t.suit === dt.suit))
      return { ok: false, error: "MIXED_SUIT_CHOW" };                                       // L2_隔離
    if (sortedTiles[1]!.rank !== sortedTiles[0]!.rank + 1 || sortedTiles[2]!.rank !== sortedTiles[1]!.rank + 1)
      return { ok: false, error: "NOT_A_SEQUENCE" };                                        // L2_隔離
    if (!sortedTiles.some(t => tileEq(t, dt)))
      return { ok: false, error: "MUST_INCLUDE_DISCARDED_TILE" };                           // L2_隔離

    // 校驗手中真實擁有除 dt 外那 2 張                                                       // L2_隔離
    const me = this.s.players[idx]!;
    const need = sortedTiles.filter(t => !tileEq(t, dt));
    const handCopy = [...me.hand];
    for (const t of need) {
      const i = handCopy.findIndex(x => tileEq(x, t));
      if (i < 0) return { ok: false, error: "TILE_NOT_IN_HAND" };
      handCopy.splice(i, 1);
    }
    const reaction = this.s.pendingReactions.find(r => r.playerId === me.playerId);
    if (!reaction) return { ok: false, error: "NOT_AWAITED" };
    reaction.declared = { kind: "chow", tiles: sortedTiles as [MahjongTile, MahjongTile, MahjongTile] };
    return this.resolveReactions();
  }

  // ─── 過水 ──────────────────────────────────
  private onPass(idx: number): ProcessResult {
    if (this.s.phase !== "pending_reactions") return { ok: false, error: "NOT_PENDING" };
    const reaction = this.s.pendingReactions.find(r => r.playerId === this.s.players[idx]!.playerId);
    if (!reaction) return { ok: false, error: "NOT_AWAITED" };
    reaction.declared = { kind: "pass" };
    return this.resolveReactions();
  }

  // ─── 等待視窗解析 — 嚴格優先級 胡 > 槓 > 碰 > 吃   (L3_架構) ──
  private resolveReactions(): ProcessResult {
    if (this.s.pendingReactions.some(r => !r.declared)) return { ok: true }; // 還在等
    return this.commitHighestPriority();
  }

  /** 取出深拷貝快照 — 給 DO Hibernation persist 使用。                    // L3_架構含防禦觀測 */
  snapshot(): MahjongSnapshot {
    return JSON.parse(JSON.stringify(this.s)) as MahjongSnapshot;
  }

  /** 當前回合者 — 給 Bot/超時邏輯查詢，避免重組整個 view。                // L2_模組 */
  currentTurn(): PlayerId {
    return this.s.players[this.s.turnIdx]!.playerId;
  }

  /** 列出所有玩家 ID（座位順序）。                                         // L2_模組 */
  playerIds(): PlayerId[] {
    return this.s.players.map(p => p.playerId);
  }

  /**
   * 強制結算 — DO timeout/disconnect 觸發。
   * 若指名 forfeitPlayerId，該玩家扣 FORFEIT_PENALTY 籌碼，其他三家平分；
   * 沒指名則全員 scoreDelta=0（流局退池，例：全員一起斷線）。           // L3_架構含防禦觀測
   * 平分採向下取整，餘數留在系統（避免無中生有的籌碼）。
   */
  forceSettle(reason: "timeout" | "disconnect", forfeitPlayerId?: PlayerId): SettlementResult {
    if (this.s.phase === "settled") throw new Error("already settled");
    this.s.phase = "settled";

    const offenderIdx = forfeitPlayerId
      ? this.s.players.findIndex(p => p.playerId === forfeitPlayerId)
      : -1;
    const otherIdxs = this.s.players.map((_, i) => i).filter(i => i !== offenderIdx);
    const split = offenderIdx >= 0 && otherIdxs.length > 0
      ? Math.floor(MJ_FORFEIT_PENALTY / otherIdxs.length)
      : 0;
    const totalLoss = split * otherIdxs.length;
    const winnerIdx = offenderIdx >= 0 ? otherIdxs[0]! : 0;

    return {
      gameId: this.s.gameId,
      roundId: this.s.roundId,
      finishedAt: Date.now(),
      reason,
      winnerId: this.s.players[winnerIdx]!.playerId,
      players: this.s.players.map((p, i) => ({
        playerId: p.playerId,
        finalRank: i === offenderIdx ? 4 : (i === winnerIdx ? 1 : 2),
        remainingCards: [],                                                  // L2_隔離
        scoreDelta: i === offenderIdx ? -totalLoss : (offenderIdx >= 0 ? split : 0),
      })),
    };
  }

  /** 由外部 alarm 在 reactionDeadlineMs 觸發；對未回應者視為 pass */    // L3_架構
  forceResolveReactions(): ProcessResult {
    if (this.s.phase !== "pending_reactions") return { ok: true };
    for (const r of this.s.pendingReactions) if (!r.declared) r.declared = { kind: "pass" };
    return this.commitHighestPriority();
  }

  private commitHighestPriority(): ProcessResult {
    const ld = this.s.lastDiscard;
    if (!ld) return { ok: false, error: "INVARIANT_NO_LAST_DISCARD" };

    // 1. 胡（多家可同時胡，依逆時鐘優先 / MVP 取第一個）            // L3_架構
    const huR = this.s.pendingReactions.find(r => r.declared?.kind === "hu");
    if (huR) {
      const winnerIdx = this.s.players.findIndex(p => p.playerId === huR.playerId);
      this.s.players[winnerIdx]!.hand.push(ld.tile);
      const isChiangKong = this.s.kongUpgradeContext !== null;
      this.s.kongUpgradeContext = null;            // 搶槓胡 → 加槓沒成功
      const settlement = this.settle(winnerIdx, false, ld.playerIdx, isChiangKong);
      return { ok: true, settlement };
    }

    // 1b. 搶槓視窗無人胡 → 完成 加槓 並抽嶺上
    if (this.s.kongUpgradeContext) {
      const ctx = this.s.kongUpgradeContext;
      this.s.kongUpgradeContext = null;
      const me = this.s.players[ctx.kongerIdx]!;
      const targetMeld = me.exposed.find(m => m.kind === "pong" && m.tiles.every(t => tileEq(t, ctx.tile)));
      // 若 invariant 失守（不應發生）— 視為 abort，回到該玩家正常出牌      // L2_隔離
      if (!targetMeld) {
        this.s.lastDiscard = null;
        this.s.pendingReactions = [];
        this.s.phase = "playing";
        return { ok: false, error: "INVARIANT_PONG_MELD_VANISHED" };
      }
      removeTilesFromHand(me.hand, ctx.tile, 1);
      targetMeld.kind = "kong_exposed";
      targetMeld.tiles.push(ctx.tile);
      this.s.lastDiscard = null;
      this.s.pendingReactions = [];
      const replacement = drawNonFlower(this.s.wall, me.flowers);
      if (!replacement) return this.drawExhaustion();
      me.hand.push(replacement);
      this.s.drawnThisTurn = replacement;
      this.s.drewFromKongReplacement = true;
      this.s.phase = "playing";
      this.s.turnIdx = ctx.kongerIdx;
      this.s.turnDeadlineMs = Date.now() + TURN_WINDOW_MS;
      const flowerSettle = this.checkFlowerTerminal(ctx.kongerIdx);
      if (flowerSettle) return { ok: true, settlement: flowerSettle };
      return { ok: true };
    }

    // 2. 槓
    const kongR = this.s.pendingReactions.find(r => r.declared?.kind === "kong");
    if (kongR) {
      const i = this.s.players.findIndex(p => p.playerId === kongR.playerId);
      const me = this.s.players[i]!;
      removeTilesFromHand(me.hand, ld.tile, 3);
      me.exposed.push({ kind: "kong_exposed", tiles: [ld.tile, ld.tile, ld.tile, ld.tile], fromPlayerId: this.s.players[ld.playerIdx]!.playerId });
      this.s.lastDiscard = null;
      const replacement = drawNonFlower(this.s.wall, me.flowers);
      if (!replacement) return this.drawExhaustion();
      me.hand.push(replacement);
      this.s.drawnThisTurn = replacement;
      this.s.drewFromKongReplacement = true;
      this.s.turnIdx = i;
      this.s.phase = "playing";
      this.s.turnDeadlineMs = Date.now() + TURN_WINDOW_MS;
      this.s.pendingReactions = [];
      return { ok: true };
    }

    // 3. 碰
    const pongR = this.s.pendingReactions.find(r => r.declared?.kind === "pong");
    if (pongR) {
      const i = this.s.players.findIndex(p => p.playerId === pongR.playerId);
      const me = this.s.players[i]!;
      removeTilesFromHand(me.hand, ld.tile, 2);
      me.exposed.push({ kind: "pong", tiles: [ld.tile, ld.tile, ld.tile], fromPlayerId: this.s.players[ld.playerIdx]!.playerId });
      this.s.lastDiscard = null;
      this.s.turnIdx = i;
      this.s.phase = "playing";        // 碰後直接打牌，不再摸
      this.s.drawnThisTurn = null;
      this.s.turnDeadlineMs = Date.now() + TURN_WINDOW_MS;
      this.s.pendingReactions = [];
      // 碰後不再摸牌，直接打牌；hand + exposed*3 = 14 + 3 = 17，等同摸後狀態     // L2_鎖定
      return { ok: true };
    }

    // 4. 吃
    const chowR = this.s.pendingReactions.find(r => r.declared?.kind === "chow");
    if (chowR && chowR.declared?.kind === "chow") {
      const i = this.s.players.findIndex(p => p.playerId === chowR.playerId);
      const me = this.s.players[i]!;
      const tiles = chowR.declared.tiles;
      for (const t of tiles) if (!tileEq(t, ld.tile)) {
        const idxH = me.hand.findIndex(x => tileEq(x, t));
        if (idxH < 0) return { ok: false, error: "INVARIANT_CHOW_TILE_MISSING" };           // L2_隔離
        me.hand.splice(idxH, 1);
      }
      me.exposed.push({ kind: "chow", tiles: [...tiles], fromPlayerId: this.s.players[ld.playerIdx]!.playerId });
      this.s.lastDiscard = null;
      this.s.turnIdx = i;
      this.s.phase = "playing";
      this.s.drawnThisTurn = null;
      this.s.turnDeadlineMs = Date.now() + TURN_WINDOW_MS;
      this.s.pendingReactions = [];
      return { ok: true };
    }

    // 全部 pass — 進入下家摸牌
    return this.advanceToNextDraw();
  }

  private advanceToNextDraw(): ProcessResult {
    // 進到下一摸 → 上一手「在空牆後打出」的河底候補也清掉。               // L2_實作
    this.s.lastDiscard = null;
    this.s.pendingReactions = [];
    this.s.lastDiscardOnEmptyWall = false;
    this.s.turnIdx = (this.s.turnIdx + 1) % 4;
    const me = this.s.players[this.s.turnIdx]!;
    const tile = drawNonFlower(this.s.wall, me.flowers);
    if (!tile) return this.drawExhaustion();
    me.hand.push(tile);
    this.s.drawnThisTurn = tile;
    this.s.drewFromKongReplacement = false;       // 進入新一手 → 槓上開花失效
    this.s.drewLastWallTile = this.s.wall.length === 0;  // 海底撈月候補：摸完後牆空 // L2_實作
    this.s.phase = "playing";
    this.s.turnDeadlineMs = Date.now() + TURN_WINDOW_MS;
    // 摸花期間 drawNonFlower 已把花轉到 me.flowers 了；檢查是否觸發 八仙/七搶一。
    const flowerSettle = this.checkFlowerTerminal(this.s.turnIdx);
    if (flowerSettle) return { ok: true, settlement: flowerSettle };
    return { ok: true };
  }

  /** 在「最近一次摸牌的玩家」剛接收完花牌後呼叫。
   *   - 該玩家收滿 8 花 → 八仙過海，自摸 +8 台，三家攤付。
   *   - 全桌總花已 8、有人持 7 → 七搶一，7 花家贏，最後 1 花的「貢獻者」付。
   *  非終局回 null。                                                       // L2_實作 */
  private checkFlowerTerminal(drawerIdx: number): SettlementResult | null {
    const total = this.s.players.reduce((n, p) => n + p.flowers.length, 0);
    if (total !== 8) return null;
    const drawer = this.s.players[drawerIdx]!;
    if (drawer.flowers.length === 8) {
      return this.settleFlowerWin(drawerIdx, "八仙過海", null);
    }
    const sevenIdx = this.s.players.findIndex((p, i) => i !== drawerIdx && p.flowers.length === 7);
    if (sevenIdx >= 0) {
      return this.settleFlowerWin(sevenIdx, "七搶一", drawerIdx);
    }
    return null;
  }

  /** 八仙過海 / 七搶一 共用結算。8 台 + 1 底；八仙視為「自摸」三家攤付，
   *  七搶一視為「食胡」由 payerIdx 一家付。                                // L2_實作 */
  private settleFlowerWin(winnerIdx: number, kind: "八仙過海" | "七搶一", payerIdx: number | null): SettlementResult {
    this.s.phase = "settled";
    const fan = 8;
    const score = 1 + fan;
    const selfDrawn = kind === "八仙過海";
    return {
      gameId: this.s.gameId,
      roundId: this.s.roundId,
      finishedAt: Date.now(),
      reason: "lastCardPlayed",
      winnerId: this.s.players[winnerIdx]!.playerId,
      players: this.s.players.map((p, i) => {
        let scoreDelta = 0;
        if (i === winnerIdx)        scoreDelta = selfDrawn ? score * 3 : score;
        else if (selfDrawn)         scoreDelta = -score;
        else if (i === payerIdx)    scoreDelta = -score;
        return {
          playerId: p.playerId,
          finalRank: i === winnerIdx ? 1 : (i === payerIdx ? 4 : 2),
          remainingCards: [],
          scoreDelta,
        };
      }),
      fanDetail: { fan, base: 1, detail: [kind] },
    };
  }

  private drawExhaustion(): ProcessResult {
    this.s.phase = "settled";
    const settlement: SettlementResult = {
      gameId: this.s.gameId,
      roundId: this.s.roundId,
      finishedAt: Date.now(),
      reason: "lastCardPlayed",
      players: this.s.players.map((p, i) => ({
        playerId: p.playerId,
        finalRank: i + 1,
        remainingCards: [],
        scoreDelta: 0,
      })),
      winnerId: this.s.players[0]!.playerId,
    };
    return { ok: true, settlement };
  }

  /**
   * 結算分數：
   *  - 自摸 (selfDrawn): 三家各付 score → 贏家 +3*score                       // L2_鎖定
   *  - 食胡 (放炮 = payerIdx): 只有放炮者付 score → 贏家 +score；其餘 0       // L2_鎖定
   * payerIdx 在自摸時為 null；食胡時為 lastDiscard.playerIdx。
   */
  private settle(winnerIdx: number, selfDrawn: boolean, payerIdx: number | null, chiangKong = false): SettlementResult {
    this.s.phase = "settled";
    const winner = this.s.players[winnerIdx]!;
    // 自摸時贏牌即 drawnThisTurn；食胡時贏牌即 lastDiscard.tile。
    const winningTile: MahjongTile = selfDrawn
      ? (this.s.drawnThisTurn ?? winner.hand[winner.hand.length - 1]!)
      : (this.s.lastDiscard?.tile ?? winner.hand[winner.hand.length - 1]!);
    // 食胡時贏牌不在 hand；要把它加進去結構性台才算得對。               // L2_實作
    const handForFan: MahjongTile[] = selfDrawn ? winner.hand : [...winner.hand, winningTile];
    const fan = calcFan({
      selfDrawn,
      menqing: winner.exposed.every(m => m.kind === "kong_concealed"),
      exposed: winner.exposed,
      hand: handForFan,
      winningTile,
      isBanker: winnerIdx === this.s.dealerIdx,
      flowerCount: winner.flowers.length,
      drewFromKongReplacement: this.s.drewFromKongReplacement,
      lastWallDraw: this.s.drewLastWallTile,
      lastRiverHu: this.s.lastDiscardOnEmptyWall,
      chiangKong,
    });
    const score = fan.base + fan.fan;                   // MVP 簡化
    return {
      gameId: this.s.gameId,
      roundId: this.s.roundId,
      finishedAt: Date.now(),
      reason: "lastCardPlayed",
      winnerId: winner.playerId,
      players: this.s.players.map((p, i) => {
        let scoreDelta = 0;
        if (i === winnerIdx) {
          scoreDelta = selfDrawn ? score * 3 : score;
        } else if (selfDrawn) {
          scoreDelta = -score;
        } else if (i === payerIdx) {
          scoreDelta = -score;
        }
        return {
          playerId: p.playerId,
          finalRank: i === winnerIdx ? 1 : (i === payerIdx ? 4 : 2),
          remainingCards: [],
          scoreDelta,
        };
      }),
      fanDetail: { fan: fan.fan, base: fan.base, detail: fan.detail },
    };
  }
}

// ──────────────────────────────────────────────
//  輔助：建構 / 洗牌  (L2_鎖定)
// ──────────────────────────────────────────────
function buildShuffledWall(rng: () => number): MahjongTile[] {
  const wall: MahjongTile[] = [];
  for (const suit of SUIT_ORDER) {
    const max = suit === "z" ? 7 : 9;
    for (let r = 1; r <= max; r++) for (let k = 0; k < 4; k++) wall.push({ suit, rank: r });
  }
  // 8 unique flower / season tiles (春夏秋冬 + 梅蘭竹菊). They auto-replace
  // on draw and never sit in the active hand, but they still count as
  // visible bonus tiles displayed under the player's seat.               // L2_實作
  for (let r = 1; r <= 8; r++) wall.push({ suit: "f", rank: r });
  // Fisher–Yates，無 modulo bias                                                       // L2_鎖定
  for (let i = wall.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [wall[i], wall[j]] = [wall[j]!, wall[i]!];
  }
  return wall;
}

// 花牌處理 (L2_實作)
// drainFlowers: deal phase — 拿走 hand 中的花牌，從 wall 頭補新牌（可能再花，會循環）
// drawNonFlower: turn / kong 補張 — 從 wall 尾抽，遇花就吸收後續抽，回傳非花牌
function drainFlowers(hand: MahjongTile[], flowers: MahjongTile[], wall: MahjongTile[]): void {
  for (let i = 0; i < hand.length;) {
    if (hand[i]!.suit === "f") {
      flowers.push(hand[i]!);
      hand.splice(i, 1);
      const repl = wall.shift();
      if (!repl) return;
      hand.push(repl);
      // 不遞增 i — 新補的牌可能還是花牌
    } else {
      i++;
    }
  }
}
function drawNonFlower(wall: MahjongTile[], flowers: MahjongTile[]): MahjongTile | null {
  while (wall.length > 0) {
    const t = wall.pop()!;
    if (t.suit !== "f") return t;
    flowers.push(t);
  }
  return null;
}

function removeTilesFromHand(hand: MahjongTile[], tile: MahjongTile, n: number): void {
  for (let k = 0; k < n; k++) {
    const i = hand.findIndex(t => tileEq(t, tile));
    if (i < 0) throw new Error("INVARIANT_TILE_MISSING");                               // L2_隔離
    hand.splice(i, 1);
  }
}

function deepCopyMelds(m: ExposedMeld[]): ExposedMeld[] {
  return m.map(x => ({ kind: x.kind, tiles: x.tiles.map(t => ({ ...t })), fromPlayerId: x.fromPlayerId }));
}
