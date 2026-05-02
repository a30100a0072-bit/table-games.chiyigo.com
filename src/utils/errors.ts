// /src/utils/errors.ts
// Central catalogue of API error codes + a response helper. Adoption is
// gradual: existing `Response.json({ error: "msg" }, { status })` sites
// still work. New code should use `errorResponse(ErrorCode.X, status)`,
// which emits BOTH the legacy `error` field AND a stable `code` so
// frontend i18n can switch on `code` without breaking older clients.
//
// Adding a new code:
//   1. Append a member to ErrorCode below.
//   2. Add a default English message in DEFAULT_MESSAGES.
//   3. Frontend i18n picks up the code on its next deploy.
//
// Codes are SCREAMING_SNAKE strings (not numbers) so log greps and
// dashboard filters stay human-readable.                                   // L3_架構含防禦觀測

export const ErrorCode = {
  UNAUTHORIZED:        "UNAUTHORIZED",
  FORBIDDEN:           "FORBIDDEN",
  NOT_FOUND:           "NOT_FOUND",
  VALIDATION_FAILED:   "VALIDATION_FAILED",
  RATE_LIMITED:        "RATE_LIMITED",
  CONFLICT:            "CONFLICT",
  GONE:                "GONE",
  INTERNAL:            "INTERNAL",
  // Domain-specific codes — extend here as new endpoints adopt the helper.
  ACCOUNT_DELETE_FAILED:    "ACCOUNT_DELETE_FAILED",
  MISSING_CONFIRMATION:     "MISSING_CONFIRMATION",
  WALLET_NOT_FOUND:         "WALLET_NOT_FOUND",
  REPLAY_NOT_FOUND:         "REPLAY_NOT_FOUND",
  REPLAY_FORBIDDEN:         "REPLAY_FORBIDDEN",
  REPLAY_SHARE_EXPIRED:     "REPLAY_SHARE_EXPIRED",
} as const;
export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHORIZED:           "unauthorized",
  FORBIDDEN:              "forbidden",
  NOT_FOUND:              "not found",
  VALIDATION_FAILED:      "invalid request",
  RATE_LIMITED:           "rate limited",
  CONFLICT:               "conflict",
  GONE:                   "gone",
  INTERNAL:               "internal error",
  ACCOUNT_DELETE_FAILED:  "deletion failed",
  MISSING_CONFIRMATION:   "missing confirmation header",
  WALLET_NOT_FOUND:       "wallet not found",
  REPLAY_NOT_FOUND:       "not found",
  REPLAY_FORBIDDEN:       "forbidden",
  REPLAY_SHARE_EXPIRED:   "share link expired",
};

/** Build a standard error Response. Carries both the legacy `error` field
 *  (kept so existing clients keep working) and the new `code` + `message`
 *  pair. Optional `extras` fold in extra context (e.g. `seq` for stale
 *  WS frames) without forcing every caller to wrap the JSON manually. */
export function errorResponse(
  code:    ErrorCode,
  status:  number,
  message?: string,
  extras?: Record<string, unknown>,
): Response {
  const msg = message ?? DEFAULT_MESSAGES[code];
  return Response.json(
    { error: msg, code, message: msg, ...(extras ?? {}) },
    { status },
  );
}
