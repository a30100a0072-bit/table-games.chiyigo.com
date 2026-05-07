import { useEffect, useRef, useState } from "react";
import { formatApiError } from "../api/http";
import { findMatch } from "../api/http";
import type { GameType } from "../shared/types";
import WalletBadge from "./WalletBadge";
import { useT } from "../i18n/useT";

const GAME_KEY: Record<GameType, "select.bigTwo" | "select.mahjong" | "select.texas" | "select.uno" | "select.yahtzee"> = {
  bigTwo: "select.bigTwo", mahjong: "select.mahjong", texas: "select.texas",
  uno: "select.uno", yahtzee: "select.yahtzee",
};

const GAME_ICON: Record<GameType, string> = {
  bigTwo: "🃏", mahjong: "🀄", texas: "♠️", uno: "🎴", yahtzee: "🎲",
};

const ROOM_SIZE = 4;
const ETA_SECONDS = 8;
// Theatrical slot-fill schedule (ms after mount). Real matchmaking is a long
// poll on the backend lobby DO that resolves with the room snapshot once full
// (or filled by bots after BOT_FILL_MS); we don't see incremental progress, so
// the slots animate against a wall clock to give the wait a shape.
const SLOT_FILL_MS = [1800, 3600, 5400];

interface Props {
  playerId: string;
  token:    string;
  gameType: GameType;
  /** Mahjong-only — 連莊 N 局；undefined / 1 = 單局制。 */
  mahjongHands?: number;
  onMatched: (roomId: string, wsUrl: string, players: string[], gameType: GameType) => void;
  onBack:    () => void;
}

export default function LobbyScreen({ playerId, token, gameType, mahjongHands, onMatched, onBack }: Props) {
  const { t } = useT();
  const [error, setError]       = useState("");
  const [filled, setFilled]     = useState(1);
  const [eta, setEta]           = useState(ETA_SECONDS);
  const [retryKey, setRetryKey] = useState(0);
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;
    findMatch(token, gameType, mahjongHands)
      .then(({ roomId, wsUrl, players, gameType: gt }) => onMatched(roomId, wsUrl, players, gt))
      .catch(err => setError(formatApiError(err, t)));
  }, [token, gameType, mahjongHands, onMatched, t, retryKey]);

  useEffect(() => {
    setFilled(1);
    setEta(ETA_SECONDS);
    const timeouts = SLOT_FILL_MS.map((ms, i) =>
      window.setTimeout(() => setFilled(c => Math.max(c, 2 + i)), ms),
    );
    const tick = window.setInterval(() => setEta(s => (s > 0 ? s - 1 : 0)), 1000);
    return () => { timeouts.forEach(window.clearTimeout); window.clearInterval(tick); };
  }, [retryKey]);

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
              onClick={() => { called.current = false; setError(""); setRetryKey(k => k + 1); }}
            >
              {t("common.retry")}
            </button>
          </div>
        </div>
      </div>
    );

  const initial = (playerId.replace(/^oidc:/, "") || "?").slice(0, 1).toUpperCase();
  const name    = playerId.replace(/^oidc:/, "");

  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-6 bg-green-950 px-4">
      <div className="absolute right-4 top-4">
        <WalletBadge token={token} />
      </div>

      <div className="flex flex-col items-center gap-1">
        <div className="text-5xl">{GAME_ICON[gameType]}</div>
        <p className="text-xs text-green-400">{t(GAME_KEY[gameType])}</p>
      </div>

      <p className="text-xl font-bold text-yellow-300">
        {t("lobby.findingTable", { n: filled, m: ROOM_SIZE })}
      </p>

      <div className="flex items-center gap-3">
        {Array.from({ length: ROOM_SIZE }).map((_, idx) => {
          const isFilled = idx < filled;
          const isSelf   = idx === 0;
          const cls = isFilled
            ? (isSelf
                ? "border-yellow-300 bg-yellow-400 text-green-950"
                : "border-green-400 bg-green-700 text-green-100 animate-pulse")
            : "border-dashed border-green-700 bg-green-900/40 text-green-700";
          return (
            <div
              key={idx}
              className={`flex h-16 w-16 items-center justify-center rounded-full border-2 text-lg font-bold transition ${cls}`}
              aria-label={isFilled ? (isSelf ? name : t("lobby.slot.filled")) : t("lobby.slot.waiting")}
            >
              {isFilled ? (isSelf ? initial : "?") : "·"}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-green-400">
        {eta > 0 ? t("lobby.eta", { n: eta }) : t("lobby.botSoon")}
      </p>

      <div className="mt-2 flex gap-3">
        <button
          onClick={() => { called.current = false; setRetryKey(k => k + 1); }}
          className="rounded-lg bg-green-800 px-4 py-2 text-sm font-bold text-green-200 hover:bg-green-700"
        >
          {t("lobby.swapTable")}
        </button>
        <button
          onClick={onBack}
          className="rounded-lg bg-green-800 px-4 py-2 text-sm font-bold text-green-200 hover:bg-green-700"
        >
          {t("lobby.privateRoom")}
        </button>
        <button
          onClick={onBack}
          className="rounded-lg bg-green-900 px-4 py-2 text-sm font-bold text-green-300 hover:bg-green-800"
        >
          {t("lobby.cancel")}
        </button>
      </div>

      <p className="absolute bottom-4 text-[10px] text-green-700">{name}</p>
    </div>
  );
}
