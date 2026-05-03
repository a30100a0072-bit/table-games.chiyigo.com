// /src/api/oidc.ts
// OIDC client routes for the chiyigo.com IdP integration.
//
// Three endpoints (plus the SPA-driven logout):
//   • GET  /auth/oauth/start    — begins flow, redirects to chiyigo authorize endpoint
//   • POST /auth/oauth/exchange — SPA delivers (code, state) from fragment, gets our JWT
//   • POST /auth/oauth/refresh  — uses stored refresh_token to silently re-issue
//   • POST /auth/oauth/logout   — revokes our session, returns end_session_endpoint URL
//
// Why not pure server-side redirect to SPA: the spec mandates fragment
// response_mode (`#code=…&state=…`). Fragments don't reach the server.
// So the SPA reads them client-side and POSTs to /exchange.            // L3_架構含防禦觀測
//
// State storage: MATCH_KV namespace, key prefix `oidc:state:<state>`,
// TTL 5min, value = JSON {nonce, verifier, redirectUri, createdAt}.
// Single-use — DELETE on lookup so a second exchange with the same
// state fails (replay defence).                                         // L2_鎖定

import {
  loadDiscovery, loadJwks, verifyIdToken,
  createPkceVerifier, pkceChallengeS256, randomState, randomNonce,
  buildAuthorizeUrl, exchangeCode, refreshTokens, OidcError,
} from "../utils/oidc";
import { signJWT } from "../utils/auth";
import { ErrorCode, errorResponse } from "../utils/errors";
import { log } from "../utils/log";
import { bump } from "../utils/metrics";

const STATE_TTL_S       = 5 * 60;
const REFRESH_TTL_DAYS  = 30;          // soft cap for our stored row's expires_at fallback
const SCOPE             = "openid profile email";
const RESPONSE_MODE     = "fragment";
const SIGNUP_GRANT      = 1000;        // matches gateway.ts
const OIDC_SUB_PREFIX   = "oidc:";     // keeps OIDC users in their own player_id namespace

// ── Env contract ────────────────────────────────────────────────────────
//
// `OIDC_ISSUER` is a public var (set in wrangler.toml [vars]).
// `OIDC_CLIENT_ID` is a public var too (clients are not secret in the
// PKCE public-client model). Putting it in [vars] avoids the deploy-time
// secret-juggling for what is by spec non-confidential.                  // L2_隔離
//
// `OIDC_REDIRECT_URI` is public-facing — the IdP allowlists it. We expect
// the chiyigo console to be configured with this exact value.
export interface OidcEnv {
  DB:               D1Database;
  MATCH_KV:         KVNamespace;
  JWT_PRIVATE_JWK:  string;
  OIDC_ISSUER:      string;
  OIDC_CLIENT_ID:   string;
  OIDC_REDIRECT_URI: string;
}

// ── Helpers ────────────────────────────────────────────────────────────
function stateKey(state: string): string { return `oidc:state:${state}`; }
function refreshKey(playerId: string): string { return `oidc:refresh:${playerId}`; }

interface StoredState {
  nonce:        string;
  verifier:     string;
  redirectUri:  string;
  createdAt:    number;
}
interface StoredRefresh {
  refreshToken: string;
  expiresAt:    number;
  rotatedFrom?: string;
}

function isOidcEnvComplete(env: Partial<OidcEnv>): env is OidcEnv {
  return Boolean(env.DB && env.MATCH_KV && env.JWT_PRIVATE_JWK
    && env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_REDIRECT_URI);
}

// ── GET /auth/oauth/start ───────────────────────────────────────────────
// Initiates the auth-code flow. Generates state + nonce + PKCE verifier,
// stashes them under MATCH_KV (5 min), returns 302 to authorize endpoint
// with response_mode=fragment so the SPA picks up code+state client-side.

export async function oauthStart(_request: Request, env: Partial<OidcEnv>): Promise<Response> {
  if (!isOidcEnvComplete(env))
    return errorResponse(ErrorCode.INTERNAL, 503, "OIDC not configured");

  const disco        = await loadDiscovery(env.OIDC_ISSUER);
  const state        = randomState();
  const nonce        = randomNonce();
  const verifier     = createPkceVerifier();
  const challenge    = await pkceChallengeS256(verifier);

  const stored: StoredState = {
    nonce, verifier,
    redirectUri: env.OIDC_REDIRECT_URI,
    createdAt:   Date.now(),
  };
  await env.MATCH_KV.put(stateKey(state), JSON.stringify(stored), {
    expirationTtl: STATE_TTL_S,
  });

  const authUrl = buildAuthorizeUrl({
    discovery:     disco,
    clientId:      env.OIDC_CLIENT_ID,
    redirectUri:   env.OIDC_REDIRECT_URI,
    scope:         SCOPE,
    state, nonce,
    codeChallenge: challenge,
    responseMode:  RESPONSE_MODE,
  });

  bump("oidc_start");
  log("info", "oidc_start", { state });
  return Response.redirect(authUrl, 302);
}

