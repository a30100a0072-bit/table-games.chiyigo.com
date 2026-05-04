import { useEffect, useState } from "react";
import { useEscapeClose } from "../hooks/useEscapeClose";
import { useFocusTrap } from "../hooks/useFocusTrap";
import {
  listTournaments, getTournament, createTournament, joinTournamentApi,
  formatApiError,
} from "../api/http";
import type { TournamentRow, TournamentDetail } from "../api/http";
import type { GameType } from "../shared/types";
import { useT } from "../i18n/useT";

interface Props {
  playerId: string;
  token:    string;
  onClose:  () => void;
  onJoinedRoom: (roomId: string, gameType: GameType) => void;
}

const GAME_LABEL_KEY: Record<GameType, "tour.gameBigTwo" | "tour.gameMahjong" | "tour.gameTexas" | "tour.gameUno" | "tour.gameYahtzee"> = {
  bigTwo:  "tour.gameBigTwo",
  mahjong: "tour.gameMahjong",
  texas:   "tour.gameTexas",
  uno:     "tour.gameUno",
  yahtzee: "tour.gameYahtzee",
};
const PRESET_BUYINS = [200, 500, 1000];

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function TournamentModal({ playerId, token, onClose, onJoinedRoom }: Props) {
  const { t } = useT();
  useEscapeClose(onClose);
  const trapRef = useFocusTrap<HTMLDivElement>();
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
      setError(formatApiError(e, t));
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
      setError(formatApiError(e, t));
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
      setError(formatApiError(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 p-4" onClick={onClose} role="dialog" aria-modal="true" ref={trapRef}>
      <div
        className="w-full max-w-md rounded-2xl bg-green-900 p-4 shadow-2xl ring-1 ring-yellow-700/40"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-lg font-bold text-yellow-300">🏆 {t("tour.title")}</span>
          <button onClick={onClose} className="rounded-full bg-green-800 px-3 py-1 text-xs text-green-200 hover:bg-green-700">{t("common.close")}</button>
        </div>

        {error && <p className="mb-2 text-sm text-red-300" role="alert">{error}</p>}

        {/* DETAIL VIEW */}
        {openId && detail && (
          <div>
            <button
              onClick={() => { setOpenId(null); refresh(); }}
              className="mb-3 text-xs text-green-300 hover:text-yellow-200"
            >{t("tour.back")}</button>
            <div className="mb-3 rounded-lg bg-green-800/60 p-3 text-sm">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-bold text-yellow-200">
                  {t(GAME_LABEL_KEY[detail.tournament.game_type])}
                </span>
                <span className="rounded-full bg-yellow-700/40 px-2 py-0.5 text-xs text-yellow-100">
                  {detail.tournament.status === "registering" ? t("tour.statusRegistering")
                    : detail.tournament.status === "running"   ? t("tour.statusRunning")
                    : t("tour.statusSettled")}
                </span>
              </div>
              <div className="text-xs text-green-300">
                {t("tour.buyInPrize", { buyIn: detail.tournament.buy_in, prize: detail.tournament.prize_pool })}
              </div>
              <div className="text-xs text-green-300">
                {t("tour.bestOfProgress", { total: detail.tournament.rounds_total, done: detail.tournament.rounds_done })}
              </div>
              {detail.tournament.game_type === "texas" && (
                <div className="mt-1 text-[11px] text-green-400">
                  {t("tour.blindsHint")}
                </div>
              )}
            </div>

            <div className="mb-3 max-h-64 overflow-y-auto">
              <div className="mb-1 text-xs font-bold text-yellow-200">{t("tour.entrants")}</div>
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
                    {t("tour.waiting")}
                  </li>
                ))}
              </ol>
            </div>

            {detail.roundResults && detail.roundResults.length > 0 && (
              <div className="mb-3">
                <div className="mb-1 text-xs font-bold text-yellow-200">{t("tour.roundScores")}</div>
                <div className="overflow-x-auto rounded-md bg-green-950/60 p-2">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="text-green-400">
                        <th className="px-1 py-0.5 text-left">{t("tour.player")}</th>
                        {detail.roundResults.map(r => (
                          <th key={r.round} className="px-1 py-0.5 text-center">R{r.round}</th>
                        ))}
                        <th className="px-1 py-0.5 text-right">{t("tour.total")}</th>
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
                {busy ? t("tour.joining") : t("tour.joinChips", { buyIn: detail.tournament.buy_in })}
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
              >{t("tour.createNew")}</button>
            )}

            {creating && (
              <div className="mb-3 rounded-lg bg-green-800/60 p-3">
                <div className="mb-2 text-xs font-bold text-yellow-200">{t("tour.create")}</div>
                <div className="mb-2 flex gap-1">
                  {(["bigTwo", "mahjong", "texas"] as GameType[]).map(g => (
                    <button
                      key={g}
                      onClick={() => setCreateGT(g)}
                      className={[
                        "flex-1 rounded-md py-1.5 text-xs font-bold",
                        createGT === g ? "bg-yellow-400 text-green-950" : "bg-green-700 text-green-200",
                      ].join(" ")}
                    >{t(GAME_LABEL_KEY[g])}</button>
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
                  {t("tour.prizeRakeHint", { prize: createBI * 4 - Math.floor(createBI * 4 * 5 / 100) })}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setCreating(false)}
                    className="flex-1 rounded-md bg-gray-700 py-1.5 text-xs font-bold text-gray-200"
                  >{t("tour.cancel")}</button>
                  <button
                    onClick={handleCreate}
                    disabled={busy}
                    className="flex-1 rounded-md bg-yellow-400 py-1.5 text-xs font-bold text-green-950 disabled:opacity-50"
                  >{busy ? t("tour.creating") : t("tour.confirmCreate")}</button>
                </div>
              </div>
            )}

            <div className="max-h-72 overflow-y-auto">
              <div className="mb-1 text-xs font-bold text-yellow-200">{t("tour.openListings")}</div>
              {!list ? <p className="py-4 text-center text-sm text-green-400">{t("tour.loading")}</p>
              : list.length === 0 ? <p className="py-4 text-center text-sm text-green-400">{t("tour.noOpen")}</p>
              : (
                <ul className="space-y-1 text-sm">
                  {list.map(row => (
                    <li
                      key={row.tournament_id}
                      onClick={() => setOpenId(row.tournament_id)}
                      className="cursor-pointer rounded-md bg-green-800/60 px-3 py-2 transition hover:bg-green-700"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold">
                          {t(GAME_LABEL_KEY[row.game_type])}
                        </span>
                        <span className="text-xs text-yellow-200">{t("tour.prize", { n: row.prize_pool })}</span>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-green-300">
                        <span>{t("tour.feeAt", { ts: fmtTime(row.created_at), buyIn: row.buy_in })}</span>
                        <span>{row.registered}/4</span>
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
