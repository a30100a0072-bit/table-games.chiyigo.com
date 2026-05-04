// /src/api/lobby.ts
// Matchmaking lobby — race-condition-safe via single LobbyDO instance per gameType. // L2_鎖定
//
// 每個遊戲類型擁有自己的 LobbyDO（idFromName(gameType)），互不干擾。            // L2_隔離
// 機器人補位（BOT_FILL）對 bigTwo / mahjong / texas 三款遊戲皆啟用。            // L2_實作

import { verifyJWT, JWTError, jwksFromPrivateEnv } from "../utils/auth";
import { takeToken, rateLimited }                  from "../utils/rateLimit";
import { ErrorCode, errorResponse }                 from "../utils/errors";
import { log }                                      from "../utils/log";
import { bump }                                     from "../utils/metrics";
import type { GameType } from "../types/game";
import { isGameType } from "../types/game";

// ── Environment ──────────────────────────────────────────────────────── L2_隔離
export interface LobbyEnv {
  LOBBY_DO:        DurableObjectNamespace;
  GAME_ROOM:       DurableObjectNamespace;   // needed to init DO when bots fill a room // L2_實作
  MATCH_KV:        KVNamespace;
  DB:              D1Database;
  JWT_PRIVATE_JWK: string;                   // JSON-serialised EC P-256 private JWK    // L3_架構含防禦觀測
}

const ROOM_SIZE      = 4;
const WAIT_MS        = 30_000;   // max queue wait before timeout
const BOT_FILL_MS    = 3_000;    // fill remaining seats with bots after this delay // L2_實作
const KV_ROOM_TTL_S  = 3_600;    // 1 h

// Minimum chip balance to enter matchmaking. Players who can't cover the
// floor are bounced before queueing so we don't seat them and crash the
// table mid-hand on settlement.                                          // L2_實作
export const ANTE_BY_GAME: Record<GameType, number> = {
  bigTwo:  100,
  mahjong: 100,
  texas:   200,
  uno:     100,
  yahtzee: 100,
};

// ── Bot ID prefix ─────────────────────────────────────────────────────── L2_隔離
// Any playerId starting with this prefix is treated as a bot seat.
// Real players are JWT-verified and will never receive this prefix.      // L2_隔離
const BOT_PREFIX = "BOT_";
const isBot = (id: string): boolean => id.startsWith(BOT_PREFIX);

// ─────────────────────────────────────────────────────────────────────────────
// LobbyDO — one named instance per GameType.                              // L2_鎖定

interface LobbyJoinBody {
  playerId: string;
  gameType: GameType;
  /** Mahjong-only — 連莊 N 局；預設 1。Lobby 桶化 key = `${gameType}:${hands}`，
   *  讓不同局數的麻將玩家不會配進同一桌。                              // L2_隔離 */
  mahjongTargetHands?: number;
}

/** Lobby DO 名稱 = `${gameType}` 或 `${gameType}:${mahjongTargetHands}`。
 *  單局（hands=1 或非麻將）走原 key 維持相容；多局麻將走 `:N` 後綴。 // L2_隔離 */
export function lobbyKey(gameType: GameType, mahjongHands?: number): string {
  if (gameType === "mahjong" && mahjongHands && mahjongHands > 1) {
    return `mahjong:${mahjongHands}`;
  }
  return gameType;
}

/** Live-room entry for spectator listings. Reach via the dedicated
 *  `idFromName("registry")` instance — that one ignores the matchmaking
 *  paths and is purely a global registry across all game types.          // L2_實作 */
export interface LiveRoomEntry {
  roomId:      string;
  gameType:    GameType;
  playerCount: number;
  capacity:    number;
  startedAt:   number;
}

export const LOBBY_REGISTRY_KEY = "registry";

export class LobbyDO implements DurableObject {

  private readonly state: DurableObjectState;
  private readonly env:   LobbyEnv;

  private pending   = new Map<string, (r: Response) => void>();
  private deadlines = new Map<string, number>();
  private botFillAt: number | null = null;        // epoch ms when bots should fill remainder // L2_實作
  private gameType:  GameType | null = null;      // bound on first join, immutable thereafter // L2_隔離
  private mahjongTargetHands: number = 1;          // bound on first join (mahjong-only) // L2_隔離
  private liveRooms = new Map<string, LiveRoomEntry>();

