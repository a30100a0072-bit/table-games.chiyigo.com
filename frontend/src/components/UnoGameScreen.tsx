import { useEffect, useRef, useState } from "react";
import type {
  PlayerAction, SettlementResult, UnoCard, UnoColor, UnoStateView,
} from "../shared/types";
import { GameSocket } from "../shared/GameSocket";
import { useT } from "../i18n/useT";
import { sfx } from "../shared/sound";
import RotateHint from "./RotateHint";

interface Props {
  playerId:   string;
  token:      string;
  roomId:     string;
  wsUrl:      string;
  spectator?: boolean;
  onSettled:  (result: SettlementResult) => void;
}

// ─── color/label helpers ────────────────────────────────────────────────────
const COLOR_BG: Record<UnoColor, string> = {
  red:    "bg-red-500",
  yellow: "bg-yellow-400",
  green:  "bg-green-500",
  blue:   "bg-blue-500",
};
const COLOR_RING: Record<UnoColor, string> = {
  red:    "ring-red-300",
  yellow: "ring-yellow-200",
  green:  "ring-green-300",
  blue:   "ring-blue-300",
};
const COLOR_LABEL: Record<UnoColor, string> = {
  red: "🔴", yellow: "🟡", green: "🟢", blue: "🔵",
};

function valueLabel(v: UnoCard["value"]): string {
  if (typeof v === "number") return String(v);
  if (v === "skip")        return "🚫";
  if (v === "reverse")     return "🔄";
  if (v === "draw2")       return "+2";
  if (v === "wild")        return "★";
  return "+4";
}

function cardKey(c: UnoCard, idx: number): string {
  return `${c.color ?? "wild"}-${c.value}-${idx}`;
}

// ─── PlayingCard (CSS-only) ─────────────────────────────────────────────────
function UnoCardFace({ card, size = "md", selected, dimmed, onClick }: {
  card: UnoCard;
  size?: "sm" | "md";
  selected?: boolean;
  dimmed?: boolean;
  onClick?: () => void;
}) {
  const isWild = card.value === "wild" || card.value === "wild_draw4";
  const bg = card.color
    ? COLOR_BG[card.color]
    : "bg-gradient-to-br from-red-500 via-yellow-400 to-blue-500";
  const dims = size === "sm"
    ? "h-14 w-10 rounded-md"
    : "h-24 w-16 rounded-lg";
  const fs = size === "sm" ? "text-sm" : "text-3xl";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={[
        "relative flex flex-shrink-0 items-center justify-center border-2 border-white text-white font-bold shadow-md select-none",
        "transition-transform duration-150 active:scale-95",
        dims, bg, fs,
        selected ? "-translate-y-5 ring-4 ring-yellow-300" : "",
        dimmed   ? "opacity-40" : "",
        isWild ? "italic" : "",
      ].join(" ")}
    >
      {valueLabel(card.value)}
    </button>
  );
}

function CardBack({ small }: { small?: boolean }) {
  return (
    <div className={[
      small ? "h-10 w-7 rounded-md" : "h-16 w-11 rounded-lg",
      "bg-gradient-to-br from-red-700 to-blue-800 border-2 border-white shadow",
    ].join(" ")} />
  );
}

// ─── opponent seat (count + face-down stack) ────────────────────────────────
function OpponentSeat({ op, isTurn }: {
  op: UnoStateView["opponents"][number];
  isTurn: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={[
        "rounded-full px-3 py-1 text-xs font-bold",
        isTurn ? "bg-yellow-400 text-green-950 ring-2 ring-yellow-200" : "bg-green-800 text-green-200",
      ].join(" ")}>
        {op.playerId} · {op.cardCount}
      </div>
      <div className="flex flex-row [&>*+*]:-ml-4">
        {Array.from({ length: Math.min(op.cardCount, 8) }).map((_, i) => (
          <CardBack key={i} small />
        ))}
      </div>
    </div>
  );
}

// ─── color picker modal (for Wild / WildDraw4) ──────────────────────────────
function ColorPicker({ onPick, onCancel }: {
  onPick: (c: UnoColor) => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 px-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-xs rounded-2xl bg-green-900 p-5 shadow-2xl">
        <h2 className="text-center text-base font-bold text-yellow-300">Pick a color</h2>
        <div className="mt-4 grid grid-cols-2 gap-3">
          {(["red", "yellow", "green", "blue"] as const).map(c => (
            <button
              key={c}
              onClick={() => onPick(c)}
              className={[
                "h-16 rounded-lg text-2xl font-bold text-white shadow-md ring-2",
                COLOR_BG[c], COLOR_RING[c],
              ].join(" ")}
            >{COLOR_LABEL[c]}</button>
          ))}
        </div>
        <button
          onClick={onCancel}
          className="mt-3 w-full rounded-md bg-gray-700 py-2 text-xs font-bold text-gray-200"
        >Cancel</button>
      </div>
    </div>
  );
}

