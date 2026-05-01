import { useEffect, useState } from "react";
import {
  listTournaments, getTournament, createTournament, joinTournamentApi,
} from "../api/http";
import type { TournamentRow, TournamentDetail } from "../api/http";
import type { GameType } from "../shared/types";

interface Props {
  playerId: string;
  token:    string;
  onClose:  () => void;
  onJoinedRoom: (roomId: string, gameType: GameType) => void;
}

const GAMES: { value: GameType; label: string }[] = [
  { value: "bigTwo",  label: "🃏 大老二" },
  { value: "mahjong", label: "🀄 麻將" },
  { value: "texas",   label: "♠️ 德州" },
];
const PRESET_BUYINS = [200, 500, 1000];

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function TournamentModal({ playerId, token, onClose, onJoinedRoom }: Props) {
  const [list,    setList]    = useState<TournamentRow[] | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [busy,    setBusy]    = useState(false);
  const [openId,  setOpenId]  = useState<string | null>(null);   // detail view
  const [creating, setCreating] = useState(false);
  const [createGT, setCreateGT] = useState<GameType>("bigTwo");
  const [createBI, setCreateBI] = useState<number>(200);

  // Detail state when openId is set
  const [detail, setDetail] = useState<TournamentDetail | null>(null);

  async function refresh() {
    setError(null);
    try {
      const r = await listTournaments();
      setList(r.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load failed");
    }
  }

  useEffect(() => { refresh(); }, []);

  // Poll detail every 3s if a tournament is selected (so users see the
  // bracket / current room update as rounds finish).
  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    let cancelled = false;
    const tick = async () => {
      try {
        const d = await getTournament(openId);
        if (!cancelled) setDetail(d);
        // If a round is running, the joined players' clients should
        // jump into the room WS. Hand control back to App.
        if (!cancelled && d.currentRoom && d.entries.some(e => e.player_id === playerId)) {
          onJoinedRoom(d.currentRoom, d.tournament.game_type);
        }
      } catch { /* keep polling */ }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [openId, playerId, onJoinedRoom]);

  async function handleCreate() {
    setBusy(true); setError(null);
    try {
      const { tournamentId } = await createTournament(token, createGT, createBI);
      setCreating(false);
      setOpenId(tournamentId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "create failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin(id: string) {
    setBusy(true); setError(null);
    try {
      await joinTournamentApi(token, id);
      setOpenId(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "join failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl bg-green-900 p-4 shadow-2xl ring-1 ring-yellow-700/40"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-lg font-bold text-yellow-300">🏆 賽事</span>
          <button onClick={onClose} className="rounded-full bg-green-800 px-3 py-1 text-xs text-green-200 hover:bg-green-700">關閉</button>
        </div>

        {error && <p className="mb-2 text-sm text-red-300">{error}</p>}

        {/* DETAIL VIEW */}
        {openId && detail && (
          <div>
            <button
              onClick={() => { setOpenId(null); refresh(); }}
              className="mb-3 text-xs text-green-300 hover:text-yellow-200"
            >← 返回列表</button>
            <div className="mb-3 rounded-lg bg-green-800/60 p-3 text-sm">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-bold text-yellow-200">
                  {GAMES.find(g => g.value === detail.tournament.game_type)?.label}
                </span>
                <span className="rounded-full bg-yellow-700/40 px-2 py-0.5 text-xs text-yellow-100">
                  {detail.tournament.status === "registering" ? "🟢 報名中"
                    : detail.tournament.status === "running"   ? "▶️ 進行中"
                    : "✅ 已結束"}
                </span>
              </div>
              <div className="text-xs text-green-300">
                報名費 {detail.tournament.buy_in} · 獎金 {detail.tournament.prize_pool}
              </div>
              <div className="text-xs text-green-300">
                Best-of-{detail.tournament.rounds_total} · 已完成 {detail.tournament.rounds_done} 局
              </div>
            </div>

            <div className="mb-3 max-h-64 overflow-y-auto">
              <div className="mb-1 text-xs font-bold text-yellow-200">參賽者</div>
              <ol className="space-y-1 text-sm">
                {detail.entries.map((e, i) => (
                  <li
                    key={e.player_id}
                    className={[
                      "flex items-center justify-between rounded-md px-3 py-1.5",
                      e.player_id === playerId ? "bg-yellow-700/40 ring-1 ring-yellow-500/50" : "bg-green-800/60",
                    ].join(" ")}
                  >
                    <span className="flex items-center gap-2">
                      <span className="w-6 text-center font-bold text-yellow-300">
                        {e.final_rank === 1 ? "🥇" : e.final_rank === 2 ? "🥈" : e.final_rank === 3 ? "🥉" : `#${i + 1}`}
                      </span>
                      <span>{e.player_id}</span>
                    </span>
                    <span className={e.agg_score >= 0 ? "text-emerald-300" : "text-red-300"}>
                      {e.agg_score >= 0 ? "+" : ""}{e.agg_score}
                    </span>
                  </li>
                ))}
                {Array.from({ length: 4 - detail.entries.length }).map((_, i) => (
                  <li key={`empty-${i}`} className="rounded-md bg-green-800/30 px-3 py-1.5 text-xs text-green-500">
                    等待中…
                  </li>
                ))}
              </ol>
            </div>

            {detail.roundResults && detail.roundResults.length > 0 && (
              <div className="mb-3">
                <div className="mb-1 text-xs font-bold text-yellow-200">每局分數</div>
                <div className="overflow-x-auto rounded-md bg-green-950/60 p-2">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="text-green-400">
                        <th className="px-1 py-0.5 text-left">玩家</th>
                        {detail.roundResults.map(r => (
                          <th key={r.round} className="px-1 py-0.5 text-center">R{r.round}</th>
                        ))}
                        <th className="px-1 py-0.5 text-right">合計</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.entries.map(e => {
                        const total = detail.roundResults.reduce(
                          (s, r) => s + (r.deltas[e.player_id] ?? 0), 0,
                        );
                        return (
                          <tr key={e.player_id} className={e.player_id === playerId ? "text-yellow-200" : ""}>
                            <td className="px-1 py-0.5 truncate max-w-[80px]">{e.player_id}</td>
                            {detail.roundResults.map(r => {
                              const d = r.deltas[e.player_id] ?? 0;
                              return (
                                <td key={r.round} className={[
                                  "px-1 py-0.5 text-center font-mono",
                                  d > 0 ? "text-emerald-400" : d < 0 ? "text-red-400" : "text-green-500",
                                ].join(" ")}>
                                  {d > 0 ? "+" : ""}{d}
                                </td>
                              );
                            })}
                            <td className={[
                              "px-1 py-0.5 text-right font-mono font-bold",
                              total >= 0 ? "text-emerald-300" : "text-red-300",
                            ].join(" ")}>
                              {total >= 0 ? "+" : ""}{total}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {detail.tournament.status === "registering"
              && !detail.entries.some(e => e.player_id === playerId) && (
              <button
                onClick={() => handleJoin(detail.tournament.tournament_id)}
                disabled={busy}
                className="w-full rounded-lg bg-yellow-400 py-2 font-bold text-green-950 disabled:opacity-50"
              >
                {busy ? "加入中…" : `加入（-${detail.tournament.buy_in} 籌碼）`}
              </button>
            )}
          </div>
        )}

        {/* LIST + CREATE */}
        {!openId && (
          <>
            {!creating && (
              <button
                onClick={() => setCreating(true)}
                className="mb-3 w-full rounded-lg bg-yellow-400 py-2 text-sm font-bold text-green-950 hover:bg-yellow-300"
              >+ 建立新賽事</button>
            )}

            {creating && (
              <div className="mb-3 rounded-lg bg-green-800/60 p-3">
                <div className="mb-2 text-xs font-bold text-yellow-200">建立賽事</div>
                <div className="mb-2 flex gap-1">
                  {GAMES.map(g => (
                    <button
                      key={g.value}
                      onClick={() => setCreateGT(g.value)}
                      className={[
                        "flex-1 rounded-md py-1.5 text-xs font-bold",
                        createGT === g.value ? "bg-yellow-400 text-green-950" : "bg-green-700 text-green-200",
                      ].join(" ")}
                    >{g.label}</button>
                  ))}
                </div>
                <div className="mb-2 flex gap-1">
                  {PRESET_BUYINS.map(b => (
                    <button
                      key={b}
                      onClick={() => setCreateBI(b)}
                      className={[
                        "flex-1 rounded-md py-1 text-xs font-bold",
                        createBI === b ? "bg-yellow-400 text-green-950" : "bg-green-700 text-green-200",
                      ].join(" ")}
                    >{b}</button>
                  ))}
                </div>
                <div className="mb-2 text-[11px] text-green-300">
                  獎金 {createBI * 4 - Math.floor(createBI * 4 * 5 / 100)}（5% 抽水）· Best-of-3
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setCreating(false)}
                    className="flex-1 rounded-md bg-gray-700 py-1.5 text-xs font-bold text-gray-200"
                  >取消</button>
                  <button
                    onClick={handleCreate}
                    disabled={busy}
                    className="flex-1 rounded-md bg-yellow-400 py-1.5 text-xs font-bold text-green-950 disabled:opacity-50"
                  >{busy ? "建立中…" : "建立"}</button>
                </div>
              </div>
            )}

            <div className="max-h-72 overflow-y-auto">
              <div className="mb-1 text-xs font-bold text-yellow-200">報名中</div>
              {!list ? <p className="py-4 text-center text-sm text-green-400">載入中…</p>
              : list.length === 0 ? <p className="py-4 text-center text-sm text-green-400">目前沒有可報名的賽事</p>
              : (
                <ul className="space-y-1 text-sm">
                  {list.map(t => (
                    <li
                      key={t.tournament_id}
                      onClick={() => setOpenId(t.tournament_id)}
                      className="cursor-pointer rounded-md bg-green-800/60 px-3 py-2 transition hover:bg-green-700"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold">
                          {GAMES.find(g => g.value === t.game_type)?.label ?? t.game_type}
                        </span>
                        <span className="text-xs text-yellow-200">獎金 {t.prize_pool}</span>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-green-300">
                        <span>{fmtTime(t.created_at)} · 報名費 {t.buy_in}</span>
                        <span>{t.registered}/4</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
