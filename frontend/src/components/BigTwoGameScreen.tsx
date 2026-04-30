import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Card, ComboType, GameStateView, PlayerAction, SettlementResult } from "../shared/types";
import { GameSocket } from "../shared/GameSocket";
import { findCombos } from "../shared/bigTwoCombos";
import type { QuickComboType } from "../shared/bigTwoCombos";

// ─── helpers ──────────────────────────────────────────────────────────────────  L2_實作

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

// ─── combo detection ──────────────────────────────────────────────────────────  L2_實作

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

// ─── PlayingCard (純 CSS / L2_實作) ───────────────────────────────────────────
// 黑/紅花色僅以 CSS 顏色區分；無外部圖片資源。

function PlayingCard({ card, size = "md", selected, onClick }: {
  card:      Card;
  size?:     "sm" | "md";
  selected?: boolean;
  onClick?:  () => void;
}) {
  const sym   = SUIT_SYMBOL[card.suit] ?? card.suit;
  const color = SUIT_COLOR[card.suit]  ?? "text-gray-900";
  const dims  = size === "sm"
    ? "h-14 w-10 rounded-md"
    : "h-24 w-16 rounded-lg";
  const rankFs = size === "sm" ? "text-[10px]" : "text-sm";
  const symFs  = size === "sm" ? "text-base"   : "text-2xl";
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "relative flex flex-shrink-0 select-none flex-col border-2 bg-white shadow-md",
        "transition-transform duration-150 active:scale-95",
        dims,
        selected ? "-translate-y-5 border-yellow-400 shadow-yellow-300/60" : "border-gray-300",
      ].join(" ")}
    >
      <span className={`absolute left-1 top-0.5 font-bold leading-none ${rankFs} ${color}`}>{card.rank}</span>
      <span className={`absolute right-1 bottom-0.5 rotate-180 font-bold leading-none ${rankFs} ${color}`}>{card.rank}</span>
      <span className={`m-auto leading-none ${symFs} ${color}`}>{sym}</span>
    </button>
  );
}

// ─── 卡背 (對手隱藏牌) ─────────────────────────────────────────────────────── L2_隔離
function CardBack({ orientation = "h" }: { orientation?: "h" | "v" }) {
  return (
    <div
      className={[
        "flex-shrink-0 rounded-md border-2 border-blue-950 shadow",
        orientation === "h" ? "h-14 w-10" : "h-10 w-14",
      ].join(" ")}
      style={{
        backgroundImage:
          "repeating-linear-gradient(45deg, #1e3a8a 0 6px, #0c1f5c 6px 12px)",
      }}
    />
  );
}

// ─── 對手座位 (L2_隔離 — 僅張數，不渲染牌面) ────────────────────────────────
function OpponentSeat({ op, currentTurn, axis }: {
  op:          GameStateView["opponents"][number];
  currentTurn: string;
  axis:        "h" | "v";
}) {
  const isTurn = currentTurn === op.playerId;
  const stack = (
    <div
      className={[
        "flex",
        axis === "h"
          ? "flex-row [&>*+*]:-ml-6"
          : "flex-col [&>*+*]:-mt-6",
      ].join(" ")}
    >
      {Array.from({ length: Math.min(op.cardCount, 13) }).map((_, i) => (
        <CardBack key={i} orientation={axis} />
      ))}
    </div>
  );
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={[
          "rounded-full px-3 py-1 text-xs font-bold transition",
          isTurn ? "bg-yellow-400 text-green-950 ring-2 ring-yellow-200" : "bg-green-800 text-green-200",
        ].join(" ")}
      >
        {op.playerId} · {op.cardCount}
      </div>
      {stack}
    </div>
  );
}

// ─── GameScreen ─────────────────────────────────────────────────────────────── L2_鎖定

interface Props {
  playerId: string;
  token:    string;
  roomId:   string;
  wsUrl:    string;
  onSettled: (result: SettlementResult) => void;
}

// 5 個快捷鍵牌型，順序對應數字鍵 1–5。                                       // L2_實作
const QUICK_COMBOS: { type: QuickComboType; label: string; key: string }[] = [
  { type: "pair",          label: "對子",   key: "1" },
  { type: "straight",      label: "順子",   key: "2" },
  { type: "fullHouse",     label: "葫蘆",   key: "3" },
  { type: "fourOfAKind",   label: "鐵支",   key: "4" },
  { type: "straightFlush", label: "同花順", key: "5" },
];

