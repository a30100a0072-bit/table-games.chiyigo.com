// /src/utils/authMw.ts
// Single auth seam for HTTP handlers. Replaces ~10 copies of the same
// 5-line Authorization-header → verifyJWT → 401-on-error pattern that
// were scattered across src/api/*.ts and src/workers/gateway.ts.
//
// Two flavours:
//   • requireAuth(req, env)            → Promise<playerId | Response>
//     returns the 401 Response on failure; caller does `if (x instanceof Response) return x;`
//   • withAuth((pid, req, env) => res) → (req, env) => res
//     wrapper form for new route handlers — cleaner when there's no other
//     pre-auth work to do.
//
// Both share the same JWTError → ErrorCode.UNAUTHORIZED translation, so
// error-shape drift between endpoints is no longer possible.            // L3_架構含防禦觀測

import { verifyJWT, JWTError, jwksFromPrivateEnv } from "./auth";
import { ErrorCode, errorResponse }                 from "./errors";

export interface AuthEnv {
  JWT_PRIVATE_JWK: string;
}

/** Extract bearer token from `Authorization: Bearer <jwt>` (empty string if missing). */
export function bearerToken(request: Request): string {
  const auth = request.headers.get("Authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

/**
 * Verify the request's Bearer JWT and return the playerId. On failure
 * returns a 401 Response that the caller should forward unchanged.
 */
export async function requireAuth(
  request: Request, env: AuthEnv,
): Promise<string | Response> {
  const token = bearerToken(request);
  try {
    return await verifyJWT(token, jwksFromPrivateEnv(env.JWT_PRIVATE_JWK));
  } catch (err) {
    return errorResponse(
      ErrorCode.UNAUTHORIZED, 401,
      err instanceof JWTError ? err.message : undefined,
    );
  }
}

/**
 * Wrap a handler so it receives a verified `playerId` as its first arg.
 * Use for new handlers; existing call sites use `requireAuth` directly.
 */
export function withAuth<E extends AuthEnv>(
  handler: (playerId: string, request: Request, env: E) => Promise<Response>,
): (request: Request, env: E) => Promise<Response> {
  return async (request, env) => {
    const r = await requireAuth(request, env);
    if (r instanceof Response) return r;
    return handler(r, request, env);
  };
}
