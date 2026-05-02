// Mirrored from src/client/GameSocket.ts — import path adjusted for frontend.
import type { PlayerAction, PlayerId, GameStateView, SettlementResult } from "./types";

export interface GameSocketConfig {
  url:         string;
  playerId:    PlayerId;
  gameId:      string;
  token:       string;
  /** When true, attaches `?spectator=1` so the DO accepts the WS without
   *  taking a seat. Spectator mode is read-only — calling `send()` will
   *  surface a server error frame. */
  spectator?:  boolean;
  maxRetries?: number;
  baseDelay?:  number;
  maxDelay?:   number;
  jitter?:     number;
  /** Periodic sync interval (ms) while connected. The DO has nothing
   *  built-in to keep the WS warm during long thinks — without traffic,
   *  intermediate proxies (Cloudflare's edge included, depending on
   *  config) eventually idle the connection out and force a reconnect.
   *  Sending a sync every 30s costs one tiny frame + one state echo
   *  back, well under any rate limit, and stops the silent dropouts.
   *  Set to 0 to disable (e.g., for tests). */
  keepAliveMs?: number;
}

type ServerMessage =
  | { type: "state";      payload: GameStateView }
  | { type: "settlement"; payload: SettlementResult }
  | { type: "system";     message: string }
  | { type: "error";      error: string };

interface SyncFrame { type: "sync"; gameId: string; playerId: PlayerId; }

export interface ActionFrame {
  gameId: string; playerId: PlayerId; seq: number; action: PlayerAction;
}

export type GameSocketEventMap = {
  connected:    [];
  disconnected: [info: DisconnectInfo];
  state:        [view: GameStateView];
  settlement:   [result: SettlementResult];
  system:       [message: string];
  error:        [message: string];
};

export interface DisconnectInfo {
  code: number; reason: string;
  willReconnect: boolean; attempt: number; nextDelayMs: number | null;
}

type Listener<K extends keyof GameSocketEventMap> = (...args: GameSocketEventMap[K]) => void;
export type SocketState = "idle" | "connecting" | "connected" | "reconnecting" | "terminated";

export class GameSocket {
  private readonly cfg: Required<GameSocketConfig>;
  private ws:            WebSocket | null = null;
  private status:        SocketState      = "idle";
  private seq:           number           = 0;
  private attempt:       number           = 0;
  private retryTimer:    ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private everConnected: boolean          = false;
  private readonly reg = new Map<keyof GameSocketEventMap, Set<Listener<never>>>();

  constructor(cfg: GameSocketConfig) {
    this.cfg = {
      maxRetries: Infinity, baseDelay: 1_000, maxDelay: 30_000, jitter: 0.25,
      spectator: false, keepAliveMs: 30_000, ...cfg,
    };
  }

  connect(): this { if (this.status === "idle") this.openSocket(); return this; }

  disconnect(): void {
    if (this.status === "terminated") return;
    this.status = "terminated";
    this.clearRetryTimer();
    this.clearKeepAlive();
    this.destroySocket(1000, "client disconnect");
    this.reg.clear();
  }

  send(action: PlayerAction): void {
    if (this.status !== "connected" || !this.ws)
      throw new Error(`GameSocket.send() called in state "${this.status}"`);
    const frame: ActionFrame = { gameId: this.cfg.gameId, playerId: this.cfg.playerId, seq: ++this.seq, action };
    this.ws.send(JSON.stringify(frame));
  }

  on<K extends keyof GameSocketEventMap>(event: K, handler: Listener<K>): () => void {
    if (!this.reg.has(event)) this.reg.set(event, new Set());
    this.reg.get(event)!.add(handler as Listener<never>);
    return () => this.off(event, handler);
  }

  off<K extends keyof GameSocketEventMap>(event: K, handler: Listener<K>): void {
    this.reg.get(event)?.delete(handler as Listener<never>);
  }

  getState(): SocketState { return this.status; }

