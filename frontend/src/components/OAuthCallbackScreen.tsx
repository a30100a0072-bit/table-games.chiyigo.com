// /frontend/src/components/OAuthCallbackScreen.tsx
// Handles the chiyigo.com OIDC redirect (response_mode=fragment). Reads
// `#code=…&state=…` from the URL, swaps it at the worker for our own JWT,
// then calls `onCompleted` to hand control back to App.tsx.
//
// On error: shows a retry path back to the login screen — never auto-
// retries the exchange (state is single-use; re-running with the same
// fragment will fail "state expired or unknown" the second time).      // L2_鎖定

import { useEffect, useState } from "react";
import { exchangeOidcCode, type OidcExchangeResponse } from "../api/oidc";
import { formatApiError } from "../api/http";
import { useT } from "../i18n/useT";

interface Props {
  onCompleted: (resp: OidcExchangeResponse) => void;
  onCancelled: () => void;
}

export default function OAuthCallbackScreen({ onCompleted, onCancelled }: Props) {
  const { t } = useT();
  const [error, setError] = useState<string>("");

  useEffect(() => {
    // Pull from fragment first (response_mode=fragment), fall back to
    // query for IdPs that quietly downgrade. Either way, after consuming
    // we strip the URL so reload doesn't re-trigger.                    // L2_實作
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1) : window.location.hash;
    const fragParams  = new URLSearchParams(hash);
    const queryParams = new URL(window.location.href).searchParams;
    const code  = fragParams.get("code")  ?? queryParams.get("code");
    const state = fragParams.get("state") ?? queryParams.get("state");
    const idpError = fragParams.get("error") ?? queryParams.get("error");

    // Always clean the URL — even on failure, leaving `code` in the bar
    // is bad form (it's already invalid by then).
    window.history.replaceState(null, "", "/");

    if (idpError) { setError(`IdP error: ${idpError}`); return; }
    if (!code || !state) { setError("missing code/state"); return; }

    let cancelled = false;
    (async () => {
      try {
        const resp = await exchangeOidcCode(code, state);
        if (!cancelled) onCompleted(resp);
      } catch (err) {
        if (!cancelled) setError(formatApiError(err, t));
      }
    })();
    return () => { cancelled = true; };
  // The effect intentionally runs once on mount (URL is consumed exactly
  // once — re-running would be a noop after replaceState).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center bg-green-950">
        <div className="w-80 rounded-2xl bg-green-900 p-6 shadow-xl">
          <h2 className="text-center text-lg font-bold text-red-400">{t("oidc.failed")}</h2>
          <p className="mt-3 text-center text-sm text-red-300">{error}</p>
          <button
            onClick={onCancelled}
            className="mt-4 w-full rounded-lg bg-yellow-400 py-2 font-bold text-green-950 hover:bg-yellow-300"
          >{t("oidc.backToLogin")}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-green-950">
      <div className="rounded-2xl bg-green-900 p-8 shadow-xl">
        <p className="text-center text-yellow-300">{t("oidc.signingIn")}</p>
      </div>
    </div>
  );
}
