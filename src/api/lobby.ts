// /src/api/lobby.ts
// Matchmaking lobby — race-condition-safe via single LobbyDO instance.  // L2_鎖定

import { verifyJWT, JWTError } from "../utils/auth";

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
const BOT_FILL_MS    = 10_000;   // fill remaining seats with bots after this delay // L2_實作
const KV_ROOM_TTL_S  = 3_600;    // 1 h

// ── Bot ID prefix ─────────────────────────────────────────────────────── L2_隔離
// Any playerId starting with this prefix is treated as a bot seat.
// Real players are JWT-verified and will never receive this prefix.      // L2_隔離
const BOT_PREFIX = "BOT_";
const isBot = (id: string): boolean => id.startsWith(BOT_PREFIX);

// ─────────────────────────────────────────────────────────────────────────────
// LobbyDO — named "main", single global instance.                        // L2_鎖定

export class LobbyDO implements DurableObject {

  private readonly state: DurableObjectState;
  private readonly env:   LobbyEnv;

  private pending   = new Map<string, (r: Response) => void>();
  private deadlines = new Map<string, number>();
  private botFillAt: number | null = null;  // epoch ms when bots should fill remainder // L2_實作

  constructor(state: DurableObjectState, env: LobbyEnv) {
    this.state = state;
    this.env   = env;
    this.state.blockConcurrencyWhile(async () => {
      const [saved, savedBotFill] = await Promise.all([
        this.state.storage.get<[string, number][]>("deadlines"),
        this.state.storage.get<number>("botFillAt"),
      ]);
      if (saved)        this.deadlines = new Map(saved);
      if (savedBotFill) this.botFillAt = savedBotFill;
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
    const { playerId } = await request.json<{ playerId: string }>();

    if (this.deadlines.has(playerId))
      return Response.json({ error: "already queued" }, { status: 409 });

    this.deadlines.set(playerId, Date.now() + WAIT_MS);

    // Arm bot-fill timer on the very first real player entering the queue. // L2_實作
    if (this.botFillAt === null) {
      this.botFillAt = Date.now() + BOT_FILL_MS;
      await this.state.storage.put("botFillAt", this.botFillAt);
    }

    await Promise.all([
      this.state.storage.put("deadlines", [...this.deadlines.entries()]),
      this.state.storage.setAlarm(this.nextAlarm()),
    ]);

    return new Promise<Response>(resolve => {
      this.pending.set(playerId, resolve);
      if (this.pending.size >= ROOM_SIZE) this.tryMatch();
    });
  }

  // ── Match 4 players → write D1 → resolve callbacks ─────────────────── L2_鎖定

  private async tryMatch(): Promise<void> {
    if (this.pending.size < ROOM_SIZE) return;

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
          capacity: ROOM_SIZE,
          botIds,
        }),
      }));
    } catch (err) {
      console.error("[LobbyDO] GameRoomDO init error:", err);
      // GameSocket reconnect handles retry; not fatal for the match response.
    }

    // Resolve only human long-poll connections (bots have no-op resolvers).
    const body = Response.json({ matched: true, roomId, players: playerIds });
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

  // ── Bot-fill: called when BOT_FILL_MS elapses ────────────────────── L2_實作
  // Fills remaining seats with virtual bot IDs and forces a match.
  // Bot resolvers are no-ops — bots have no HTTP connection to reply to. // L2_隔離

  private async fillWithBots(): Promise<void> {
    if (this.pending.size === 0) return;   // no real players — nothing to fill for // L2_實作

    let botIdx = 1;
    while (this.pending.size < ROOM_SIZE) {
      this.pending.set(`${BOT_PREFIX}${botIdx++}`, () => {}); // no-op resolver // L2_隔離
    }

    await this.tryMatch();
  }

  // ── Alarm: expire stale waiters + trigger bot-fill ─────────────────── L2_鎖定
  // setTimeout is FORBIDDEN; all timeouts are enforced here.            // L2_鎖定

  async alarm(): Promise<void> {
    const now = Date.now();

    // ① Bot-fill deadline                                               // L2_實作
    if (this.botFillAt !== null && this.botFillAt <= now) {
      this.botFillAt = null;
      await this.state.storage.delete("botFillAt");
      await this.fillWithBots();
      // If fillWithBots matched everyone, pending/deadlines are empty
      // and the re-arm below will call deleteAlarm(). ✓
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

  const existingRoom = await env.MATCH_KV.get(`room:${playerId}`);
  if (existingRoom) {
    return Response.json(
      { error: "already in a room", roomId: existingRoom },
      { status: 409 },
    );
  }

  const stub = env.LOBBY_DO.get(env.LOBBY_DO.idFromName("main"));
  return stub.fetch(
    new Request("https://lobby.internal/join", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ playerId }),
    }),
  );
}