  constructor(state: DurableObjectState, env: LobbyEnv) {
    this.state = state;
    this.env   = env;
    this.state.blockConcurrencyWhile(async () => {
      const [saved, savedBotFill, savedType, savedHands, savedLive] = await Promise.all([
        this.state.storage.get<[string, number][]>("deadlines"),
        this.state.storage.get<number>("botFillAt"),
        this.state.storage.get<GameType>("gameType"),
        this.state.storage.get<number>("mahjongTargetHands"),
        this.state.storage.get<[string, LiveRoomEntry][]>("liveRooms"),
      ]);
      if (saved)        this.deadlines = new Map(saved);
      if (savedBotFill) this.botFillAt = savedBotFill;
      if (savedHands)   this.mahjongTargetHands = savedHands;
      if (savedType)    this.gameType  = savedType;
      if (savedLive)    this.liveRooms = new Map(savedLive);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/join" && request.method === "POST")
      return this.join(request);
    if (url.pathname === "/register-live" && request.method === "POST")
      return this.registerLive(request);
    if (url.pathname === "/unregister-live" && request.method === "POST")
      return this.unregisterLive(request);
    if (url.pathname === "/live" && request.method === "GET")
      return this.listLive();
    return new Response("not found", { status: 404 });
  }

  // ── Live-room registry (spectator listings) ────────────────────────── L2_實作
  // Routed only on the `idFromName("registry")` instance; per-gameType
  // matchmaking instances will never see these paths in practice but
  // serving them is harmless.

  private async registerLive(request: Request): Promise<Response> {
    const body = await request.json<LiveRoomEntry>();
    if (!body.roomId || !isGameType(body.gameType))
      return new Response("bad payload", { status: 400 });
    this.liveRooms.set(body.roomId, body);
    await this.state.storage.put("liveRooms", [...this.liveRooms.entries()]);
    return Response.json({ ok: true });
  }

  private async unregisterLive(request: Request): Promise<Response> {
    const { roomId } = await request.json<{ roomId: string }>();
    if (!roomId) return new Response("bad payload", { status: 400 });
    this.liveRooms.delete(roomId);
    await this.state.storage.put("liveRooms", [...this.liveRooms.entries()]);
    return Response.json({ ok: true });
  }

  private listLive(): Response {
    return Response.json({ rooms: [...this.liveRooms.values()] });
  }

  // ── Join queue ──────────────────────────────────────────────────────── L2_鎖定

  private async join(request: Request): Promise<Response> {
    const body = await request.json<LobbyJoinBody>();
    const { playerId, gameType } = body;
    const requestedHands = body.mahjongTargetHands ?? 1;
    if (!isGameType(gameType))
      return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "invalid gameType");
    if (gameType === "mahjong") {
      if (!Number.isInteger(requestedHands) || requestedHands < 1 || requestedHands > 16)
        return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "mahjongTargetHands must be 1..16");
    } else if (body.mahjongTargetHands !== undefined && body.mahjongTargetHands !== 1) {
      return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "mahjongTargetHands only valid for mahjong");
    }

