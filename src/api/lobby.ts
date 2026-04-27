// /src/api/lobby.ts
// Matchmaking lobby — race-condition-safe via single LobbyDO instance per gameType. // L2_鎖定
//
// 每個遊戲類型擁有自己的 LobbyDO（idFromName(gameType)），互不干擾。            // L2_隔離
// 機器人補位（BOT_FILL）對 bigTwo / mahjong / texas 三款遊戲皆啟用。            // L2_實作

import { verifyJWT, JWTError } from "../utils/auth";
import type { GameType } from "../types/game";
import { isGameType } from "../types/game";

// ── Environment ──────────────────────────────────────────────────────── L2_隔離
export interface LobbyEnv {
  LOBBY_DO:   DurableObjectNamespace;
  GAME_ROOM:  DurableObjectNamespace;   // needed to init DO when bots fill a room // L2_實作
  MATCH_KV:   KVNamespace;
  DB:         D1Database;
  JWT_SECRET: string;
}

const ROOM_SIZE      = 4;
const WAIT_MS        = 30_000;   // max queue wait before timeout
const BOT_FILL_MS    = 3_000;    // fill remaining seats with bots after this delay // L2_實作
const KV_ROOM_TTL_S  = 3_600;    // 1 h

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
}

export class LobbyDO implements DurableObject {

  private readonly state: DurableObjectState;
  private readonly env:   LobbyEnv;

  private pending   = new Map<string, (r: Response) => void>();
  private deadlines = new Map<string, number>();
  private botFillAt: number | null = null;        // epoch ms when bots should fill remainder // L2_實作
  private gameType:  GameType | null = null;      // bound on first join, immutable thereafter // L2_隔離

  constructor(state: DurableObjectState, env: LobbyEnv) {
    this.state = state;
    this.env   = env;
    this.state.blockConcurrencyWhile(async () => {
      const [saved, savedBotFill, savedType] = await Promise.all([
        this.state.storage.get<[string, number][]>("deadlines"),
        this.state.storage.get<number>("botFillAt"),
        this.state.storage.get<GameType>("gameType"),
      ]);
      if (saved)        this.deadlines = new Map(saved);
      if (savedBotFill) this.botFillAt = savedBotFill;
      if (savedType)    this.gameType  = savedType;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/join" && request.method === "POST")
      return this.join(request);
    return new Response("not found", { status: 404 });
  }

  // ── Join queue ──────────────────────────────────────────────────────── L2_鎖定

  private async join(request: Request): Promise<Response> {
    const body = await request.json<LobbyJoinBody>();
    const { playerId, gameType } = body;
    if (!isGameType(gameType))
      return Response.json({ error: "invalid gameType" }, { status: 400 });

    // 同一 LobbyDO 實例只能服務單一 gameType。                              // L2_隔離
    if (this.gameType === null) {
      this.gameType = gameType;
      await this.state.storage.put("gameType", this.gameType);
    } else if (this.gameType !== gameType) {
      return Response.json({ error: "gameType mismatch for this lobby" }, { status: 400 });
    }

    if (this.deadlines.has(playerId))
      return Response.json({ error: "already queued" }, { status: 409 });

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
    playerId = await verifyJWT(token, env.JWT_SECRET);
  } catch (err) {
    return Response.json(
      { error: err instanceof JWTError ? err.message : "unauthorized" },
      { status: 401 },
    );
  }

  // gameType 從請求 body 帶入；預設 bigTwo 以保留既有客戶端相容性。        // L2_隔離
  let gameType: GameType = "bigTwo";
  try {
    const body = await request.json<{ gameType?: string }>();
    if (isGameType(body.gameType)) gameType = body.gameType;
  } catch { /* default */ }

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
      return Response.json(
        { error: "already in a room", roomId: existingRoom },
        { status: 409 },
      );
    }
  }

  // 每個 gameType 擁有獨立 LobbyDO 實例。                                // L2_隔離
  const stub = env.LOBBY_DO.get(env.LOBBY_DO.idFromName(gameType));
  return stub.fetch(
    new Request("https://lobby.internal/join", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ playerId, gameType }),
    }),
  );
}
