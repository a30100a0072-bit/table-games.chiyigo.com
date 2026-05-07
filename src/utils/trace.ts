// /src/utils/trace.ts
// Request-scoped traceId middleware.                                       // L3_架構含防禦觀測
//
// What it does:
//   1. Generates a short traceId per inbound request (16 hex chars).
//   2. Wraps the handler, captures status + duration.
//   3. Stamps every response with `X-Request-Id` so the SPA can echo it
//      back to support/error reports for log correlation.
//   4. Emits ONE structured `request_complete` log line per request that
//      ties traceId ↔ method + path + status + ms + ip. Inner log() calls
//      can include traceId via the optional fields bag if they want to;
//      this wrapper is the cheapest correlation surface that doesn't
//      require AsyncLocalStorage or threading through every helper.
//   5. Catches unhandled throws → returns 500 carrying the traceId so the
//      user can quote it on a bug report.
//
// Cost: 1 extra Headers clone per response; negligible. The log line
// already exists in stdout for `wrangler tail`; adding it once per request
// at the seam beats trying to retro-fit traceId into every hand-rolled log
// call site.

import { log, errStr } from "./log";

export interface TraceContext {
  traceId: string;
  method:  string;
  path:    string;
  ip:      string;
}

const HEADER = "X-Request-Id";

/** 16 hex chars = 64 bits — collision probability negligible at our scale. */
export function genTraceId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < buf.length; i++) {
    s += buf[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/**
 * Wrap a fetch handler. Adds `X-Request-Id` to the response, logs one
 * structured request_complete line, and converts unhandled throws into
 * 500s carrying the same id.
 */
export async function withTrace(
  request: Request,
  handler: (ctx: TraceContext) => Promise<Response>,
): Promise<Response> {
  // Honour an inbound `X-Request-Id` if the caller supplied one (useful
  // for cross-service correlation). Cap the length so a malicious client
  // can't bloat our log lines.
  const inbound = request.headers.get(HEADER);
  const traceId = inbound && /^[A-Za-z0-9._-]{1,64}$/.test(inbound)
    ? inbound
    : genTraceId();
  const url     = new URL(request.url);
  const ctx: TraceContext = {
    traceId,
    method: request.method,
    path:   url.pathname,
    ip:     clientIp(request),
  };
  const startMs = Date.now();
  let status: number;
  let res: Response;
  try {
    res = await handler(ctx);
    status = res.status;
  } catch (e) {
    status = 500;
    log("error", "request_unhandled", {
      traceId, method: ctx.method, path: ctx.path, ip: ctx.ip,
      err: errStr(e),
    });
    res = new Response(
      JSON.stringify({ error: "internal", code: "INTERNAL", traceId }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Always stamp the response. Cloning via `new Response(...)` because
  // some upstream paths return a frozen Response (e.g. Response.json).
  const h = new Headers(res.headers);
  h.set(HEADER, traceId);
  // Append (don't overwrite) so cors() additions survive when this
  // wrapper sits outermost.
  const existingExpose = h.get("Access-Control-Expose-Headers");
  if (!existingExpose || !existingExpose.toLowerCase().includes("x-request-id")) {
    h.set(
      "Access-Control-Expose-Headers",
      existingExpose ? `${existingExpose}, ${HEADER}` : HEADER,
    );
  }
  const wrapped = new Response(res.body, {
    status,
    statusText: res.statusText,
    headers: h,
  });

  log(status >= 500 ? "error" : status >= 400 ? "warn" : "info", "request_complete", {
    traceId,
    method:     ctx.method,
    path:       ctx.path,
    ip:         ctx.ip,
    status,
    durationMs: Date.now() - startMs,
  });

  return wrapped;
}