// ─── main screen ────────────────────────────────────────────────────────────
export default function UnoGameScreen({ playerId, token, roomId, wsUrl, spectator, onSettled }: Props) {
  const { t } = useT();
  const [view,    setView]    = useState<UnoStateView | null>(null);
  const [connMsg, setConnMsg] = useState(t("ws.connecting"));
  const [sysMsg,  setSysMsg]  = useState("");
  const [timeLeft, setTimeLeft] = useState(0);
  const [pickingColorFor, setPickingColorFor] = useState<UnoCard | null>(null);
  const socketRef = useRef<GameSocket | null>(null);
  const watching = !!spectator;

  useEffect(() => {
    const sock = new GameSocket({ url: wsUrl, playerId, gameId: roomId, token, spectator: watching });
    socketRef.current = sock;
    sock.on("connected",    ()     => setConnMsg(""));
    sock.on("disconnected", (info) => setConnMsg(info.willReconnect ? t("ws.reconnecting", { attempt: info.attempt + 1 }) : t("ws.disconnected")));
    sock.on("state",        (v)    => {
      const wasMyTurn = view?.currentTurn === playerId;
      const nowMyTurn = (v as unknown as UnoStateView).currentTurn === playerId;
      if (!wasMyTurn && nowMyTurn) sfx.myTurn();
      setView(v as unknown as UnoStateView);
    });
    sock.on("settlement",   (r) => {
      const me = r.players.find(p => p.playerId === playerId);
      if (me) (me.finalRank === 1 ? sfx.win : sfx.lose)();
      onSettled(r);
    });
    sock.on("system", (m) => setSysMsg(m));
    sock.on("error",  (m) => setSysMsg(m));
    sock.connect();
    return () => sock.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl, playerId, roomId, token, onSettled]);

  useEffect(() => {
    if (!view) return;
    const tick = () => setTimeLeft(Math.max(0, Math.round((view.turnDeadlineMs - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [view?.turnDeadlineMs]);

  if (!view) {
    return (
      <div className="flex h-full items-center justify-center bg-green-950">
        <p className="text-green-300">{connMsg || t("ws.waitingGame")}</p>
      </div>
    );
  }

  const isMyTurn = view.currentTurn === playerId && !watching;
  const top = view.topDiscard.card;
  const topColor = view.currentColor;

  function send(action: PlayerAction) {
    try { socketRef.current?.send(action); }
    catch { /* ignore wrong-state */ }
  }

  function tryPlay(c: UnoCard) {
    if (!isMyTurn) return;
    if (c.value === "wild" || c.value === "wild_draw4") {
      setPickingColorFor(c);
      return;
    }
    send({ type: "uno_play", card: c });
    sfx.cardPlay();
  }

  function confirmWildColor(color: UnoColor) {
    if (!pickingColorFor) return;
    send({ type: "uno_play", card: pickingColorFor, declaredColor: color });
    sfx.cardPlay();
    setPickingColorFor(null);
  }

  return (
    <>
      <RotateHint />
      <div className="fixed inset-0 flex flex-col bg-green-950 text-white">
        {/* ── opponents row ── */}
        <div className="flex items-start justify-around p-3">
          {view.opponents.map(op => (
            <OpponentSeat key={op.playerId} op={op} isTurn={view.currentTurn === op.playerId} />
          ))}
        </div>

        {/* ── center: discard pile + draw pile + direction ── */}
        <div className="flex flex-1 items-center justify-center gap-6 px-4">
          <div className="flex flex-col items-center gap-1">
            <span className="text-xs text-green-400">{t("uno.draw")}</span>
            <button
              type="button"
              disabled={!isMyTurn || view.hasDrawn}
              onClick={() => { send({ type: "uno_draw" }); }}
              className="relative h-24 w-16 rounded-lg bg-gradient-to-br from-red-700 to-blue-800 border-2 border-white shadow disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-yellow-200">
                {view.drawPileCount}
              </span>
            </button>
          </div>

          <div className="flex flex-col items-center gap-1">
            <span className={[
              "rounded-full px-3 py-0.5 text-xs font-bold uppercase tracking-widest text-white",
              COLOR_BG[topColor],
            ].join(" ")}>
              {COLOR_LABEL[topColor]} {topColor}
            </span>
            <UnoCardFace card={top} />
            <span className="text-[10px] text-green-400">
              {view.direction === 1 ? "→" : "←"} · {view.opponents.length + 1} {t("uno.players")}
            </span>
          </div>
        </div>

        {/* ── status / countdown / sys msg ── */}
        <div className="flex items-center justify-between px-4 pb-1 text-xs">
          <span className="text-green-300">
            {isMyTurn ? t("uno.yourTurn") : `${view.currentTurn} · ${t("uno.thinking")}`}
          </span>
          <span className={timeLeft <= 5 ? "text-red-400 font-bold" : "text-green-400"}>
            ⏱ {timeLeft}s
          </span>
        </div>
        {(sysMsg || connMsg) && (
          <p className="px-4 pb-1 text-center text-[11px] text-yellow-300">{sysMsg || connMsg}</p>
        )}

        {/* ── my hand ── */}
        <div className="overflow-x-auto bg-green-900/60 px-3 pb-4 pt-3">
          <div className="flex justify-center gap-1 [&>*+*]:-ml-3">
            {view.self.hand.map((c, i) => {
              const legal =
                c.value === "wild" || c.value === "wild_draw4" ||
                c.color === topColor || c.value === top.value;
              return (
                <UnoCardFace
                  key={cardKey(c, i)}
                  card={c}
                  dimmed={!legal}
                  onClick={isMyTurn ? () => tryPlay(c) : undefined}
                />
              );
            })}
          </div>

          <div className="mt-3 flex justify-center gap-2">
            <button
              disabled={!isMyTurn || view.hasDrawn}
              onClick={() => { send({ type: "uno_draw" }); }}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >{t("uno.drawBtn")}</button>
            <button
              disabled={!isMyTurn || !view.hasDrawn}
              onClick={() => { send({ type: "uno_pass" }); }}
              className="rounded-lg bg-gray-600 px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >{t("uno.pass")}</button>
          </div>
        </div>
      </div>

      {pickingColorFor && (
        <ColorPicker
          onPick={confirmWildColor}
          onCancel={() => setPickingColorFor(null)}
        />
      )}
    </>
  );
}
