// /test/oidc.test.ts
// OIDC client validation tests. We mint id_tokens locally with WebCrypto,
// publish them through a synthetic JWKS, and exercise verifyIdToken across
// the spec checks: sig, iss, aud, exp/iat, nonce, kid, alg.

import { describe, expect, it, beforeEach } from "vitest";
import {
  verifyIdToken, OidcError, _resetCachesForTests,
  createPkceVerifier, pkceChallengeS256,
  buildAuthorizeUrl,
  type OidcDiscovery, type OidcJwks, type OidcPublicJwk,
} from "../src/utils/oidc";

// ── Helpers ────────────────────────────────────────────────────────────
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

interface Issued {
  idToken: string;
  jwks:    OidcJwks;
  kid:     string;
  /** Sign + repackage: lets a test mutate header/payload after the fact. */
  privateKey: CryptoKey;
}

interface Claims {
  iss:    string;
  aud:    string | string[];
  sub:    string;
  exp:    number;
  iat:    number;
  nonce?: string;
  email?: string;
  name?:  string;
  picture?: string;
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
}

async function publicJwkOf(pub: CryptoKey, kid: string): Promise<OidcPublicJwk> {
  const jwk = await crypto.subtle.exportKey("jwk", pub) as JsonWebKey;
  return {
    kty: "EC", crv: "P-256",
    x: jwk.x!, y: jwk.y!, kid,
    alg: "ES256", use: "sig",
  };
}

async function issueIdToken(
  claims: Claims,
  opts:   { kid?: string; alg?: string; missingKid?: boolean } = {},
): Promise<Issued> {
  const kid    = opts.kid ?? "kid-1";
  const { privateKey, publicKey } = await generateKeyPair();
  const header: Record<string, unknown> = { alg: opts.alg ?? "ES256", typ: "JWT" };
  if (!opts.missingKid) header.kid = kid;
  const hdrB64 = b64urlEncode(JSON.stringify(header));
  const payB64 = b64urlEncode(JSON.stringify(claims));
  const sig    = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, privateKey,
    new TextEncoder().encode(`${hdrB64}.${payB64}`),
  );
  const idToken = `${hdrB64}.${payB64}.${b64urlEncode(sig)}`;
  return {
    idToken,
    jwks: { keys: [await publicJwkOf(publicKey, kid)] },
    kid,
    privateKey,
  };
}

const ISSUER   = "https://chiyigo.com";
const AUDIENCE = "client-table-games";

