// /src/api/lobby.ts
// Matchmaking lobby — race-condition-safe via single LobbyDO instance. // L2_鎖定

import { verifyJWT, JWTError } from "../utils/auth";

// ── Environment ──────────────────────────────────────────────────────── L2_隔離
export interface LobbyEnv {
  LOBBY_DO:   DurableObjectNamespace;
  MATCH_KV:   KVNamespace;   // player→room visibility layer         // L2_隔離
  DB:         D1Database;
  JWT_SECRET: string;
}

const ROOM_SIZE     = 4;
const WAIT_MS       = 30_000;   // max queue wait before timeout
const KV_ROOM_TTL_S = 3_600;    // 1 h — prevents re-queuing during active game

// ─────────────────────────────────────────────────────────────────────────────
// LobbyDO — named "main", single global instance.                     // L2_鎖定
//
// Race-condition rationale:
//   All POST /join requests funnel to ONE DO whose JS is single-threaded.
//   In-memory queue mutations are therefore sequential — no external lock needed.
//
// Risk: if idFromName("main") is replaced with idFromRequest() the serialisation
//   guarantee breaks and a distributed lock (e.g. DO per shard + KV CAS) would
//   be required.                                                       // L3_糾錯風險表

export class LobbyDO implements DurableObject {

  private readonly state: DurableObjectState;
  private readonly env:   LobbyEnv;

  // Callbacks held in memory.  CF DO stays warm while ≥1 HTTP request is open,
  // so these pointers are safe for the lifetime of the long-poll.     // L3_糾錯風險表
  private pending   = new Map<string, (r: Response) => void>();
  // Deadlines are persisted so alarm() can clean up after hibernation.
  private deadlines = new Map<string, number>();

  constructor(state: DurableObjectState, env: LobbyEnv) {
    this.state = state;
    this.env   = env;
    // Hydrate deadline table before any request is served.
    this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get<[string, number][]>("deadlines");
      if (saved) this.deadlines = new Map(saved);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/join" && request.method === "POST")
      return this.join(request);
    return new Response("not found", { status: 404 });
  }

  // ── Join queue ──────────────────────────────────────────────────── L2_鎖定

  private async join(request: Request): Promise<Response> {
    const { playerId } = await request.json<{ playerId: string }>();

    // Dedup check: sequential execution makes this atomic.            // L2_鎖定
    if (this.deadlines.has(playerId))
      return Response.json({ error: "already queued" }, { status: 409 });

    // Mutate in-memory state BEFORE the first await to close any
    // re-entrancy window that opens during async storage writes.      // L3_糾錯風險表
    this.deadlines.set(playerId, Date.now() + WAIT_MS);

    await Promise.all([
      this.state.storage.put("deadlines", [...this.deadlines.entries()]),
      this.state.storage.setAlarm(Math.min(...this.deadlines.values())),
    ]);

    // Return a long-poll Promise.  The unresolved Promise keeps the HTTP
    // connection open, which prevents CF from hibernating this DO.
    return new Promise<Response>(resolve => {
      this.pending.set(playerId, resolve);
      if (this.pending.size >= ROOM_SIZE) {
        // Fire without await: tryMatch() resolves the pending callbacks
        // asynchronously after the D1 write completes.
        this.tryMatch();
      }
    });
  }

  // ── Match 4 players → write D1 → resolve callbacks ─────────────── L2_鎖定

  private async tryMatch(): Promise<void> {
    if (this.pending.size < ROOM_SIZE) return;

    // Evict from pending IMMEDIATELY before any await.               // L2_鎖定
    // A second tryMatch() fired mid-flight will see pending.size < 4 and bail.
    const batch     = [...this.pending.entries()].slice(0, ROOM_SIZE);
    const playerIds = batch.map(([id]) => id);
    const roomId    = crypto.randomUUID();

    for (const [id] of batch) {
      this.pending.delete(id);
      this.deadlines.delete(id);
    }

    try {
      // Atomic D1 insert — failure rolls back logical match.         // L2_鎖定
      await this.env.DB
        .prepare(
          "INSERT INTO GameRooms (room_id, player_ids, status, created_at)" +
          " VALUES (?, ?, 'waiting', ?)",
        )
        .bind(roomId, JSON.stringify(playerIds), Date.now())
        .run();
    } catch (err) {
      // D1 write failed: restore players so they remain in queue.    // L3_糾錯風險表
      console.error("[LobbyDO] D1 insert failed — restoring players:", err);
      const restored = Date.now() + WAIT_MS;
      for (const [id, resolve] of batch) {
        this.pending.set(id, resolve);
        this.deadlines.set(id, restored);
      }
      await this.state.storage.put("deadlines", [...this.deadlines.entries()]);
      return;
    }

    // Resolve all 4 long-poll responses in one tick.
    const body = Response.json({ matched: true, roomId, players: playerIds });
    for (const [, resolve] of batch) resolve(body.clone());

    // KV: mark each player as "in room" — gateway reads this to block
    // duplicate match requests for the duration of the game.         // L2_隔離
    await Promise.all([
      this.state.storage.put("deadlines", [...this.deadlines.entries()]),
      ...playerIds.map(id =>
        this.env.MATCH_KV.put(`room:${id}`, roomId, { expirationTtl: KV_ROOM_TTL_S }),
      ),
    ]);
  }

  // ── Alarm: expire stale waiters ─────────────────────────────────── L2_鎖定
  // setTimeout is FORBIDDEN; all timeouts are enforced here.         // L2_鎖定

  async alarm(): Promise<void> {
    const now = Date.now();

    for (const [id, dl] of this.deadlines) {
      if (dl > now) continue;
      this.deadlines.delete(id);
      // pending callback may be absent if player disconnected mid-wait — safe.
      this.pending.get(id)?.(
        Response.json({ matched: false, reason: "timeout" }, { status: 408 }),
      );
      this.pending.delete(id);
    }

    await this.state.storage.put("deadlines", [...this.deadlines.entries()]);

    if (this.deadlines.size > 0) {
      await this.state.storage.setAlarm(Math.min(...this.deadlines.values()));
    } else {
      await this.state.storage.deleteAlarm();
    }
  }
}

// ── Gateway handler — called by /api/match in src/index.ts ──────────── L2_隔離

export async function handleMatch(
  request: Request,
  env: LobbyEnv,
): Promise<Response> {

  // ① Authenticate — extract playerId from Bearer JWT.
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

  // ② KV guard: block player already assigned to an active room.     // L2_隔離
  // This is a fast-path rejection before hitting the DO.
  const existingRoom = await env.MATCH_KV.get(`room:${playerId}`);
  if (existingRoom) {
    return Response.json(
      { error: "already in a room", roomId: existingRoom },
      { status: 409 },
    );
  }

  // ③ Delegate to single LobbyDO — the idFromName("main") guarantee means
  //   all in-flight /api/match requests serialise through one JS context.  // L2_鎖定
  const stub = env.LOBBY_DO.get(env.LOBBY_DO.idFromName("main"));
  return stub.fetch(
    new Request("https://lobby.internal/join", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ playerId }),
    }),
  );
}
