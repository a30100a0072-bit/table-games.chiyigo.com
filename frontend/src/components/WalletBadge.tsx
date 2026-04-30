import { useEffect, useState } from "react";
import { getWallet, claimBailout, BailoutError } from "../api/http";
import type { WalletResponse, LedgerEntry } from "../api/http";
import { useT } from "../i18n/useT";

const BAILOUT_THRESHOLD = 100;

interface Props {
  token:    string;
  refreshKey?: number;   // bump to force refetch (e.g. after settlement)
}

const REASON_LABEL: Record<string, string> = {
  signup:     "開戶贈送",
  settlement: "牌局結算",
  bailout:    "救濟金",
  daily:      "每日登入",
  adjustment: "管理員調整",
};

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function WalletBadge({ token, refreshKey = 0 }: Props) {
  const { t } = useT();
  const [wallet,  setWallet]  = useState<WalletResponse | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [open,    setOpen]    = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [tick,    setTick]    = useState(0);   // bumped after a successful claim

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getWallet(token)
      .then(w => { if (!cancelled) setWallet(w); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "載入失敗"); });
    return () => { cancelled = true; };
  }, [token, refreshKey, tick]);

  async function handleBailout() {
    if (claiming) return;
    setClaiming(true);
    setError(null);
    try {
      await claimBailout(token);
      setTick(t => t + 1);   // refetch wallet
    } catch (e) {
      if (e instanceof BailoutError && e.detail.nextEligibleAt) {
        const hrs = Math.ceil((e.detail.nextEligibleAt - Date.now()) / 3_600_000);
        setError(`領取失敗：${e.message}${hrs > 0 ? `，再 ${hrs} 小時可領` : ""}`);
      } else {
        setError(e instanceof Error ? e.message : "領取失敗");
      }
    } finally {
      setClaiming(false);
    }
  }

  const eligible = !!wallet && wallet.chipBalance < BAILOUT_THRESHOLD;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 rounded-full bg-yellow-600/90 px-4 py-1.5 text-sm font-bold text-yellow-50 shadow-lg transition hover:bg-yellow-500 active:scale-95"
      >
        <span>💰</span>
        <span>
          {error    ? "—"
          : wallet  ? wallet.chipBalance.toLocaleString()
          :           "…"}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-12 z-10 w-72 rounded-xl bg-green-900 p-3 text-xs text-green-100 shadow-2xl ring-1 ring-yellow-700/40">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-sm font-bold text-yellow-300">💰</span>
            {wallet && <span className="text-green-400">{t("wallet.balance")} {wallet.chipBalance.toLocaleString()}</span>}
          </div>

          {error && <p className="mb-2 text-red-300">{error}</p>}

          {eligible && (
            <button
              onClick={handleBailout}
              disabled={claiming}
              className="mb-2 w-full rounded-md bg-red-600 py-1.5 text-xs font-bold text-white shadow transition hover:bg-red-500 disabled:opacity-50"
            >
              {claiming ? t("wallet.bailoutLoading") : t("wallet.bailout", { n: BAILOUT_THRESHOLD })}
            </button>
          )}

          {wallet && wallet.ledger.length === 0 && (
            <p className="text-green-400">{t("wallet.empty")}</p>
          )}

          {wallet && wallet.ledger.length > 0 && (
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {wallet.ledger.map((e: LedgerEntry) => (
                <li key={e.ledger_id} className="flex items-center justify-between gap-2 border-b border-green-800/60 pb-1">
                  <span className="flex flex-col">
                    <span>{REASON_LABEL[e.reason] ?? e.reason}</span>
                    <span className="text-[10px] text-green-500">{fmtTime(e.created_at)}</span>
                  </span>
                  <span className={e.delta >= 0 ? "font-bold text-emerald-300" : "font-bold text-red-300"}>
                    {e.delta >= 0 ? "+" : ""}{e.delta}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
