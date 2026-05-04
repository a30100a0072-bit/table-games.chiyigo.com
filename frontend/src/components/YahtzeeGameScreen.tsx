import { useEffect, useRef, useState } from "react";
import type {
  PlayerAction, SettlementResult,
  YahtzeeStateView, YahtzeeSlot, DieFace, HeldTuple,
} from "../shared/types";
import { YAHTZEE_SLOTS } from "../shared/types";
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

const DIE_FACE: Record<DieFace, string> = {
  1: "⚀", 2: "⚁", 3: "⚂", 4: "⚃", 5: "⚄", 6: "⚅",
};

const SLOT_LABEL: Record<YahtzeeSlot, string> = {
  ones:  "1s",  twos: "2s",  threes: "3s",
  fours: "4s",  fives: "5s", sixes:  "6s",
  threeKind: "3-Kind", fourKind: "4-Kind", fullHouse: "Full House",
  smallStraight: "Sm Str", largeStraight: "Lg Str",
  yahtzee: "YAHTZEE", chance: "Chance",
};

// Pure preview score — mirrors scoreSlot() shape on the server (UI-only).
function previewScore(dice: readonly DieFace[], slot: YahtzeeSlot): number {
  const counts: Record<number, number> = {};
  for (const d of dice) counts[d] = (counts[d] ?? 0) + 1;
  const total = dice.reduce((a, b) => a + b, 0);
  const set = new Set(dice);
  const has = (n: number) => set.has(n as DieFace);
  switch (slot) {
    case "ones":   return (counts[1] ?? 0) * 1;
    case "twos":   return (counts[2] ?? 0) * 2;
    case "threes": return (counts[3] ?? 0) * 3;
    case "fours":  return (counts[4] ?? 0) * 4;
    case "fives":  return (counts[5] ?? 0) * 5;
    case "sixes":  return (counts[6] ?? 0) * 6;
    case "threeKind": return Object.values(counts).some(n => n >= 3) ? total : 0;
    case "fourKind":  return Object.values(counts).some(n => n >= 4) ? total : 0;
    case "fullHouse": {
      const v = Object.values(counts);
      return v.includes(3) && v.includes(2) ? 25 : 0;
    }
    case "smallStraight":
      return [1,2,3].some(a => has(a) && has(a+1) && has(a+2) && has(a+3)) ? 30 : 0;
    case "largeStraight":
      return ((has(1)&&has(2)&&has(3)&&has(4)&&has(5)) ||
              (has(2)&&has(3)&&has(4)&&has(5)&&has(6))) ? 40 : 0;
    case "yahtzee":
      return Object.values(counts).some(n => n === 5) ? 50 : 0;
    case "chance": return total;
  }
}

function Die({ face, held, onClick }: { face: DieFace; held: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={[
        "h-14 w-14 rounded-lg text-4xl bg-white text-black shadow-md",
        "transition active:scale-95",
        held ? "ring-4 ring-yellow-400 -translate-y-1" : "ring-1 ring-gray-400",
        onClick ? "cursor-pointer" : "cursor-default",
      ].join(" ")}
    >
      {DIE_FACE[face]}
    </button>
  );
}

