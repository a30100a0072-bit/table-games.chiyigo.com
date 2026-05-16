// /src/routes/admin.ts
// Admin surface — chip adjustment / account freeze / user list / health.
// Auth via X-Admin-Secret header (timing-safe), centralised in
// utils/adminAuth.ts so every endpoint fails identically when the
// secret is missing or wrong.                                          // L3_架構含防禦觀測

import { checkAdmin, AdminEnv }       from "../utils/adminAuth";
import { ErrorCode, errorResponse }   from "../utils/errors";
import { log }                        from "../utils/log";
import { bump }                       from "../utils/metrics";
import { writeAudit }                 from "../domain/audit";

export interface AdminRouteEnv extends AdminEnv {
  DB: D1Database;
}

// ── POST /api/admin/adjust ───────────────────────────────────────────
// Body: { playerId, delta (signed integer), reason (free text) }.
// Writes a chip_ledger 'adjustment' row + atomically refreshes balance.
export async function adjustChips(request: Request, env: AdminRouteEnv): Promise<Response> {
  const gate = checkAdmin(request, env);
  if (gate) return gate;

  let body: { playerId?: string; delta?: number; reason?: string };
  try { body = await request.json(); }
  catch { return errorResponse(ErrorCode.INVALID_JSON, 400); }

  const playerId = (body.playerId ?? "").trim();
  const delta    = Number(body.delta);
  const reason   = (body.reason ?? "").trim() || "manual";
  if (!playerId || !Number.isFinite(delta) || delta === 0 || !Number.isInteger(delta))
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "playerId + non-zero integer delta required");

  const now = Date.now();
  const upd = await env.DB
    .prepare(
      "UPDATE users SET chip_balance = chip_balance + ?, updated_at = ?" +
      " WHERE player_id = ? AND chip_balance + ? >= 0",
    )
    .bind(delta, now, playerId, delta)
    .run();

  if (!upd.success || (upd.meta?.changes ?? 0) === 0) {
    return errorResponse(ErrorCode.OVERDRAW, 409, "player not found or would overdraw");
  }

  await env.DB
    .prepare(
      "INSERT INTO chip_ledger (player_id, game_id, delta, reason, created_at)" +
      " VALUES (?, NULL, ?, 'adjustment', ?)",
    )
    .bind(playerId, delta, now)
    .run();

  bump("admin_adjustments");
  log("warn", "admin_adjusted", { playerId, delta, reason });
  await writeAudit(env.DB, "adjust", playerId, delta, reason);

  const after = await env.DB
    .prepare("SELECT chip_balance FROM users WHERE player_id = ?")
    .bind(playerId)
    .first<{ chip_balance: number }>();

  return Response.json({
    playerId, delta, reason, chipBalance: after?.chip_balance ?? 0,
  });
}

// ── POST /api/admin/freeze ───────────────────────────────────────────
export async function freezePlayer(request: Request, env: AdminRouteEnv): Promise<Response> {
  const gate = checkAdmin(request, env);
  if (gate) return gate;

  let body: { playerId?: string; reason?: string };
  try { body = await request.json(); }
  catch { return errorResponse(ErrorCode.INVALID_JSON, 400); }
  const playerId = (body.playerId ?? "").trim();
  const reason   = (body.reason ?? "").trim().slice(0, 200);
  if (!playerId) return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "playerId required");

  const upd = await env.DB
    .prepare(
      "UPDATE users SET frozen_at = ?, frozen_reason = ?, updated_at = ?" +
      " WHERE player_id = ?",
    )
    .bind(Date.now(), reason || null, Date.now(), playerId)
    .run();
  if (!upd.success || (upd.meta?.changes ?? 0) === 0)
    return errorResponse(ErrorCode.NOT_FOUND, 404, "player not found");

  log("warn", "admin_froze", { playerId, reason });
  await writeAudit(env.DB, "freeze", playerId, null, reason);
  return Response.json({ playerId, frozen: true, reason });
}

// ── POST /api/admin/unfreeze ─────────────────────────────────────────
export async function unfreezePlayer(request: Request, env: AdminRouteEnv): Promise<Response> {
  const gate = checkAdmin(request, env);
  if (gate) return gate;

  let body: { playerId?: string };
  try { body = await request.json(); }
  catch { return errorResponse(ErrorCode.INVALID_JSON, 400); }
  const playerId = (body.playerId ?? "").trim();
  if (!playerId) return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "playerId required");

  const upd = await env.DB
    .prepare(
      "UPDATE users SET frozen_at = 0, frozen_reason = NULL, updated_at = ?" +
      " WHERE player_id = ?",
    )
    .bind(Date.now(), playerId)
    .run();
  if (!upd.success || (upd.meta?.changes ?? 0) === 0)
    return errorResponse(ErrorCode.NOT_FOUND, 404, "player not found");

  log("warn", "admin_unfroze", { playerId });
  await writeAudit(env.DB, "unfreeze", playerId, null, null);
  return Response.json({ playerId, frozen: false });
}

