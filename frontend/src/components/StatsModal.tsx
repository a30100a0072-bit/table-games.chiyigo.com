import { useEffect, useState } from "react";
import { getHistory, getLeaderboard } from "../api/http";
import type { HistoryEntry, LeaderboardRow } from "../api/http";

interface Props {
  playerId: string;
  token:    string;
  onClose:  () => void;
}

type Tab = "leaderboard" | "history";

const REASON_LABEL: Record<string, string> = {
  lastCardPlayed: "正常結算",
  timeout:        "逾時",
  disconnect:     "斷線",
};

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

export default function StatsModal({ playerId, token, onClose }: Props) {
  const [tab,         setTab]         = useState<Tab>("leaderboard");
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[] | null>(null);
  const [history,     setHistory]     = useState<HistoryEntry[] | null>(null);
  const [error,       setError]       = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (tab === "leaderboard" && !leaderboard) {
      getLeaderboard()
        .then(r => { if (!cancelled) setLeaderboard(r.rows); })
        .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "載入失敗"); });
    } else if (tab === "history" && !history) {
      getHistory(token)
        .then(r => { if (!cancelled) setHistory(r.games); })
        .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "載入失敗"); });
    }
    return () => { cancelled = true; };
  }, [tab, token, leaderboard, history]);

  const wins   = history?.filter(g => g.final_rank === 1).length ?? 0;
  const total  = history?.length ?? 0;
  const winPct = total > 0 ? Math.round((wins / total) * 100) : 0;
  const netDelta = history?.reduce((n, g) => n + g.score_delta, 0) ?? 0;

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-green-900 p-4 shadow-2xl ring-1 ring-yellow-700/40"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-lg font-bold text-yellow-300">統計</span>
          <button onClick={onClose} className="rounded-full bg-green-800 px-3 py-1 text-xs text-green-200 hover:bg-green-700">關閉</button>
        </div>

        <div className="mb-3 flex gap-2">
          <button
            onClick={() => setTab("leaderboard")}
            className={[
              "flex-1 rounded-lg px-3 py-1.5 text-sm font-bold transition",
              tab === "leaderboard" ? "bg-yellow-400 text-green-950" : "bg-green-800 text-green-300 hover:bg-green-700",
            ].join(" ")}
          >🏆 排行榜</button>
          <button
            onClick={() => setTab("history")}
            className={[
              "flex-1 rounded-lg px-3 py-1.5 text-sm font-bold transition",
              tab === "history" ? "bg-yellow-400 text-green-950" : "bg-green-800 text-green-300 hover:bg-green-700",
            ].join(" ")}
          >📋 戰績</button>
        </div>

        {error && <p className="mb-2 text-sm text-red-300">{error}</p>}

        {tab === "leaderboard" && (
          <div className="max-h-96 overflow-y-auto">
            {!leaderboard ? <p className="py-8 text-center text-sm text-green-400">載入中…</p>
            : leaderboard.length === 0 ? <p className="py-8 text-center text-sm text-green-400">尚無資料</p>
            : (
              <ol className="space-y-1 text-sm">
                {leaderboard.map((row, i) => (
                  <li
                    key={row.player_id}
                    className={[
                      "flex items-center justify-between rounded-md px-3 py-2",
                      row.player_id === playerId ? "bg-yellow-700/40 ring-1 ring-yellow-500/50" : "bg-green-800/60",
                    ].join(" ")}
                  >
                    <span className="flex items-center gap-2">
                      <span className="w-6 text-center font-bold text-yellow-300">
                        {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1}
                      </span>
                      <span className={row.player_id === playerId ? "font-bold text-yellow-200" : "text-green-100"}>
                        {row.display_name || row.player_id}
                      </span>
                    </span>
                    <span className="font-bold text-yellow-200">{row.chip_balance.toLocaleString()}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {tab === "history" && (
          <div className="max-h-96 overflow-y-auto">
            {!history ? <p className="py-8 text-center text-sm text-green-400">載入中…</p>
            : history.length === 0 ? <p className="py-8 text-center text-sm text-green-400">尚無對戰紀錄</p>
            : (
              <>
                <div className="mb-2 grid grid-cols-3 gap-2 rounded-lg bg-green-800/60 p-2 text-center text-xs">
                  <div><div className="text-yellow-300">{total}</div><div className="text-green-300">場數</div></div>
                  <div><div className="text-yellow-300">{winPct}%</div><div className="text-green-300">勝率</div></div>
                  <div><div className={netDelta >= 0 ? "text-emerald-300" : "text-red-300"}>{netDelta >= 0 ? "+" : ""}{netDelta}</div><div className="text-green-300">淨分</div></div>
                </div>
                <ul className="space-y-1 text-sm">
                  {history.map(g => (
                    <li key={g.game_id} className="flex items-center justify-between rounded-md bg-green-800/60 px-3 py-1.5">
                      <span className="flex items-center gap-2">
                        <span className={[
                          "w-7 rounded-full text-center text-[10px] font-bold leading-5",
                          g.final_rank === 1 ? "bg-yellow-500 text-green-950" : "bg-green-700 text-green-200",
                        ].join(" ")}>#{g.final_rank}</span>
                        <span className="text-[10px] text-green-400">{fmtTime(g.finished_at)} · {REASON_LABEL[g.reason] ?? g.reason}</span>
                      </span>
                      <span className={g.score_delta >= 0 ? "font-bold text-emerald-300" : "font-bold text-red-300"}>
                        {g.score_delta >= 0 ? "+" : ""}{g.score_delta}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
