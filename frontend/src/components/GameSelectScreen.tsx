import { GAME_TYPES, GAME_LABEL } from "../shared/types";
import type { GameType } from "../shared/types";

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

interface Props {
  playerId: string;
  onPick: (gameType: GameType) => void;
}

export default function GameSelectScreen({ playerId, onPick }: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-green-950 p-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-yellow-300">選擇遊戲</h1>
        <p className="mt-1 text-sm text-green-300">{playerId}</p>
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
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
