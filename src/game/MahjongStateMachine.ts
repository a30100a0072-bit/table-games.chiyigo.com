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
  }
}
function isSuited(i: number): boolean { return i < 27; }

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
//  台數計算（MVP — 平胡 / 自摸 / 門清）  (L2_待辦：大四喜/字一色/清一色精算)
// ──────────────────────────────────────────────
export interface FanResult {
  base: number;            // 底
  fan: number;             // 台
  detail: string[];
}
function calcFan(opts: {
  selfDrawn: boolean;
  menqing: boolean;        // 門前清（未吃碰）
  exposed: ExposedMeld[];
  hand: MahjongTile[];     // 含胡牌
  drewFromKongReplacement?: boolean;
}): FanResult {
  const detail: string[] = ["平胡"];
  let fan = 0;

  // 完整牌組（手牌 + 對外副露）— 所有結構性台用得上                       // L2_實作
  const all: MahjongTile[] = [...opts.hand, ...opts.exposed.flatMap(m => m.tiles)];

  // 清一色：全 m / p / s 同花色，無字牌
  // 字一色：全字牌
  const suits = new Set(all.map(t => t.suit));
  if (suits.size === 1) {
    if (suits.has("z")) { fan += 16; detail.push("字一色"); }
    else                { fan += 8;  detail.push("清一色"); }
  }

  // 大三元：中(z5) / 發(z6) / 白(z7) 三組刻子（≥3 張即視為刻子，含明刻 / 暗刻 / 槓）
  const honorCount = (rank: number) =>
    all.filter(t => t.suit === "z" && t.rank === rank).length;
  if (honorCount(5) >= 3 && honorCount(6) >= 3 && honorCount(7) >= 3) {
    fan += 8; detail.push("大三元");
  }

  // 大四喜：東(z1) / 南(z2) / 西(z3) / 北(z4) 四組刻子
  if (honorCount(1) >= 3 && honorCount(2) >= 3 && honorCount(3) >= 3 && honorCount(4) >= 3) {
    fan += 16; detail.push("大四喜");
  }

  // 槓上開花：開槓後從牌牆尾補一張，補到的牌正好胡（state machine 標記）   // L3_架構
  if (opts.drewFromKongReplacement && opts.selfDrawn) {
    fan += 1; detail.push("槓上開花");
  }

  if (opts.selfDrawn) { fan += 1; detail.push("自摸"); }
  if (opts.menqing)   { fan += 1; detail.push("門前清"); }
  if (opts.menqing && opts.selfDrawn) { fan += 1; detail.push("門清自摸"); }

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
  lastDiscard: { tile: MahjongTile; playerIdx: number } | null;
  pendingReactions: PendingReaction[];           // L3_架構
  reactionDeadlineMs: number;
  turnDeadlineMs: number;
  drawnThisTurn: MahjongTile | null;             // 本回合剛摸的牌（決定 menqing/自摸）
  drewFromKongReplacement: boolean;              // 補摸自槓尾，下一手胡計「槓上開花」 // L3_架構
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
    // 莊家補一張
    const banker = 0;
    const drawn = wall.shift()!;
    playerStates[banker]!.hand.push(drawn);

    this.s = {
      gameId,
      roundId,
      phase: "playing",
      players: playerStates,
      wall,
      turnIdx: banker,
      lastDiscard: null,
      pendingReactions: [],
      reactionDeadlineMs: 0,
      turnDeadlineMs: Date.now() + TURN_WINDOW_MS,
      drawnThisTurn: drawn,
      drewFromKongReplacement: false,
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
    } else {
      // 加槓：手中有 1 張，且 exposed 已有對應 pong
      const ownCount = me.hand.filter(t => tileEq(t, a.tile)).length;
      const targetMeld = me.exposed.find(m => m.kind === "pong" && m.tiles.every(t => tileEq(t, a.tile)));
      if (ownCount < 1 || !targetMeld) return { ok: false, error: "INVALID_ADDED_KONG" };  // L2_隔離
      removeTilesFromHand(me.hand, a.tile, 1);
      targetMeld.kind = "kong_exposed";
      targetMeld.tiles.push(a.tile);
    }
    // 槓後補一張
    const replacement = this.s.wall.pop();
    if (!replacement) return this.drawExhaustion();
    me.hand.push(replacement);
    this.s.drawnThisTurn = replacement;
    this.s.drewFromKongReplacement = true;        // 下一手自摸胡計槓上開花  // L3_架構
    return { ok: true };
  }

  // ─── 碰 ────────────────────────────────────
  private onPong(idx: number, a: MahjongPongAction): ProcessResult {
    if (this.s.phase !== "pending_reactions" || !this.s.lastDiscard) return { ok: false, error: "NO_PENDING_DISCARD" };
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
   * 強制結算 — DO timeout/disconnect 觸發；MVP 採「流局」處理：
   * 所有玩家 scoreDelta=0，winnerId 取首位（前端依 reason 顯示中止訊息）。 // L3_架構含防禦觀測
   */
  forceSettle(reason: "timeout" | "disconnect"): SettlementResult {
    if (this.s.phase === "settled") throw new Error("already settled");
    this.s.phase = "settled";
    return {
      gameId: this.s.gameId,
      roundId: this.s.roundId,
      finishedAt: Date.now(),
      reason,
      winnerId: this.s.players[0]!.playerId,
      players: this.s.players.map((p, i) => ({
        playerId: p.playerId,
        finalRank: i + 1,
        remainingCards: [],                                                  // L2_隔離
        scoreDelta: 0,
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
      const settlement = this.settle(winnerIdx, false, ld.playerIdx);
      return { ok: true, settlement };
    }

    // 2. 槓
    const kongR = this.s.pendingReactions.find(r => r.declared?.kind === "kong");
    if (kongR) {
      const i = this.s.players.findIndex(p => p.playerId === kongR.playerId);
      const me = this.s.players[i]!;
      removeTilesFromHand(me.hand, ld.tile, 3);
      me.exposed.push({ kind: "kong_exposed", tiles: [ld.tile, ld.tile, ld.tile, ld.tile], fromPlayerId: this.s.players[ld.playerIdx]!.playerId });
      this.s.lastDiscard = null;
      const replacement = this.s.wall.pop();
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
    this.s.lastDiscard = null;
    this.s.pendingReactions = [];
    this.s.turnIdx = (this.s.turnIdx + 1) % 4;
    const tile = this.s.wall.pop();
    if (!tile) return this.drawExhaustion();
    this.s.players[this.s.turnIdx]!.hand.push(tile);
    this.s.drawnThisTurn = tile;
    this.s.drewFromKongReplacement = false;       // 進入新一手 → 槓上開花失效
    this.s.phase = "playing";
    this.s.turnDeadlineMs = Date.now() + TURN_WINDOW_MS;
    return { ok: true };
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
  private settle(winnerIdx: number, selfDrawn: boolean, payerIdx: number | null): SettlementResult {
    this.s.phase = "settled";
    const winner = this.s.players[winnerIdx]!;
    const fan = calcFan({
      selfDrawn,
      menqing: winner.exposed.every(m => m.kind === "kong_concealed"),
      exposed: winner.exposed,
      hand: winner.hand,
      drewFromKongReplacement: this.s.drewFromKongReplacement,
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
  // Fisher–Yates，無 modulo bias                                                       // L2_鎖定
  for (let i = wall.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [wall[i], wall[j]] = [wall[j]!, wall[i]!];
  }
  return wall;
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
