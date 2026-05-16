// /src/routes/wallet.ts
// HTTP handlers for the authenticated wallet surface:
//   GET  /api/me/wallet   — balance + cursor-paginated ledger
//   POST /api/me/bailout  — low-balance relief grant (24h cooldown)
//   GET  /api/me/history  — last 50 settled games
//
// Each handler: requireAuth → rate-limit → D1 ops via prepared statements.
// Side effects (chip_balance writes) use conditional UPDATE for CAS so
// concurrent requests can't double-grant.                              // L3_架構含防禦觀測

import { requireAuth }                from "../utils/authMw";
import { takeToken, rateLimited }     from "../utils/rateLimit";
import { ErrorCode, errorResponse }   from "../utils/errors";
import { log }                        from "../utils/log";
import { bump }                       from "../utils/metrics";
import {
  BAILOUT_THRESHOLD, BAILOUT_AMOUNT, BAILOUT_COOLDOWN_MS,
} from "../domain/economy";

export interface WalletEnv {
  DB:              D1Database;
  JWT_PRIVATE_JWK: string;
}

// ── GET /api/me/wallet ───────────────────────────────────────────────
export async function getWallet(request: Request, env: WalletEnv): Promise<Response> {
  const pidOr = await requireAuth(request, env);
  if (pidOr instanceof Response) return pidOr;
  const playerId = pidOr;

  if (!takeToken(`wallet:${playerId}`, "wallet")) return rateLimited();

  // Cursor pagination: ?ledgerCursor=N returns rows with ledger_id < N.
  // Cursor unset → MAX_SAFE_INTEGER ("from the top").
  const url = new URL(request.url);
  const cursorRaw = url.searchParams.get("ledgerCursor");
  const cursor = cursorRaw && /^\d+$/.test(cursorRaw)
    ? Number(cursorRaw)
    : Number.MAX_SAFE_INTEGER;

  const PAGE_SIZE = 20;

  const [walletRow, ledger] = await Promise.all([
    env.DB
      .prepare("SELECT display_name, chip_balance, updated_at FROM users WHERE player_id = ?")
      .bind(playerId)
      .first<{ display_name: string; chip_balance: number; updated_at: number }>(),
    env.DB
      .prepare(
        "SELECT ledger_id, game_id, delta, reason, created_at" +
        " FROM chip_ledger WHERE player_id = ? AND ledger_id < ?" +
        " ORDER BY ledger_id DESC LIMIT 20",
      )
      .bind(playerId, cursor)
      .all<{ ledger_id: number; game_id: string | null; delta: number; reason: string; created_at: number }>(),
  ]);

  if (!walletRow) return errorResponse(ErrorCode.WALLET_NOT_FOUND, 404);

  const rows = ledger.results ?? [];
  const nextLedgerCursor = rows.length === PAGE_SIZE ? rows[rows.length - 1]!.ledger_id : null;

  return Response.json({
    playerId,
    displayName: walletRow.display_name,
    chipBalance: walletRow.chip_balance,
    updatedAt:   walletRow.updated_at,
    ledger:      rows,
    nextLedgerCursor,
  });
}

// ── POST /api/me/bailout ─────────────────────────────────────────────
// 條件：餘額 < BAILOUT_THRESHOLD 且距離上次領取 ≥ BAILOUT_COOLDOWN_MS。
// chip_ledger UNIQUE(player_id, game_id, reason) 無法擋（game_id NULL）
// 改用 users.last_bailout_at 作為防重領的真正鎖；conditional UPDATE 即 CAS。
export async function claimBailout(request: Request, env: WalletEnv): Promise<Response> {
  const pidOr = await requireAuth(request, env);
  if (pidOr instanceof Response) return pidOr;
  const playerId = pidOr;

  if (!takeToken(`bailout:${playerId}`, "bailout")) return rateLimited();

  const now    = Date.now();
  const cutoff = now - BAILOUT_COOLDOWN_MS;

  const upd = await env.DB
    .prepare(
      "UPDATE users SET" +
      "  chip_balance    = chip_balance + ?," +
      "  last_bailout_at = ?," +
      "  updated_at      = ?" +
      " WHERE player_id = ?" +
      "   AND chip_balance < ?" +
      "   AND last_bailout_at <= ?",
    )
    .bind(BAILOUT_AMOUNT, now, now, playerId, BAILOUT_THRESHOLD, cutoff)
    .run();

  if (!upd.success || (upd.meta?.changes ?? 0) === 0) {
    const wallet = await env.DB
      .prepare("SELECT chip_balance, last_bailout_at FROM users WHERE player_id = ?")
      .bind(playerId)
      .first<{ chip_balance: number; last_bailout_at: number }>();
    if (!wallet) {
      log("warn", "bailout_blocked", { playerId, reason: "wallet_not_found" });
      return errorResponse(ErrorCode.WALLET_NOT_FOUND, 404);
    }
    const reason = wallet.chip_balance >= BAILOUT_THRESHOLD
      ? "balance above threshold"
      : "cooldown active";
    const nextEligibleAt = wallet.last_bailout_at + BAILOUT_COOLDOWN_MS;
    log("info", "bailout_blocked", { playerId, reason, balance: wallet.chip_balance });
    return errorResponse(
      ErrorCode.BAILOUT_INELIGIBLE, 409, reason,
      { balance: wallet.chip_balance, nextEligibleAt },
    );
  }

  await env.DB
    .prepare(
      "INSERT INTO chip_ledger (player_id, game_id, delta, reason, created_at)" +
      " VALUES (?, NULL, ?, 'bailout', ?)",
    )
    .bind(playerId, BAILOUT_AMOUNT, now)
    .run();

  const after = await env.DB
    .prepare("SELECT chip_balance FROM users WHERE player_id = ?")
    .bind(playerId)
    .first<{ chip_balance: number }>();

  bump("bailouts_granted");
  log("info", "bailout_granted", {
    playerId, granted: BAILOUT_AMOUNT, balanceAfter: after?.chip_balance ?? BAILOUT_AMOUNT,
  });

  return Response.json({
    granted: BAILOUT_AMOUNT,
    chipBalance: after?.chip_balance ?? BAILOUT_AMOUNT,
    nextEligibleAt: now + BAILOUT_COOLDOWN_MS,
  });
}

// ── GET /api/me/history ──────────────────────────────────────────────
// Joins games × player_settlements so we can show "won/lost X chips on
// game Y at time Z" without N+1 round-trips.
export async function getHistory(request: Request, env: WalletEnv): Promise<Response> {
  const pidOr = await requireAuth(request, env);
  if (pidOr instanceof Response) return pidOr;
  const playerId = pidOr;

  if (!takeToken(`wallet:${playerId}`, "wallet")) {
    bump("rate_limited");
    return rateLimited();
  }

  const rows = await env.DB
    .prepare(
      "SELECT g.game_id, g.finished_at, g.reason, g.winner_id," +
      "       ps.final_rank, ps.score_delta" +
      " FROM player_settlements ps" +
      " JOIN games g ON g.game_id = ps.game_id" +
      " WHERE ps.player_id = ?" +
      " ORDER BY g.finished_at DESC" +
      " LIMIT 50",
    )
    .bind(playerId)
    .all<{
      game_id: string; finished_at: number; reason: string; winner_id: string;
      final_rank: number; score_delta: number;
    }>();

  return Response.json({
    playerId,
    games: rows.results ?? [],
  });
}
