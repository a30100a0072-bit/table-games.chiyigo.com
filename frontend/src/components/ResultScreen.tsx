import { useEffect, useState } from "react";
import type { SettlementResult } from "../shared/types";
import { useT } from "../i18n/useT";
import type { DictKey } from "../i18n/dict";
import { shareReplayApi, formatApiError } from "../api/http";
import { Share2 } from "./Icons";

const RANK_KEY: DictKey[] = [
  "result.firstPlace", "result.firstPlace", "result.secondPlace", "result.thirdPlace", "result.fourthPlace",
];
const RANK_BADGE = ["", "🥇", "🥈", "🥉", "4️⃣"];
const RANK_RING  = ["", "ring-yellow-300", "ring-stone-300", "ring-amber-600", "ring-green-600"];

function stripOidc(id: string): string { return id.replace(/^oidc:/, ""); }

function useCountUp(target: number, durationMs = 1100): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (target === 0) { setV(0); return; }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - p) * (1 - p);
      setV(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return v;
}

interface Props {
  playerId:    string;
  token:       string;
  settlement:  SettlementResult;
  onPlayAgain: () => void;
}

export default function ResultScreen({ playerId, token, settlement, onPlayAgain }: Props) {
  const { t } = useT();
  const sorted = [...settlement.players].sort((a, b) => a.finalRank - b.finalRank);
  const me = settlement.players.find(p => p.playerId === playerId);
  const rankLabel = (r: number) => t(RANK_KEY[r] ?? "result.fourthPlace");
  const isWinner = settlement.winnerId === playerId;

  const animatedDelta = useCountUp(me ? Math.abs(me.scoreDelta) : 0);
  const sign = me && me.scoreDelta < 0 ? "-" : "+";

  const [shareState, setShareState] = useState<"idle" | "loading" | "ok" | "err">("idle");
  const [shareMsg,   setShareMsg]   = useState<string>("");

  async function onShareReplay() {
    if (shareState === "loading") return;
    setShareState("loading");
    setShareMsg("");
    try {
      const r = await shareReplayApi(token, settlement.gameId);
      const url = `${window.location.origin}${window.location.pathname}?replay=${encodeURIComponent(r.token)}`;
      try {
        await navigator.clipboard.writeText(url);
        setShareState("ok");
        setShareMsg(t("rep.shareCopied", { preview: url.slice(0, 56) }));
      } catch {
        setShareState("ok");
        setShareMsg(url);
      }
    } catch (e) {
      setShareState("err");
      setShareMsg(formatApiError(e, t));
    }
  }

  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-5 bg-green-950 px-4 text-white">
      {isWinner && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden motion-reduce:hidden" aria-hidden="true">
          <span className="absolute left-[12%] top-[14%] animate-bounce text-3xl">🎉</span>
          <span className="absolute right-[14%] top-[10%] animate-bounce text-3xl delay-150">✨</span>
          <span className="absolute left-[18%] bottom-[20%] animate-bounce text-2xl delay-300">🎊</span>
          <span className="absolute right-[20%] bottom-[24%] animate-bounce text-2xl delay-500">⭐</span>
          <span className="absolute left-1/2 top-[6%] -translate-x-1/2 animate-pulse text-4xl">🏆</span>
        </div>
      )}

      <h2 className={`text-2xl font-bold text-yellow-300 ${isWinner ? "animate-pulse" : ""}`}>
        {isWinner ? t("result.win") : t("result.end")}
      </h2>

      {me && (
        <div className="flex flex-col items-center gap-2">
          <div className={`text-6xl drop-shadow-lg ${isWinner ? "animate-bounce" : ""}`}>
            {RANK_BADGE[me.finalRank] ?? "🎴"}
          </div>
          <p className="text-lg text-green-100">{rankLabel(me.finalRank)}</p>
          <p className={`font-mono text-3xl font-bold ${me.scoreDelta >= 0 ? "text-green-300" : "text-red-400"}`}>
            🪙 {sign}{animatedDelta}
          </p>
        </div>
      )}

      <div className="w-72 rounded-2xl bg-green-900 p-3 shadow-xl">
        {sorted.map(p => (
          <div
            key={p.playerId}
            className={[
              "flex items-center justify-between gap-2 rounded-lg px-2 py-1.5",
              p.playerId === playerId ? "bg-green-800/60 ring-1 ring-yellow-400/50" : "",
            ].join(" ")}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className={`flex h-8 w-8 items-center justify-center rounded-full bg-green-950 text-base ring-2 ${RANK_RING[p.finalRank] ?? "ring-green-700"}`}>
                {RANK_BADGE[p.finalRank] ?? p.finalRank}
              </span>
              <span className={`truncate text-sm ${p.playerId === playerId ? "font-bold text-yellow-300" : "text-green-100"}`}>
                {stripOidc(p.playerId)}
              </span>
            </div>
            <span className={`shrink-0 font-mono text-sm ${p.scoreDelta >= 0 ? "text-green-300" : "text-red-400"}`}>
              {p.scoreDelta >= 0 ? "+" : ""}{p.scoreDelta}
            </span>
          </div>
        ))}
      </div>

      {settlement.matchProgress && settlement.matchProgress.targetHands > 1 && settlement.matchProgress.cumulativeScores && (
        <div className="w-72 rounded-2xl border border-amber-700/40 bg-amber-900/30 p-3 text-sm shadow-inner">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-bold text-amber-200">
              {t("result.matchSummary", { n: settlement.matchProgress.handNumber, m: settlement.matchProgress.targetHands })}
            </span>
          </div>
          {[...Object.entries(settlement.matchProgress.cumulativeScores)]
            .sort(([, a], [, b]) => b - a)
            .map(([pid, total]) => (
              <div key={pid} className="flex items-center justify-between py-1 text-[12px]">
                <span className={pid === playerId ? "font-bold text-yellow-300" : "text-amber-100"}>{stripOidc(pid)}</span>
                <span className={total >= 0 ? "font-mono text-green-300" : "font-mono text-red-300"}>
                  {total >= 0 ? "+" : ""}{total}
                </span>
              </div>
            ))}
        </div>
      )}

      {settlement.fanDetail && (
        <div className="w-72 rounded-2xl border border-yellow-700/40 bg-green-900/50 p-3 text-sm shadow-inner">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-bold text-yellow-300">{t("result.fanDetail")}</span>
            <span className="text-yellow-200">{t("result.fanLine", { base: settlement.fanDetail.base, fan: settlement.fanDetail.fan })}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {settlement.fanDetail.detail.map((d, i) => (
              <span key={i} className="rounded-full bg-yellow-700/30 px-2 py-0.5 text-[11px] text-yellow-100">
                {d}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={onPlayAgain}
          className="tap44 rounded-xl bg-yellow-400 px-7 py-3 font-bold text-green-950 transition hover:bg-yellow-300"
        >
          {t("result.again")}
        </button>
        <button
          onClick={onShareReplay}
          disabled={shareState === "loading"}
          className="tap44 inline-flex items-center gap-2 rounded-xl bg-green-800 px-5 py-3 font-bold text-green-100 transition hover:bg-green-700 disabled:opacity-50"
          title={t("result.shareReplay")}
        >
          <Share2 size={16} />
          {shareState === "loading" ? t("common.loading") : t("result.shareReplay")}
        </button>
      </div>

      {shareMsg && (
        <p className={`max-w-xs break-all text-center text-[11px] ${shareState === "err" ? "text-red-400" : "text-green-300"}`}>
          {shareMsg}
        </p>
      )}
    </div>
  );
}
