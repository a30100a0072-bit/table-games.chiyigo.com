import { type FormEvent, useState } from "react";
import { formatApiError } from "../api/http";
import { getToken, FrozenAccountError } from "../api/http";
import { startOidcLogin } from "../api/oidc";
import { useT } from "../i18n/useT";
import { unlockAudio } from "../shared/sound";
import LocaleToggle from "./LocaleToggle";

interface Props {
  onLoggedIn: (playerId: string, token: string, dailyBonus: number | null) => void;
}

export default function LoginScreen({ onLoggedIn }: Props) {
  const { t } = useT();
  const [name,    setName]    = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");
  const [frozen,  setFrozen]  = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    // Submit is the user's first deliberate gesture in the app — flip the
    // AudioContext to "running" now so opponent-driven sfx aren't silent
    // on iOS Safari later.
    unlockAudio();
    setLoading(true); setError(""); setFrozen(null);
    try {
      const { token, playerId, dailyBonus } = await getToken(trimmed);
      onLoggedIn(playerId, token, dailyBonus ?? null);
    } catch (err) {
      if (err instanceof FrozenAccountError) {
        setFrozen(err.reason || "—");
      } else {
        setError(formatApiError(err, t));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-green-950">
      <div className="absolute right-4 top-4">
        <LocaleToggle />
      </div>
      <div className="w-80 rounded-2xl bg-green-900 p-8 shadow-xl">
        <h1 className="mb-2 text-center text-3xl font-bold text-yellow-300">{t("login.title")}</h1>
        <p className="mb-6 text-center text-sm text-green-300">{t("login.subtitle")}</p>
        {frozen && (
          <div className="mb-4 rounded-lg border-l-4 border-red-500 bg-red-900/60 p-3 ring-1 ring-red-500/40" role="alert">
            <p className="text-sm font-bold text-red-300">{t("login.frozen")}</p>
            <p className="mt-1 text-xs text-red-200">{t("login.frozenReason", { r: frozen })}</p>
            <p className="mt-1 text-[11px] text-red-300/80">{t("login.frozenContact")}</p>
          </div>
        )}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            className="rounded-lg bg-green-800 px-4 py-3 text-white placeholder-green-400 outline-none focus:ring-2 focus:ring-yellow-400"
            placeholder={t("login.placeholder")}
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={16}
            disabled={loading}
            autoFocus
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading || !name.trim()}
            className="rounded-lg bg-yellow-400 py-3 font-bold text-green-950 transition hover:bg-yellow-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? t("login.connecting") : t("login.submit")}
          </button>
        </form>

        {/* Divider + chiyigo SSO. Top-level navigation — no fetch wrap. */}
        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-green-700" />
          <span className="text-[10px] uppercase tracking-widest text-green-500">{t("login.or")}</span>
          <div className="h-px flex-1 bg-green-700" />
        </div>
        <button
          onClick={() => { unlockAudio(); startOidcLogin(); }}
          disabled={loading}
          className="w-full rounded-lg bg-green-700 py-3 font-bold text-yellow-100 ring-1 ring-yellow-500/40 transition hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("login.chiyigoSso")}
        </button>
      </div>
    </div>
  );
}
