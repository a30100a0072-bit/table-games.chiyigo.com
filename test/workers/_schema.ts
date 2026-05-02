// /test/workers/_schema.ts
// Shared DDL applier for workerd-runtime tests. miniflare provisions a
// fresh in-memory D1 per run, so each spec's beforeAll() must create the
// tables it touches. Keeping this in one place avoids drift between specs.
//
// Mirrors the relevant subset of src/db/schema.sql. We don't pull schema.sql
// at test time because miniflare's worker bundle is sandboxed without fs.   // L3_架構含防禦觀測

import { env } from "cloudflare:test";

const DDL = [
  // Core game / wallet — needed for /auth/token, wallet, settlement paths.
  `CREATE TABLE IF NOT EXISTS GameRooms (
     room_id TEXT PRIMARY KEY, player_ids TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'waiting', created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS games (
     game_id TEXT PRIMARY KEY, round_id TEXT NOT NULL, finished_at INTEGER NOT NULL,
     reason TEXT NOT NULL, winner_id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS player_settlements (
     game_id TEXT NOT NULL, player_id TEXT NOT NULL, final_rank INTEGER NOT NULL,
     score_delta INTEGER NOT NULL, remaining_json TEXT NOT NULL,
     PRIMARY KEY (game_id, player_id))`,
  `CREATE TABLE IF NOT EXISTS users (
     player_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
     chip_balance INTEGER NOT NULL DEFAULT 1000,
     last_bailout_at INTEGER NOT NULL DEFAULT 0,
     last_login_at INTEGER NOT NULL DEFAULT 0,
     frozen_at INTEGER NOT NULL DEFAULT 0, frozen_reason TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS chip_ledger (
     ledger_id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL,
     game_id TEXT, delta INTEGER NOT NULL, reason TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (player_id, game_id, reason))`,

  // Tournaments — referenced by export.
  `CREATE TABLE IF NOT EXISTS tournament_entries (
     tournament_id TEXT NOT NULL, player_id TEXT NOT NULL,
     registered_at INTEGER NOT NULL, agg_score INTEGER NOT NULL DEFAULT 0,
     final_rank INTEGER, PRIMARY KEY (tournament_id, player_id))`,

  // Friends + DMs.
  `CREATE TABLE IF NOT EXISTS friendships (
     a_id TEXT NOT NULL, b_id TEXT NOT NULL, requester TEXT NOT NULL,
     status TEXT NOT NULL, created_at INTEGER NOT NULL, responded_at INTEGER,
     PRIMARY KEY (a_id, b_id))`,
  `CREATE TABLE IF NOT EXISTS dms (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     sender TEXT NOT NULL, recipient TEXT NOT NULL,
     body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER)`,

  // Private rooms + invites.
  `CREATE TABLE IF NOT EXISTS room_tokens (
     token TEXT PRIMARY KEY, game_id TEXT NOT NULL, game_type TEXT NOT NULL,
     capacity INTEGER NOT NULL, created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS room_invites (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     inviter TEXT NOT NULL, invitee TEXT NOT NULL, token TEXT NOT NULL,
     game_type TEXT NOT NULL, created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL, status TEXT NOT NULL,
     responded_at INTEGER, UNIQUE (inviter, invitee, token))`,

  // Replays + shares + participants index.
  `CREATE TABLE IF NOT EXISTS replay_meta (
     game_id TEXT PRIMARY KEY, game_type TEXT NOT NULL,
     engine_version INTEGER NOT NULL, player_ids TEXT NOT NULL,
     initial_snapshot TEXT NOT NULL, events TEXT NOT NULL,
     started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL,
     winner_id TEXT, reason TEXT)`,
  `CREATE TABLE IF NOT EXISTS replay_shares (
     token TEXT PRIMARY KEY, game_id TEXT NOT NULL, owner_id TEXT NOT NULL,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS replay_participants (
     game_id TEXT NOT NULL, player_id TEXT NOT NULL,
     finished_at INTEGER NOT NULL,
     PRIMARY KEY (game_id, player_id))`,

  // Audit log for the daily retention sweep — powers /api/admin/health.
  `CREATE TABLE IF NOT EXISTS cron_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ran_at INTEGER NOT NULL,
     dms_purged INTEGER NOT NULL DEFAULT 0,
     room_tokens_purged INTEGER NOT NULL DEFAULT 0,
     replay_shares_purged INTEGER NOT NULL DEFAULT 0,
     room_invites_purged INTEGER NOT NULL DEFAULT 0,
     errors_json TEXT)`,
];

let applied = false;
export async function applyTestSchema(): Promise<void> {
  if (applied) return;
  const db = (env as unknown as { DB: D1Database }).DB;
  for (const stmt of DDL) await db.prepare(stmt).run();
  applied = true;
}
