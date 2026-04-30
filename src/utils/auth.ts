// /src/utils/auth.ts
// ES256 (ECDSA P-256) JWT sign + verify, plus JWKS publication.
// The Worker acts as its own IdP: it signs tokens with a private JWK
// (env.JWT_PRIVATE_JWK) and exposes the matching public JWK at
// /.well-known/jwks.json for any verifier (this Worker included).      // L3_架構含防禦觀測

// ── Errors ─────────────────────────────────────────────────────────────
export class JWTError extends Error {
  constructor(msg: string) { super(msg); this.name = "JWTError"; }
}

// ── JWK shapes ─────────────────────────────────────────────────────────
export interface PrivateJwk {
  kty: "EC"; crv: "P-256";
  x: string; y: string; d: string;
  kid: string;
  alg?: "ES256"; use?: "sig";
}
export interface PublicJwk {
  kty: "EC"; crv: "P-256";
  x: string; y: string;
  kid: string;
  alg: "ES256"; use: "sig";
}
export interface Jwks { keys: PublicJwk[]; }

interface JWTClaims { sub: string; iat?: number; exp: number; }

// ── base64url helpers (no Node Buffer) ─────────────────────────────────
function b64urlEncode(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : new Uint8Array(input);
  let bin = "";
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function b64urlDecode(input: string): Uint8Array {
  const pad = "=".repeat((4 - (input.length % 4)) % 4);
  const raw = atob((input + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

// ── Module-scoped caches (Workers reuse these across requests) ─────────
let signKeyCache:   { jwkJson: string; key: CryptoKey; kid: string } | null = null;
let jwksCache:      { jwkJson: string; jwks: Jwks } | null = null;
const verifyKeyCache = new Map<string, CryptoKey>();

// ── Private JWK parsing & public derivation ────────────────────────────
export function parsePrivateJwk(raw: string): PrivateJwk {
  let j: Partial<PrivateJwk>;
  try { j = JSON.parse(raw) as Partial<PrivateJwk>; }
  catch { throw new JWTError("JWT_PRIVATE_JWK is not valid JSON"); }
  if (j.kty !== "EC" || j.crv !== "P-256" || !j.x || !j.y || !j.d || !j.kid)
    throw new JWTError("JWT_PRIVATE_JWK must be an EC P-256 JWK with kid");
  return j as PrivateJwk;
}

export function publicJwkOf(priv: PrivateJwk): PublicJwk {
  return { kty: "EC", crv: "P-256", x: priv.x, y: priv.y, kid: priv.kid, alg: "ES256", use: "sig" };
}

/** Build the JWKS document this Worker publishes at /.well-known/jwks.json. */
export function jwksFromPrivateEnv(privateJwkJson: string): Jwks {
  if (jwksCache && jwksCache.jwkJson === privateJwkJson) return jwksCache.jwks;
  const jwks: Jwks = { keys: [publicJwkOf(parsePrivateJwk(privateJwkJson))] };
  jwksCache = { jwkJson: privateJwkJson, jwks };
  return jwks;
}

// ── WebCrypto key import ───────────────────────────────────────────────
async function getSignKey(privateJwkJson: string): Promise<{ key: CryptoKey; kid: string }> {
  if (signKeyCache && signKeyCache.jwkJson === privateJwkJson)
    return { key: signKeyCache.key, kid: signKeyCache.kid };
  const priv = parsePrivateJwk(privateJwkJson);
  const key  = await crypto.subtle.importKey(
    "jwk", priv as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false, ["sign"],
  );
  signKeyCache = { jwkJson: privateJwkJson, key, kid: priv.kid };
  return { key, kid: priv.kid };
}

async function getVerifyKey(jwk: PublicJwk): Promise<CryptoKey> {
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

// ── Sign ───────────────────────────────────────────────────────────────
/** Issue an ES256 JWT signed with the Worker's private JWK. */
export async function signJWT(
  sub:            string,
  privateJwkJson: string,
  ttlSeconds:     number = 86_400,
): Promise<string> {
  const { key, kid } = await getSignKey(privateJwkJson);
  const header  = b64urlEncode(JSON.stringify({ alg: "ES256", typ: "JWT", kid }));
  const now     = Math.floor(Date.now() / 1000);
  const payload = b64urlEncode(JSON.stringify({ sub, iat: now, exp: now + ttlSeconds }));
  const msg     = `${header}.${payload}`;
  const sig     = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key,
    new TextEncoder().encode(msg),
  );
  // WebCrypto ECDSA already emits raw r||s (64 bytes for P-256), which is
  // exactly the JWS encoding — no DER unwrapping needed.                // L2_鎖定
  return `${msg}.${b64urlEncode(sig)}`;
}

// ── Verify ─────────────────────────────────────────────────────────────
/**
 * Verify an ES256 JWT against a JWKS and return the `sub` claim.
 * Throws JWTError on any validation failure — caller decides HTTP status.
 */
export async function verifyJWT(token: string, jwks: Jwks): Promise<string> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JWTError("malformed token: expected 3 segments");
  const [hdrB64, payloadB64, sigB64] = parts as [string, string, string];

  let hdr: { alg?: string; kid?: string; typ?: string };
  try   { hdr = JSON.parse(new TextDecoder().decode(b64urlDecode(hdrB64))); }
  catch { throw new JWTError("malformed header"); }
  if (hdr.alg !== "ES256") throw new JWTError("alg must be ES256");
  if (!hdr.kid)            throw new JWTError("missing kid");

  const jwk = jwks.keys.find(k => k.kid === hdr.kid);
  if (!jwk) throw new JWTError(`unknown kid: ${hdr.kid}`);

  const key   = await getVerifyKey(jwk);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, key,
    b64urlDecode(sigB64) as BufferSource,
    new TextEncoder().encode(`${hdrB64}.${payloadB64}`),
  );
  if (!valid) throw new JWTError("invalid signature");

  let claims: JWTClaims;
  try   { claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))); }
  catch { throw new JWTError("malformed payload"); }

  if (typeof claims.exp !== "number")             throw new JWTError("missing exp claim");
  if (Math.floor(Date.now() / 1000) >= claims.exp) throw new JWTError("token expired");
  if (!claims.sub)                                 throw new JWTError("missing sub claim");
  return claims.sub;
}
