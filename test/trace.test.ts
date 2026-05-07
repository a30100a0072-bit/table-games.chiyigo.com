// /test/trace.test.ts
// Pin the trace middleware contract — anything load-bearing for support
// (X-Request-Id echo, inbound id reuse, 500 on throw) gets a guard test.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { withTrace } from "../src/utils/trace";

const HEADER = "X-Request-Id";

function req(opts: { headers?: Record<string, string>; method?: string; url?: string } = {}): Request {
  return new Request(opts.url ?? "https://x.example/health", {
    method:  opts.method ?? "GET",
    headers: opts.headers ?? {},
  });
}

describe("withTrace", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("stamps X-Request-Id on success", async () => {
    const res = await withTrace(req(), async () => new Response("ok", { status: 200 }));
    const id = res.headers.get(HEADER);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(res.status).toBe(200);
  });

  it("reuses inbound X-Request-Id when valid", async () => {
    const res = await withTrace(req({ headers: { [HEADER]: "client-abc-123" } }),
      async () => new Response(null, { status: 204 }));
    expect(res.headers.get(HEADER)).toBe("client-abc-123");
  });

  it("rejects malformed inbound trace id and generates a fresh one", async () => {
    const res = await withTrace(req({ headers: { [HEADER]: "bad id with spaces" } }),
      async () => new Response(null, { status: 204 }));
    expect(res.headers.get(HEADER)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("converts an unhandled throw into a 500 carrying the trace id", async () => {
    const res = await withTrace(req(), async () => { throw new Error("boom"); });
    expect(res.status).toBe(500);
    const id = res.headers.get(HEADER);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    const body = await res.json() as { traceId: string; code: string };
    expect(body.code).toBe("INTERNAL");
    expect(body.traceId).toBe(id);
    // request_unhandled goes to console.error.
    expect(errSpy).toHaveBeenCalled();
  });

  it("preserves Access-Control-Expose-Headers and appends X-Request-Id", async () => {
    const res = await withTrace(req(), async () =>
      new Response(null, { status: 200, headers: { "Access-Control-Expose-Headers": "X-Total-Count" } }),
    );
    const expose = res.headers.get("Access-Control-Expose-Headers") ?? "";
    expect(expose).toContain("X-Total-Count");
    expect(expose.toLowerCase()).toContain("x-request-id");
  });

  it("emits exactly one request_complete log line per request", async () => {
    await withTrace(req({ method: "POST", url: "https://x.example/api/match" }),
      async () => new Response(null, { status: 200 }));
    const lines = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((s: string) => s.includes("request_complete"));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.method).toBe("POST");
    expect(parsed.path).toBe("/api/match");
    expect(parsed.status).toBe(200);
    expect(typeof parsed.durationMs).toBe("number");
    expect(parsed.traceId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("logs at warn level for 4xx and error level for 5xx", async () => {
    await withTrace(req(), async () => new Response(null, { status: 404 }));
    await withTrace(req(), async () => new Response(null, { status: 502 }));
    const warnLine = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .find((s: string) => s.includes("\"status\":404"));
    const errLine = errSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .find((s: string) => s.includes("\"status\":502"));
    expect(warnLine).toBeTruthy();
    expect(JSON.parse(warnLine!).level).toBe("warn");
    expect(errLine).toBeTruthy();
    expect(JSON.parse(errLine!).level).toBe("error");
  });
});