export default function BigTwoGameScreen({ playerId, token, roomId, wsUrl, onSettled }: Props) {
  const [view,     setView]     = useState<GameStateView | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sysMsg,   setSysMsg]   = useState("");
  const [connMsg,  setConnMsg]  = useState("連線中…");
  const [timeLeft, setTimeLeft] = useState(0);
  // 快捷鍵循環狀態：同一鍵按多次會循環顯示同類型的下一個組合。              // L2_實作
  const [cycle,    setCycle]    = useState<{ type: QuickComboType; index: number } | null>(null);
  const socketRef = useRef<GameSocket | null>(null);

  // ── socket lifecycle ───────────────────────────────────────────────────── L2_鎖定
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

  // ── countdown ──────────────────────────────────────────────────────────── L2_鎖定
  useEffect(() => {
    if (!view) return;
    const tick = () => setTimeLeft(Math.max(0, Math.round((view.turnDeadlineMs - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [view?.turnDeadlineMs]);

  // ── 卡牌 toggle (L3_邏輯安防) ──────────────────────────────────────────────
  const toggle = useCallback((card: Card) => {
    setCycle(null);
    setSelected(prev => {
      const next = new Set(prev);
      const k = cardKey(card);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }, []);

  // ── 快捷鍵：每種牌型可選的所有組合 (cached per hand) ─────────────────────── L2_實作
  const hand = view?.self.hand;
  const combosByType = useMemo<Record<QuickComboType, Card[][]>>(() => {
    const empty = { pair: [], straight: [], fullHouse: [], fourOfAKind: [], straightFlush: [] } as
      Record<QuickComboType, Card[][]>;
    if (!hand) return empty;
    return {
      pair:          findCombos(hand, "pair"),
      straight:      findCombos(hand, "straight"),
      fullHouse:     findCombos(hand, "fullHouse"),
      fourOfAKind:   findCombos(hand, "fourOfAKind"),
      straightFlush: findCombos(hand, "straightFlush"),
    };
  }, [hand]);

  // 按下快捷鍵：第一次 → 選最小的組合；同鍵再按 → 循環下一個。               // L2_實作
  const pickCombo = useCallback((type: QuickComboType) => {
    const list = combosByType[type];
    if (list.length === 0) return;
    const nextIndex = cycle && cycle.type === type
      ? (cycle.index + 1) % list.length
      : 0;
    setCycle({ type, index: nextIndex });
    setSelected(new Set(list[nextIndex].map(cardKey)));
  }, [combosByType, cycle]);

  // ── 鍵盤監聽 1–5 觸發對應牌型 ─────────────────────────────────────────── L2_實作
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // 避免在 input/textarea 中觸發
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const hit = QUICK_COMBOS.find(q => q.key === e.key);
      if (hit) { e.preventDefault(); pickCombo(hit.type); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickCombo]);

  if (!view) {
    return (
      <div className="flex h-full items-center justify-center bg-green-950">
        <p className="text-green-300">{connMsg || "等待遊戲開始…"}</p>
      </div>
    );
  }

  const isMyTurn      = view.currentTurn === playerId;
  const sortedHand    = sortCards(view.self.hand);
  const selectedCards = view.self.hand.filter(c => selected.has(cardKey(c)));
  const combo         = selectedCards.length > 0 ? detectCombo(selectedCards) : null;

  function handlePlay() {
    if (!combo || !socketRef.current) return;
    const action: PlayerAction = { type: "play", cards: selectedCards, combo };
    try { socketRef.current.send(action); } catch { /* L3_邏輯安防: ignore wrong state */ }
    setSelected(new Set());
  }

  function handlePass() {
    if (!socketRef.current) return;
    try { socketRef.current.send({ type: "pass" }); } catch { /* L3_邏輯安防 */ }
  }

  // 對手座位映射：opponents[0]=left, [1]=top, [2]=right                      // L2_模組
  const [oLeft, oTop, oRight] = [view.opponents[0], view.opponents[1], view.opponents[2]];

  return (
    <>
      {/* ─── Portrait 強制鎖定 (L3_邏輯安防 / Tailwind portrait variant) ─── */}
      <div className="hidden portrait:fixed portrait:inset-0 portrait:z-[9999] portrait:flex portrait:flex-col portrait:items-center portrait:justify-center portrait:bg-black portrait:text-yellow-300">
        <div className="animate-spin text-7xl">⟳</div>
        <div className="mt-6 text-xl tracking-widest">請將設備轉為橫向</div>
      </div>

      {/* ─── 桌面：CSS Grid 5 區塊 (L2_模組) ─── */}
      <div
        className="portrait:hidden fixed inset-0 grid select-none text-white"
        style={{
          gridTemplateColumns: "14% 1fr 14%",
          gridTemplateRows:    "18% 1fr 32%",
          gridTemplateAreas: `
            ".    top    ."
            "left center right"
            "self self   self"
          `,
          background:
            "radial-gradient(ellipse at center, #1f6b3f 0%, #0d3a22 70%, #07261a 100%)",
        }}
      >
        {(connMsg || sysMsg) && (
          <div className="absolute left-0 right-0 top-0 z-10 bg-yellow-700/90 px-4 py-1 text-center text-xs text-yellow-100">
            {connMsg || sysMsg}
          </div>
        )}

        {/* 上方對手 */}
        <section className="flex items-center justify-center" style={{ gridArea: "top" }}>
          {oTop && <OpponentSeat op={oTop} currentTurn={view.currentTurn} axis="h" />}
        </section>

        {/* 左方對手 */}
        <section className="flex items-center justify-center" style={{ gridArea: "left" }}>
          {oLeft && <OpponentSeat op={oLeft} currentTurn={view.currentTurn} axis="v" />}
        </section>

        {/* 中心桌面：lastPlay 渲染 (L2_鎖定) */}
        <section
          className="flex flex-col items-center justify-center gap-3 px-2"
          style={{ gridArea: "center" }}
        >
          <div className="flex items-center gap-3 text-xs text-green-200/80">
            <span className="rounded-full border border-white/20 px-3 py-0.5 uppercase tracking-widest">
              {view.phase}
            </span>
            {view.passCount > 0 && (
              <span className="text-green-400">PASS ×{view.passCount}</span>
            )}
          </div>

          <div className="flex min-h-[110px] items-center justify-center [&>*+*]:-ml-3">
            {view.lastPlay
              ? view.lastPlay.cards.map(c => (
                  <PlayingCard key={cardKey(c)} card={c} size="md" />
                ))
              : <span className="italic tracking-widest text-green-500">— 新一輪 —</span>
            }
          </div>

          {view.lastPlay && (
            <p className="text-xs text-green-300/80">
              {view.lastPlay.playerId} · {view.lastPlay.combo}
            </p>
          )}

          <div
            className={[
              "rounded-full px-4 py-1 text-sm font-bold transition",
              isMyTurn
                ? "bg-yellow-400 text-green-950 shadow-lg shadow-yellow-400/40"
                : "bg-green-800 text-green-300",
            ].join(" ")}
          >
            {isMyTurn ? `輪到你了 · ${timeLeft}s` : `${view.currentTurn} 的回合 · ${timeLeft}s`}
          </div>
        </section>

        {/* 右方對手 */}
        <section className="flex items-center justify-center" style={{ gridArea: "right" }}>
          {oRight && <OpponentSeat op={oRight} currentTurn={view.currentTurn} axis="v" />}
        </section>

        {/* 下方本家：層疊手牌 + 動作 (L2_實作 / L3_邏輯安防) */}
        <section
          className="flex flex-col items-center justify-end gap-3 pb-4"
          style={{ gridArea: "self" }}
        >
          <div className="text-xs text-green-300/80">
            手牌 {view.self.cardCount} 張
          </div>

          {/* 層疊：負 margin (L2_實作) */}
          <div className="flex items-end justify-center pt-6 [&>*+*]:-ml-7">
            {sortedHand.map(c => (
              <PlayingCard
                key={cardKey(c)}
                card={c}
                size="md"
                selected={selected.has(cardKey(c))}
                onClick={() => toggle(c)}
              />
            ))}
          </div>

          {/* 快捷牌型列 (L2_實作) — 鍵盤 1–5 / 點擊；同鍵循環下一組 */}
          <div className="flex items-center gap-2">
            {QUICK_COMBOS.map(({ type, label, key }) => {
              const list  = combosByType[type];
              const count = list.length;
              const active = cycle?.type === type;
              return (
                <button
                  key={type}
                  type="button"
                  disabled={count === 0}
                  onClick={() => pickCombo(type)}
                  title={count === 0 ? `沒有可用的${label}` : `${label}（${count} 組可選；按 ${key} 或重複點擊循環）`}
                  className={[
                    "relative flex flex-col items-center rounded-lg px-3 py-1.5 text-xs font-bold shadow transition",
                    "disabled:cursor-not-allowed disabled:bg-gray-800 disabled:text-gray-500 disabled:opacity-50",
                    active
                      ? "bg-yellow-400 text-green-950 ring-2 ring-yellow-200"
                      : "bg-green-800 text-yellow-200 hover:bg-green-700",
                  ].join(" ")}
                >
                  <span className="flex items-baseline gap-1">
                    <span className="opacity-70">[{key}]</span>
                    <span>{label}</span>
                  </span>
                  <span className="text-[10px] opacity-80">
                    {count === 0 ? "—" : active ? `${(cycle!.index + 1)}/${count}` : `${count} 組`}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={!isMyTurn || !combo}
              onClick={handlePlay}
              className="min-w-[120px] rounded-xl bg-red-600 px-5 py-2.5 text-base font-bold text-white shadow transition hover:brightness-110 active:translate-y-[1px] disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500 disabled:opacity-60"
            >
              出牌{combo ? ` · ${combo}` : ` (${selected.size})`}
            </button>
            <button
              type="button"
              disabled={!isMyTurn}
              onClick={handlePass}
              className="min-w-[110px] rounded-xl bg-gray-600 px-5 py-2.5 text-base font-bold text-white shadow transition hover:brightness-110 active:translate-y-[1px] disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500 disabled:opacity-60"
            >
              PASS
            </button>
          </div>
        </section>
      </div>
    </>
  );
}
