// /src/domain/wallet.ts
// Chip-wallet primitives. Framework-agnostic: takes a D1Database, no
// HTTP types. Route handlers call these; they don't reach into D1
// directly. Centralises the idempotency invariants (signup ledger
// uniqueness, daily-bonus CAS) so multiple call paths (guest /auth/token
// + OIDC exchange) can't drift.                                          // L3_架構含防禦觀測

import {
  SIGNUP_GRANT, DAILY_BONUS_AMOUNT, DAILY_BONUS_COOLDOWN_MS,
} from "./economy";
import { log } from "../utils/log";
import { bump } from "../utils/metrics";

/**
 * Create the user row + write the signup ledger entry. Idempotent:
 * INSERT OR IGNORE on `users` and the UNIQUE(player_id, game_id, reason)
 * constraint on `chip_ledger` make re-runs safe.                       // L3_架構含防禦觀測
 */
export async function ensureUserWallet(db: D1Database, playerId: string): Promise<void> {
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO users (player_id, display_name, chip_balance, created_at, updated_at)" +
        " VALUES (?, ?, ?, ?, ?)",
      )
      .bind(playerId, playerId, SIGNUP_GRANT, now, now),
    db
      .prepare(
        "INSERT OR IGNORE INTO chip_ledger (player_id, game_id, delta, reason, created_at)" +
        " VALUES (?, NULL, ?, 'signup', ?)",
      )
      .bind(playerId, SIGNUP_GRANT, now),
  ]);
}

/**
 * Grant a daily-login bonus iff last_login_at is older than the cooldown.
 * Conditional UPDATE acts as CAS so concurrent /auth/token calls in the
 * same 24h window can't double-grant. Returns the granted amount or null.
 */
export async function maybeGrantDailyBonus(
  db: D1Database, playerId: string,
): Promise<number | null> {
  const now    = Date.now();
  const cutoff = now - DAILY_BONUS_COOLDOWN_MS;
  const upd = await db
    .prepare(
      "UPDATE users SET" +
      "  chip_balance  = chip_balance + ?," +
      "  last_login_at = ?," +
      "  updated_at    = ?" +
      " WHERE player_id = ?" +
      "   AND last_login_at <= ?",
    )
    .bind(DAILY_BONUS_AMOUNT, now, now, playerId, cutoff)
    .run();
  if (!upd.success || (upd.meta?.changes ?? 0) === 0) return null;
  await db
    .prepare(
      "INSERT INTO chip_ledger (player_id, game_id, delta, reason, created_at)" +
      " VALUES (?, NULL, ?, 'daily', ?)",
    )
    .bind(playerId, DAILY_BONUS_AMOUNT, now)
    .run();
  bump("daily_bonus_granted");
  log("info", "daily_bonus_granted", { playerId, amount: DAILY_BONUS_AMOUNT });
  return DAILY_BONUS_AMOUNT;
}
