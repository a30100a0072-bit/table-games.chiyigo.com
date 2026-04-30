// Generate an EC P-256 private JWK for ES256 JWT signing.
// Usage:  node scripts/gen-jwk.mjs
// Then:   wrangler secret put JWT_PRIVATE_JWK --env production  (paste the JSON)

import { webcrypto } from "node:crypto";

const { privateKey } = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const jwk = await webcrypto.subtle.exportKey("jwk", privateKey);
jwk.kid = webcrypto.randomUUID();
jwk.alg = "ES256";
jwk.use = "sig";
process.stdout.write(JSON.stringify(jwk) + "\n");