// ── GET /api/admin/users — list with frozen state, paginated ─────────
export async function listAdminUsers(request: Request, env: AdminRouteEnv): Promise<Response> {
  const gate = checkAdmin(request, env);
  if (gate) return gate;

  const url    = new URL(request.url);
  const limit  = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const search = (url.searchParams.get("q") ?? "").trim();

  const rows = search
    ? await env.DB
        .prepare(
          "SELECT player_id, display_name, chip_balance, frozen_at, frozen_reason, created_at" +
          " FROM users WHERE player_id LIKE ?" +
          " ORDER BY created_at DESC LIMIT ? OFFSET ?",
        )
        .bind(`%${search}%`, limit, offset)
        .all()
    : await env.DB
        .prepare(
          "SELECT player_id, display_name, chip_balance, frozen_at, frozen_reason, created_at" +
          " FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?",
        )
        .bind(limit, offset)
        .all();

  return Response.json({ rows: rows.results ?? [], limit, offset });
}

// ── GET /api/admin/health — operational snapshot ─────────────────────
// Aggregates the few signals an operator wants at a glance: most recent
// cron sweep + recent runs window, table sizes, and frozen-account
// count. All cheap COUNT(*) / single-row reads — meant to be cheap
// enough to poll once a minute from a dashboard.
export async function getAdminHealth(request: Request, env: AdminRouteEnv): Promise<Response> {
  const gate = checkAdmin(request, env);
  if (gate) return gate;

  const now    = Date.now();
  const dayAgo = now - 86_400_000;

  // Run all reads in parallel; each falls back so a single missing table
  // (e.g. cron_runs on a fresh deploy) doesn't tank the whole endpoint.
  const [lastCron, recentCronRows, frozen, ledger, replays, dms, shares] = await Promise.all([
    env.DB.prepare(
      "SELECT ran_at, dms_purged, room_tokens_purged, replay_shares_purged," +
      "       room_invites_purged, errors_json" +
      "  FROM cron_runs ORDER BY ran_at DESC LIMIT 1",
    ).first<{
      ran_at: number; dms_purged: number; room_tokens_purged: number;
      replay_shares_purged: number; room_invites_purged: number;
      errors_json: string | null;
    }>().catch(() => null),
    env.DB.prepare(
      "SELECT COUNT(*) AS n, SUM(CASE WHEN errors_json IS NOT NULL THEN 1 ELSE 0 END) AS failed" +
      "  FROM cron_runs WHERE ran_at >= ?",
    ).bind(now - 7 * 86_400_000)
     .first<{ n: number; failed: number }>().catch(() => ({ n: 0, failed: 0 })),
    env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE frozen_at > 0")
      .first<{ n: number }>().catch(() => ({ n: 0 })),
    env.DB.prepare("SELECT COUNT(*) AS n FROM chip_ledger WHERE created_at >= ?")
      .bind(dayAgo).first<{ n: number }>().catch(() => ({ n: 0 })),
    env.DB.prepare("SELECT COUNT(*) AS n FROM replay_meta")
      .first<{ n: number }>().catch(() => ({ n: 0 })),
    env.DB.prepare("SELECT COUNT(*) AS n FROM dms")
      .first<{ n: number }>().catch(() => ({ n: 0 })),
    env.DB.prepare("SELECT COUNT(*) AS n FROM replay_shares WHERE expires_at > ?")
      .bind(now).first<{ n: number }>().catch(() => ({ n: 0 })),
  ]);

  return Response.json({
    now,
    cron: {
      lastRunAt:      lastCron?.ran_at ?? null,
      lastResult:     lastCron && {
        dmsPurged:          lastCron.dms_purged,
        roomTokensPurged:   lastCron.room_tokens_purged,
        replaySharesPurged: lastCron.replay_shares_purged,
        roomInvitesPurged:  lastCron.room_invites_purged,
        errors:             lastCron.errors_json ? JSON.parse(lastCron.errors_json) as string[] : [],
      },
      runsLast7d:     recentCronRows?.n      ?? 0,
      failuresLast7d: recentCronRows?.failed ?? 0,
    },
    counts: {
      frozenUsers:        frozen?.n  ?? 0,
      ledgerRowsLast24h:  ledger?.n  ?? 0,
      replayRows:         replays?.n ?? 0,
      dmRows:             dms?.n     ?? 0,
      activeReplayShares: shares?.n  ?? 0,
    },
  });
}
