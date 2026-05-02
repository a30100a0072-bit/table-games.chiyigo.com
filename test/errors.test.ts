// /test/errors.test.ts
// Pin the error-response shape so future migrators know the contract:
// every error body keeps a legacy `error` field AND a stable `code`.

import { describe, expect, it } from "vitest";
import { ErrorCode, errorResponse } from "../src/utils/errors";

describe("errorResponse", () => {
  it("emits both legacy `error` and new `code`/`message` fields", async () => {
    const r = errorResponse(ErrorCode.UNAUTHORIZED, 401);
    expect(r.status).toBe(401);
    const body = await r.json() as Record<string, unknown>;
    expect(body.code).toBe("UNAUTHORIZED");
    expect(body.message).toBe("unauthorized");
    expect(body.error).toBe("unauthorized");      // backward-compat
  });

  it("honours an explicit message override", async () => {
    const r = errorResponse(ErrorCode.VALIDATION_FAILED, 400, "blinds must be > 0");
    const body = await r.json() as { code: string; message: string; error: string };
    expect(body.code).toBe("VALIDATION_FAILED");
    expect(body.message).toBe("blinds must be > 0");
    expect(body.error).toBe("blinds must be > 0");
  });

  it("merges extras into the body without overwriting code/message", async () => {
    const r = errorResponse(ErrorCode.RATE_LIMITED, 429, undefined, { retryAfterMs: 1500 });
    const body = await r.json() as Record<string, unknown>;
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.retryAfterMs).toBe(1500);
  });
});
