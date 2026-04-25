// /src/client/GameSocket.ts
// Framework-agnostic WebSocket SDK — Browser / React Native / Flutter Webview.

import type {
  PlayerAction, ActionFrame, GameStateView,
  SettlementResult, PlayerId,
} from "../types/game";

// ─────────────────────────────────────────────────────────────────── L3_代碼附資源清單
// Runtime resources owned by one GameSocket instance:
//   • WebSocket         — 1 instance, torn down on close, replaced on reconnect
//   • setTimeout timer  — at most 1 (reconnect backoff), cleared on disconnect()
//   • Map<event, Set>   — listener registry, fully cleared on disconnect()
// External APIs used: globalThis.WebSocket, globalThis.setTimeout,
//                     globalThis.clearTimeout, Math.random (jitter only — not security)
// ─────────────────────────────────────────────────────────────────── L3_代碼附資源清單

// ── Config ────────────────────────────────────────────────────────── L2_模組

export interface GameSocketConfig {
  /** Full WS/WSS URL to the GameRoomDO /join endpoint. */
  url:          string;
  playerId:     PlayerId;
  gameId:       string;
  /** JWT Bearer — appended as `?token=` (Authorization header unsupported in WS). */
  token:        string;
  /** Default: Infinity */
  maxRetries?:  number;
  /** Base reconnect delay in ms. Default: 1 000 */
  baseDelay?:   number;
  /** Maximum reconnect delay in ms. Default: 30 000 */
  maxDelay?:    number;
  /** Jitter fraction 0–1 (prevents thundering herd). Default: 0.25 */
  jitter?:      number;
}

// ── Server → Client message shapes ───────────────────────────────── L2_模組

type ServerMessage =
  | { type: "state";      payload: GameStateView }
  | { type: "settlement"; payload: SettlementResult }
  | { type: "system";     message: string }
  | { type: "error";      error: string };

// ── Sync frame ────────────────────────────────────────────────────── L3_邏輯安防
// Sent after reconnect to request the latest GameStateView.
// Server (GameRoomDO.ts webSocketMessage) must detect `type === "sync"`
// and respond with { type: "state", payload: machine.getView(playerId) }.
interface SyncFrame {
  type:     "sync";
  gameId:   string;
  playerId: PlayerId;
}

// ── Typed event map ───────────────────────────────────────────────── L2_模組

export type GameSocketEventMap = {
  /** Fires on every successful (re)connection. */
  connected:    [];
  /** Fires when the socket closes; includes whether a retry is scheduled. */
  disconnected: [info: DisconnectInfo];
  /** Latest perspective-isolated game state from the server. */
  state:        [view: GameStateView];
  /** Game over — final ranking and scores. */
  settlement:   [result: SettlementResult];
  /** Server-sent system notice (disconnect/reconnect notifications). */
  system:       [message: string];
  /** Protocol or server error string. */
  error:        [message: string];
};

export interface DisconnectInfo {
  code:          number;
  reason:        string;
  willReconnect: boolean;
  attempt:       number;
  nextDelayMs:   number | null;
}

type Listener<K extends keyof GameSocketEventMap> =
  (...args: GameSocketEventMap[K]) => void;

// ── Socket state ─────────────────────────────────────────────────── L2_模組

export type SocketState =
  | "idle"          // not yet connected
  | "connecting"    // first-time connect in progress
  | "connected"     // open and ready
  | "reconnecting"  // backoff timer running or new WS being opened
  | "terminated";   // disconnect() called; instance is dead

// ══════════════════════════════════════════════════════════════════════
//  GameSocket
// ══════════════════════════════════════════════════════════════════════

export class GameSocket {

  private readonly cfg: Required<GameSocketConfig>;

  private ws:               WebSocket | null = null;
  private status:           SocketState      = "idle";
  private seq:              number           = 0;    // monotone; never reset across reconnects
  private attempt:          number           = 0;
  private retryTimer:       ReturnType<typeof setTimeout> | null = null;
  private everConnected:    boolean          = false; // true after first successful open

