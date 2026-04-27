// /src/utils/auth.ts

// ── Encode helper (sign path) ─────────────────────────────────────────
function b64urlEncode(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : new Uint8Array(input);
  let bin = "";
  bytes.forEach(b => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Issue an HS256 JWT signed with the Worker's JWT_SECRET. */
export async function signJWT(
  sub:        string,
  secret:     string,
  ttlSeconds: number = 86_400,
): Promise<string> {
  const header  = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now     = Math.floor(Date.now() / 1000);
  const payload = b64urlEncode(JSON.stringify({ sub, iat: now, exp: now + ttlSeconds }));
  const msg     = `${header}.${payload}`;
  const key     = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return `${msg}.${b64urlEncode(sig)}`;
}

export class JWTError extends Error {
  constructor(msg: string) { super(msg); this.name = "JWTError"; }
}

interface JWTClaims {
  sub:  string;   // playerId
  exp:  number;   // seconds since epoch
  iat?: number;
}

// base64url → Uint8Array without Node.js Buffer                       // L3_糾錯風險表
function b64url(input: string): Uint8Array {
  const pad  = "=".repeat((4 - (input.length % 4)) % 4);
  const raw  = atob((input + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const buf  = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

/**
 * Verify an HS256 JWT and return the `sub` claim (playerId).
 * Throws JWTError on any validation failure — caller decides HTTP status.
 */
export async function verifyJWT(token: string, secret: string): Promise<string> {
  const parts = token.split(".");
  if (parts.length !== 3)                                              // L3_糾錯風險表
    throw new JWTError("malformed token: expected 3 segments");

  const [hdr, payload, sig] = parts as [string, string, string];        // L2_鎖定 length===3 已守衛

  // ── Signature verification ──────────────────────────────────────── L2_鎖定
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    b64url(sig) as BufferSource,
    new TextEncoder().encode(`${hdr}.${payload}`),
  );
  if (!valid) throw new JWTError("invalid signature");                 // L2_鎖定

  // ── Payload parsing ─────────────────────────────────────────────── L3_糾錯風險表
  let claims: JWTClaims;
  try   { claims = JSON.parse(new TextDecoder().decode(b64url(payload))); }
  catch { throw new JWTError("malformed payload"); }

  // ── Expiration check ────────────────────────────────────────────── L2_鎖定
  if (typeof claims.exp !== "number")
    throw new JWTError("missing exp claim");
  if (Math.floor(Date.now() / 1000) >= claims.exp)                    // L2_鎖定
    throw new JWTError("token expired");

  if (!claims.sub) throw new JWTError("missing sub claim");
  return claims.sub;
}
