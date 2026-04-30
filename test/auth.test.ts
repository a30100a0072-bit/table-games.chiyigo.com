// /test/auth.test.ts
// ES256 JWT sign/verify roundtrip + JWKS rotation behaviour.

import { describe, expect, it } from "vitest";
import {
  signJWT, verifyJWT, jwksFromPrivateEnv,
  parsePrivateJwks, parsePrivateJwk, JWTError,
} from "../src/utils/auth";

// Node 20+ exposes Web Crypto on globalThis.crypto (no import needed).

async function genKey(kid: string = crypto.randomUUID()): Promise<string> {
  const { privateKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", privateKey) as JsonWebKey & {
    kid?: string; alg?: string; use?: string;
  };
  jwk.kid = kid; jwk.alg = "ES256"; jwk.use = "sig";
  return JSON.stringify(jwk);
}

describe("ES256 JWT", () => {
  it("signs and verifies a roundtrip with sub claim", async () => {
    const priv = await genKey();
    const token = await signJWT("alice", priv, 60);
    const sub = await verifyJWT(token, jwksFromPrivateEnv(priv));
    expect(sub).toBe("alice");
  });

  it("rejects tampered payload", async () => {
    const priv = await genKey();
    const token = await signJWT("alice", priv, 60);
    const [h, p, s] = token.split(".");
    const fakePayload = btoa(JSON.stringify({ sub: "evil", exp: 9999999999 }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    await expect(verifyJWT(`${h}.${fakePayload}.${s}`, jwksFromPrivateEnv(priv)))
      .rejects.toThrow(JWTError);
  });

  it("rejects expired tokens", async () => {
    const priv = await genKey();
    const token = await signJWT("alice", priv, -1);   // already expired
    await expect(verifyJWT(token, jwksFromPrivateEnv(priv)))
      .rejects.toThrow(/expired/);
  });

  it("rejects unknown kid (key not in JWKS)", async () => {
    const priv1 = await genKey("old-kid");
    const priv2 = await genKey("new-kid");
    const token = await signJWT("alice", priv1, 60);
    await expect(verifyJWT(token, jwksFromPrivateEnv(priv2)))
      .rejects.toThrow(/kid/);
  });
});

describe("JWKS rotation", () => {
  it("accepts a single JWK (back-compat) and produces 1-key JWKS", async () => {
    const priv = await genKey();
    const jwks = jwksFromPrivateEnv(priv);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]!.alg).toBe("ES256");
    expect(jwks.keys[0]).not.toHaveProperty("d");   // no private key in JWKS
  });

  it("accepts an array of JWKs and lists all public keys", async () => {
    const a = JSON.parse(await genKey("kid-a"));
    const b = JSON.parse(await genKey("kid-b"));
    const env = JSON.stringify([a, b]);
    const jwks = jwksFromPrivateEnv(env);
    expect(jwks.keys.map(k => k.kid).sort()).toEqual(["kid-a", "kid-b"]);
  });

  it("verifies tokens signed by either key during rotation", async () => {
    const a = JSON.parse(await genKey("kid-a"));
    const b = JSON.parse(await genKey("kid-b"));

    // Phase 1 — A is primary (signs); B is published for upcoming rotation.
    const env1 = JSON.stringify([a, b]);
    const jwks1 = jwksFromPrivateEnv(env1);
    const tokA  = await signJWT("alice", env1, 60);

    // Phase 2 — B becomes primary; A still verifies legacy tokens.
    const env2 = JSON.stringify([b, a]);
    const jwks2 = jwksFromPrivateEnv(env2);
    const tokB  = await signJWT("bob", env2, 60);

    // Both phases verify both tokens.
    expect(await verifyJWT(tokA, jwks1)).toBe("alice");
    expect(await verifyJWT(tokA, jwks2)).toBe("alice");
    expect(await verifyJWT(tokB, jwks1)).toBe("bob");
    expect(await verifyJWT(tokB, jwks2)).toBe("bob");
  });

  it("rejects malformed input and duplicate kids", async () => {
    expect(() => parsePrivateJwks("not-json")).toThrow(/JSON/);
    expect(() => parsePrivateJwks("[]")).toThrow(/no keys/);
    const a = JSON.parse(await genKey("dup"));
    const b = JSON.parse(await genKey("dup"));
    expect(() => parsePrivateJwks(JSON.stringify([a, b]))).toThrow(/duplicate kid/);
  });

  it("parsePrivateJwk returns the first key for back-compat", async () => {
    const a = JSON.parse(await genKey("a"));
    const b = JSON.parse(await genKey("b"));
    const single = parsePrivateJwk(JSON.stringify(a));
    expect(single.kid).toBe("a");
    const first = parsePrivateJwk(JSON.stringify([a, b]));
    expect(first.kid).toBe("a");
  });
});