// ── POST /auth/oauth/exchange ─────────────────────────────────────────
// Body: { code, state }. Validates state, swaps code for tokens, validates
// id_token (sig + iss/aud/exp/iat/nonce), upserts user row, mints OUR
// JWT, stores refresh_token in MATCH_KV keyed by playerId.

export async function oauthExchange(request: Request, env: Partial<OidcEnv>): Promise<Response> {
  if (!isOidcEnvComplete(env))
    return errorResponse(ErrorCode.INTERNAL, 503, "OIDC not configured");

  let code: string, state: string;
  try {
    const body = await request.json<{ code?: string; state?: string }>();
    code  = (body.code  ?? "").trim();
    state = (body.state ?? "").trim();
    if (!code || !state) throw new Error("missing");
  } catch {
    return errorResponse(ErrorCode.INVALID_JSON, 400);
  }

  // State lookup + DELETE (single-use). Failure here covers both
  // expired / never-existed (server replay safety).                      // L2_鎖定
  const raw = await env.MATCH_KV.get(stateKey(state));
  if (!raw) return errorResponse(ErrorCode.UNAUTHORIZED, 400, "state expired or unknown");
  await env.MATCH_KV.delete(stateKey(state));
  let stored: StoredState;
  try { stored = JSON.parse(raw) as StoredState; }
  catch { return errorResponse(ErrorCode.UNAUTHORIZED, 400, "state corrupt"); }

  let claims;
  let tokens;
  try {
    const disco = await loadDiscovery(env.OIDC_ISSUER);
    tokens = await exchangeCode(
      disco, env.OIDC_CLIENT_ID, stored.redirectUri,
      code, stored.verifier,
    );
    const jwks  = await loadJwks(disco.jwks_uri);
    claims      = await verifyIdToken(tokens.id_token, {
      issuer:   env.OIDC_ISSUER,
      audience: env.OIDC_CLIENT_ID,
      jwks,
      nonce:    stored.nonce,
    });
  } catch (err) {
    const msg = err instanceof OidcError ? err.message : "exchange failed";
    log("warn", "oidc_exchange_failed", { msg, state });
    return errorResponse(ErrorCode.UNAUTHORIZED, 401, msg);
  }

  // Map sub → namespaced player_id. The "oidc:" prefix lets the existing
  // guest-name validation rules stay intact (they reject ":" in names).   // L2_隔離
  const playerId   = OIDC_SUB_PREFIX + claims.sub;
  const displayName = claims.name ?? claims.email ?? playerId;

  await ensureOidcUser(env.DB, playerId, claims.sub, displayName);

  // Frozen-account gate (defence in depth — same check as /auth/token).   // L3_架構含防禦觀測
  const frozen = await env.DB
    .prepare("SELECT frozen_at, frozen_reason FROM users WHERE player_id = ?")
    .bind(playerId)
    .first<{ frozen_at: number; frozen_reason: string | null }>();
  if (frozen && frozen.frozen_at > 0) {
    log("warn", "oidc_blocked_frozen", { playerId });
    return errorResponse(ErrorCode.ACCOUNT_FROZEN, 423, undefined,
      { reason: frozen.frozen_reason ?? "" });
  }

  // Persist refresh_token (if IdP issued one). We key by playerId — only
  // one active refresh row per user — and store the prior value's hash
  // in `rotatedFrom` so a stolen refresh used after a legitimate refresh
  // can be detected (one-shot rotation).                                  // L2_鎖定
  if (tokens.refresh_token) {
    const expiresAt = Date.now() + REFRESH_TTL_DAYS * 86_400_000;
    const stored: StoredRefresh = { refreshToken: tokens.refresh_token, expiresAt };
    await env.MATCH_KV.put(refreshKey(playerId), JSON.stringify(stored), {
      expirationTtl: REFRESH_TTL_DAYS * 86_400,
    });
  }

  const ourJwt = await signJWT(playerId, env.JWT_PRIVATE_JWK);
  bump("oidc_exchange_ok");
  log("info", "oidc_exchange_ok", { playerId });

  return Response.json({
    token:    ourJwt,
    playerId,
    profile: {
      email:   claims.email   ?? null,
      name:    claims.name    ?? null,
      picture: claims.picture ?? null,
    },
  });
}

// ── POST /auth/oauth/refresh ─────────────────────────────────────────
// Body: { playerId }. Caller must already hold a valid (possibly near-
// expired) JWT — gateway routes through verifyJWT first. We use the
// stored refresh_token to fetch new id/access tokens, validate the new
// id_token, rotate the stored refresh, and re-mint our JWT.

