// /src/do/GameRoomDO.ts
// Cloudflare Durable Object — room lifecycle, WebSocket sessions, alarm multiplexing.
// ZERO direct D1 writes; all settlement flows through SETTLEMENT_QUEUE.           // L3_架構含防禦觀測
// setTimeout is FORBIDDEN; every timeout uses state.storage.setAlarm().           // L3_架構含防禦觀測

import { BigTwoStateMachine } from "../game/BigTwoStateMachine";
import type { MachineSnapshot } from "../game/BigTwoStateMachine";
import type {
  PlayerId, ActionFrame, GameStateView,
  SettlementResult, SettlementQueueMessage,
} from "../types/game";

// ── Environment bindings ──────────────────────────────────────────── L2_模組
export interface Env {
  GAME_ROOM:        DurableObjectNamespace;
  SETTLEMENT_QUEUE: Queue<SettlementQueueMessage>;
}

// ── Storage key registry ─────────────────────────────────────────── L2_模組
const SK = {
  ROOM:    "room",
  MACHINE: "machine",
  SEQS:    "seqs",
  DISC:    "disconnected",
  ALARMS:  "alarms",
} as const;

// ── Per-connection metadata (lives inside WS attachment, survives hibernation) ──
interface WsAttachment {
  playerId:  PlayerId;
  sessionId: string;   // unique per TCP connection, not per player
}

// ─────────────────────────────────────────────────────────────────── L3_糾錯風險表
// CF DO exposes ONE alarm() slot. We multiplex multiple logical timers by keeping
// a sorted AlarmEntry[] in storage. On each alarm() fire, all due entries are
// processed and the clock is re-armed to the next nearest deadline.
// Risk: if setAlarm() is not called after every mutation of this.alarms, a timer
// will silently disappear. Always go through scheduleAlarm / cancelAlarm helpers.
interface AlarmEntry {
  kind:      "turn" | "reconnect";
  playerId?: PlayerId;
  deadline:  number;   // Unix ms
}

// ── Room metadata ────────────────────────────────────────────────── L2_模組
interface RoomMeta {
  gameId:    string;
  roundId:   string;
  phase:     "waiting" | "playing" | "settled";
  playerIds: PlayerId[];
  capacity:  number;
}

// 60-second reconnect grace window before forced settlement.            // L3_架構含防禦觀測
const RECONNECT_MS = 60_000;

// ── Durable Object ────────────────────────────────────────────────── L3_架構含防禦觀測

export class GameRoomDO implements DurableObject {

  private readonly state: DurableObjectState;
  private readonly env:   Env;

