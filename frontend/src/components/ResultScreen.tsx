import type { SettlementResult } from "../shared/types";

const RANK_LABEL = ["", "🥇 第一", "🥈 第二", "🥉 第三", "第四"];

interface Props {
  playerId:   string;
  settlement: SettlementResult;
  onPlayAgain: () => void;
}

export default function ResultScreen({ playerId, settlement, onPlayAgain }: Props) {
  const sorted = [...settlement.players].sort((a, b) => a.finalRank - b.finalRank);
  const me = settlement.players.find(p => p.playerId === playerId);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-green-950 text-white">
      <h2 className="text-2xl font-bold text-yellow-300">
        {settlement.winnerId === playerId ? "你贏了！🎉" : "遊戲結束"}
      </h2>

      {me && (
        <p className="text-lg text-green-200">
          {RANK_LABEL[me.finalRank] ?? `第${me.finalRank}名`}
          <span className={me.scoreDelta >= 0 ? "ml-3 text-green-400" : "ml-3 text-red-400"}>
            {me.scoreDelta >= 0 ? "+" : ""}{me.scoreDelta} 分
          </span>
        </p>
      )}

      <div className="w-72 rounded-2xl bg-green-900 p-4 shadow-xl">
        {sorted.map(p => (
          <div key={p.playerId} className="flex items-center justify-between py-2 border-b border-green-800 last:border-0">
            <span className="font-bold">{RANK_LABEL[p.finalRank] ?? p.finalRank}</span>
            <span className={p.playerId === playerId ? "text-yellow-300 font-bold" : "text-green-200"}>
              {p.playerId}
            </span>
            <span className={p.scoreDelta >= 0 ? "text-green-400" : "text-red-400"}>
              {p.scoreDelta >= 0 ? "+" : ""}{p.scoreDelta}
            </span>
          </div>
        ))}
      </div>

      <button
        onClick={onPlayAgain}
        className="rounded-xl bg-yellow-400 px-8 py-3 font-bold text-green-950 hover:bg-yellow-300 transition"
      >
        再來一局
      </button>
    </div>
  );
}
