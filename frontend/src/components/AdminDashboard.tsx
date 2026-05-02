import { useCallback, useEffect, useState } from "react";
import { useEscapeClose } from "../hooks/useEscapeClose";
import { formatApiError } from "../api/http";
import { getAdminHealthApi } from "../api/http";
import type { AdminHealth } from "../api/http";
import { useT } from "../i18n/useT";

// localStorage key for the admin secret. Using session-scoped storage
// would log the operator out on tab close, which is friendlier than the
// alternative of stashing the secret in a long-lived cookie. SessionStorage
// is also unreachable from XHR contexts that aren't this tab.
const SECRET_KEY = "chiyigo.admin-secret";

function fmtTime(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

interface Props { onClose: () => void; }

export default function AdminDashboard({ onClose }: Props) {
  useEscapeClose(onClose);
  const { t } = useT();
  const [secret, setSecret] = useState<string | null>(() =>
    typeof sessionStorage !== "undefined" ? sessionStorage.getItem(SECRET_KEY) : null,
  );
  const [draft,    setDraft]    = useState("");
  const [health,   setHealth]   = useState<AdminHealth | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [err,      setErr]      = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!secret) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await getAdminHealthApi(secret);
      setHealth(r);
    } catch (e) {
      const msg = formatApiError(e, t);
      setErr(msg);
      // Bad secret? Drop it so the operator re-enters cleanly instead of
      // hammering the endpoint until the rate limit cuts in.
      if (msg.includes("invalid admin secret")) {
        sessionStorage.removeItem(SECRET_KEY);
        setSecret(null);
      }
    } finally {
      setLoading(false);
    }
  }, [secret]);

  // Initial load + 30s polling.
  useEffect(() => {
    if (!secret) return;
    void refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [secret, refresh]);

  function submitSecret(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    sessionStorage.setItem(SECRET_KEY, trimmed);
    setSecret(trimmed);
    setDraft("");
  }
  function logout() {
    sessionStorage.removeItem(SECRET_KEY);
    setSecret(null);
    setHealth(null);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/80 px-4 py-8 overflow-y-auto" role="dialog" aria-modal="true">
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-2xl bg-green-900 p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-yellow-300">⚙️ {t("admin.title")}</h2>
          <button
            onClick={onClose}
            className="rounded-full bg-green-800 px-3 py-1 text-xs text-green-200 hover:bg-green-700"
          >{t("common.close")}</button>
        </div>

        {!secret && (
          <form onSubmit={submitSecret} className="flex flex-col gap-2">
            <label className="text-xs text-green-200">
              {t("admin.secretPrompt")}
            </label>
            <input
              type="password"
              autoFocus
              value={draft}
              onChange={e => setDraft(e.target.value)}
              className="rounded-md border border-green-700 bg-green-950 px-3 py-2 text-sm text-yellow-100 outline-none focus:border-yellow-400"
              aria-label={t("admin.secretPrompt")}
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              className="rounded-md bg-yellow-500 px-4 py-2 text-sm font-bold text-green-950 hover:bg-yellow-400 disabled:opacity-50"
            >{t("admin.secretSubmit")}</button>
            {err && <p className="text-xs text-red-300" role="alert">{err}</p>}
          </form>
        )}

        {secret && (
          <>
            <div className="flex items-center gap-2 text-[11px]">
              <button
                onClick={refresh}
                disabled={loading}
                className="rounded bg-green-800 px-3 py-1 font-bold text-yellow-200 hover:bg-green-700 disabled:opacity-50"
              >{loading ? "…" : t("admin.refresh")}</button>
              <span className="flex-1 text-green-400">{t("admin.autoRefresh")}</span>
              <button
                onClick={logout}
                className="rounded bg-red-800 px-3 py-1 font-bold text-red-50 hover:bg-red-700"
              >{t("admin.logout")}</button>
            </div>

            {err && <p className="text-xs text-red-300" role="alert">{err}</p>}

            {health && (
              <>
                <section className="rounded-md bg-green-950/60 p-3">
                  <h3 className="mb-2 text-sm font-bold text-yellow-200">🧹 {t("admin.cron")}</h3>
                  <p className="text-[11px] text-green-200">
                    {health.cron.lastRunAt
                      ? t("admin.cron.lastRun", { when: fmtTime(health.cron.lastRunAt) })
                      : t("admin.cron.never")}
                  </p>
                  <p className="text-[11px] text-green-300">
                    {t("admin.cron.runs7d", {
                      n: health.cron.runsLast7d,
                      failed: health.cron.failuresLast7d,
                    })}
                  </p>
                  {health.cron.lastResult && (
                    <p className="mt-1 text-[11px] text-green-200">
                      {t("admin.cron.purged", {
                        dms: health.cron.lastResult.dmsPurged,
                        rt:  health.cron.lastResult.roomTokensPurged,
                        rs:  health.cron.lastResult.replaySharesPurged,
                        ri:  health.cron.lastResult.roomInvitesPurged,
                      })}
                    </p>
                  )}
                  {health.cron.lastResult && health.cron.lastResult.errors.length > 0 && (
                    <p className="mt-1 text-[11px] text-red-300" role="alert">
                      {t("admin.cron.errors", { list: health.cron.lastResult.errors.join("; ") })}
                    </p>
                  )}
                </section>

                <section className="rounded-md bg-green-950/60 p-3">
                  <h3 className="mb-2 text-sm font-bold text-yellow-200">📊 {t("admin.counts")}</h3>
                  <dl className="grid grid-cols-2 gap-y-1 text-[11px] text-green-200">
                    <dt>{t("admin.counts.frozenUsers")}</dt>
                    <dd className="text-right font-mono text-yellow-200">{health.counts.frozenUsers}</dd>
                    <dt>{t("admin.counts.ledger24h")}</dt>
                    <dd className="text-right font-mono text-yellow-200">{health.counts.ledgerRowsLast24h}</dd>
                    <dt>{t("admin.counts.replays")}</dt>
                    <dd className="text-right font-mono text-yellow-200">{health.counts.replayRows}</dd>
                    <dt>{t("admin.counts.dms")}</dt>
                    <dd className="text-right font-mono text-yellow-200">{health.counts.dmRows}</dd>
                    <dt>{t("admin.counts.activeShares")}</dt>
                    <dd className="text-right font-mono text-yellow-200">{health.counts.activeReplayShares}</dd>
                  </dl>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