    // 同一 LobbyDO 實例只能服務單一 gameType。                              // L2_隔離
    if (this.gameType === null) {
      this.gameType = gameType;
      this.mahjongTargetHands = requestedHands;
      await Promise.all([
        this.state.storage.put("gameType", this.gameType),
        this.state.storage.put("mahjongTargetHands", this.mahjongTargetHands),
      ]);
    } else if (this.gameType !== gameType) {
      return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "gameType mismatch for this lobby");
    } else if (gameType === "mahjong" && this.mahjongTargetHands !== requestedHands) {
      // 不同局數的玩家不該共桌；handleMatch 已用 lobbyKey 桶化避免，但仍守一道。 // L2_隔離
      return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "mahjongTargetHands mismatch for this lobby");
    }

    if (this.deadlines.has(playerId))
      return errorResponse(ErrorCode.ALREADY_QUEUED, 409);

    this.deadlines.set(playerId, Date.now() + WAIT_MS);

    // Arm bot-fill timer on the very first real player (all game types).   // L2_實作
    if (this.botFillAt === null) {
      this.botFillAt = Date.now() + BOT_FILL_MS;
      await this.state.storage.put("botFillAt", this.botFillAt);
    }

    const next = this.nextAlarm();
    await Promise.all([
      this.state.storage.put("deadlines", [...this.deadlines.entries()]),
      next !== null ? this.state.storage.setAlarm(next) : Promise.resolve(),
    ]);

    return new Promise<Response>(resolve => {
      this.pending.set(playerId, resolve);
      if (this.pending.size >= ROOM_SIZE) this.tryMatch();
    });
  }

  // ── Match 4 players → write D1 → resolve callbacks ─────────────────── L2_鎖定

  private async tryMatch(): Promise<void> {
    if (this.pending.size < ROOM_SIZE) return;
    if (this.gameType === null) return;

    const batch     = [...this.pending.entries()].slice(0, ROOM_SIZE);
    const playerIds = batch.map(([id]) => id);
    const botIds    = playerIds.filter(isBot);                           // L2_實作
    const humanIds  = playerIds.filter(id => !isBot(id));
    const roomId    = crypto.randomUUID();

    // Evict from pending BEFORE any await.                              // L2_鎖定
    for (const [id] of batch) {
      this.pending.delete(id);
      this.deadlines.delete(id);
    }

    try {
      await this.env.DB
        .prepare(
          "INSERT INTO GameRooms (room_id, player_ids, status, created_at)" +
          " VALUES (?, ?, 'waiting', ?)",
        )
        .bind(roomId, JSON.stringify(playerIds), Date.now())
        .run();
    } catch (err) {
      console.error("[LobbyDO] D1 insert failed — restoring human players:", err);
      const restored = Date.now() + WAIT_MS;
      // Only real players are restored; bots are ephemeral.             // L2_隔離
      for (const [id, resolve] of batch) {
        if (!isBot(id)) {
          this.pending.set(id, resolve);
          this.deadlines.set(id, restored);
        }
      }
      await this.state.storage.put("deadlines", [...this.deadlines.entries()]);
      return;
    }

    // Always init GameRoomDO before resolving long-polls — prevents the
    // race where clients reach the DO before /init completes.           // L3_架構含防禦觀測
    try {
      const stub = this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(roomId));
      await stub.fetch(new Request("https://gameroom.internal/init", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          gameId:   roomId,
          roundId:  crypto.randomUUID(),
          gameType: this.gameType,
          capacity: ROOM_SIZE,
          botIds,
          ...(this.gameType === "mahjong" && this.mahjongTargetHands > 1
            ? { mahjongTargetHands: this.mahjongTargetHands } : {}),
        }),
      }));
    } catch (err) {
      console.error("[LobbyDO] GameRoomDO init error:", err);
      // GameSocket reconnect handles retry; not fatal for the match response.
    }

    // Resolve only human long-poll connections (bots have no-op resolvers).
    const body = Response.json({ matched: true, roomId, gameType: this.gameType, players: playerIds });
    for (const [id, resolve] of batch) {
      if (!isBot(id)) resolve(body.clone());
    }

    // KV visibility flag — bots never make match requests, no KV needed. // L2_隔離
    await Promise.all([
      this.state.storage.put("deadlines", [...this.deadlines.entries()]),
      ...humanIds.map(id =>
        this.env.MATCH_KV.put(`room:${id}`, roomId, { expirationTtl: KV_ROOM_TTL_S }),
      ),
    ]);
  }

  // ── Bot-fill: called when BOT_FILL_MS elapses (all game types) ────── L2_實作

  private async fillWithBots(): Promise<void> {
    if (this.pending.size === 0) return;   // no real players — nothing to fill for // L2_實作
    if (this.gameType === null) return;

    let botIdx = 1;
    while (this.pending.size < ROOM_SIZE) {
      this.pending.set(`${BOT_PREFIX}${botIdx++}`, () => {}); // no-op resolver // L2_隔離
    }

    await this.tryMatch();
  }

  // ── Alarm: expire stale waiters + trigger bot-fill ─────────────────── L2_鎖定

  async alarm(): Promise<void> {
    const now = Date.now();

    // ① Bot-fill deadline                                               // L2_實作
    if (this.botFillAt !== null && this.botFillAt <= now) {
      this.botFillAt = null;
      await this.state.storage.delete("botFillAt");
      await this.fillWithBots();
    }

    // ② Expire real-player wait deadlines
    for (const [id, dl] of this.deadlines) {
      if (dl > now) continue;
      this.deadlines.delete(id);
      this.pending.get(id)?.(
        Response.json({ matched: false, reason: "timeout" }, { status: 408 }),
      );
      this.pending.delete(id);
    }

    await this.state.storage.put("deadlines", [...this.deadlines.entries()]);

    // ③ Re-arm clock for remaining events
    const next = this.nextAlarm();
    if (next !== null) {
      await this.state.storage.setAlarm(next);
    } else {
      await this.state.storage.deleteAlarm();
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private nextAlarm(): number | null {
    const times: number[] = [...this.deadlines.values()];
    if (this.botFillAt !== null) times.push(this.botFillAt);
    return times.length > 0 ? Math.min(...times) : null;
  }
}

// ── Gateway handler ──────────────────────────────────────────────────── L2_隔離

export async function handleMatch(
  request: Request,
  env: LobbyEnv,
): Promise<Response> {

  const auth  = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  let playerId: string;
  try {
    playerId = await verifyJWT(token, jwksFromPrivateEnv(env.JWT_PRIVATE_JWK));
  } catch (err) {
    return errorResponse(
      ErrorCode.UNAUTHORIZED, 401,
      err instanceof JWTError ? err.message : undefined,
    );
  }

  if (!takeToken(`match:${playerId}`, "match")) {
    bump("rate_limited");
    log("warn", "rate_limited", { playerId, route: "/api/match" });
    return rateLimited();
  }

  // Defence in depth: a token issued before a freeze must not survive
  // matchmaking. /auth/token also checks but legitimate tokens live up
  // to 24 h and the freeze should bite immediately.                    // L3_架構含防禦觀測
  const frozen = await env.DB
    .prepare("SELECT frozen_at FROM users WHERE player_id = ?")
    .bind(playerId)
    .first<{ frozen_at: number }>();
  if (frozen && frozen.frozen_at > 0) {
    log("warn", "match_blocked_frozen", { playerId });
    return errorResponse(ErrorCode.ACCOUNT_FROZEN, 423);
  }

  bump("matches_started");

  // gameType 從請求 body 帶入；預設 bigTwo 以保留既有客戶端相容性。        // L2_隔離
  let gameType: GameType = "bigTwo";
  let mahjongHands = 1;
  try {
    const body = await request.json<{ gameType?: string; mahjongHands?: number }>();
    if (isGameType(body.gameType)) gameType = body.gameType;
    if (typeof body.mahjongHands === "number") mahjongHands = body.mahjongHands;
  } catch { /* default */ }

  // Validate mahjongHands range + applicability before chip check so an
  // invalid request fails fast without freezing chips.                  // L3_邏輯安防
  if (mahjongHands !== 1) {
    if (gameType !== "mahjong")
      return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "mahjongHands only valid for mahjong");
    if (!Number.isInteger(mahjongHands) || mahjongHands < 1 || mahjongHands > 16)
      return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "mahjongHands must be 1..16");
  }

  // Chip floor — the wallet must cover this match's total ANTE (per-hand × N).
  // Returning users get this row from /auth/token's lazy create; if the row is
  // missing we treat balance as 0 (which fails the check).             // L2_實作
  const ante = ANTE_BY_GAME[gameType] * (gameType === "mahjong" ? mahjongHands : 1);
  const wallet = await env.DB
    .prepare("SELECT chip_balance FROM users WHERE player_id = ?")
    .bind(playerId)
    .first<{ chip_balance: number }>();
  const balance = wallet?.chip_balance ?? 0;
  if (balance < ante) {
    log("info", "match_blocked_insufficient_chips", { playerId, gameType, balance, required: ante });
    return errorResponse(
      ErrorCode.INSUFFICIENT_CHIPS, 402, undefined,
      { balance, required: ante, gameType },
    );
  }

  const existingRoom = await env.MATCH_KV.get(`room:${playerId}`);
  if (existingRoom) {
    // Belt-and-suspenders: if the KV pointer survived a cleanup race, check D1
    // for the room's status and clear the stale entry so the player isn't locked
    // out for the full TTL after a game has actually ended.                   // L3_架構含防禦觀測
    const row = await env.DB
      .prepare("SELECT status FROM GameRooms WHERE room_id = ?")
      .bind(existingRoom)
      .first<{ status: string }>();
    const stale = !row || row.status === "settled";
    if (stale) {
      await env.MATCH_KV.delete(`room:${playerId}`);
    } else {
      return errorResponse(
        ErrorCode.ALREADY_IN_ROOM, 409, undefined,
        { roomId: existingRoom },
      );
    }
  }

  // 每個 (gameType, hands) 組合擁有獨立 LobbyDO — 不同局數的麻將玩家不會配對。 // L2_隔離
  const stub = env.LOBBY_DO.get(env.LOBBY_DO.idFromName(lobbyKey(gameType, mahjongHands)));
  return stub.fetch(
    new Request("https://lobby.internal/join", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        playerId, gameType,
        ...(gameType === "mahjong" && mahjongHands > 1 ? { mahjongTargetHands: mahjongHands } : {}),
      }),
    }),
  );
}
