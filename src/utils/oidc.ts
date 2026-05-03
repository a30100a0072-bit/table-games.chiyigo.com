// /src/utils/oidc.ts
// OIDC (OpenID Connect) client utilities for the chiyigo.com IdP.
// All crypto goes through WebCrypto (no new dependencies). Mirrors the
// shape of utils/auth.ts (this Worker's own JWT issuance) — there we
// SIGN with our private JWK, here we VERIFY against chiyigo's JWKS.   // L3_架構含防禦觀測
//
// Spec match (chiyigo's OIDC spec, 2026-05-04):
//   • Discovery:        https://chiyigo.com/.well-known/openid-configuration
//   • Issuer:           https://chiyigo.com (must match id_token.iss exactly)
//   • Algorithm:        ES256 (id_token header.alg + kid → JWKS lookup)
//   • Audience:         our client_id (must equal id_token.aud)
//   • Flow:             Authorization Code + PKCE S256
//   • Public client:    token_endpoint_auth_method = none
//   • Required claims:  iss, aud, sub, exp, iat, nonce
//   • Optional claims:  email, name, picture

export class OidcError extends Error {
  constructor(msg: string) { super(msg); this.name = "OidcError"; }
}

// ── Discovery + JWKS shapes ───────────────────────────────────────────────
export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint:         string;
  jwks_uri:               string;
  userinfo_endpoint?:     string;
  end_session_endpoint?:  string;
  /** Algorithms the IdP advertises for id_token signing. We require ES256. */
  id_token_signing_alg_values_supported?: string[];
  /** Response modes — we use "fragment". */
  response_modes_supported?: string[];
}

export interface OidcPublicJwk {
  kty: "EC"; crv: "P-256";
  x:   string; y: string;
  kid: string;
  alg?: string;
  use?: string;
}
export interface OidcJwks { keys: OidcPublicJwk[]; }

// ── ID token claim shape (only fields we read; passthrough is allowed) ─
export interface OidcIdTokenClaims {
  iss:     string;
  aud:     string | string[];
  sub:     string;
  exp:     number;
  iat:     number;
  nonce?:  string;
  email?:  string;
  name?:   string;
  picture?: string;
  // Other claims permitted; we don't constrain them.
  [k: string]: unknown;
}

// ── Module-level caches (Workers reuse across requests) ───────────────
// Discovery + JWKS are stable; cache for 1h. The cache key is the
// issuer URL so a future multi-IdP setup wouldn't collide.            // L2_鎖定
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS      = 60 * 60 * 1000;

interface DiscoCacheEntry { value: OidcDiscovery; fetchedAt: number; }
interface JwksCacheEntry  { value: OidcJwks;       fetchedAt: number; }

const discoCache: Map<string, DiscoCacheEntry> = new Map();
const jwksCache:  Map<string, JwksCacheEntry>  = new Map();

// Global fetch override slot — tests inject a stub. Production passes
// `fetch` through as a parameter (preferred), but a few code paths can
// only see `oidc.ts` and need the slot.                                 // L2_隔離
type FetchLike = typeof fetch;

export async function loadDiscovery(issuer: string, fetchFn: FetchLike = fetch): Promise<OidcDiscovery> {
  const now = Date.now();
  const cached = discoCache.get(issuer);
  if (cached && (now - cached.fetchedAt) < DISCOVERY_TTL_MS) return cached.value;

  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetchFn(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new OidcError(`discovery fetch failed: ${res.status}`);
  const doc = await res.json() as OidcDiscovery;
  if (doc.issuer !== issuer) throw new OidcError(`discovery iss mismatch: got ${doc.issuer}, expected ${issuer}`);
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri)
    throw new OidcError("discovery doc missing required endpoints");
  if (doc.id_token_signing_alg_values_supported &&
      !doc.id_token_signing_alg_values_supported.includes("ES256"))
    throw new OidcError("IdP does not advertise ES256");
  discoCache.set(issuer, { value: doc, fetchedAt: now });
  return doc;
}

