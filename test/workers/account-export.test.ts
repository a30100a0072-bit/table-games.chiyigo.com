// /test/workers/account-export.test.ts
// Real workerd-runtime check of GET /api/me/export. Seeds rows directly
// into D1 (skipping the gameplay paths that would write them in prod),
// then fetches the export and asserts the JSON sections come back joined
// + filtered against the caller.

import { describe, expect, it, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { applyTestSchema } from "./_schema";

const DB = () => (env as unknown as { DB: D1Database }).DB;

beforeAll(applyTestSchema);

async function tokFor(playerId: string): Promise<string> {
  const r = await SELF.fetch("https://t.local/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId }),
  });
  expect(r.status).toBe(200);
  return (await r.json() as { token: string }).token;
}

describe("Worker (miniflare): GET /api/me/export", () => {
  it("returns a JSON attachment whose sections are filtered to the caller", async () => {
    const tok = await tokFor("exporter");
    const db  = DB();

    // Seed a replay with exporter as one seat plus a stray row that's not
    // theirs — the participants JOIN must filter the stranger out.
    await db.prepare(
      "INSERT OR IGNORE INTO replay_meta (game_id, game_type, engine_version, player_ids, initial_snapshot, events," +
      " started_at, finished_at, winner_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "g-mine", "bigTwo", 3, JSON.stringify(["exporter", "bob"]),
      "{}", "[]", 1000, 2000, "exporter", "lastCardPlayed",
    ).run();
    await db.prepare(
      "INSERT OR IGNORE INTO replay_meta (game_id, game_type, engine_version, player_ids, initial_snapshot, events," +
      " started_at, finished_at, winner_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "g-other", "bigTwo", 3, JSON.stringify(["bob", "carol"]),
      "{}", "[]", 1000, 2000, "bob", "lastCardPlayed",
    ).run();
    await db.prepare(
      "INSERT OR IGNORE INTO replay_participants (game_id, player_id, finished_at) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)",
    ).bind(
      "g-mine",  "exporter", 2000,
      "g-mine",  "bob",      2000,
      "g-other", "bob",      2000,
      "g-other", "carol",    2000,
    ).run();

    const r = await SELF.fetch("https://t.local/api/me/export", {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
    expect(r.headers.get("content-disposition")).toMatch(/attachment.*exporter/);

    const body = await r.json() as {
      schema: string; playerId: string;
      profile: { player_id: string } | null;
      chipLedger: unknown[];
      replays: Array<{ game_id: string }>;
    };
    expect(body.schema).toBe("big-two-export-v1");
    expect(body.playerId).toBe("exporter");
    expect(body.profile?.player_id).toBe("exporter");
    // The /auth/token call grants signup + daily ledger entries; export must
    // surface them.
    expect(body.chipLedger.length).toBeGreaterThanOrEqual(1);
    // Replays JOIN: only the game with exporter as a seat.
    expect(body.replays.map(r2 => r2.game_id)).toEqual(["g-mine"]);
  });

  it("rejects without a JWT", async () => {
    const r = await SELF.fetch("https://t.local/api/me/export");
    expect(r.status).toBe(401);
  });
});