  private readonly reg = new Map<keyof GameSocketEventMap, Set<Listener<any>>>();

  constructor(cfg: GameSocketConfig) {
    this.cfg = {
      maxRetries: Infinity,
      baseDelay:  1_000,
      maxDelay:   30_000,
      jitter:     0.25,
      ...cfg,
    };
  }

  // ── Public API ───────────────────────────────────────────────────── L2_模組

  /** Open the connection. No-op if already connecting/connected. */
  connect(): this {
    if (this.status !== "idle") return this;
    this.openSocket();
    return this;
  }

  /**
   * Permanently close and clean up all resources.
   * After calling this, the instance must be discarded.              // L3_代碼附資源清單
   */
  disconnect(): void {
    if (this.status === "terminated") return;
    this.status = "terminated";
    this.clearRetryTimer();                          // clear backoff timer // L3_代碼附資源清單
    this.destroySocket(1000, "client disconnect");   // remove WS listeners // L3_代碼附資源清單
    this.reg.clear();                                // drop all listeners   // L3_代碼附資源清單
  }

  /**
   * Send a PlayerAction to the server.
   * Throws if the socket is not in "connected" state.                // L3_邏輯安防
   */
  send(action: PlayerAction): void {
    if (this.status !== "connected" || !this.ws)                      // L3_邏輯安防
      throw new Error(`GameSocket.send() called in state "${this.status}"`);

    const frame: ActionFrame = {
      gameId:   this.cfg.gameId,
      playerId: this.cfg.playerId,
      seq:      ++this.seq,    // seq persists across reconnects — server checks monotonicity
      action,
    };
    this.ws.send(JSON.stringify(frame));
  }

  /**
   * Subscribe to an event.
   * Returns an unsubscribe function — suitable for React useEffect / Vue onUnmounted.
   */
  on<K extends keyof GameSocketEventMap>(
    event:   K,
    handler: Listener<K>,
  ): () => void {
    if (!this.reg.has(event)) this.reg.set(event, new Set());
    this.reg.get(event)!.add(handler as Listener<any>);
    return () => this.off(event, handler);
  }

  off<K extends keyof GameSocketEventMap>(
    event:   K,
    handler: Listener<K>,
  ): void {
    this.reg.get(event)?.delete(handler as Listener<any>);
  }

  getState(): SocketState { return this.status; }

  // ── Socket lifecycle ─────────────────────────────────────────────── L3_邏輯安防

  private openSocket(): void {
    this.status = this.attempt === 0 ? "connecting" : "reconnecting";

    const url = new URL(this.cfg.url);
    url.searchParams.set("playerId", this.cfg.playerId);
    url.searchParams.set("token",    this.cfg.token);   // JWT in query string // L3_邏輯安防

    const ws     = new WebSocket(url.toString());
    ws.onopen    = this.onOpen;
    ws.onmessage = this.onMessage;
    ws.onclose   = this.onClose;
    ws.onerror   = this.onError;
    this.ws = ws;
  }

