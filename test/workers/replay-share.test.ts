// /test/workers/replay-share.test.ts
// End-to-end share-token lifecycle on the real workerd runtime:
// mint → resolve (public, no JWT) → list-mine → revoke → resolve 404.
// Hits the same DB miniflare provisions, so the JOIN against
// replay_participants and the owner-scoped DELETE both run for real.

import { describe, expect, it, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { applyTestSchema } from "./_schema";

const DB = () => (env as unknown as { DB: D1Database }).DB;

beforeAll(async () => {
  await applyTestSchema();
  // Seed one finished replay where alice is a seat. We don't go through
  // the DO settlement path here — that's covered elsewhere — we just need
  // a row the share endpoints can mint against.
  const db = DB();
  await db.prepare(
    "INSERT OR IGNORE INTO replay_meta (game_id, game_type, engine_version," +
    " player_ids, initial_snapshot, events, started_at, finished_at, winner_id, reason)" +
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    "g-share", "bigTwo", 3,
    JSON.stringify(["alice", "bob"]),
    JSON.stringify({ stub: true }),
    JSON.stringify([]),
    1000, 2000, "alice", "lastCardPlayed",
  ).run();
  await db.prepare(
    "INSERT OR IGNORE INTO replay_participants (game_id, player_id, finished_at)" +
    " VALUES (?, ?, ?), (?, ?, ?)",
  ).bind("g-share", "alice", 2000, "g-share", "bob", 2000).run();
});

async function tokFor(playerId: string): Promise<string> {
  const r = await SELF.fetch("https://t.local/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId }),
  });
  expect(r.status).toBe(200);
  const body = await r.json() as { token: string };
  return body.token;
}

describe("Worker (miniflare): replay share lifecycle", () => {
  it("mint → public resolve → list-mine → revoke → resolve 404", async () => {
    const aliceTok = await tokFor("alice");

    // 1. mint
    const mint = await SELF.fetch("https://t.local/api/replays/g-share/share", {
      method: "POST",
      headers: { "Authorization": `Bearer ${aliceTok}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(mint.status).toBe(201);
    const mintBody = await mint.json() as { token: string; expiresAt: number };
    expect(mintBody.token).toBeTruthy();
    expect(mintBody.expiresAt).toBeGreaterThan(Date.now());

    // 2. resolve — no Authorization header at all (capability == token)
    const resolve = await SELF.fetch(
      `https://t.local/api/replays/by-token/${encodeURIComponent(mintBody.token)}`,
    );
    expect(resolve.status).toBe(200);
    const rb = await resolve.json() as { gameId: string; sharedBy: string };
    expect(rb.gameId).toBe("g-share");
    expect(rb.sharedBy).toBe("alice");

    // 3. list-mine surfaces the active token
    const list = await SELF.fetch("https://t.local/api/me/shares", {
      headers: { "Authorization": `Bearer ${aliceTok}` },
    });
    expect(list.status).toBe(200);
    const listBody = await list.json() as { shares: Array<{ token: string }> };
    expect(listBody.shares.some(s => s.token === mintBody.token)).toBe(true);

    // 4. revoke as owner
    const del = await SELF.fetch(
      `https://t.local/api/replays/share/${encodeURIComponent(mintBody.token)}`,
      { method: "DELETE", headers: { "Authorization": `Bearer ${aliceTok}` } },
    );
    expect(del.status).toBe(200);

    // 5. resolve now 404 — the row is gone, capability dies with it
    const after = await SELF.fetch(
      `https://t.local/api/replays/by-token/${encodeURIComponent(mintBody.token)}`,
    );
    expect(after.status).toBe(404);
  });

  it("revoke by non-owner returns 404 and leaves the row intact (no existence leak)", async () => {
    const aliceTok = await tokFor("alice");
    const malloryTok = await tokFor("mallory");

    const mint = await SELF.fetch("https://t.local/api/replays/g-share/share", {
      method: "POST",
      headers: { "Authorization": `Bearer ${aliceTok}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { token: shareTok } = await mint.json() as { token: string };

    const malloryDel = await SELF.fetch(
      `https://t.local/api/replays/share/${encodeURIComponent(shareTok)}`,
      { method: "DELETE", headers: { "Authorization": `Bearer ${malloryTok}` } },
    );
    expect(malloryDel.status).toBe(404);

    // Row survives — alice can still resolve it
    const stillThere = await SELF.fetch(
      `https://t.local/api/replays/by-token/${encodeURIComponent(shareTok)}`,
    );
    expect(stillThere.status).toBe(200);

    // Cleanup so the next test starts fresh-ish.
    await SELF.fetch(
      `https://t.local/api/replays/share/${encodeURIComponent(shareTok)}`,
      { method: "DELETE", headers: { "Authorization": `Bearer ${aliceTok}` } },
    );
  });

  it("non-seated player can't mint a share (403)", async () => {
    const malloryTok = await tokFor("mallory");
    const r = await SELF.fetch("https://t.local/api/replays/g-share/share", {
      method: "POST",
      headers: { "Authorization": `Bearer ${malloryTok}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(403);
  });
});