function freshClaims(over: Partial<Claims> = {}): Claims {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss:   ISSUER,
    aud:   AUDIENCE,
    sub:   "user-42",
    iat:   now,
    exp:   now + 600,
    nonce: "n-abc",
    email: "u42@chiyigo.com",
    name:  "User Forty-Two",
    ...over,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────
beforeEach(() => { _resetCachesForTests(); });

describe("verifyIdToken — happy path", () => {
  it("returns claims when sig + iss + aud + nonce all match", async () => {
    const { idToken, jwks } = await issueIdToken(freshClaims());
    const claims = await verifyIdToken(idToken, {
      issuer: ISSUER, audience: AUDIENCE, jwks, nonce: "n-abc",
    });
    expect(claims.sub).toBe("user-42");
    expect(claims.email).toBe("u42@chiyigo.com");
  });

  it("accepts aud as an array containing the audience", async () => {
    const { idToken, jwks } = await issueIdToken(freshClaims({
      aud: [AUDIENCE, "other-client"],
    }));
    const claims = await verifyIdToken(idToken, {
      issuer: ISSUER, audience: AUDIENCE, jwks, nonce: "n-abc",
    });
    expect(claims.sub).toBe("user-42");
  });

  it("skips nonce check when caller doesn't supply one (refresh path)", async () => {
    const { idToken, jwks } = await issueIdToken(freshClaims({ nonce: undefined }));
    const claims = await verifyIdToken(idToken, {
      issuer: ISSUER, audience: AUDIENCE, jwks, // no nonce
    });
    expect(claims.sub).toBe("user-42");
  });
});

describe("verifyIdToken — rejection cases", () => {
  it("rejects wrong issuer", async () => {
    const { idToken, jwks } = await issueIdToken(freshClaims({ iss: "https://evil.example" }));
    await expect(verifyIdToken(idToken, { issuer: ISSUER, audience: AUDIENCE, jwks, nonce: "n-abc" }))
      .rejects.toThrow(/iss mismatch/);
  });

  it("rejects wrong audience", async () => {
    const { idToken, jwks } = await issueIdToken(freshClaims({ aud: "different-client" }));
    await expect(verifyIdToken(idToken, { issuer: ISSUER, audience: AUDIENCE, jwks, nonce: "n-abc" }))
      .rejects.toThrow(/aud mismatch/);
  });

  it("rejects nonce mismatch", async () => {
    const { idToken, jwks } = await issueIdToken(freshClaims({ nonce: "wrong-nonce" }));
    await expect(verifyIdToken(idToken, { issuer: ISSUER, audience: AUDIENCE, jwks, nonce: "n-abc" }))
      .rejects.toThrow(/nonce mismatch/);
  });

  it("rejects expired tokens", async () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    const { idToken, jwks } = await issueIdToken(freshClaims({ iat: past, exp: past + 60 }));
    await expect(verifyIdToken(idToken, { issuer: ISSUER, audience: AUDIENCE, jwks, nonce: "n-abc" }))
      .rejects.toThrow(/expired/);
  });

  it("rejects unknown kid (key not in JWKS)", async () => {
    const { idToken } = await issueIdToken(freshClaims(), { kid: "other-kid" });
    const { jwks }    = await issueIdToken(freshClaims());   // different keypair, kid-1
    await expect(verifyIdToken(idToken, { issuer: ISSUER, audience: AUDIENCE, jwks, nonce: "n-abc" }))
      .rejects.toThrow(/unknown kid/);
  });

  it("rejects missing kid in header", async () => {
    const { idToken, jwks } = await issueIdToken(freshClaims(), { missingKid: true });
    await expect(verifyIdToken(idToken, { issuer: ISSUER, audience: AUDIENCE, jwks, nonce: "n-abc" }))
      .rejects.toThrow(/missing kid/);
  });

  it("rejects non-ES256 alg", async () => {
    const { idToken, jwks } = await issueIdToken(freshClaims(), { alg: "HS256" });
    await expect(verifyIdToken(idToken, { issuer: ISSUER, audience: AUDIENCE, jwks, nonce: "n-abc" }))
      .rejects.toThrow(/alg must be ES256/);
  });

  it("rejects tampered payload (signature invalidates)", async () => {
    const { idToken, jwks } = await issueIdToken(freshClaims());
    const [h, _p, s] = idToken.split(".");
    const fakePayload = b64urlEncode(JSON.stringify({
      ...freshClaims(),
      sub: "evil",  // tamper the sub
    }));
    await expect(verifyIdToken(`${h}.${fakePayload}.${s}`,
      { issuer: ISSUER, audience: AUDIENCE, jwks, nonce: "n-abc" }))
      .rejects.toThrow(OidcError);
  });

  it("rejects malformed token (missing segments)", async () => {
    const { jwks } = await issueIdToken(freshClaims());
    await expect(verifyIdToken("not.atoken",
      { issuer: ISSUER, audience: AUDIENCE, jwks, nonce: "n-abc" }))
      .rejects.toThrow(/malformed/);
  });
});

describe("PKCE helpers", () => {
  it("createPkceVerifier produces 64-char base64url", () => {
    const v = createPkceVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{64}$/);
  });

  it("pkceChallengeS256 is deterministic and base64url-encoded SHA-256", async () => {
    const v = "test_verifier_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789---";
    const c1 = await pkceChallengeS256(v);
    const c2 = await pkceChallengeS256(v);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(c1.length).toBeGreaterThan(40);   // SHA-256 → 32 bytes → 43 chars b64url
  });
});

describe("buildAuthorizeUrl", () => {
  const fakeDisco: OidcDiscovery = {
    issuer:                  ISSUER,
    authorization_endpoint:  "https://chiyigo.com/oauth/authorize",
    token_endpoint:          "https://chiyigo.com/oauth/token",
    jwks_uri:                "https://chiyigo.com/.well-known/jwks.json",
  };

  it("includes every required param + response_mode=fragment", () => {
    const u = new URL(buildAuthorizeUrl({
      discovery:     fakeDisco,
      clientId:      AUDIENCE,
      redirectUri:   "https://example.com/cb",
      scope:         "openid profile email",
      state:         "s-1",
      nonce:         "n-1",
      codeChallenge: "challenge-here",
    }));
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe(AUDIENCE);
    expect(u.searchParams.get("redirect_uri")).toBe("https://example.com/cb");
    expect(u.searchParams.get("scope")).toBe("openid profile email");
    expect(u.searchParams.get("state")).toBe("s-1");
    expect(u.searchParams.get("nonce")).toBe("n-1");
    expect(u.searchParams.get("code_challenge")).toBe("challenge-here");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("response_mode")).toBe("fragment");
  });
});
