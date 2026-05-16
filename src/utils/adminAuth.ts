// /src/utils/adminAuth.ts
// Shared admin gate. Returns null when the request carries a valid
// X-Admin-Secret header matching env.ADMIN_SECRET; otherwise returns
// the Response the caller should forward (401 / 503).
//
// Timing-safe compare protects against secret-length leak. ADMIN_SECRET
// unset → 503 (admin endpoints fail closed rather than authenticating
// against undefined).                                                  // L3_架構含防禦觀測

import { ErrorCode, errorResponse } from "./errors";

export interface AdminEnv {
  ADMIN_SECRET?: string;
}

export function checkAdmin(request: Request, env: AdminEnv): Response | null {
  if (!env.ADMIN_SECRET) return errorResponse(ErrorCode.ADMIN_DISABLED, 503);
  const provided = request.headers.get("X-Admin-Secret") ?? "";
  if (!timingSafeEqual(provided, env.ADMIN_SECRET))
    return errorResponse(ErrorCode.UNAUTHORIZED, 401);
  return null;
}

/** Constant-time string compare. Avoids leaking the secret length. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
