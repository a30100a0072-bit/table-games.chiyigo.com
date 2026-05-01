import { type FormEvent, useState } from "react";
import { getToken, FrozenAccountError } from "../api/http";
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
        setError(err instanceof Error ? err.message : t("login.fail"));
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
          {frozen && (
            <div className="rounded-lg bg-red-900/60 p-3 ring-1 ring-red-500/40">
              <p className="text-sm font-bold text-red-300">{t("login.frozen")}</p>
              <p className="mt-1 text-xs text-red-200">{t("login.frozenReason", { r: frozen })}</p>
              <p className="mt-1 text-[11px] text-red-300/80">{t("login.frozenContact")}</p>
            </div>
          )}
          <button
            type="submit"
            disabled={loading || !name.trim()}
            className="rounded-lg bg-yellow-400 py-3 font-bold text-green-950 transition hover:bg-yellow-300 disabled:opacity-50"
          >
            {loading ? t("login.connecting") : t("login.submit")}
          </button>
        </form>
      </div>
    </div>
  );
}
