// /test/workers/auth-flow.test.ts
// Real workerd-runtime end-to-end auth flow: /auth/token issues a token
// signed with the miniflare-bound JWT_PRIVATE_JWK, /api/me/wallet
// verifies it against the published JWKS. No mocks — DB is the real
// in-memory D1 instance miniflare provisions from wrangler.toml.

import { describe, expect, it, beforeAll } from "vitest";
import { SELF } from "cloudflare:test";
import { applyTestSchema } from "./_schema";

beforeAll(applyTestSchema);

describe("Worker (miniflare): full auth + wallet flow", () => {
  it("issues a token, lazy-creates wallet, then /api/me/wallet verifies", async () => {
    const tok = await SELF.fetch("https://t.local/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: "alice" }),
    });
    expect(tok.status).toBe(200);
    const tokBody = await tok.json() as { token: string; playerId: string; dailyBonus: number };
    expect(tokBody.playerId).toBe("alice");
    expect(typeof tokBody.token).toBe("string");
    expect(tokBody.dailyBonus).toBe(100);

    const wallet = await SELF.fetch("https://t.local/api/me/wallet", {
      headers: { Authorization: `Bearer ${tokBody.token}` },
    });
    expect(wallet.status).toBe(200);
    const wb = await wallet.json() as { chipBalance: number; ledger: Array<{ reason: string }> };
    expect(wb.chipBalance).toBe(1100);          // 1000 signup + 100 daily
    expect(wb.ledger.map(l => l.reason).sort()).toEqual(["daily", "signup"]);
  });

  it("rejects malformed JWT", async () => {
    const r = await SELF.fetch("https://t.local/api/me/wallet", {
      headers: { Authorization: "Bearer not.a.token" },
    });
    expect(r.status).toBe(401);
  });

  it("admin freeze then /auth/token returns 423", async () => {
    // Bootstrap a user
    const tok = await SELF.fetch("https://t.local/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: "banhammer" }),
    });
    expect(tok.status).toBe(200);

    const freeze = await SELF.fetch("https://t.local/api/admin/freeze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Secret": "test-admin",
      },
      body: JSON.stringify({ playerId: "banhammer", reason: "abuse" }),
    });
    expect(freeze.status).toBe(200);

    const blocked = await SELF.fetch("https://t.local/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId: "banhammer" }),
    });
    expect(blocked.status).toBe(423);
    const body = await blocked.json() as { error: string; reason: string };
    expect(body.error).toBe("account frozen");
    expect(body.reason).toBe("abuse");
  });
});
