// /test/rateLimit.test.ts
// Token-bucket rate limiter — capacity, refill, isolation per key.

import { describe, expect, it, vi } from "vitest";
import { takeToken, RATE } from "../src/utils/rateLimit";

describe("takeToken (token-bucket)", () => {
  it("allows up to capacity then blocks", () => {
    const cap = RATE.token.capacity;
    const key = `test:cap:${Math.random()}`;
    for (let i = 0; i < cap; i++) {
      expect(takeToken(key, "token")).toBe(true);
    }
    expect(takeToken(key, "token")).toBe(false);
  });

  it("isolates buckets per key", () => {
    const k1 = `test:k1:${Math.random()}`;
    const k2 = `test:k2:${Math.random()}`;
    for (let i = 0; i < RATE.token.capacity; i++) takeToken(k1, "token");
    // k1 is exhausted but k2 starts fresh
    expect(takeToken(k1, "token")).toBe(false);
    expect(takeToken(k2, "token")).toBe(true);
  });

  it("refills tokens over time", () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = vi.fn(() => now);

    try {
      const key = `test:refill:${Math.random()}`;
      const cap = RATE.match.capacity;       // 30
      // Drain
      for (let i = 0; i < cap; i++) takeToken(key, "match");
      expect(takeToken(key, "match")).toBe(false);

      // Advance 60s — 30/min refill = full bucket back
      now += 61_000;
      expect(takeToken(key, "match")).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it("bailout has very tight capacity (defence-in-depth alongside cooldown)", () => {
    const key = `test:bailout:${Math.random()}`;
    const cap = RATE.bailout.capacity;
    expect(cap).toBeLessThanOrEqual(5);   // sanity: bursty bailout claims caught early
    for (let i = 0; i < cap; i++) expect(takeToken(key, "bailout")).toBe(true);
    expect(takeToken(key, "bailout")).toBe(false);
  });
});
