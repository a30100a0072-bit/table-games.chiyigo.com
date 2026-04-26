import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Card, ComboType, GameStateView, PlayerAction, SettlementResult } from "../shared/types";
import { GameSocket } from "../shared/GameSocket";

// ─── helpers ──────────────────────────────────────────────────────────────────

const SUIT_SYMBOL: Record<string, string> = {
  spades: "♠", hearts: "♥", clubs: "♣", diamonds: "♦",
};
const SUIT_COLOR: Record<string, string> = {
  spades: "text-gray-900", hearts: "text-red-600", clubs: "text-gray-900", diamonds: "text-red-600",
};

function cardKey(c: Card) { return `${c.rank}-${c.suit}`; }

const RANK_ORDER = ["3","4","5","6","7","8","9","10","J","Q","K","A","2"] as const;
const rankVal = (r: string) => RANK_ORDER.indexOf(r as typeof RANK_ORDER[number]);
const suitVal = (s: string) => ({ spades: 3, hearts: 2, clubs: 1, diamonds: 0 }[s] ?? 0);
const cardVal  = (c: Card)  => rankVal(c.rank) * 4 + suitVal(c.suit);
const sortCards = (cards: Card[]) => [...cards].sort((a, b) => cardVal(a) - cardVal(b));

// ─── combo detection ──────────────────────────────────────────────────────────

function detectCombo(cards: Card[]): ComboType | null {
  const n = cards.length;
  if (n === 1) return "single";
  if (n === 2) return cards[0].rank === cards[1].rank ? "pair" : null;
  if (n === 3) return cards[0].rank === cards[1].rank && cards[1].rank === cards[2].rank ? "triple" : null;
  if (n !== 5) return null;

  const sorted  = sortCards(cards);
  const ranks   = sorted.map(c => rankVal(c.rank));
  const suits   = sorted.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = ranks.every((r, i) => i === 0 || r === ranks[i - 1] + 1);
  const rankGroups = Object.values(
    sorted.reduce<Record<string, number>>((acc, c) => { acc[c.rank] = (acc[c.rank] ?? 0) + 1; return acc; }, {})
  ).sort((a, b) => b - a);

  if (isFlush && isStraight) return "straightFlush";
  if (rankGroups[0] === 4)   return "fourOfAKind";
  if (rankGroups[0] === 3 && rankGroups[1] === 2) return "fullHouse";
  if (isFlush)     return "flush";
  if (isStraight)  return "straight";
  return null;
}

// ─── CardView ─────────────────────────────────────────────────────────────────

function CardView({ card, selected, onClick }: { card: Card; selected: boolean; onClick: () => void }) {
  const sym   = SUIT_SYMBOL[card.suit] ?? card.suit;
  const color = SUIT_COLOR[card.suit]  ?? "text-gray-900";
  return (
    <button
      onClick={onClick}
      className={[
        "relative flex h-20 w-13 flex-shrink-0 select-none flex-col rounded-xl border-2 bg-white shadow-md",
        "transition-transform active:scale-95",
        selected ? "-translate-y-4 border-yellow-400 shadow-yellow-300/50" : "border-gray-300",
      ].join(" ")}
      style={{ width: "3.25rem" }}
    >
      <span className={`absolute left-1 top-0.5 text-xs font-bold leading-none ${color}`}>{card.rank}</span>
      <span className={`absolute right-1 bottom-0.5 rotate-180 text-xs font-bold leading-none ${color}`}>{card.rank}</span>
      <span className={`m-auto text-xl leading-none ${color}`}>{sym}</span>
    </button>
  );
}

// ─── HandView ─────────────────────────────────────────────────────────────────

function HandView({ hand, selected, toggle }: {
  hand:    Card[];
  selected: Set<string>;
  toggle:  (c: Card) => void;
}) {
  const sorted = sortCards(hand);
  return (
    <div className="hand-scroll flex gap-1.5 overflow-x-auto px-3 pb-2 pt-6">
      {sorted.map(c => (
        <CardView
          key={cardKey(c)}
          card={c}
          selected={selected.has(cardKey(c))}
          onClick={() => toggle(c)}
        />
      ))}
    </div>
  );
}

// ─── TableDisplay ─────────────────────────────────────────────────────────────

