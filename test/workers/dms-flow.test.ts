// /test/workers/dms-flow.test.ts
// End-to-end DM happy path on workerd: friendship gate, send, inbox
// returns the message and marks it read, unread count flips back to 0.

import { describe, expect, it, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { applyTestSchema } from "./_schema";

const DB = () => (env as unknown as { DB: D1Database }).DB;

beforeAll(async () => {
  await applyTestSchema();
  // Pre-accept friendship between dm-alice and dm-bob (canonical pair).
  // Skipping the real /api/friends round-trip keeps this spec focused.
  const [a, b] = ["dm-alice", "dm-bob"].sort();
  await DB().prepare(
    "INSERT OR IGNORE INTO friendships (a_id, b_id, requester, status, created_at, responded_at)" +
    " VALUES (?, ?, ?, 'accepted', ?, ?)",
  ).bind(a, b, a, Date.now(), Date.now()).run();
});

async function tokFor(playerId: string): Promise<string> {
  const r = await SELF.fetch("https://t.local/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId }),
  });
  expect(r.status).toBe(200);
  return (await r.json() as { token: string }).token;
}

describe("Worker (miniflare): DM happy path", () => {
  it("send → inbox marks read → unread count flips to 0", async () => {
    const aliceTok = await tokFor("dm-alice");
    const bobTok   = await tokFor("dm-bob");

    // Send
    const send = await SELF.fetch("https://t.local/api/dm/send", {
      method: "POST",
      headers: { "Authorization": `Bearer ${aliceTok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: "dm-bob", body: "hello bob" }),
    });
    expect(send.status).toBe(201);

    // Bob unread = 1
    const unread1 = await SELF.fetch("https://t.local/api/dm/unread", {
      headers: { "Authorization": `Bearer ${bobTok}` },
    });
    expect((await unread1.json() as { unread: number }).unread).toBe(1);

    // Bob inbox surfaces the message AND the SELECT/UPDATE pair marks it read.
    const inbox = await SELF.fetch("https://t.local/api/dm/inbox", {
      headers: { "Authorization": `Bearer ${bobTok}` },
    });
    expect(inbox.status).toBe(200);
    const ib = await inbox.json() as { messages: Array<{ sender: string; body: string }> };
    expect(ib.messages.some(m => m.sender === "dm-alice" && m.body === "hello bob")).toBe(true);

    // Bob unread = 0 after the inbox read
    const unread2 = await SELF.fetch("https://t.local/api/dm/unread", {
      headers: { "Authorization": `Bearer ${bobTok}` },
    });
    expect((await unread2.json() as { unread: number }).unread).toBe(0);
  });

  it("rejects DM to a non-friend (403)", async () => {
    const aliceTok = await tokFor("dm-alice");
    const r = await SELF.fetch("https://t.local/api/dm/send", {
      method: "POST",
      headers: { "Authorization": `Bearer ${aliceTok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: "stranger", body: "hi" }),
    });
    expect(r.status).toBe(403);
  });

  it("rejects empty body (400) and oversize body (413)", async () => {
    const aliceTok = await tokFor("dm-alice");
    const empty = await SELF.fetch("https://t.local/api/dm/send", {
      method: "POST",
      headers: { "Authorization": `Bearer ${aliceTok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: "dm-bob", body: "   " }),
    });
    expect(empty.status).toBe(400);

    const big = await SELF.fetch("https://t.local/api/dm/send", {
      method: "POST",
      headers: { "Authorization": `Bearer ${aliceTok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: "dm-bob", body: "x".repeat(501) }),
    });
    expect(big.status).toBe(413);
  });
});
