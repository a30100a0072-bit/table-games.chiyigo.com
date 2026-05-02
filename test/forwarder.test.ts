// /test/forwarder.test.ts
// Unit tests for the tail-forwarder formatter. The webhook POST itself
// isn't exercised here — that's an integration concern. We pin the
// filtering + message-shaping logic that decides what ever reaches a
// webhook in the first place.

import { describe, expect, it } from "vitest";
import {
  parseLogLine, shouldForwardLog, formatTrace, postWithRetry,
} from "../src/forwarder/index";

function trace(parts: Partial<TraceItem>): TraceItem {
  return {
    exceptions: [],
    logs:       [],
    eventTimestamp: 1700000000000,
    ...parts,
  } as TraceItem;
}
function logLine(level: string, msg: unknown): TraceItem["logs"][number] {
  return { level: level as TraceItem["logs"][number]["level"], message: [msg], timestamp: 1700000000000 };
}

describe("parseLogLine", () => {
  it("parses a structured JSON log line into level + event + rest", () => {
    const r = parseLogLine(JSON.stringify({ level: "warn", event: "rate_limited", playerId: "alice" }));
    expect(r).toEqual({ level: "warn", event: "rate_limited", rest: { playerId: "alice" } });
  });

  it("returns null for non-JSON strings", () => {
    expect(parseLogLine("plain old log")).toBeNull();
  });

  it("returns null for JSON without level/event fields", () => {
    expect(parseLogLine(JSON.stringify({ msg: "hi" }))).toBeNull();
  });
});

describe("shouldForwardLog", () => {
  it("forwards every error / warn console line regardless of payload", () => {
    expect(shouldForwardLog("error", null)).toBe(true);
    expect(shouldForwardLog("warn",  null)).toBe(true);
  });

  it("drops info-level lines whose event isn't on the allow list", () => {
    const parsed = { level: "info", event: "token_issued", rest: {} };
    expect(shouldForwardLog("log", parsed)).toBe(false);
  });

  it("forwards info-level lines whose event IS on the allow list", () => {
    const parsed = { level: "info", event: "admin_adjusted", rest: {} };
    expect(shouldForwardLog("log", parsed)).toBe(true);
  });
});

describe("formatTrace", () => {
  it("returns null when nothing in the trace meets the bar", () => {
    const t = trace({ logs: [logLine("info", JSON.stringify({ level: "info", event: "token_issued" }))] });
    expect(formatTrace(t, "test")).toBeNull();
  });

  it("formats an exception line with the 🔥 marker", () => {
    const t = trace({ exceptions: [{ name: "TypeError", message: "bad thing", timestamp: 0 }] });
    const out = formatTrace(t, "test");
    expect(out).toContain("🔥 TypeError: bad thing");
    expect(out).toContain("[test]");
  });

  it("formats a structured warn line with fields appended", () => {
    const t = trace({
      logs: [logLine("warn", JSON.stringify({ level: "warn", event: "rate_limited", playerId: "alice", route: "/api/match" }))],
    });
    const out = formatTrace(t, "prod")!;
    expect(out).toContain("⚠️ rate_limited");
    expect(out).toContain("playerId=alice");
    expect(out).toContain("route=/api/match");
  });

  it("falls back to raw text for non-JSON warn lines", () => {
    const t = trace({ logs: [logLine("warn", "something bad happened")] });
    const out = formatTrace(t, "prod")!;
    expect(out).toContain("📝 something bad happened");
  });

  it("caps body length so Discord's 2000-char limit is never exceeded", () => {
    const t = trace({
      logs: Array.from({ length: 200 }, () =>
        logLine("error", JSON.stringify({ level: "error", event: "boom", payload: "x".repeat(50) })),
      ),
    });
    const out = formatTrace(t, "prod")!;
    // Header + at-most 1500 chars body. Total well under 2000.
    expect(out.length).toBeLessThanOrEqual(1600);
  });
});

describe("postWithRetry", () => {
  const noSleep = () => Promise.resolve();

  it("returns ok on first-attempt 200", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response("ok", { status: 200 }); }) as typeof fetch;
    const r = await postWithRetry("https://x", "{}", { fetchImpl, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it("retries 5xx and succeeds on second attempt", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("", { status: calls === 1 ? 503 : 200 });
    }) as typeof fetch;
    const r = await postWithRetry("https://x", "{}", { fetchImpl, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(2);
  });

  it("retries on 429 (rate limited)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("", { status: calls < 3 ? 429 : 200 });
    }) as typeof fetch;
    const r = await postWithRetry("https://x", "{}", { fetchImpl, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
  });

  it("gives up immediately on permanent 4xx (e.g. 404 misconfigured webhook)", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response("", { status: 404 }); }) as typeof fetch;
    const r = await postWithRetry("https://x", "{}", { fetchImpl, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(1);
    expect(r.lastStatus).toBe(404);
    expect(calls).toBe(1);
  });

  it("retries network errors and reports lastError on terminal failure", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; throw new Error("ENOTFOUND"); }) as typeof fetch;
    const r = await postWithRetry("https://x", "{}", { fetchImpl, sleep: noSleep, maxAttempts: 3 });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(3);
    expect(r.lastError).toBe("ENOTFOUND");
    expect(calls).toBe(3);
  });

  it("waits between attempts using the injected sleep (exponential)", async () => {
    const delays: number[] = [];
    const sleep = (ms: number) => { delays.push(ms); return Promise.resolve(); };
    const fetchImpl = (async () => new Response("", { status: 503 })) as typeof fetch;
    await postWithRetry("https://x", "{}", { fetchImpl, sleep, maxAttempts: 3 });
    // Two waits between three attempts: 200 then 800.
    expect(delays).toEqual([200, 800]);
  });
});