export async function loadJwks(jwksUri: string, fetchFn: FetchLike = fetch): Promise<OidcJwks> {
  const now = Date.now();
  const cached = jwksCache.get(jwksUri);
  if (cached && (now - cached.fetchedAt) < JWKS_TTL_MS) return cached.value;

  const res = await fetchFn(jwksUri, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new OidcError(`jwks fetch failed: ${res.status}`);
  const jwks = await res.json() as OidcJwks;
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0)
    throw new OidcError("jwks empty");
  jwksCache.set(jwksUri, { value: jwks, fetchedAt: now });
  return jwks;
}

// ── base64url helpers (mirror utils/auth.ts) ──────────────────────────
function b64urlDecode(input: string): Uint8Array {
  const pad = "=".repeat((4 - (input.length % 4)) % 4);
  const raw = atob((input + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}
function b64urlEncode(input: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input instanceof Uint8Array
      ? input
      : new Uint8Array(input);
  let bin = "";
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// ── ID token verification ─────────────────────────────────────────────
// Strict checks per spec section above:
//   • header.alg === "ES256"
//   • header.kid resolves in jwks
//   • signature valid
//   • iss === expected issuer (full string equality, not prefix)
//   • aud contains our client_id (string compare or array.includes)
//   • iat <= now + skew
//   • exp >  now - skew
//   • nonce === expected nonce (when expected supplied)
//
// Skew defaults to 60s — enough to absorb edge clock drift between
// chiyigo and Cloudflare without opening a meaningful replay window.   // L2_鎖定
export interface VerifyIdTokenOpts {
  issuer:   string;
  audience: string;
  jwks:     OidcJwks;
  /** When provided, must equal id_token.nonce. */
  nonce?:   string;
  nowSec?:  number;
  skewSec?: number;
}

const verifyKeyCache = new Map<string, CryptoKey>();
async function importVerifyKey(jwk: OidcPublicJwk): Promise<CryptoKey> {
  const cached = verifyKeyCache.get(jwk.kid);
  if (cached) return cached;
  const key = await crypto.subtle.importKey(
    "jwk", jwk as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false, ["verify"],
  );
  verifyKeyCache.set(jwk.kid, key);
  return key;
}

export async function verifyIdToken(
  token: string,
  opts:  VerifyIdTokenOpts,
): Promise<OidcIdTokenClaims> {
  const skew = opts.skewSec ?? 60;
  const now  = opts.nowSec  ?? Math.floor(Date.now() / 1000);

  const parts = token.split(".");
  if (parts.length !== 3) throw new OidcError("malformed id_token: expected 3 segments");
  const [hdrB64, payloadB64, sigB64] = parts as [string, string, string];

  let hdr: { alg?: string; kid?: string; typ?: string };
  try { hdr = JSON.parse(new TextDecoder().decode(b64urlDecode(hdrB64))); }
  catch { throw new OidcError("malformed header"); }
  if (hdr.alg !== "ES256") throw new OidcError(`alg must be ES256 (got ${hdr.alg})`);
  if (!hdr.kid)            throw new OidcError("id_token header missing kid");

  const jwk = opts.jwks.keys.find(k => k.kid === hdr.kid);
  if (!jwk) throw new OidcError(`unknown kid: ${hdr.kid}`);

  const key   = await importVerifyKey(jwk);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, key,
    b64urlDecode(sigB64) as BufferSource,
    new TextEncoder().encode(`${hdrB64}.${payloadB64}`),
  );
  if (!valid) throw new OidcError("invalid id_token signature");

  let claims: OidcIdTokenClaims;
  try { claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as OidcIdTokenClaims; }
  catch { throw new OidcError("malformed id_token payload"); }

  if (claims.iss !== opts.issuer)
    throw new OidcError(`iss mismatch: got ${claims.iss}, expected ${opts.issuer}`);

  const audOk = Array.isArray(claims.aud)
    ? claims.aud.includes(opts.audience)
    : claims.aud === opts.audience;
  if (!audOk) throw new OidcError(`aud mismatch: got ${JSON.stringify(claims.aud)}, expected ${opts.audience}`);

  if (typeof claims.exp !== "number") throw new OidcError("missing exp claim");
  if (typeof claims.iat !== "number") throw new OidcError("missing iat claim");
  if (claims.exp + skew <= now)       throw new OidcError("id_token expired");
  if (claims.iat - skew > now)        throw new OidcError("id_token issued in the future");

  if (!claims.sub)                    throw new OidcError("missing sub claim");

  if (opts.nonce !== undefined) {
    if (typeof claims.nonce !== "string" || claims.nonce !== opts.nonce)
      throw new OidcError("nonce mismatch");
  }

  return claims;
}

// ── PKCE helpers ──────────────────────────────────────────────────────
// RFC 7636: verifier is 43–128 chars from [A-Z a-z 0-9 - . _ ~].
// We use 43 bytes of randomness → 64-char base64url, well within the
// upper bound. The challenge is the URL-safe SHA-256 of the verifier.   // L2_鎖定
export function randomB64url(byteLen: number): string {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return b64urlEncode(buf);
}

export function createPkceVerifier(): string {
  return randomB64url(48); // 64 chars after b64url
}

export async function pkceChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64urlEncode(digest);
}

export function randomState(): string  { return randomB64url(24); }
export function randomNonce(): string  { return randomB64url(24); }

// ── Authorization URL builder ─────────────────────────────────────────
export interface AuthorizeUrlOpts {
  discovery:    OidcDiscovery;
  clientId:     string;
  redirectUri:  string;
  scope:        string;       // "openid profile email"
  state:        string;
  nonce:        string;
  codeChallenge: string;
  responseMode?: "fragment" | "query" | "form_post";
}

export function buildAuthorizeUrl(opts: AuthorizeUrlOpts): string {
  const u = new URL(opts.discovery.authorization_endpoint);
  u.searchParams.set("response_type",          "code");
  u.searchParams.set("client_id",              opts.clientId);
  u.searchParams.set("redirect_uri",           opts.redirectUri);
  u.searchParams.set("scope",                  opts.scope);
  u.searchParams.set("state",                  opts.state);
  u.searchParams.set("nonce",                  opts.nonce);
  u.searchParams.set("code_challenge",         opts.codeChallenge);
  u.searchParams.set("code_challenge_method",  "S256");
  u.searchParams.set("response_mode",          opts.responseMode ?? "fragment");
  return u.toString();
}

// ── Token endpoint exchange ───────────────────────────────────────────
export interface TokenResponse {
  id_token:      string;
  access_token:  string;
  refresh_token?: string;
  token_type:    string;
  expires_in?:   number;
  scope?:        string;
}

export async function exchangeCode(
  discovery:   OidcDiscovery,
  clientId:    string,
  redirectUri: string,
  code:        string,
  codeVerifier: string,
  fetchFn:     FetchLike = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type:    "authorization_code",
    code,
    redirect_uri:  redirectUri,
    client_id:     clientId,
    code_verifier: codeVerifier,
  });
  const res = await fetchFn(discovery.token_endpoint, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OidcError(`token exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return await res.json() as TokenResponse;
}

export async function refreshTokens(
  discovery:   OidcDiscovery,
  clientId:    string,
  refreshToken: string,
  fetchFn:     FetchLike = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: refreshToken,
    client_id:     clientId,
  });
  const res = await fetchFn(discovery.token_endpoint, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OidcError(`refresh failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return await res.json() as TokenResponse;
}

// ── Test helpers ──────────────────────────────────────────────────────
export function _resetCachesForTests(): void {
  discoCache.clear();
  jwksCache.clear();
  verifyKeyCache.clear();
}