  /**
   * Detach all handlers and close the socket.
   * Nullifying handlers before close prevents a recursive onClose callback. // L3_代碼附資源清單
   */
  private destroySocket(code: number, reason: string): void {
    if (!this.ws) return;
    const ws     = this.ws;
    this.ws      = null;
    ws.onopen    = null;   // L3_代碼附資源清單
    ws.onmessage = null;   // L3_代碼附資源清單
    ws.onclose   = null;   // L3_代碼附資源清單
    ws.onerror   = null;   // L3_代碼附資源清單
    try { ws.close(code, reason); } catch { /* already closed */ }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;                                          // L3_代碼附資源清單
    }
  }

  // ── WebSocket event handlers (arrow fns — bound to instance) ─────── L3_邏輯安防

  private onOpen = (): void => {
    const isReconnect = this.everConnected;
    this.status       = "connected";
    this.everConnected = true;
    this.attempt      = 0;
    this.clearRetryTimer();
    this.emit("connected");

    // After a reconnect, request the latest state from the server.   // L3_邏輯安防
    if (isReconnect) this.sendSync();
  };

  private onMessage = (ev: MessageEvent): void => {
    // Normalise binary or text payloads.                              // L3_邏輯安防
    let raw: string;
    if (typeof ev.data === "string") {
      raw = ev.data;
    } else if (ev.data instanceof ArrayBuffer) {
      raw = new TextDecoder().decode(ev.data);
    } else {
      this.emit("error", "unsupported binary message format (Blob)");
      return;
    }

    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      this.emit("error", "received non-JSON message from server");    // L3_邏輯安防
      return;
    }

    switch (msg.type) {
      case "state":      this.emit("state",      msg.payload); break;
      case "settlement": this.emit("settlement", msg.payload); break;
      case "system":     this.emit("system",     msg.message); break;
      case "error":      this.emit("error",      msg.error);   break;
      // Unknown type: silently drop — forward-compatible.            // L3_邏輯安防
    }
  };

  private onClose = (ev: CloseEvent): void => {
    if (this.status === "terminated") return;  // explicit disconnect() — skip retry

    this.ws = null;

    const willReconnect = this.attempt < this.cfg.maxRetries;
    const nextDelayMs   = willReconnect ? this.nextDelay() : null;

    this.emit("disconnected", {
      code: ev.code,
      reason: ev.reason,
      willReconnect,
      attempt:     this.attempt,
      nextDelayMs,
    });

    if (willReconnect && nextDelayMs !== null) {
      this.scheduleReconnect(nextDelayMs);
    } else {
      this.status = "terminated";
    }
  };

  private onError = (): void => {
    // onerror provides no useful detail; onClose fires immediately after.
    // Emit early so the UI can show a connecting-spinner promptly.
    this.emit("error", "WebSocket error — waiting for close event");
  };

  // ── Exponential backoff with jitter ──────────────────────────────── L3_邏輯安防

  private scheduleReconnect(delayMs: number): void {
    this.status      = "reconnecting";
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.status !== "terminated") this.openSocket();
    }, delayMs);
  }

  /**
   * delay = clamp(base × 2^attempt, max) × (1 + jitter × U(-1, 1))
   *
   * Full-jitter within ±jitter band prevents client thundering herd. // L3_邏輯安防
   */
  private nextDelay(): number {
    const { baseDelay, maxDelay, jitter } = this.cfg;
    const expo  = Math.min(baseDelay * (2 ** this.attempt), maxDelay);
    const noise = expo * jitter * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(expo + noise));
  }

  // ── SYNC request ─────────────────────────────────────────────────── L3_邏輯安防

  /**
   * Ask the server for the latest GameStateView.
   * Called automatically after every successful reconnect.
   *
   * Server contract: GameRoomDO.webSocketMessage() must detect
   * `{ type: "sync" }` and reply with `{ type: "state", payload: view }`.
   */
  private sendSync(): void {
    if (this.status !== "connected" || !this.ws) return;             // L3_邏輯安防
    const frame: SyncFrame = {
      type:     "sync",
      gameId:   this.cfg.gameId,
      playerId: this.cfg.playerId,
    };
    this.ws.send(JSON.stringify(frame));
  }

  // ── Typed event emitter ──────────────────────────────────────────── L2_模組

  private emit<K extends keyof GameSocketEventMap>(
    event: K,
    ...args: GameSocketEventMap[K]
  ): void {
    this.reg.get(event)?.forEach(fn => {
      try {
        fn(...args);
      } catch (err) {
        // A broken listener must not kill the dispatch loop.         // L3_邏輯安防
        console.error(`[GameSocket] "${event}" listener threw:`, err);
      }
    });
  }
}
