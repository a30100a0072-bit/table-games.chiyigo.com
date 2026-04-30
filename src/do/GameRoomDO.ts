// /src/do/GameRoomDO.ts
// Cloudflare Durable Object — room lifecycle, WebSocket sessions, alarm multiplexing.
// ZERO direct D1 writes; all settlement flows through SETTLEMENT_QUEUE.           // L3_架構含防禦觀測
// setTimeout is FORBIDDEN; every timeout uses state.storage.setAlarm().           // L3_架構含防禦觀測
//
// 多遊戲版本：透過 IGameEngine 適配層支援 bigTwo / mahjong / texas。              // L2_模組
// 機器人補位目前僅支援 bigTwo（其它遊戲 Lobby 不會塞 BOT_）。                     // L2_實作

import { createEngine, restoreEngine } from "../game/GameEngineAdapter";
import type { IGameEngine } from "../game/GameEngineAdapter";
import { getBigTwoBotAction, getMahjongBotAction, getTexasBotAction } from "../game/BotAI";
import type {
  PlayerAction,
  PlayerId, ActionFrame, GameType, GameStateView, MahjongStateView, PokerStateView,
  SettlementResult, SettlementQueueMessage,
} from "../types/game";
import { isGameType } from "../types/game";

// ── Environment bindings ──────────────────────────────────────────────── L2_模組
export interface Env {
  GAME_ROOM:        DurableObjectNamespace;
  SETTLEMENT_QUEUE: Queue<SettlementQueueMessage>;
  MATCH_KV:         KVNamespace;       // cleared on cleanup so players can rejoin // L2_隔離
}

// ── Storage key registry ─────────────────────────────────────────────── L2_模組
const SK = {
  ROOM:    "room",
  MACHINE: "machine",
  SEQS:    "seqs",
  DISC:    "disconnected",
  ALARMS:  "alarms",
} as const;

interface WsAttachment {
  playerId:  PlayerId;
  sessionId: string;
}

// ─────────────────────────────────────────────────────────────────────── L3_架構含防禦觀測
// "bot"   — fires after a bot's think delay, triggering its BotAI.        // L2_實作
// "react" — Mahjong-only; fires when reactionDeadlineMs expires so the
//           state machine can collapse unresolved reactions to pass.       // L3_架構
// One CF alarm slot is multiplexed across all alarm kinds.
interface AlarmEntry {
  kind:      "turn" | "reconnect" | "bot" | "react";
  playerId?: PlayerId;
  deadline:  number;
}

interface RoomMeta {
  gameId:    string;
  roundId:   string;
  gameType:  GameType;                           // L2_模組
  phase:     "waiting" | "playing" | "settled";
  playerIds: PlayerId[];
  capacity:  number;
}

const RECONNECT_MS  = 60_000;
const BOT_THINK_MS  = 1_500;    // simulated think time for active turns       // L2_實作
const BOT_REACT_MS  = 250;      // mahjong reaction snap delay (≪ 3.5s window) // L2_實作
const BOT_PREFIX    = "BOT_";
const isBot = (id: PlayerId): boolean => id.startsWith(BOT_PREFIX);

export class GameRoomDO implements DurableObject {

  private readonly state: DurableObjectState;
  private readonly env:   Env;

