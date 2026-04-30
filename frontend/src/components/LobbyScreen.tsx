import { useEffect, useRef, useState } from "react";
import { findMatch } from "../api/http";
import type { GameType } from "../shared/types";
import WalletBadge from "./WalletBadge";
import { useT } from "../i18n/useT";

const GAME_KEY: Record<GameType, "select.bigTwo" | "select.mahjong" | "select.texas"> = {
  bigTwo: "select.bigTwo", mahjong: "select.mahjong", texas: "select.texas",
};

interface Props {
  playerId: string;
  token:    string;
  gameType: GameType;
  onMatched: (roomId: string, wsUrl: string, players: string[], gameType: GameType) => void;
  onBack:    () => void;
}

export default function LobbyScreen({ playerId, token, gameType, onMatched, onBack }: Props) {
  const { t } = useT();
  const [dots,  setDots]  = useState(".");
  const [error, setError] = useState("");
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;
    findMatch(token, gameType)
      .then(({ roomId, wsUrl, players, gameType: gt }) => onMatched(roomId, wsUrl, players, gt))
      .catch(err => setError(err instanceof Error ? err.message : t("login.fail")));
  }, [token, gameType, onMatched, t]);

  useEffect(() => {
    const id = setInterval(() => setDots(d => d.length >= 3 ? "." : d + "."), 500);
    return () => clearInterval(id);
  }, []);

  if (error)
    return (
      <div className="flex h-full items-center justify-center bg-green-950">
        <div className="rounded-2xl bg-green-900 p-8 text-center shadow-xl">
          <p className="mb-4 text-red-400">{error}</p>
          <div className="flex gap-3">
            <button
              className="rounded-lg bg-green-700 px-4 py-2 font-bold text-green-100"
              onClick={onBack}
            >
              {t("common.back")}
            </button>
            <button
              className="rounded-lg bg-yellow-400 px-6 py-2 font-bold text-green-950"
              onClick={() => { called.current = false; setError(""); }}
            >
              {t("common.retry")}
            </button>
          </div>
        </div>
      </div>
    );

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-green-950">
      <div className="absolute right-4 top-4">
        <WalletBadge token={token} />
      </div>
      <div className="text-6xl">{gameType === "mahjong" ? "🀄" : gameType === "texas" ? "♠️" : "🃏"}</div>
      <p className="text-xl font-bold text-yellow-300">{t("lobby.matching")}{dots}</p>
      <p className="text-sm text-green-300">{t(GAME_KEY[gameType])}</p>
      <p className="text-xs text-green-500">{playerId}</p>
      <button
        onClick={onBack}
        className="mt-4 rounded-lg bg-green-800 px-4 py-2 text-sm font-bold text-green-200 hover:bg-green-700"
      >
        {t("lobby.cancel")}
      </button>
    </div>
  );
}
