import { type FormEvent, useState } from "react";
import { getToken } from "../api/http";
import { useT } from "../i18n/useT";
import LocaleToggle from "./LocaleToggle";

interface Props {
  onLoggedIn: (playerId: string, token: string, dailyBonus: number | null) => void;
}

export default function LoginScreen({ onLoggedIn }: Props) {
  const { t } = useT();
  const [name,    setName]    = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setLoading(true); setError("");
    try {
      const { token, playerId, dailyBonus } = await getToken(trimmed);
      onLoggedIn(playerId, token, dailyBonus ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("login.fail"));
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
