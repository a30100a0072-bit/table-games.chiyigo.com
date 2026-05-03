// /frontend/src/api/oidc.ts
// Client helpers for the chiyigo.com OIDC SSO flow. Pure HTTP wrappers —
// no framework deps. Companion to api/http.ts (which targets our own
// /auth/token endpoint for guest accounts).
import { readApiError } from "../i18n/errorCodes";

const BASE = import.meta.env.VITE_WORKER_URL as string;

export interface OidcExchangeResponse {
  token:    string;
  playerId: string;
  profile: {
    email:   string | null;
    name:    string | null;
    picture: string | null;
  };
}

/** Top-level navigation that hands the browser off to the IdP. The worker
 *  emits a 302 with state/nonce/PKCE already minted. */
export function startOidcLogin(): void {
  window.location.assign(`${BASE}/auth/oauth/start`);
}

/** Called by OAuthCallbackScreen after pulling code+state from the URL
 *  fragment. Returns our own JWT + player profile. */
export async function exchangeOidcCode(code: string, state: string): Promise<OidcExchangeResponse> {
  const res = await fetch(`${BASE}/auth/oauth/exchange`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ code, state }),
  });
  if (!res.ok) throw await readApiError(res);
  return await res.json() as OidcExchangeResponse;
}

/** Silent refresh — caller must already hold a valid (possibly near-
 *  expiry) JWT. The worker uses the stored refresh_token to mint a new one. */
export async function refreshOidcSession(token: string): Promise<{ token: string; playerId: string }> {
  const res = await fetch(`${BASE}/auth/oauth/refresh`, {
    method:  "POST",
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) throw await readApiError(res);
  return await res.json() as { token: string; playerId: string };
}

/** Three-way logout. Worker drops our stored refresh row and returns the
 *  IdP's end_session_endpoint (when published) so the SPA can navigate
 *  the user there for chiyigo-side termination. */
export async function logoutOidcSession(token: string): Promise<{ endSessionEndpoint: string | null }> {
  const res = await fetch(`${BASE}/auth/oauth/logout`, {
    method:  "POST",
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) throw await readApiError(res);
  return await res.json() as { endSessionEndpoint: string | null };
}
