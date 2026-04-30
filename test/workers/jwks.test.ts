// /test/workers/jwks.test.ts
// Real workerd-runtime tests via @cloudflare/vitest-pool-workers — the
// Worker entry point is loaded as in production, with our wrangler.toml
// bindings overridden by vitest.workers.config.ts.

import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

describe("Worker (miniflare): /.well-known/jwks.json", () => {
  it("serves a single ES256 P-256 public JWK", async () => {
    const r = await SELF.fetch("https://test.local/.well-known/jwks.json");
    expect(r.status).toBe(200);
    const body = await r.json() as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    const k = body.keys[0]!;
    expect(k.kty).toBe("EC");
    expect(k.crv).toBe("P-256");
    expect(k.alg).toBe("ES256");
    expect(k.kid).toBe("7c739aba-da2a-497f-86c6-67350ffe5cae");
    expect(k).not.toHaveProperty("d");      // private bits stay server-side
  });

  it("404s on unknown routes", async () => {
    const r = await SELF.fetch("https://test.local/no-such-path");
    expect(r.status).toBe(404);
  });

  it("CORS preflight on /api/match returns 204", async () => {
    const r = await SELF.fetch("https://test.local/api/match", { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
