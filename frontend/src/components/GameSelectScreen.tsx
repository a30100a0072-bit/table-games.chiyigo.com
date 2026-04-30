import { useState } from "react";
import { GAME_TYPES } from "../shared/types";
import type { GameType } from "../shared/types";
import WalletBadge from "./WalletBadge";
import StatsModal  from "./StatsModal";
import LocaleToggle from "./LocaleToggle";
import { useT } from "../i18n/useT";

const ICON: Record<GameType, string> = {
  bigTwo:  "🃏",
  mahjong: "🀄",
  texas:   "♠️",
};

const LABEL_KEY: Record<GameType, "select.bigTwo" | "select.mahjong" | "select.texas"> = {
  bigTwo:  "select.bigTwo",
  mahjong: "select.mahjong",
  texas:   "select.texas",
};
const TAG_KEY: Record<GameType, "select.tag.bigTwo" | "select.tag.mahjong" | "select.tag.texas"> = {
  bigTwo:  "select.tag.bigTwo",
  mahjong: "select.tag.mahjong",
  texas:   "select.tag.texas",
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
  const { t } = useT();
  const [stats, setStats] = useState(false);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-green-950 p-6">
      <div className="absolute left-4 top-4 flex items-center gap-2">
        <button
          onClick={() => setStats(true)}
          className="rounded-full bg-green-800 px-4 py-1.5 text-sm font-bold text-yellow-200 shadow-lg transition hover:bg-green-700 active:scale-95"
        >
          {t("select.stats")}
        </button>
        <LocaleToggle />
      </div>
      <div className="absolute right-4 top-4">
        <WalletBadge token={token} />
      </div>
      {stats && <StatsModal playerId={playerId} token={token} onClose={() => setStats(false)} />}

      <div className="text-center">
        <h1 className="text-2xl font-bold text-yellow-300">{t("select.title")}</h1>
        <p className="mt-1 text-sm text-green-300">{playerId}</p>
        {dailyBonus !== null && dailyBonus !== undefined && dailyBonus > 0 && (
          <p className="mt-3 inline-block rounded-full bg-yellow-700/40 px-4 py-1 text-sm text-yellow-200 ring-1 ring-yellow-500/40">
            {t("select.dailyBonus", { n: dailyBonus })}
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
              <span className="text-lg font-bold text-yellow-300">{t(LABEL_KEY[g])}</span>
              <span className="text-xs text-green-400">{t(TAG_KEY[g])}</span>
              <span className="mt-0.5 text-[10px] text-yellow-500/80">{t("select.minAnte", { n: ANTE[g] })}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
