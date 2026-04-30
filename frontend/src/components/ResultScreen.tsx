import type { SettlementResult } from "../shared/types";
import { useT } from "../i18n/useT";
import type { DictKey } from "../i18n/dict";

const RANK_KEY: DictKey[] = [
  "result.firstPlace", "result.firstPlace", "result.secondPlace", "result.thirdPlace", "result.fourthPlace",
];

interface Props {
  playerId:   string;
  settlement: SettlementResult;
  onPlayAgain: () => void;
}

export default function ResultScreen({ playerId, settlement, onPlayAgain }: Props) {
  const { t } = useT();
  const sorted = [...settlement.players].sort((a, b) => a.finalRank - b.finalRank);
  const me = settlement.players.find(p => p.playerId === playerId);
  const rankLabel = (r: number) => t(RANK_KEY[r] ?? "result.fourthPlace");

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-green-950 text-white">
      <h2 className="text-2xl font-bold text-yellow-300">
        {settlement.winnerId === playerId ? t("result.win") : t("result.end")}
      </h2>

      {me && (
        <p className="text-lg text-green-200">
          {rankLabel(me.finalRank)}
          <span className={me.scoreDelta >= 0 ? "ml-3 text-green-400" : "ml-3 text-red-400"}>
            {t("result.delta", { n: `${me.scoreDelta >= 0 ? "+" : ""}${me.scoreDelta}` })}
          </span>
        </p>
      )}

      <div className="w-72 rounded-2xl bg-green-900 p-4 shadow-xl">
        {sorted.map(p => (
          <div key={p.playerId} className="flex items-center justify-between py-2 border-b border-green-800 last:border-0">
            <span className="font-bold">{rankLabel(p.finalRank)}</span>
            <span className={p.playerId === playerId ? "text-yellow-300 font-bold" : "text-green-200"}>
              {p.playerId}
            </span>
            <span className={p.scoreDelta >= 0 ? "text-green-400" : "text-red-400"}>
              {p.scoreDelta >= 0 ? "+" : ""}{p.scoreDelta}
            </span>
          </div>
        ))}
      </div>

      {/* 麻將台數明細 — 只有麻將會帶 fanDetail，其他遊戲為 undefined */}
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

      <button
        onClick={onPlayAgain}
        className="rounded-xl bg-yellow-400 px-8 py-3 font-bold text-green-950 hover:bg-yellow-300 transition"
      >
        {t("result.again")}
      </button>
    </div>
  );
}
