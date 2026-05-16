// /src/domain/economy.ts
// Chip economy constants. Framework-agnostic: pure values, no IO, no
// runtime dependencies. Centralised here so changing a number doesn't
// require hunting through routes/api code — and so two files can't
// drift (gateway.ts and oidc.ts both had a private `SIGNUP_GRANT = 1000`
// before this module landed).
//
// Future-flexibility note: when we grow beyond hardcoded values
// (admin-adjustable economy from a `config` table), this file becomes
// the read-from-DB seam — call sites already import named constants,
// so swapping `export const X = 100` for `export function getX(env)`
// is local.                                                              // L3_架構含防禦觀測

// ── New-user grant ─────────────────────────────────────────────────
/** Chips credited the first time a player hits /auth/token or completes
 *  OIDC exchange. Idempotent via INSERT OR IGNORE on chip_ledger's
 *  UNIQUE(player_id, game_id='signup', reason) constraint. */
export const SIGNUP_GRANT = 1000;

// ── Daily login bonus ──────────────────────────────────────────────
/** Awarded once per 24h on /auth/token. Conditional UPDATE acts as CAS
 *  so concurrent calls in the same window can't double-grant. */
export const DAILY_BONUS_AMOUNT   = 100;
export const DAILY_BONUS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ── Bailout (low-balance relief) ───────────────────────────────────
/** Eligibility: chip_balance < THRESHOLD AND last_bailout_at older than
 *  COOLDOWN. Grants AMOUNT. Single-statement UPDATE acts as CAS. */
export const BAILOUT_THRESHOLD     = 100;
export const BAILOUT_AMOUNT        = 500;
export const BAILOUT_COOLDOWN_MS   = 24 * 60 * 60 * 1000;
