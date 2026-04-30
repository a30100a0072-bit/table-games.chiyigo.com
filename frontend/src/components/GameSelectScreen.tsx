import { useState } from "react";
import { GAME_TYPES, GAME_LABEL } from "../shared/types";
import type { GameType } from "../shared/types";
import WalletBadge from "./WalletBadge";
import StatsModal  from "./StatsModal";

const ICON: Record<GameType, string> = {
  bigTwo:  "🃏",
  mahjong: "🀄",
  texas:   "♠️",
};

const TAGLINE: Record<GameType, string> = {
  bigTwo:  "四人鬥地主經典 · 含 Bot 補位",
  mahjong: "16 張台式 · 吃碰槓胡",
  texas:   "無限注德撲 · 邊池結算",
};

const ANTE: Record<GameType, number> = {
  bigTwo:  100,
  mahjong: 100,
  texas:   200,
};

interface Props {
  playerId:    string;
  token:       string;
  dailyBonus?: number | null;
  onPick:      (gameType: GameType) => void;
}

export default function GameSelectScreen({ playerId, token, dailyBonus, onPick }: Props) {
  const [stats, setStats] = useState(false);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-green-950 p-6">
      <div className="absolute left-4 top-4">
        <button
          onClick={() => setStats(true)}
          className="rounded-full bg-green-800 px-4 py-1.5 text-sm font-bold text-yellow-200 shadow-lg transition hover:bg-green-700 active:scale-95"
        >
          📊 統計
        </button>
      </div>
      <div className="absolute right-4 top-4">
        <WalletBadge token={token} />
      </div>
      {stats && <StatsModal playerId={playerId} token={token} onClose={() => setStats(false)} />}

      <div className="text-center">
        <h1 className="text-2xl font-bold text-yellow-300">選擇遊戲</h1>
        <p className="mt-1 text-sm text-green-300">{playerId}</p>
        {dailyBonus !== null && dailyBonus !== undefined && dailyBonus > 0 && (
          <p className="mt-3 inline-block rounded-full bg-yellow-700/40 px-4 py-1 text-sm text-yellow-200 ring-1 ring-yellow-500/40">
            🎁 每日登入獎勵 +{dailyBonus} 籌碼
          </p>
        )}
      </div>

      <div className="flex w-full max-w-md flex-col gap-3">
        {GAME_TYPES.map(g => (
          <button
            key={g}
            onClick={() => onPick(g)}
            className="flex items-center gap-4 rounded-2xl bg-green-900 p-4 text-left shadow-lg transition hover:bg-green-800 active:scale-[0.98]"
          >
            <span className="text-4xl">{ICON[g]}</span>
            <span className="flex flex-col">
              <span className="text-lg font-bold text-yellow-300">{GAME_LABEL[g]}</span>
              <span className="text-xs text-green-400">{TAGLINE[g]}</span>
              <span className="mt-0.5 text-[10px] text-yellow-500/80">最低 {ANTE[g]} 籌碼</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