export default function YahtzeeGameScreen({ playerId, token, roomId, wsUrl, spectator, onSettled }: Props) {
  const { t } = useT();
  const [view, setView] = useState<YahtzeeStateView | null>(null);
  const [connMsg, setConnMsg] = useState(t("ws.connecting"));
  const [sysMsg, setSysMsg] = useState("");
  const [timeLeft, setTimeLeft] = useState(0);
  // Local hold state — synced from server `view.held` on each state event,
  // but flips client-side optimistically so the UI feels responsive.
  const [localHeld, setLocalHeld] = useState<HeldTuple>([false, false, false, false, false]);
  const socketRef = useRef<GameSocket | null>(null);
  const watching = !!spectator;

  useEffect(() => {
    const sock = new GameSocket({ url: wsUrl, playerId, gameId: roomId, token, spectator: watching });
    socketRef.current = sock;
    sock.on("connected",    ()     => setConnMsg(""));
    sock.on("disconnected", (info) => setConnMsg(info.willReconnect ? t("ws.reconnecting", { attempt: info.attempt + 1 }) : t("ws.disconnected")));
    sock.on("state", (v) => {
      const yv = v as unknown as YahtzeeStateView;
      const wasMyTurn = view?.currentTurn === playerId;
      const nowMyTurn = yv.currentTurn === playerId;
      if (!wasMyTurn && nowMyTurn) sfx.myTurn();
      setView(yv);
      setLocalHeld(yv.held);
    });
    sock.on("settlement", (r) => {
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
  const card = view.self.scorecard;
  const opens = YAHTZEE_SLOTS.filter(s => card[s] === null);
  const hasRolled = view.rollsLeft < 3;

  function send(action: PlayerAction) {
    try { socketRef.current?.send(action); }
    catch { /* ignore */ }
  }

  function toggleHold(i: number) {
    if (!isMyTurn || !hasRolled) return;
    setLocalHeld(prev => {
      const next = [...prev] as HeldTuple;
      next[i] = !next[i];
      return next;
    });
  }

  function handleRoll() {
    if (!isMyTurn) return;
    send({ type: "yz_roll", held: hasRolled ? localHeld : [false,false,false,false,false] });
    sfx.cardPlay();
  }

  function handleScore(slot: YahtzeeSlot) {
    if (!isMyTurn || !hasRolled) return;
    if (card[slot] !== null) return;
    send({ type: "yz_score", slot });
    sfx.cardPlay();
  }

  // Compute upper subtotal + bonus preview.
  const upperSum =
    (card.ones ?? 0) + (card.twos ?? 0) + (card.threes ?? 0) +
    (card.fours ?? 0) + (card.fives ?? 0) + (card.sixes ?? 0);
  const bonus = upperSum >= 63 ? 35 : 0;
  const totalScore =
    YAHTZEE_SLOTS.reduce((sum, s) => sum + (card[s] ?? 0), 0) + bonus;

  return (
    <>
      <RotateHint />
      <div className="fixed inset-0 flex flex-col bg-green-950 text-white">
        {/* Header — round + countdown */}
        <div className="flex items-center justify-between px-4 py-2 text-xs">
          <span className="text-green-300">
            {t("yz.turn", { n: view.turnNumber + 1, total: view.totalTurns })}
          </span>
          <span className={timeLeft <= 5 ? "text-red-400 font-bold" : "text-green-400"}>
            ⏱ {timeLeft}s
          </span>
        </div>

        {/* Status banner */}
        <div className="px-4 pb-1 text-center text-sm font-bold text-yellow-300">
          {isMyTurn
            ? t("yz.yourTurn", { n: view.rollsLeft })
            : t("yz.waitingFor", { id: view.currentTurn })}
        </div>

        {/* Dice row */}
        <div className="flex items-center justify-center gap-2 py-3">
          {view.dice.map((d, i) => (
            <Die
              key={i}
              face={d}
              held={localHeld[i]!}
              onClick={isMyTurn && hasRolled ? () => toggleHold(i) : undefined}
            />
          ))}
        </div>

        {/* Roll button */}
        <div className="flex justify-center pb-2">
          <button
            disabled={!isMyTurn || view.rollsLeft === 0}
            onClick={handleRoll}
            className="rounded-lg bg-yellow-400 px-6 py-2 text-base font-bold text-green-950 shadow disabled:cursor-not-allowed disabled:opacity-50"
          >
            🎲 {t("yz.roll", { n: view.rollsLeft })}
          </button>
        </div>

        {(sysMsg || connMsg) && (
          <p className="px-4 pb-1 text-center text-[11px] text-yellow-300">{sysMsg || connMsg}</p>
        )}

        {/* Scorecard table */}
        <div className="flex-1 overflow-y-auto bg-green-900/50 px-2 pb-3 pt-1">
          <table className="w-full text-[11px] text-green-100">
            <thead>
              <tr className="text-yellow-300">
                <th className="py-1 text-left">{t("yz.slot")}</th>
                <th className="py-1 text-right">{view.self.playerId}</th>
                {view.opponents.map(op => (
                  <th key={op.playerId} className="py-1 text-right">{op.playerId}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {YAHTZEE_SLOTS.map(slot => {
                const myScore = card[slot];
                const open = myScore === null;
                const preview = open && hasRolled && isMyTurn
                  ? previewScore(view.dice, slot) : null;
                return (
                  <tr key={slot} className="border-t border-green-800/40">
                    <td className="py-1">{SLOT_LABEL[slot]}</td>
                    <td className="py-1 text-right">
                      {myScore !== null ? (
                        <span className="text-green-300">{myScore}</span>
                      ) : open && isMyTurn && hasRolled ? (
                        <button
                          onClick={() => handleScore(slot)}
                          className="rounded bg-yellow-700 px-2 py-0.5 text-[10px] font-bold text-yellow-100 hover:bg-yellow-600"
                        >
                          {preview !== null ? `+${preview}` : t("yz.fill")}
                        </button>
                      ) : (
                        <span className="text-green-700">—</span>
                      )}
                    </td>
                    {view.opponents.map(op => (
                      <td key={op.playerId} className="py-1 text-right">
                        {op.scorecard[slot] !== null
                          ? <span className="text-green-300">{op.scorecard[slot]}</span>
                          : <span className="text-green-700">—</span>}
                      </td>
                    ))}
                  </tr>
                );
              })}
              <tr className="border-t-2 border-yellow-600/40">
                <td className="py-1 text-yellow-300">{t("yz.bonus")}</td>
                <td className="py-1 text-right">{bonus}/35</td>
                {view.opponents.map(op => {
                  const oUpper =
                    (op.scorecard.ones ?? 0) + (op.scorecard.twos ?? 0) +
                    (op.scorecard.threes ?? 0) + (op.scorecard.fours ?? 0) +
                    (op.scorecard.fives ?? 0) + (op.scorecard.sixes ?? 0);
                  const oBonus = oUpper >= 63 ? 35 : 0;
                  return <td key={op.playerId} className="py-1 text-right">{oBonus}/35</td>;
                })}
              </tr>
              <tr className="border-t border-yellow-600/40">
                <td className="py-1 font-bold text-yellow-300">{t("yz.total")}</td>
                <td className="py-1 text-right font-bold text-yellow-200">{totalScore}</td>
                {view.opponents.map(op => {
                  const oTotal =
                    YAHTZEE_SLOTS.reduce((s, k) => s + (op.scorecard[k] ?? 0), 0) +
                    ((op.scorecard.ones ?? 0) + (op.scorecard.twos ?? 0) +
                     (op.scorecard.threes ?? 0) + (op.scorecard.fours ?? 0) +
                     (op.scorecard.fives ?? 0) + (op.scorecard.sixes ?? 0) >= 63 ? 35 : 0);
                  return <td key={op.playerId} className="py-1 text-right font-bold text-yellow-200">{oTotal}</td>;
                })}
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-center text-[10px] text-green-400">
            {opens.length} {t("yz.slotsLeft")}
          </p>
        </div>
      </div>
    </>
  );
}
