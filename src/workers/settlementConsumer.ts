// /src/workers/settlementConsumer.ts
// Cloudflare Queue Consumer — receives SettlementQueueMessage from GameRoomDO
// and persists results to D1.  All D1 writes are atomic via db.batch(). // L3_架構含防禦觀測

import type { SettlementQueueMessage, SettlementResult, PlayerSettlement } from "../types/game";

export interface ConsumerEnv {
  DB: D1Database;
}

const BOT_PREFIX = "BOT_";
const isBot = (id: string): boolean => id.startsWith(BOT_PREFIX);
const STARTING_CHIPS = 1000;

// ── Queue handler ─────────────────────────────────────────────────────── L2_實作
// Called by CF runtime when messages are available.
// Each message is acknowledged (auto-ack) only when the handler returns
// without throwing.  Explicit message.retry() re-enqueues on D1 failure. // L3_架構含防禦觀測

export async function handleQueue(
  batch: MessageBatch<SettlementQueueMessage>,
  env:   ConsumerEnv,
): Promise<void> {
  for (const message of batch.messages) {
    if (message.body.type !== "settlement") {
      // Unknown message type — ack and skip to avoid poison-pill looping. // L3_架構含防禦觀測
      message.ack();
      continue;
    }

    try {
      await writeSettlement(env.DB, message.body.payload);
      message.ack();
    } catch (err) {
      // Transient D1 error: re-enqueue for automatic retry.             // L3_架構含防禦觀測
      console.error("[settlementConsumer] D1 write failed, retrying:", err);
      message.retry();
    }
  }
}

// ── D1 write (atomic batch) ───────────────────────────────────────────── L2_實作

async function writeSettlement(db: D1Database, result: SettlementResult): Promise<void> {
  const {
    gameId, roundId, finishedAt, reason, winnerId, players,
  } = result;

  // INSERT OR IGNORE lets the consumer be idempotent: if the Queue retries
  // a message that already succeeded, the duplicate is silently dropped.  // L3_架構含防禦觀測
  const insertGame = db
    .prepare(
      "INSERT OR IGNORE INTO games (game_id, round_id, finished_at, reason, winner_id)" +
      " VALUES (?, ?, ?, ?, ?)",
    )
    .bind(gameId, roundId, finishedAt, reason, winnerId);

  const insertPlayers = players.map((p: PlayerSettlement) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO player_settlements" +
        " (game_id, player_id, final_rank, score_delta, remaining_json)" +
        " VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        gameId,
        p.playerId,
        p.finalRank,
        p.scoreDelta,
        JSON.stringify(p.remainingCards),
      ),
  );

  // Chip economy — humans only. Bots have no wallet.                     // L2_實作
  // For each human:
  //   1. Lazy-create users row (idempotent via INSERT OR IGNORE).
  //   2. Append a settlement ledger row (UNIQUE(player_id,game_id,'settlement')
  //      makes Queue retries a no-op).
  //   3. Recompute users.chip_balance from the ledger SUM — derived value,
  //      so the recompute is idempotent even if step 2 was a no-op.
  const humans = players.filter(p => !isBot(p.playerId));
  const chipStmts: D1PreparedStatement[] = [];
  for (const p of humans) {
    chipStmts.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO users (player_id, display_name, chip_balance, created_at, updated_at)" +
          " VALUES (?, ?, ?, ?, ?)",
        )
        .bind(p.playerId, p.playerId, STARTING_CHIPS, finishedAt, finishedAt),
      db
        .prepare(
          "INSERT OR IGNORE INTO chip_ledger (player_id, game_id, delta, reason, created_at)" +
          " VALUES (?, ?, ?, 'settlement', ?)",
        )
        .bind(p.playerId, gameId, p.scoreDelta, finishedAt),
      db
        .prepare(
          "UPDATE users SET" +
          "  chip_balance = ? + COALESCE((SELECT SUM(delta) FROM chip_ledger WHERE player_id = ?), 0)," +
          "  updated_at   = ?" +
          " WHERE player_id = ?",
        )
        .bind(STARTING_CHIPS, p.playerId, finishedAt, p.playerId),
    );
  }

  const markRoom = db
    .prepare("UPDATE GameRooms SET status = 'settled' WHERE room_id = ?")
    .bind(gameId);

  // db.batch() executes all statements in a single transaction.         // L3_架構含防禦觀測
  await db.batch([insertGame, ...insertPlayers, ...chipStmts, markRoom]);
}
