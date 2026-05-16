// /src/routes/auth.ts
// POST /auth/token — issue an ES256 JWT for a guest-style playerId.
// No password (MVP); OIDC SSO is the production path. Players choose a
// display name; the JWT sub claim becomes their playerId.
//
// Side effects: lazy-create user wallet + maybe-grant daily bonus.    // L3_架構含防禦觀測

import { signJWT }                    from "../utils/auth";
import { ErrorCode, errorResponse }   from "../utils/errors";
import { log }                        from "../utils/log";
import { bump }                       from "../utils/metrics";
import { ensureUserWallet, maybeGrantDailyBonus } from "../domain/wallet";

export interface IssueTokenEnv {
  DB:              D1Database;
  JWT_PRIVATE_JWK: string;
}

export async function issueToken(request: Request, env: IssueTokenEnv): Promise<Response> {
  let playerId: string;
  try {
    const body = await request.json<{ playerId?: string }>();
    playerId   = (body.playerId ?? "").trim();
  } catch {
    return errorResponse(ErrorCode.INVALID_JSON, 400);
  }

  // Frozen account check — defended at the auth boundary so a banned
  // user can't even pick up a token. Match endpoint also checks (defence
  // in depth) for tokens issued before the freeze landed.               // L3_架構含防禦觀測
  const frozen = await env.DB
    .prepare("SELECT frozen_at, frozen_reason FROM users WHERE player_id = ?")
    .bind(playerId)
    .first<{ frozen_at: number; frozen_reason: string | null }>();
  if (frozen && frozen.frozen_at > 0) {
    log("warn", "auth_blocked_frozen", { playerId, reason: frozen.frozen_reason ?? "unspecified" });
    return errorResponse(
      ErrorCode.ACCOUNT_FROZEN, 423, undefined,
      { reason: frozen.frozen_reason ?? "" },
    );
  }

  if (playerId.length < 2 || playerId.length > 20)
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "playerId must be 2–20 chars");

  if (!/^[a-zA-Z0-9_-]+$/.test(playerId))
    return errorResponse(ErrorCode.VALIDATION_FAILED, 400, "a-z A-Z 0-9 _ - only");

  if (playerId.toUpperCase().startsWith("BOT_"))
    return errorResponse(ErrorCode.RESERVED_PREFIX, 400);

  // Deletion tombstones look like `DELETED_<hex>`. Guard signup so a user
  // can't recreate a tombstoned identity.                                 // L3_架構含防禦觀測
  if (playerId.toUpperCase().startsWith("DELETED_"))
    return errorResponse(ErrorCode.RESERVED_PREFIX, 400);

  await ensureUserWallet(env.DB, playerId);
  const dailyBonus = await maybeGrantDailyBonus(env.DB, playerId);

  const token = await signJWT(playerId, env.JWT_PRIVATE_JWK);
  bump("tokens_issued");
  log("info", "token_issued", { playerId, dailyBonus: dailyBonus ?? 0 });
  return Response.json({ token, playerId, dailyBonus });
}
