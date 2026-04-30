import { useEffect, useState } from "react";
import { getWallet } from "../api/http";
import type { WalletResponse, LedgerEntry } from "../api/http";

interface Props {
  token:    string;
  refreshKey?: number;   // bump to force refetch (e.g. after settlement)
}

const REASON_LABEL: Record<string, string> = {
  signup:     "開戶贈送",
  settlement: "牌局結算",
  adjustment: "管理員調整",
};

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function WalletBadge({ token, refreshKey = 0 }: Props) {
  const [wallet, setWallet] = useState<WalletResponse | null>(null);
  const [error,  setError]  = useState<string | null>(null);
  const [open,   setOpen]   = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getWallet(token)
      .then(w => { if (!cancelled) setWallet(w); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "載入失敗"); });
    return () => { cancelled = true; };
  }, [token, refreshKey]);

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
            <span className="text-sm font-bold text-yellow-300">籌碼明細</span>
            {wallet && <span className="text-green-400">餘額 {wallet.chipBalance.toLocaleString()}</span>}
          </div>

          {error && <p className="text-red-300">{error}</p>}

          {wallet && wallet.ledger.length === 0 && (
            <p className="text-green-400">尚無流水紀錄</p>
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
