import { useEffect, useState } from "react";
import { listMyReplaysApi, getReplayApi } from "../api/http";
import type { ReplayDetail, ReplaySummary, ReplayEvent } from "../api/http";
import type { GameType } from "../shared/types";
import { useT } from "../i18n/useT";

interface Props {
  token:   string;
  onClose: () => void;
}

const ICON: Record<GameType, string> = { bigTwo: "🃏", mahjong: "🀄", texas: "♠️" };
const LABEL_KEY: Record<GameType, "select.bigTwo" | "select.mahjong" | "select.texas"> = {
  bigTwo: "select.bigTwo", mahjong: "select.mahjong", texas: "select.texas",
};

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Best-effort textual rendering of a single replay event. The shapes
 *  follow PlayerAction in src/types/game.ts; we duck-type rather than
 *  re-import to keep the modal independent of backend types. */
function fmtEvent(e: ReplayEvent): string {
  if (e.kind === "tick") return "（反應視窗結束）";
  const a = e.action as { type?: string; cards?: unknown[]; combo?: string;
    tile?: { suit: string; rank: number }; tiles?: unknown[];
    raiseAmount?: number; selfDrawn?: boolean } | undefined;
  const who = e.playerId ?? "?";
  if (!a || !a.type) return `${who}: ?`;
  switch (a.type) {
    case "play":   return `${who} 出牌 ${(a.cards ?? []).length} 張 (${a.combo ?? "?"})`;
    case "pass":   return `${who} pass`;
    case "discard":return `${who} 打 ${a.tile?.rank}${a.tile?.suit}`;
    case "chow":   return `${who} 吃`;
    case "pong":   return `${who} 碰`;
    case "kong":   return `${who} 槓`;
    case "hu":     return `${who} ${a.selfDrawn ? "自摸" : "胡"}`;
    case "mj_pass":return `${who} 過`;
    case "fold":   return `${who} fold`;
    case "check":  return `${who} check`;
    case "call":   return `${who} call`;
    case "raise":  return `${who} raise → ${a.raiseAmount ?? "?"}`;
    default:       return `${who} ${a.type}`;
  }
}

export default function ReplaysModal({ token, onClose }: Props) {
  const { t } = useT();
  const [list,    setList]    = useState<ReplaySummary[] | null>(null);
  const [detail,  setDetail]  = useState<ReplayDetail | null>(null);
  const [busy,    setBusy]    = useState(false);
  const [err,     setErr]     = useState<string | null>(null);

  useEffect(() => {
    listMyReplaysApi(token)
      .then(d => setList(d.replays))
      .catch(e => setErr(e instanceof Error ? e.message : "failed"));
  }, [token]);

  async function open(gameId: string) {
    setBusy(true); setErr(null);
    try { setDetail(await getReplayApi(token, gameId)); }
    catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 px-4">
      <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl bg-green-900 p-5 shadow-2xl">
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-bold text-yellow-300">
            🎬 {detail ? `${ICON[detail.gameType]} ${t(LABEL_KEY[detail.gameType])}` : t("rep.title")}
          </h2>
          <div className="flex gap-1">
            {detail && (
              <button
                onClick={() => setDetail(null)}
                className="rounded-full bg-green-800 px-3 py-1 text-xs text-green-200 hover:bg-green-700"
              >{t("common.back")}</button>
            )}
            <button
              onClick={onClose}
              className="rounded-full bg-green-800 px-3 py-1 text-xs text-green-200 hover:bg-green-700"
            >{t("common.close")}</button>
          </div>
        </div>

        {err && <p className="mt-2 text-xs text-red-300">{err}</p>}

        <div className="mt-3 flex-1 overflow-y-auto">
          {!detail && (
            <>
              {!list && <p className="text-center text-xs text-green-500">{t("friends.loading")}</p>}
              {list && list.length === 0 && (
                <p className="text-center text-xs text-green-500">{t("rep.empty")}</p>
              )}
              {list && list.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {list.map(r => (
                    <li
                      key={r.gameId}
                      className="flex items-center justify-between gap-2 rounded-md bg-green-800/60 px-3 py-2"
                    >
                      <div className="flex flex-1 flex-col text-xs">
                        <span className="font-bold text-yellow-100">
                          {ICON[r.gameType]} {t(LABEL_KEY[r.gameType])}
                          {r.winnerId && <span className="ml-2 text-green-300">🏆 {r.winnerId}</span>}
                        </span>
                        <span className="text-[10px] text-green-400">{fmtTime(r.finishedAt)}</span>
                        {!r.replayable && (
                          <span className="text-[10px] text-amber-400">{t("rep.versionOld")}</span>
                        )}
                      </div>
                      <button
                        onClick={() => open(r.gameId)}
                        disabled={busy}
                        className="rounded bg-purple-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-purple-500 disabled:opacity-50"
                      >{t("rep.view")}</button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {detail && (
            <div className="flex flex-col gap-2 text-xs">
              <p className="text-green-300">
                {fmtTime(detail.startedAt)} · {detail.playerIds.join(" / ")}
              </p>
              {detail.winnerId && (
                <p className="text-yellow-200">🏆 {detail.winnerId} ({detail.reason ?? "?"})</p>
              )}
              {!detail.replayable && (
                <p className="rounded bg-amber-700/40 p-2 text-[11px] text-amber-200">
                  {t("rep.versionOldDetail", {
                    saved: detail.engineVersion, current: detail.currentVersion,
                  })}
                </p>
              )}
              {detail.replayable && (
                <ol className="flex flex-col gap-0.5 rounded bg-green-950/60 p-2 font-mono text-[10px] text-green-200">
                  {detail.events.length === 0 && (
                    <li className="italic text-green-500">{t("rep.noEvents")}</li>
                  )}
                  {detail.events.map((e, i) => (
                    <li key={i}>
                      <span className="text-green-500">{String(i + 1).padStart(3, "0")}</span>{" "}
                      {fmtEvent(e)}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
