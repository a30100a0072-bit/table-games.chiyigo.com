// /frontend/src/i18n/errorCodes.ts
// Maps server-side ErrorCode strings to dict.ts translation keys.
//
// Adoption is opt-in: handlers that call `formatApiError(body, t)` get a
// translated message; older handlers reading `body.error` still work
// because the server emits both shapes.
//
// Adding a code:
//   1. extend ErrorCode in src/utils/errors.ts (server)
//   2. append a row in CODE_TO_KEY below
//   3. add the key under the "err.*" namespace of both halves of dict.ts
// If a code isn't mapped, formatApiError falls back to the server's
// default message so we never blank-render an unknown error.            // L3_架構含防禦觀測

import type { TFunction } from "./useT";
import type { DictKey } from "./dict";

const CODE_TO_KEY: Record<string, string> = {
  UNAUTHORIZED:           "err.unauthorized",
  FORBIDDEN:              "err.forbidden",
  NOT_FOUND:              "err.notFound",
  VALIDATION_FAILED:      "err.validation",
  RATE_LIMITED:           "err.rateLimited",
  CONFLICT:               "err.conflict",
  GONE:                   "err.gone",
  INTERNAL:               "err.internal",
  ACCOUNT_DELETE_FAILED:  "err.deleteFailed",
  ACCOUNT_FROZEN:         "err.frozen",
  MISSING_CONFIRMATION:   "err.missingConfirm",
  WALLET_NOT_FOUND:       "err.walletNotFound",
  REPLAY_NOT_FOUND:       "err.replayNotFound",
  REPLAY_FORBIDDEN:       "err.replayForbidden",
  REPLAY_SHARE_EXPIRED:   "err.shareExpired",
  INVALID_JSON:           "err.invalidJson",
  RESERVED_PREFIX:        "err.reservedPrefix",
  ADMIN_DISABLED:         "err.adminDisabled",
  BAILOUT_INELIGIBLE:     "err.bailoutIneligible",
  OVERDRAW:               "err.overdraw",
  INSUFFICIENT_CHIPS:     "err.insufficientChips",
  TOKEN_EXPIRED:          "err.tokenExpired",
  ALREADY_FRIENDS:        "err.alreadyFriends",
  FRIEND_REQUEST_PENDING: "err.friendPending",
  ALREADY_IN_ROOM:        "err.alreadyInRoom",
  ALREADY_QUEUED:         "err.alreadyQueued",
  TOURNAMENT_REGISTRATION_CLOSED: "err.tourClosed",
};

interface MaybeApiError {
  code?:    string;
  message?: string;
  error?:   string;
}

/** Thrown by http.ts when a response is non-OK. Carries the parsed body
 *  so consumers can switch on `code` or pull domain extras (`balance`,
 *  `roomId`, etc.) without re-parsing. The `.message` field is the
 *  server's English default — translate via formatApiError(err, t). */
export class ApiError extends Error {
  readonly code:   string;
  readonly status: number;
  readonly body:   Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    const msg = (body.message as string | undefined) ?? (body.error as string | undefined) ?? `HTTP ${status}`;
    super(msg);
    this.name   = "ApiError";
    this.status = status;
    this.code   = (body.code as string | undefined) ?? "UNKNOWN";
    this.body   = body;
  }
}

/** Best-effort: turn a non-OK fetch Response into an ApiError. Consumes
 *  the body. Falls back to a stub ApiError if JSON parsing fails. */
export async function readApiError(res: Response): Promise<ApiError> {
  let body: Record<string, unknown>;
  try { body = await res.json() as Record<string, unknown>; }
  catch { body = { error: `HTTP ${res.status}` }; }
  return new ApiError(res.status, body);
}

/** Translate an API error body. Pass the response JSON; we'll prefer
 *  body.code (new shape), fall back to body.message / body.error
 *  (legacy). The optional `defaultKey` is used when neither side
 *  provides anything — typically for non-JSON / network failures.    */
export function formatApiError(
  source: MaybeApiError | ApiError | unknown,
  t:      TFunction,
  defaultKey = "err.unknown",
): string {
  // ApiError carries the parsed body — read code from there.
  if (source instanceof ApiError) {
    if (CODE_TO_KEY[source.code])
      return t(CODE_TO_KEY[source.code]! as DictKey, { message: source.message });
    return source.message;
  }
  // Plain Error with no body — best we can do is its message.
  if (source instanceof Error) return source.message;
  // Direct body object (legacy callers that already json-parsed).
  const body = source as MaybeApiError | null | undefined;
  if (body?.code && CODE_TO_KEY[body.code]) {
    return t(CODE_TO_KEY[body.code]! as DictKey, { message: body.message ?? body.error ?? "" });
  }
  return body?.message ?? body?.error ?? t(defaultKey as DictKey);
}