  // In-memory cache — always rebuilt from storage on cold-start / hibernation wake.
  private machine:      BigTwoStateMachine | null = null;
  private room:         RoomMeta | null           = null;
  private seqs:         Record<PlayerId, number>  = {};   // last accepted seq per player
  private disconnected: Record<PlayerId, number>  = {};   // playerId → disconnect timestamp ms
  private alarms:       AlarmEntry[]              = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env   = env;
    // blockConcurrencyWhile prevents stale reads after hibernation wake-up.  // L3_架構含防禦觀測
    this.state.blockConcurrencyWhile(() => this.hydrate());
  }

  // ── Cold-start / hibernation hydration ───────────────────────────── L3_架構含防禦觀測

  private async hydrate(): Promise<void> {
    const [room, snap, seqs, disc, alarms] = await Promise.all([
      this.state.storage.get<RoomMeta>(SK.ROOM),
      this.state.storage.get<MachineSnapshot>(SK.MACHINE),
      this.state.storage.get<Record<PlayerId, number>>(SK.SEQS),
      this.state.storage.get<Record<PlayerId, number>>(SK.DISC),
      this.state.storage.get<AlarmEntry[]>(SK.ALARMS),
    ]);
    this.room         = room   ?? null;
    this.seqs         = seqs   ?? {};
    this.disconnected = disc   ?? {};
    this.alarms       = alarms ?? [];
    if (snap) this.machine = BigTwoStateMachine.restore(snap);
  }

  // ── HTTP / WebSocket upgrade entry ──────────────────────────────── L2_模組

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/init")
      return this.handleInit(request);
    if (url.pathname === "/join" && request.headers.get("Upgrade") === "websocket")
      return this.handleJoin(request);
    return new Response("not found", { status: 404 });
  }

  // POST /init  body: { gameId, roundId, capacity }
  private async handleInit(request: Request): Promise<Response> {
    if (this.room) return new Response("already initialised", { status: 409 });
    const { gameId, roundId, capacity } = await request.json<{
      gameId: string; roundId: string; capacity: number;
    }>();
    if (capacity < 2 || capacity > 4)                                  // L3_糾錯風險表
      return new Response("capacity must be 2–4", { status: 400 });
    this.room = { gameId, roundId, phase: "waiting", playerIds: [], capacity };
    await this.state.storage.put(SK.ROOM, this.room);
    return Response.json({ ok: true, gameId });
  }

  // GET /join?playerId=xxx  (WebSocket upgrade)
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
      if (phase !== "waiting")         return new Response("game in progress",  { status: 409 });
      if (isKnown && !isDisconnected)  return new Response("already connected", { status: 409 });
      if (playerIds.length >= capacity) return new Response("room full",        { status: 409 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    const att: WsAttachment = { playerId, sessionId: crypto.randomUUID() };
    this.state.acceptWebSocket(server, [playerId]);   // Hibernation API  // L3_架構含防禦觀測
    server.serializeAttachment(att);

    if (isReconnect) {
      await this.cancelAlarm("reconnect", playerId);
      delete this.disconnected[playerId];
      await this.state.storage.put(SK.DISC, this.disconnected);
      if (this.machine)
        server.send(JSON.stringify({ type: "state", payload: this.machine.getView(playerId) }));
      this.broadcastSystemMsg(`${playerId} 已重連`);
    } else {
      this.room.playerIds.push(playerId);
      await this.state.storage.put(SK.ROOM, this.room);
      if (this.room.playerIds.length === capacity) await this.startGame();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Game start ────────────────────────────────────────────────────── L2_模組

  private async startGame(): Promise<void> {
    if (!this.room) return;
    this.room.phase = "playing";
    this.machine = new BigTwoStateMachine(
      this.room.gameId, this.room.roundId, this.room.playerIds,
    );
    await Promise.all([
      this.state.storage.put(SK.ROOM, this.room),
      this.persistMachine(),
    ]);
    this.broadcastViews();
    const deadline = this.machine.getView(this.room.playerIds[0]).turnDeadlineMs;
    await this.scheduleTurnAlarm(deadline);
  }

  // ── WebSocket Hibernation API ─────────────────────────────────────── L3_架構含防禦觀測

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

    // ── SYNC: client requests latest state after reconnect ────────────
    // GameSocket.ts sends { type:"sync" } immediately after re-open.
    if ((parsed as { type: string }).type === "sync") {
      if (this.machine)
        ws.send(JSON.stringify({ type: "state", payload: this.machine.getView(playerId) }));
      return;
    }

    const frame = parsed as ActionFrame;

    // Anti-replay: each player's seq must be strictly increasing.      // L3_糾錯風險表
    if (frame.seq <= (this.seqs[playerId] ?? -1)) {
      ws.send(JSON.stringify({ error: "stale or duplicate seq", seq: frame.seq }));
      return;
    }

    if (!this.machine || this.room?.phase !== "playing") {
      ws.send(JSON.stringify({ error: "game not active" }));
      return;
    }

    let result: ReturnType<BigTwoStateMachine["processAction"]>;
    try {
      result = this.machine.processAction(playerId, frame.action);
    } catch (err) {
      ws.send(JSON.stringify({ error: (err as Error).message }));
      return;
    }

    this.seqs[playerId] = frame.seq;
    await Promise.all([
      this.persistMachine(),
      this.state.storage.put(SK.SEQS, this.seqs),
    ]);

    this.broadcastViews(result.viewFor);

    if (result.settlement) {
      await this.handleSettlement(result.settlement);
    } else {
      const deadline = result.viewFor(this.room!.playerIds[0]).turnDeadlineMs;
      await this.scheduleTurnAlarm(deadline);
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

  // ── 60-second disconnect buffer ───────────────────────────────────── L3_架構含防禦觀測

  private async onDisconnect(playerId: PlayerId): Promise<void> {
    if (!this.room || this.disconnected[playerId] !== undefined) return;  // deduplicate close events

    this.disconnected[playerId] = Date.now();
    await this.state.storage.put(SK.DISC, this.disconnected);

    if (this.room.phase === "playing") {
      this.broadcastSystemMsg(`${playerId} 斷線 — ${RECONNECT_MS / 1000}s 內可重連`);
      await this.scheduleAlarm({                                          // L3_架構含防禦觀測
        kind: "reconnect", playerId, deadline: Date.now() + RECONNECT_MS,
      });
    } else {
      // Waiting room: schedule cleanup only if every seat is empty.
      const allGone = this.room.playerIds.every(id => this.disconnected[id] !== undefined);
      if (allGone)
        await this.scheduleAlarm({ kind: "reconnect", deadline: Date.now() + RECONNECT_MS });
    }
  }

  // ── Alarm multiplexer ─────────────────────────────────────────────── L3_糾錯風險表

  async alarm(): Promise<void> {
    const now   = Date.now();
    const FUDGE = 50;                                // ms tolerance for CF scheduling jitter
    const due   = this.alarms.filter(a => a.deadline <= now + FUDGE);
    this.alarms = this.alarms.filter(a => a.deadline  > now + FUDGE);
    await this.state.storage.put(SK.ALARMS, this.alarms);

    for (const entry of due) {
      if (entry.kind === "turn")      await this.onTurnTimeout();
      if (entry.kind === "reconnect") await this.onReconnectExpired(entry.playerId);
    }

    await this.rearmClock();
  }

  private async onTurnTimeout(): Promise<void> {
    if (!this.machine || this.room?.phase !== "playing") return;
    const settlement = this.machine.forceSettle("timeout");
    this.broadcastViews();
    await this.handleSettlement(settlement);
  }

  private async onReconnectExpired(playerId?: PlayerId): Promise<void> {
    if (!this.room) return;

    if (!playerId) {
      // Waiting room, every seat stayed empty → teardown.
      await this.cleanup(); return;
    }

    if (this.disconnected[playerId] === undefined) return; // player already reconnected

    if (this.room.phase === "playing" && this.machine) {
      const settlement = this.machine.forceSettle("disconnect");
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

  // ── Settlement → Queue  (NOT D1) ─────────────────────────────────── L3_架構含防禦觀測

  private async handleSettlement(result: SettlementResult): Promise<void> {
    const frame = JSON.stringify({ type: "settlement", payload: result });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(frame); } catch {}
    }
    // DO never writes D1 directly — Queue Consumer owns that persistence path. // L3_架構含防禦觀測
    await this.env.SETTLEMENT_QUEUE.send({ type: "settlement", payload: result });
    await this.cleanup();
  }

  // ── Broadcast helpers ─────────────────────────────────────────────── L2_模組

  private broadcastViews(viewFor?: (pid: PlayerId) => GameStateView): void {
    const fn = viewFor ?? ((pid: PlayerId) => this.machine?.getView(pid));
    for (const ws of this.state.getWebSockets()) {
      const att  = ws.deserializeAttachment() as WsAttachment | null;
      if (!att) continue;
      const view = fn(att.playerId);
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

  // ── Alarm plumbing helpers ────────────────────────────────────────── L3_糾錯風險表

  private async scheduleTurnAlarm(deadline: number): Promise<void> {
    this.alarms = this.alarms.filter(a => a.kind !== "turn"); // one turn alarm at a time
    this.alarms.push({ kind: "turn", deadline });
    await this.saveAlarms();
    await this.rearmClock();
  }

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
    if (this.machine) await this.state.storage.put(SK.MACHINE, this.machine.snapshot());
  }

  // ── Resource cleanup  (防幽靈計費) ───────────────────────────────── L3_架構含防禦觀測

  private async cleanup(): Promise<void> {
    for (const ws of this.state.getWebSockets()) {
      try { ws.close(1000, "room closed"); } catch {}
    }
    // Cancel alarm before deleteAll — prevents a phantom re-fire on a dead DO.  // L3_糾錯風險表
    await this.state.storage.deleteAlarm();
    // Wipe all DO storage — stops Cloudflare from billing a ghost Durable Object. // L3_架構含防禦觀測
    await this.state.storage.deleteAll();
    this.machine      = null;
    this.room         = null;
    this.seqs         = {};
    this.disconnected = {};
    this.alarms       = [];
  }
}
