// /src/utils/rateLimit.ts
// In-memory token-bucket rate limiter, scoped to the Worker isolate.
// Cloudflare typically pins traffic from the same IP/region to the same
// isolate, so this gives meaningful burst protection without extra infra.
// A determined attacker can fan out across regions; the official
// Cloudflare ratelimit binding is the hardening upgrade once GA.        // L3_架構含防禦觀測

interface Bucket { tokens: number; lastRefill: number; }
const buckets = new Map<string, Bucket>();

export interface RateSpec { capacity: number; perSec: number; }

export const RATE: Record<"token" | "match" | "wallet" | "bailout", RateSpec> = {
  token:   { capacity: 10, perSec: 10 / 60 },   // 10/min  per IP
  match:   { capacity: 30, perSec: 30 / 60 },   // 30/min  per playerId
  wallet:  { capacity: 60, perSec: 60 / 60 },   //  1/sec  per playerId
  bailout: { capacity:  3, perSec:  3 / 60 },   //  3/min  per playerId (24h cooldown still applies)
};

export function takeToken(key: string, kind: keyof typeof RATE): boolean {
  const limit = RATE[kind];
  const now   = Date.now();
  const b     = buckets.get(key) ?? { tokens: limit.capacity, lastRefill: now };
  const elapsed = (now - b.lastRefill) / 1000;
  b.tokens     = Math.min(limit.capacity, b.tokens + elapsed * limit.perSec);
  b.lastRefill = now;
  if (b.tokens < 1) { buckets.set(key, b); return false; }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

export function rateLimited(): Response {
  return Response.json(
    { error: "rate limited" },
    { status: 429, headers: { "Retry-After": "60" } },
  );
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