  private engine:       IGameEngine | null = null;
  private room:         RoomMeta | null    = null;
  private seqs:         Record<PlayerId, number>  = {};
  private disconnected: Record<PlayerId, number>  = {};
  private alarms:       AlarmEntry[]              = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env   = env;
    this.state.blockConcurrencyWhile(() => this.hydrate());
  }

  private async hydrate(): Promise<void> {
    const [room, snap, seqs, disc, alarms] = await Promise.all([
      this.state.storage.get<RoomMeta>(SK.ROOM),
      this.state.storage.get<unknown>(SK.MACHINE),
      this.state.storage.get<Record<PlayerId, number>>(SK.SEQS),
      this.state.storage.get<Record<PlayerId, number>>(SK.DISC),
      this.state.storage.get<AlarmEntry[]>(SK.ALARMS),
    ]);
    this.room         = room   ?? null;
    this.seqs         = seqs   ?? {};
    this.disconnected = disc   ?? {};
    this.alarms       = alarms ?? [];
    if (snap && this.room) this.engine = restoreEngine(this.room.gameType, snap);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/init")
      return this.handleInit(request);
    if (url.pathname === "/join" && request.headers.get("Upgrade") === "websocket")
      return this.handleJoin(request);
    return new Response("not found", { status: 404 });
  }

  // POST /init  body: { gameId, roundId, gameType, capacity, botIds?: string[] }
  // botIds pre-populates bot seats so the game starts as soon as human
  // players fill the remaining slots via WebSocket.                      // L2_實作
  private async handleInit(request: Request): Promise<Response> {
    if (this.room) return new Response("already initialised", { status: 409 });
    const { gameId, roundId, gameType, capacity, botIds = [] } = await request.json<{
      gameId: string; roundId: string; gameType?: string; capacity: number; botIds?: string[];
    }>();
    if (capacity < 2 || capacity > 4)
      return new Response("capacity must be 2–4", { status: 400 });

    // 預設保留 bigTwo 以維持既有 /rooms 端點向下相容。                     // L2_隔離
    const gt: GameType = isGameType(gameType) ? gameType : "bigTwo";
    if (gt === "mahjong" && capacity !== 4)
      return new Response("mahjong requires capacity=4", { status: 400 });

    this.room = {
      gameId, roundId, gameType: gt, phase: "waiting",
      playerIds: [...botIds], capacity,
    };
    await this.state.storage.put(SK.ROOM, this.room);

    // Edge case: all-bot room (tests / future use).
    if (this.room.playerIds.length === capacity) await this.startGame();

    return Response.json({ ok: true, gameId, gameType: gt });
  }

  private async handleJoin(request: Request): Promise<Response> {
    if (!this.room)
      return new Response("room not found", { status: 404 });
    if (this.room.phase === "settled")
      return new Response("game already settled", { status: 410 });

    const url      = new URL(request.url);
    const playerId = url.searchParams.get("playerId");
    if (!playerId)
      return new Response("missing playerId", { status: 400 });

    const { phase, playerIds, capacity } = this.room;
    const isKnown        = playerIds.includes(playerId);
    const isDisconnected = this.disconnected[playerId] !== undefined;
    const isReconnect    = isKnown && isDisconnected;

    if (!isReconnect) {
      if (phase !== "waiting")          return new Response("game in progress",  { status: 409 });
      if (isKnown && !isDisconnected)   return new Response("already connected", { status: 409 });
      if (playerIds.length >= capacity) return new Response("room full",         { status: 409 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    const att: WsAttachment = { playerId, sessionId: crypto.randomUUID() };
    this.state.acceptWebSocket(server, [playerId]);
    server.serializeAttachment(att);

    if (isReconnect) {
      await this.cancelAlarm("reconnect", playerId);
      delete this.disconnected[playerId];
      await this.state.storage.put(SK.DISC, this.disconnected);
      if (this.engine)
        server.send(JSON.stringify({ type: "state", payload: this.engine.getView(playerId) }));
      this.broadcastSystemMsg(`${playerId} 已重連`);
    } else {
      this.room.playerIds.push(playerId);
      await this.state.storage.put(SK.ROOM, this.room);
      // Bot seats are pre-counted; startGame fires when capacity is reached. // L2_實作
      if (this.room.playerIds.length === capacity) await this.startGame();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Game start ────────────────────────────────────────────────────────── L2_模組

  private async startGame(): Promise<void> {
    if (!this.room) return;
    this.room.phase = "playing";
    this.engine = createEngine({
      gameType:  this.room.gameType,
      gameId:    this.room.gameId,
      roundId:   this.room.roundId,
      playerIds: this.room.playerIds,
    });
    await Promise.all([
      this.state.storage.put(SK.ROOM, this.room),
      this.persistMachine(),
    ]);
    this.broadcastViews();
    // Mahjong pending_reactions uses reactionDeadlineMs; others use turnDeadlineMs. // L2_鎖定
    await this.scheduleNextDeadline();
    // If the seat that should act is a bot, schedule bot action.          // L2_實作
    await this.checkBotTurn();
  }

  // ── WebSocket Hibernation API ─────────────────────────────────────────── L3_架構含防禦觀測

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (!att) { ws.close(1011, "missing attachment"); return; }
    const { playerId } = att;

    let parsed: ActionFrame | { type: "sync" };
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      ws.send(JSON.stringify({ error: "invalid JSON" }));
      return;
    }

    if ((parsed as { type: string }).type === "sync") {
      if (this.engine)
        ws.send(JSON.stringify({ type: "state", payload: this.engine.getView(playerId) }));
      return;
    }

    const frame = parsed as ActionFrame;

    if (frame.seq <= (this.seqs[playerId] ?? -1)) {
      ws.send(JSON.stringify({ error: "stale or duplicate seq", seq: frame.seq }));
      return;
    }

    if (!this.engine || this.room?.phase !== "playing") {
      ws.send(JSON.stringify({ error: "game not active" }));
      return;
    }

    let outcome: ReturnType<IGameEngine["processAction"]>;
    try {
      outcome = this.engine.processAction(playerId, frame.action);
    } catch (err) {
      ws.send(JSON.stringify({ error: (err as Error).message }));
      return;
    }

    this.seqs[playerId] = frame.seq;
    await Promise.all([
      this.persistMachine(),
      this.state.storage.put(SK.SEQS, this.seqs),
    ]);

    this.broadcastViews();

    if (outcome.settlement) {
      await this.handleSettlement(outcome.settlement);
    } else {
      await this.scheduleNextDeadline();
      // Schedule bot action if the next seat is a bot.                  // L2_實作
      await this.checkBotTurn();
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (att) await this.onDisconnect(att.playerId);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const att = ws.deserializeAttachment() as WsAttachment | null;
    if (att) await this.onDisconnect(att.playerId);
  }

  // ── 60-second disconnect buffer ───────────────────────────────────────── L3_架構含防禦觀測

  private async onDisconnect(playerId: PlayerId): Promise<void> {
    if (!this.room || this.disconnected[playerId] !== undefined) return;

    this.disconnected[playerId] = Date.now();
    await this.state.storage.put(SK.DISC, this.disconnected);

    if (this.room.phase === "playing") {
      this.broadcastSystemMsg(`${playerId} 斷線 — ${RECONNECT_MS / 1000}s 內可重連`);
      await this.scheduleAlarm({
        kind: "reconnect", playerId, deadline: Date.now() + RECONNECT_MS,
      });
    } else {
      const allGone = this.room.playerIds.every(id => this.disconnected[id] !== undefined);
      if (allGone)
        await this.scheduleAlarm({ kind: "reconnect", deadline: Date.now() + RECONNECT_MS });
    }
  }

  // ── Alarm multiplexer ─────────────────────────────────────────────────── L3_架構含防禦觀測

  async alarm(): Promise<void> {
    const now   = Date.now();
    const FUDGE = 50;
    const due   = this.alarms.filter(a => a.deadline <= now + FUDGE);
    this.alarms = this.alarms.filter(a => a.deadline  > now + FUDGE);
    await this.state.storage.put(SK.ALARMS, this.alarms);

    for (const entry of due) {
      if (entry.kind === "turn")      await this.onTurnTimeout();
      if (entry.kind === "reconnect") await this.onReconnectExpired(entry.playerId);
      if (entry.kind === "bot")       await this.onBotTurn(entry.playerId!); // L2_實作
      if (entry.kind === "react")     await this.onReactionTimeout();        // L3_架構
    }

    await this.rearmClock();
  }

  private async onTurnTimeout(): Promise<void> {
    if (!this.engine || this.room?.phase !== "playing") return;
    // 逾時 = 當前行動者棄局，由其承擔 forfeit penalty；bots 沒錢包，不處罰。 // L2_實作
    const offender = this.engine.currentTurn();
    const settlement = this.engine.forceSettle("timeout", isBot(offender) ? undefined : offender);
    this.broadcastViews();
    await this.handleSettlement(settlement);
  }

  private async onReconnectExpired(playerId?: PlayerId): Promise<void> {
    if (!this.room) return;

    if (!playerId) {
      await this.cleanup(); return;
    }
    if (this.disconnected[playerId] === undefined) return;

    if (this.room.phase === "playing" && this.engine) {
      // 60s 重連寬限期過了還沒回來 = 棄局，由斷線玩家承擔 forfeit。           // L2_實作
      const settlement = this.engine.forceSettle("disconnect", isBot(playerId) ? undefined : playerId);
      this.broadcastViews();
      await this.handleSettlement(settlement);
    } else {
      this.room.playerIds = this.room.playerIds.filter(id => id !== playerId);
      delete this.disconnected[playerId];
      if (this.room.playerIds.length === 0) {
        await this.cleanup();
      } else {
        await this.state.storage.put(SK.ROOM, this.room);
        await this.state.storage.put(SK.DISC, this.disconnected);
      }
    }
  }

  // ── Bot turn execution ────────────────────────────────────────────────── L2_實作
  // Dispatches to the right BotAI based on gameType + current phase.       // L2_模組

  private async onBotTurn(botId: PlayerId): Promise<void> {
    if (!this.engine || this.room?.phase !== "playing") return;
    const gt = this.room.gameType;

    // Compute action; null = bot has no current obligation (race condition). // L3_架構含防禦觀測
    let action: PlayerAction | null;
    try {
      action = this.computeBotAction(gt, botId);
    } catch (err) {
      console.error(`[BotAI] action computation failed for ${botId}:`, err);
      action = null;
    }
    if (!action) return;     // turn moved on while we were waiting — drop silently // L3_架構含防禦觀測

    let outcome: ReturnType<IGameEngine["processAction"]>;
    try {
      outcome = this.engine.processAction(botId, action);
    } catch (err) {
      // BotAI produced an invalid action — force-settle to prevent deadlock. // L3_架構含防禦觀測
      console.error(`[BotAI] invalid action for ${botId}:`, err);
      const settlement = this.engine.forceSettle("disconnect");
      this.broadcastViews();
      await this.handleSettlement(settlement);
      return;
    }

    await this.persistMachine();
    this.broadcastViews();

    if (outcome.settlement) {
      await this.handleSettlement(outcome.settlement);
    } else {
      await this.scheduleNextDeadline();
      // Chain: if the next player (or another reaction-bot) is a bot, schedule it. // L2_實作
      await this.checkBotTurn();
    }
  }

  /** Compute the bot's intended action for the current engine state.        // L2_模組 */
  private computeBotAction(gt: GameType, botId: PlayerId): PlayerAction | null {
    if (!this.engine) return null;
    if (gt === "bigTwo") {
      const v = this.engine.getView(botId) as GameStateView;
      if (v.currentTurn !== botId) return null;
      return getBigTwoBotAction(v, v.self.hand);
    }
    if (gt === "texas") {
      const v = this.engine.getView(botId) as PokerStateView;
      if (v.currentTurn !== botId) return null;
      return getTexasBotAction(v);
    }
    // mahjong: bot may be the active discarder or one of the 3 reactors.
    const v = this.engine.getView(botId) as MahjongStateView;
    const isReactor = v.phase === "pending_reactions" && v.awaitingReactionsFrom.includes(botId);
    const isOnTurn  = v.phase === "playing" && v.currentTurn === botId;
    if (!isReactor && !isOnTurn) return null;
    return getMahjongBotAction(v);
  }

  // ── Bot-turn check ────────────────────────────────────────────────────── L2_實作
  // Called after every turn transition (human action, bot action, or game start).
  // Schedules the next bot alarm for whichever bot owes an action right now.

  private async checkBotTurn(): Promise<void> {
    if (!this.engine || this.room?.phase !== "playing") return;
    const gt = this.room.gameType;

    if (gt === "bigTwo" || gt === "texas") {
      const currentTurn = this.engine.currentTurn();
      if (!isBot(currentTurn)) return;
      this.alarms = this.alarms.filter(a => a.kind !== "turn");
      await this.scheduleAlarm({
        kind: "bot", playerId: currentTurn, deadline: Date.now() + BOT_THINK_MS,
      });
      return;
    }

    // Mahjong: pending_reactions may have multiple bots owing; schedule one at a time. // L2_實作
    const view = this.engine.getView(this.room.playerIds[0]!) as MahjongStateView;
    if (view.phase === "pending_reactions") {
      const botToReact = view.awaitingReactionsFrom.find(isBot);
      if (!botToReact) return;
      await this.scheduleAlarm({
        kind: "bot", playerId: botToReact, deadline: Date.now() + BOT_REACT_MS,
      });
      return;
    }
    if (view.phase === "playing" && isBot(view.currentTurn)) {
      this.alarms = this.alarms.filter(a => a.kind !== "turn");
      await this.scheduleAlarm({
        kind: "bot", playerId: view.currentTurn, deadline: Date.now() + BOT_THINK_MS,
      });
    }
  }

  // ── Mahjong reaction-window timeout ──────────────────────────────────── L3_架構
  // Fires when reactionDeadlineMs elapses and at least one human still owes a reaction.
  // Engine collapses outstanding reactions to pass and commits highest priority.

  private async onReactionTimeout(): Promise<void> {
    if (!this.engine || this.room?.phase !== "playing") return;
    if (this.room.gameType !== "mahjong") return;
    const outcome = this.engine.tickReactionDeadline();
    await this.persistMachine();
    this.broadcastViews();
    if (outcome.settlement) {
      await this.handleSettlement(outcome.settlement);
      return;
    }
    await this.scheduleNextDeadline();
    await this.checkBotTurn();
  }

  // ── Settlement → Queue ────────────────────────────────────────────────── L3_架構含防禦觀測

  private async handleSettlement(result: SettlementResult): Promise<void> {
    const frame = JSON.stringify({ type: "settlement", payload: result });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(frame); } catch {}
    }
    await this.env.SETTLEMENT_QUEUE.send({ type: "settlement", payload: result });
    await this.cleanup();
  }

  // ── Broadcast helpers ─────────────────────────────────────────────────── L2_模組

  private broadcastViews(): void {
    if (!this.engine) return;
    for (const ws of this.state.getWebSockets()) {
      const att  = ws.deserializeAttachment() as WsAttachment | null;
      if (!att) continue;
      const view = this.engine.getView(att.playerId);
      if (!view) continue;
      try { ws.send(JSON.stringify({ type: "state", payload: view })); } catch {}
    }
  }

  private broadcastSystemMsg(message: string): void {
    const payload = JSON.stringify({ type: "system", message });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(payload); } catch {}
    }
  }

  /**
   * Schedule the next phase-appropriate deadline alarm.
   *  - mahjong + pending_reactions → "react" alarm at reactionDeadlineMs
   *  - everything else             → "turn"  alarm at turnDeadlineMs
   * Replaces any pre-existing turn/react alarm (mutually exclusive).        // L2_鎖定
   */
  private async scheduleNextDeadline(): Promise<void> {
    if (!this.engine || !this.room) return;
    this.alarms = this.alarms.filter(a => a.kind !== "turn" && a.kind !== "react");

    if (this.room.gameType === "mahjong") {
      const v = this.engine.getView(this.room.playerIds[0]!) as MahjongStateView;
      if (v.phase === "pending_reactions" && typeof v.reactionDeadlineMs === "number" && v.reactionDeadlineMs > 0) {
        this.alarms.push({ kind: "react", deadline: v.reactionDeadlineMs });
        await this.saveAlarms();
        await this.rearmClock();
        return;
      }
    }

    const view = this.engine.getView(this.room.playerIds[0]!) as { turnDeadlineMs?: number };
    if (typeof view.turnDeadlineMs === "number") {
      this.alarms.push({ kind: "turn", deadline: view.turnDeadlineMs });
    }
    await this.saveAlarms();
    await this.rearmClock();
  }

  // ── Alarm plumbing ────────────────────────────────────────────────────── L3_架構含防禦觀測

  private async scheduleAlarm(entry: AlarmEntry): Promise<void> {
    this.alarms.push(entry);
    await this.saveAlarms();
    await this.rearmClock();
  }

  private async cancelAlarm(kind: AlarmEntry["kind"], playerId?: PlayerId): Promise<void> {
    this.alarms = this.alarms.filter(a => !(a.kind === kind && a.playerId === playerId));
    await this.saveAlarms();
    await this.rearmClock();
  }

  private async saveAlarms(): Promise<void> {
    await this.state.storage.put(SK.ALARMS, this.alarms);
  }

  private async rearmClock(): Promise<void> {
    if (this.alarms.length === 0) {
      await this.state.storage.deleteAlarm();
    } else {
      await this.state.storage.setAlarm(Math.min(...this.alarms.map(a => a.deadline)));
    }
  }

  private async persistMachine(): Promise<void> {
    if (this.engine) await this.state.storage.put(SK.MACHINE, this.engine.snapshot());
  }

  private async cleanup(): Promise<void> {
    // Clear MATCH_KV `room:{pid}` for every human player so they can rejoin a new lobby. // L2_隔離
    // Bots never make match requests so they have no KV entries.
    const humanIds = (this.room?.playerIds ?? []).filter(id => !isBot(id));
    await Promise.all(humanIds.map(id => this.env.MATCH_KV.delete(`room:${id}`).catch(() => {})));

    for (const ws of this.state.getWebSockets()) {
      try { ws.close(1000, "room closed"); } catch {}
    }
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
    this.engine       = null;
    this.room         = null;
    this.seqs         = {};
    this.disconnected = {};
    this.alarms       = [];
  }
}
