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

/** Translate an API error body. Pass the response JSON; we'll prefer
 *  body.code (new shape), fall back to body.message / body.error
 *  (legacy). The optional `defaultKey` is used when neither side
 *  provides anything — typically for non-JSON / network failures.    */
export function formatApiError(
  body: MaybeApiError | null | undefined,
  t:    TFunction,
  defaultKey = "err.unknown",
): string {
  if (body?.code && CODE_TO_KEY[body.code]) {
    // The mapped key may itself be a no-op fallback to the server message;
    // pass it through so dict.ts strings can interpolate `{message}`.
    return t(CODE_TO_KEY[body.code]! as DictKey, { message: body.message ?? body.error ?? "" });
  }
  return body?.message ?? body?.error ?? t(defaultKey as DictKey);
}