  private openSocket(): void {
    this.status = this.attempt === 0 ? "connecting" : "reconnecting";
    const url = new URL(this.cfg.url);
    url.searchParams.set("playerId", this.cfg.playerId);
    url.searchParams.set("token",    this.cfg.token);
    if (this.cfg.spectator) url.searchParams.set("spectator", "1");
    const ws = new WebSocket(url.toString());
    ws.onopen    = this.onOpen;
    ws.onmessage = this.onMessage;
    ws.onclose   = this.onClose;
    ws.onerror   = this.onError;
    this.ws = ws;
  }

  private destroySocket(code: number, reason: string): void {
    if (!this.ws) return;
    const ws = this.ws; this.ws = null;
    ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null;
    try { ws.close(code, reason); } catch { /* already closed */ }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer !== null) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
  }

  private startKeepAlive(): void {
    this.clearKeepAlive();
    if (this.cfg.keepAliveMs <= 0) return;
    this.keepAliveTimer = setInterval(() => {
      // sendSync is a no-op when not in "connected" state, so a stale
      // timer firing during reconnect is benign. The frame itself is
      // tiny and the server's response is the same state we already
      // have — bandwidth-cheap.
      this.sendSync();
    }, this.cfg.keepAliveMs);
  }

  private onOpen = (): void => {
    const isReconnect = this.everConnected;
    this.status = "connected"; this.everConnected = true; this.attempt = 0;
    this.clearRetryTimer(); this.emit("connected");
    if (isReconnect) this.sendSync();
    this.startKeepAlive();
  };

  private onMessage = (ev: MessageEvent): void => {
    let raw: string;
    if (typeof ev.data === "string") raw = ev.data;
    else if (ev.data instanceof ArrayBuffer) raw = new TextDecoder().decode(ev.data);
    else { this.emit("error", "unsupported binary format"); return; }
    let msg: ServerMessage;
    try { msg = JSON.parse(raw) as ServerMessage; }
    catch { this.emit("error", "non-JSON message"); return; }
    switch (msg.type) {
      case "state":      this.emit("state",      msg.payload); break;
      case "settlement": this.emit("settlement", msg.payload); break;
      case "system":     this.emit("system",     msg.message); break;
      case "error":      this.emit("error",      msg.error);   break;
    }
  };

  private onClose = (ev: CloseEvent): void => {
    if (this.status === "terminated") return;
    this.ws = null;
    this.clearKeepAlive();
    const willReconnect = this.attempt < this.cfg.maxRetries;
    const nextDelayMs   = willReconnect ? this.nextDelay() : null;
    this.emit("disconnected", { code: ev.code, reason: ev.reason, willReconnect, attempt: this.attempt, nextDelayMs });
    if (willReconnect && nextDelayMs !== null) this.scheduleReconnect(nextDelayMs);
    else this.status = "terminated";
  };

  private onError = (): void => { this.emit("error", "WebSocket error"); };

  private scheduleReconnect(delayMs: number): void {
    this.status = "reconnecting"; this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.status !== "terminated") this.openSocket();
    }, delayMs);
  }

  private nextDelay(): number {
    const { baseDelay, maxDelay, jitter } = this.cfg;
    const expo  = Math.min(baseDelay * (2 ** this.attempt), maxDelay);
    const noise = expo * jitter * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(expo + noise));
  }

  private sendSync(): void {
    if (this.status !== "connected" || !this.ws) return;
    const frame: SyncFrame = { type: "sync", gameId: this.cfg.gameId, playerId: this.cfg.playerId };
    this.ws.send(JSON.stringify(frame));
  }

  private emit<K extends keyof GameSocketEventMap>(event: K, ...args: GameSocketEventMap[K]): void {
    this.reg.get(event)?.forEach(fn => {
      try { (fn as (...a: GameSocketEventMap[K]) => void)(...args); }
      catch (err) { console.error(`[GameSocket] "${event}" threw:`, err); }
    });
  }
}