export async function oauthRefresh(playerId: string, env: Partial<OidcEnv>): Promise<Response> {
  if (!isOidcEnvComplete(env))
    return errorResponse(ErrorCode.INTERNAL, 503, "OIDC not configured");

  if (!playerId.startsWith(OIDC_SUB_PREFIX))
    return errorResponse(ErrorCode.UNAUTHORIZED, 400, "not an OIDC session");

  const raw = await env.MATCH_KV.get(refreshKey(playerId));
  if (!raw) return errorResponse(ErrorCode.UNAUTHORIZED, 401, "no refresh token");
  let row: StoredRefresh;
  try { row = JSON.parse(raw) as StoredRefresh; }
  catch { return errorResponse(ErrorCode.UNAUTHORIZED, 401, "refresh row corrupt"); }
  if (row.expiresAt < Date.now())
    return errorResponse(ErrorCode.UNAUTHORIZED, 401, "refresh expired");

  let tokens;
  let claims;
  try {
    const disco = await loadDiscovery(env.OIDC_ISSUER);
    tokens = await refreshTokens(disco, env.OIDC_CLIENT_ID, row.refreshToken);
    const jwks = await loadJwks(disco.jwks_uri);
    // No nonce on refreshed id_tokens (per OIDC core spec).
    claims = await verifyIdToken(tokens.id_token, {
      issuer:   env.OIDC_ISSUER,
      audience: env.OIDC_CLIENT_ID,
      jwks,
    });
  } catch (err) {
    const msg = err instanceof OidcError ? err.message : "refresh failed";
    log("warn", "oidc_refresh_failed", { msg, playerId });
    // On any failure, drop the stored refresh — forces a fresh login.    // L2_鎖定
    await env.MATCH_KV.delete(refreshKey(playerId));
    return errorResponse(ErrorCode.UNAUTHORIZED, 401, msg);
  }

  // Sanity: the new id_token's sub must match our row.
  const subMatched = (OIDC_SUB_PREFIX + claims.sub) === playerId;
  if (!subMatched) {
    await env.MATCH_KV.delete(refreshKey(playerId));
    return errorResponse(ErrorCode.UNAUTHORIZED, 401, "sub mismatch on refresh");
  }

  if (tokens.refresh_token && tokens.refresh_token !== row.refreshToken) {
    const expiresAt = Date.now() + REFRESH_TTL_DAYS * 86_400_000;
    const next: StoredRefresh = {
      refreshToken: tokens.refresh_token, expiresAt, rotatedFrom: row.refreshToken.slice(0, 8),
    };
    await env.MATCH_KV.put(refreshKey(playerId), JSON.stringify(next), {
      expirationTtl: REFRESH_TTL_DAYS * 86_400,
    });
  }

  const ourJwt = await signJWT(playerId, env.JWT_PRIVATE_JWK);
  bump("oidc_refresh_ok");
  return Response.json({ token: ourJwt, playerId });
}

// ── POST /auth/oauth/logout ─────────────────────────────────────────
// Drops our stored refresh + returns end_session_endpoint (if the IdP
// publishes one) so the SPA can navigate the user there for chiyigo-side
// session termination. Three-way logout is SPA-driven because fragment
// response_mode + cross-origin cookie SOP make it impossible to do a
// single server-side cascade.                                            // L2_鎖定

export async function oauthLogout(playerId: string, env: Partial<OidcEnv>): Promise<Response> {
  if (!isOidcEnvComplete(env))
    return errorResponse(ErrorCode.INTERNAL, 503, "OIDC not configured");

  await env.MATCH_KV.delete(refreshKey(playerId));
  let endSession: string | null = null;
  try {
    const disco = await loadDiscovery(env.OIDC_ISSUER);
    endSession  = disco.end_session_endpoint ?? null;
  } catch {
    // Discovery failure on logout is non-fatal — client-side state is
    // already cleared, the IdP session can be ended on next login.
  }
  return Response.json({ ok: true, endSessionEndpoint: endSession });
}

// ── User upsert ───────────────────────────────────────────────────────
// Mirrors gateway.ts ensureUserWallet but writes oidc_sub too. Idempotent.

async function ensureOidcUser(
  db:           D1Database,
  playerId:     string,
  oidcSub:      string,
  displayName:  string,
): Promise<void> {
  const now = Date.now();
  await db.batch([
    db.prepare(
      "INSERT OR IGNORE INTO users (player_id, display_name, oidc_sub, chip_balance, created_at, updated_at)" +
      " VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(playerId, displayName, oidcSub, SIGNUP_GRANT, now, now),
    db.prepare(
      "INSERT OR IGNORE INTO chip_ledger (player_id, game_id, delta, reason, created_at)" +
      " VALUES (?, NULL, ?, 'signup', ?)",
    ).bind(playerId, SIGNUP_GRANT, now),
    // Refresh display name on every login so chiyigo profile changes flow
    // through. updated_at gets bumped too.
    db.prepare(
      "UPDATE users SET display_name = ?, updated_at = ? WHERE player_id = ?",
    ).bind(displayName, now, playerId),
  ]);
}