function TableDisplay({ lastPlay, currentTurn, playerId, opponents, passCount, deadlineMs }: {
  lastPlay:    GameStateView["lastPlay"];
  currentTurn: string;
  playerId:    string;
  opponents:   GameStateView["opponents"];
  passCount:   number;
  deadlineMs:  number;
}) {
  const [timeLeft, setTimeLeft] = useState(0);

  useEffect(() => {
    const tick = () => setTimeLeft(Math.max(0, Math.round((deadlineMs - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [deadlineMs]);

  const isMyTurn = currentTurn === playerId;

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex gap-6">
        {opponents.map(op => (
          <div key={op.playerId} className="flex flex-col items-center gap-1">
            <div className={[
              "rounded-full px-3 py-1 text-xs font-bold",
              currentTurn === op.playerId ? "bg-yellow-400 text-green-950" : "bg-green-800 text-green-200",
            ].join(" ")}>
              {op.playerId}
            </div>
            <span className="text-sm text-green-300">{op.cardCount}張</span>
          </div>
        ))}
      </div>

      <div className="flex min-h-24 items-center justify-center gap-1.5">
        {lastPlay
          ? lastPlay.cards.map(c => (
              <div
                key={cardKey(c)}
                className="flex h-16 w-11 flex-col rounded-lg border-2 border-gray-300 bg-white shadow"
              >
                <span className={`m-auto text-lg leading-none ${SUIT_COLOR[c.suit] ?? "text-gray-900"}`}>
                  {SUIT_SYMBOL[c.suit]}
                </span>
              </div>
            ))
          : <span className="text-green-500 text-sm">尚無出牌</span>
        }
      </div>

      {lastPlay && (
        <p className="text-xs text-green-400">
          {lastPlay.playerId} 出了 {lastPlay.combo}
          {passCount > 0 && `  ·  已PASS ${passCount}人`}
        </p>
      )}

      <div className={[
        "rounded-full px-4 py-1 text-sm font-bold",
        isMyTurn ? "bg-yellow-400 text-green-950" : "bg-green-800 text-green-300",
      ].join(" ")}>
        {isMyTurn ? `輪到你了  ${timeLeft}s` : `${currentTurn} 的回合  ${timeLeft}s`}
      </div>
    </div>
  );
}

// ─── ActionBar ────────────────────────────────────────────────────────────────

function ActionBar({ canPlay, onPlay, onPass, combo }: {
  canPlay: boolean;
  combo:   ComboType | null;
  onPlay:  () => void;
  onPass:  () => void;
}) {
  return (
    <div className="flex gap-3 px-4 pb-4">
      <button
        disabled={!canPlay || !combo}
        onClick={onPlay}
        className="flex-1 rounded-xl bg-yellow-400 py-3 font-bold text-green-950 transition hover:bg-yellow-300 disabled:opacity-40"
      >
        出牌{combo ? ` (${combo})` : ""}
      </button>
      <button
        disabled={!canPlay}
        onClick={onPass}
        className="rounded-xl bg-green-700 px-6 py-3 font-bold text-green-100 transition hover:bg-green-600 disabled:opacity-40"
      >
        PASS
      </button>
    </div>
  );
}

// ─── GameScreen ───────────────────────────────────────────────────────────────

interface Props {
  playerId: string;
  token:    string;
  roomId:   string;
  wsUrl:    string;
  onSettled: (result: SettlementResult) => void;
}

export default function GameScreen({ playerId, token, roomId, wsUrl, onSettled }: Props) {
  const [view,     setView]     = useState<GameStateView | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sysMsg,   setSysMsg]   = useState("");
  const [connMsg,  setConnMsg]  = useState("連線中…");
  const socketRef = useRef<GameSocket | null>(null);

  useEffect(() => {
    const sock = new GameSocket({ url: wsUrl, playerId, gameId: roomId, token });
    socketRef.current = sock;

    sock.on("connected",    ()      => setConnMsg(""));
    sock.on("disconnected", (info)  => setConnMsg(info.willReconnect ? "重新連線中…" : "連線中斷"));
    sock.on("state",        (v)     => { setView(v); setSelected(new Set()); });
    sock.on("settlement",   (r)     => onSettled(r));
    sock.on("system",       (msg)   => setSysMsg(msg));
    sock.on("error",        (msg)   => setSysMsg(msg));

    sock.connect();
    return () => sock.disconnect();
  }, [wsUrl, playerId, roomId, token, onSettled]);

  const toggle = useCallback((card: Card) => {
    setSelected(prev => {
      const next = new Set(prev);
      const k = cardKey(card);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }, []);

  const isMyTurn = view?.currentTurn === playerId;

  const selectedCards = view
    ? view.self.hand.filter(c => selected.has(cardKey(c)))
    : [];
  const combo = selectedCards.length > 0 ? detectCombo(selectedCards) : null;

  function handlePlay() {
    if (!combo || !socketRef.current) return;
    const action: PlayerAction = { type: "play", cards: selectedCards, combo };
    try { socketRef.current.send(action); } catch { /* ignore in wrong state */ }
    setSelected(new Set());
  }

  function handlePass() {
    if (!socketRef.current) return;
    try { socketRef.current.send({ type: "pass" }); } catch { /* ignore */ }
  }

  if (!view)
    return (
      <div className="flex h-full items-center justify-center bg-green-950">
        <p className="text-green-300">{connMsg || "等待遊戲開始…"}</p>
      </div>
    );

  return (
    <div className="flex h-full flex-col bg-green-950 text-white">
      {(connMsg || sysMsg) && (
        <div className="bg-yellow-700 px-4 py-1 text-center text-xs text-yellow-100">
          {connMsg || sysMsg}
        </div>
      )}

      <div className="flex-1 overflow-hidden px-2 pt-4">
        <TableDisplay
          lastPlay={view.lastPlay}
          currentTurn={view.currentTurn}
          playerId={playerId}
          opponents={view.opponents}
          passCount={view.passCount}
          deadlineMs={view.turnDeadlineMs}
        />
      </div>

      <div className="shrink-0">
        <div className="px-3 pb-1 text-xs text-green-400">
          手牌 {view.self.cardCount} 張
        </div>
        <HandView hand={view.self.hand} selected={selected} toggle={toggle} />
        <ActionBar
          canPlay={isMyTurn}
          combo={combo}
          onPlay={handlePlay}
          onPass={handlePass}
        />
      </div>
    </div>
  );
}
