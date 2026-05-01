import { useState } from "react";
import { GAME_TYPES } from "../shared/types";
import type { GameType } from "../shared/types";
import WalletBadge from "./WalletBadge";
import StatsModal  from "./StatsModal";
import TournamentModal from "./TournamentModal";
import LocaleToggle from "./LocaleToggle";
import MuteToggle from "./MuteToggle";
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
  onJoinedTournamentRoom?: (roomId: string, gameType: GameType) => void;
  onSpectate?: (roomId: string, gameType: GameType) => void;
  onLogout?:   () => void;
}

export default function GameSelectScreen({ playerId, token, dailyBonus, onPick, onJoinedTournamentRoom, onSpectate, onLogout }: Props) {
  const { t } = useT();
  const [stats,    setStats]    = useState(false);
  const [tour,     setTour]     = useState(false);
  const [specOpen, setSpecOpen] = useState(false);
  const [specRoom, setSpecRoom] = useState("");
  const [specType, setSpecType] = useState<GameType>("bigTwo");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-green-950 p-6">
      <div className="absolute left-4 top-4 flex items-center gap-2">
        <button
          onClick={() => setStats(true)}
          className="rounded-full bg-green-800 px-4 py-1.5 text-sm font-bold text-yellow-200 shadow-lg transition hover:bg-green-700 active:scale-95"
        >
          {t("select.stats")}
        </button>
        <button
          onClick={() => setTour(true)}
          className="rounded-full bg-green-800 px-4 py-1.5 text-sm font-bold text-yellow-200 shadow-lg transition hover:bg-green-700 active:scale-95"
        >
          🏆
        </button>
        {onSpectate && (
          <button
            onClick={() => setSpecOpen(true)}
            title={t("spec.title")}
            className="rounded-full bg-green-800 px-4 py-1.5 text-sm font-bold text-yellow-200 shadow-lg transition hover:bg-green-700 active:scale-95"
          >
            👁️
          </button>
        )}
        <LocaleToggle />
        <MuteToggle />
      </div>
      <div className="absolute right-4 top-4">
        <WalletBadge token={token} />
      </div>
      {stats && <StatsModal playerId={playerId} token={token} onClose={() => setStats(false)} />}
      {specOpen && onSpectate && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-green-900 p-5 shadow-2xl">
            <h2 className="text-center text-lg font-bold text-yellow-300">👁️ {t("spec.title")}</h2>
            <p className="mt-1 text-center text-xs text-green-400">{t("spec.enterRoomId")}</p>

            <div className="mt-4 flex flex-col gap-3">
              <select
                value={specType}
                onChange={e => setSpecType(e.target.value as GameType)}
                className="rounded-lg bg-green-800 px-3 py-2 text-sm text-yellow-100"
              >
                {GAME_TYPES.map(g => (
                  <option key={g} value={g}>{ICON[g]} {t(LABEL_KEY[g])}</option>
                ))}
              </select>
              <input
                type="text"
                value={specRoom}
                onChange={e => setSpecRoom(e.target.value.trim())}
                placeholder="room-id"
                className="rounded-lg bg-green-800 px-3 py-2 text-sm text-yellow-100 placeholder:text-green-500"
              />
            </div>

            <div className="mt-4 flex gap-2">
              <button
                onClick={() => { setSpecOpen(false); setSpecRoom(""); }}
                className="flex-1 rounded-lg bg-gray-700 py-2 text-sm font-bold text-gray-200"
              >{t("common.cancel")}</button>
              <button
                disabled={specRoom.length < 4}
                onClick={() => {
                  const id = specRoom;
                  setSpecOpen(false); setSpecRoom("");
                  onSpectate(id, specType);
                }}
                className="flex-1 rounded-lg bg-purple-600 py-2 text-sm font-bold text-white disabled:bg-gray-700 disabled:text-gray-500"
              >{t("spec.start")}</button>
            </div>
          </div>
        </div>
      )}
      {tour && (
        <TournamentModal
          playerId={playerId}
          token={token}
          onClose={() => setTour(false)}
          onJoinedRoom={(roomId, gt) => {
            setTour(false);
            onJoinedTournamentRoom?.(roomId, gt);
          }}
        />
      )}

      <div className="text-center">
        <h1 className="text-2xl font-bold text-yellow-300">{t("select.title")}</h1>
        <div className="mt-1 flex items-center justify-center gap-2 text-sm text-green-300">
          <span>{playerId}</span>
          {onLogout && (
            <button
              onClick={onLogout}
              className="rounded-full bg-green-800/80 px-2 py-0.5 text-[10px] text-green-300 hover:bg-red-700 hover:text-red-100"
            >{t("common.logout")}</button>
          )}
        </div>
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
