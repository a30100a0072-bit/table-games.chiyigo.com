import { useEffect, useState } from "react";
import { formatApiError } from "../api/http";
import { getWallet, claimBailout, BailoutError, deleteAccountApi, exportAccountApi } from "../api/http";
import type { WalletResponse, LedgerEntry } from "../api/http";
import { useT } from "../i18n/useT";

const BAILOUT_THRESHOLD = 100;

interface Props {
  token:    string;
  refreshKey?: number;   // bump to force refetch (e.g. after settlement)
  /** Called after a successful DELETE /api/me so App can drop the JWT
   *  and route the user back to the login screen. */
  onAccountDeleted?: () => void;
}

const REASON_LABEL: Record<string, string> = {
  signup:     "開戶贈送",
  settlement: "牌局結算",
  bailout:    "救濟金",
  daily:      "每日登入",
  adjustment: "管理員調整",
  tournament: "賽事",
};

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function WalletBadge({ token, refreshKey = 0, onAccountDeleted }: Props) {
  const { t } = useT();
  const [wallet,  setWallet]  = useState<WalletResponse | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [open,    setOpen]    = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [tick,    setTick]    = useState(0);   // bumped after a successful claim
  const [deleteStep, setDeleteStep] = useState<0 | 1 | 2>(0);
  const [deleteText, setDeleteText] = useState("");
  const [deleting,   setDeleting]   = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getWallet(token)
      .then(w => { if (!cancelled) setWallet(w); })
      .catch(e => { if (!cancelled) setError(formatApiError(e, t)); });
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
        setError(formatApiError(e, t));
      }
    } finally {
      setClaiming(false);
    }
  }

  const [exporting, setExporting] = useState(false);
  async function handleExport() {
    if (exporting) return;
    setExporting(true); setError(null);
    try { await exportAccountApi(token); }
    catch (e) { setError(formatApiError(e, t)); }
    finally { setExporting(false); }
  }

  async function confirmDelete() {
    if (deleting) return;
    setDeleting(true); setError(null);
    try {
      await deleteAccountApi(token);
      onAccountDeleted?.();
    } catch (e) {
      setError(formatApiError(e, t));
      setDeleting(false);
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

          {wallet && (
            <div className="mb-2 rounded-md border-l-4 border-red-600 bg-red-900/30 p-2">
              <button
                onClick={handleBailout}
                disabled={claiming || !eligible}
                className="w-full rounded-md bg-red-600 py-1.5 text-xs font-bold text-white shadow transition hover:bg-red-500 disabled:cursor-not-allowed disabled:bg-red-900/60 disabled:text-red-300/60"
              >
                {claiming ? t("wallet.bailoutLoading") : t("wallet.bailout", { n: BAILOUT_THRESHOLD })}
              </button>
              {!eligible && (
                <p className="mt-1 text-[10px] text-red-200/70">
                  {t("wallet.bailoutHint", { n: BAILOUT_THRESHOLD })}
                </p>
              )}
            </div>
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
              {wallet.nextLedgerCursor !== null && (
                <li className="flex justify-center pt-1">
                  <button
                    onClick={async () => {
                      try {
                        const more = await getWallet(token, wallet.nextLedgerCursor!);
                        setWallet({
                          ...more,
                          ledger: [...wallet.ledger, ...more.ledger],
                        });
                      } catch (e) { setError(formatApiError(e, t)); }
                    }}
                    className="rounded bg-green-800 px-3 py-0.5 text-[10px] font-bold text-yellow-200 hover:bg-green-700"
                  >{t("wallet.loadMore")}</button>
                </li>
              )}
            </ul>
          )}

          {/* Data export + account deletion — small footer */}
          <div className="mt-3 flex items-center justify-between border-t border-green-800/60 pt-2 text-[10px]">
            <button
              onClick={handleExport}
              disabled={exporting}
              className="text-yellow-300/80 hover:text-yellow-200 disabled:opacity-50"
            >{exporting ? "匯出中…" : "匯出資料"}</button>
            {deleteStep === 0 && (
              <button
                onClick={() => setDeleteStep(1)}
                className="text-red-400/70 hover:text-red-300"
              >刪除帳號</button>
            )}
          </div>
          <div className={deleteStep === 0 ? "hidden" : "mt-2 border-t border-red-900/60 pt-2"}>
            {deleteStep === 1 && (
              <div className="text-[11px] text-red-200">
                <p className="mb-2">刪除後好友 / 訊息 / 邀請會清空，籌碼帳本會匿名化（無法復原）。</p>
                <div className="flex gap-1">
                  <button
                    onClick={() => setDeleteStep(0)}
                    className="flex-1 rounded bg-gray-700 py-1 text-[10px] font-bold text-gray-200"
                  >取消</button>
                  <button
                    onClick={() => setDeleteStep(2)}
                    className="flex-1 rounded bg-red-700 py-1 text-[10px] font-bold text-white"
                  >我了解，繼續</button>
                </div>
              </div>
            )}
            {deleteStep === 2 && (
              <div className="text-[11px] text-red-200">
                <p className="mb-1">輸入 <code className="rounded bg-red-950 px-1">DELETE</code> 確認：</p>
                <input
                  type="text"
                  value={deleteText}
                  onChange={e => setDeleteText(e.target.value)}
                  disabled={deleting}
                  className="mb-2 w-full rounded bg-red-950 px-2 py-1 text-xs text-red-100"
                />
                <div className="flex gap-1">
                  <button
                    onClick={() => { setDeleteStep(0); setDeleteText(""); }}
                    disabled={deleting}
                    className="flex-1 rounded bg-gray-700 py-1 text-[10px] font-bold text-gray-200 disabled:opacity-50"
                  >取消</button>
                  <button
                    onClick={confirmDelete}
                    disabled={deleting || deleteText !== "DELETE"}
                    className="flex-1 rounded bg-red-700 py-1 text-[10px] font-bold text-white disabled:bg-gray-700 disabled:text-gray-500"
                  >{deleting ? "刪除中…" : "確定刪除"}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
