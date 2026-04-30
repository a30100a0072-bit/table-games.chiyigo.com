import { useEffect, useRef, useState } from "react";
import type {
  PokerStateView, Card, PlayerAction, SettlementResult,
} from "../shared/types";
import { GameSocket } from "../shared/GameSocket";

const SUIT_SYMBOL: Record<string, string> = { spades: "♠", hearts: "♥", clubs: "♣", diamonds: "♦" };
const SUIT_COLOR:  Record<string, string> = { spades: "text-gray-900", clubs: "text-gray-900", hearts: "text-red-600", diamonds: "text-red-600" };

function CardView({ card, faceDown }: { card?: Card; faceDown?: boolean }) {
  if (faceDown || !card)
    return <div className="h-16 w-11 rounded-lg border-2 border-green-700 bg-green-800 shadow" />;
  const sym = SUIT_SYMBOL[card.suit] ?? card.suit;
  const col = SUIT_COLOR[card.suit] ?? "text-gray-900";
  return (
    <div className="relative flex h-16 w-11 flex-col rounded-lg border-2 border-gray-300 bg-white shadow">
      <span className={`absolute left-1 top-0.5 text-xs font-bold ${col}`}>{card.rank}</span>
      <span className={`m-auto text-lg ${col}`}>{sym}</span>
    </div>
  );
}

interface Props {
  playerId: string;
  token:    string;
  roomId:   string;
  wsUrl:    string;
  onSettled: (result: SettlementResult) => void;
}

export default function TexasHoldemGameScreen({ playerId, token, roomId, wsUrl, onSettled }: Props) {
  const [view,    setView]    = useState<PokerStateView | null>(null);
  const [raise,   setRaise]   = useState<number>(0);
  const [sysMsg,  setSysMsg]  = useState("");
  const [connMsg, setConnMsg] = useState("連線中…");
  const socketRef = useRef<GameSocket | null>(null);

  useEffect(() => {
    const sock = new GameSocket({ url: wsUrl, playerId, gameId: roomId, token });
    socketRef.current = sock;

    sock.on("connected",    ()    => setConnMsg(""));
    sock.on("disconnected", (i)   => setConnMsg(i.willReconnect ? "重新連線中…" : "連線中斷"));
    sock.on("state",        (v)   => {
      const pv = v as unknown as PokerStateView;
      setView(pv);
      // default raise = currentBet + minRaise (clamped to stack)
      setRaise(Math.min(pv.self.stack + pv.self.betThisStreet, pv.currentBet + pv.minRaise));
    });
    sock.on("settlement",   (r)   => onSettled(r));
    sock.on("system",       (m)   => setSysMsg(m));
    sock.on("error",        (m)   => setSysMsg(m));

    sock.connect();
    return () => sock.disconnect();
  }, [wsUrl, playerId, roomId, token, onSettled]);

  function send(action: PlayerAction) {
    try { socketRef.current?.send(action); }
    catch (err) { setSysMsg(err instanceof Error ? err.message : "送出失敗"); }
  }

  if (!view)
    return (
      <div className="flex h-full items-center justify-center bg-green-950">
        <p className="text-green-300">{connMsg || "等待遊戲開始…"}</p>
      </div>
    );

  const me        = view.self;
  const isMyTurn  = view.currentTurn === playerId;
  const owe       = Math.max(0, view.currentBet - me.betThisStreet);
  const canCheck  = isMyTurn && owe === 0;
  const canCall   = isMyTurn && owe > 0;
  const canRaise  = isMyTurn && me.stack > owe;     // need extra to raise
  const totalPot  = view.pots.reduce((s, p) => s + p.amount, 0);

  return (
    <div className="flex h-full flex-col bg-green-950 text-white">
      {(connMsg || sysMsg) && (
        <div className="bg-yellow-700 px-4 py-1 text-center text-xs text-yellow-100">
          {connMsg || sysMsg}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 pt-3">
        <div className="flex flex-wrap justify-center gap-3">
          {view.opponents.map(op => (
            <div key={op.playerId} className="flex flex-col items-center gap-1">
              <div className={[
                "rounded-full px-3 py-1 text-xs font-bold",
                view.currentTurn === op.playerId ? "bg-yellow-400 text-green-950"
                : op.hasFolded ? "bg-gray-700 text-gray-400"
                : "bg-green-800 text-green-200",
              ].join(" ")}>
                {op.playerId}{op.isAllIn && " (All-in)"}{op.hasFolded && " (棄)"}
              </div>
              <div className="flex gap-0.5">
                {op.holeCards
                  ? <><CardView card={op.holeCards[0]} /><CardView card={op.holeCards[1]} /></>
                  : <><CardView faceDown /><CardView faceDown /></>}
              </div>
              <div className="text-[10px] text-green-300">籌碼 {op.stack}</div>
              {op.betThisStreet > 0 && <div className="text-[10px] text-yellow-300">下注 {op.betThisStreet}</div>}
            </div>
          ))}
        </div>

        <div className="mt-5 flex flex-col items-center gap-2 rounded-2xl bg-green-900/60 p-4">
          <div className="text-xs text-green-300">底池 {totalPot} · {view.street}</div>
          <div className="flex gap-1.5">
            {Array.from({ length: 5 }).map((_, i) => {
              const c = view.communityCards[i];
              return c
                ? <CardView key={i} card={c} />
                : <div key={i} className="h-16 w-11 rounded-lg border-2 border-dashed border-green-700" />;
            })}
          </div>
          {view.pots.length > 1 && (
            <div className="flex flex-col items-center gap-0.5 text-[10px]">
              {view.pots.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className={i === 0 ? "rounded-full bg-yellow-700/40 px-2 py-0.5 text-yellow-200" : "rounded-full bg-blue-800/60 px-2 py-0.5 text-blue-200"}>
                    {i === 0 ? "主池" : `邊池 ${i}`} {p.amount}
                  </span>
                  <span className="text-green-500/80">
                    {p.eligiblePlayerIds.length} 人爭奪
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className={[
          "mx-auto mt-4 w-fit rounded-full px-4 py-1 text-sm font-bold",
          isMyTurn ? "bg-yellow-400 text-green-950" : "bg-green-800 text-green-300",
        ].join(" ")}>
          {isMyTurn ? `輪到你 · 需跟 ${owe}` : `${view.currentTurn} 行動中`}
        </div>
      </div>

      <div className="shrink-0">
        <div className="flex items-center justify-between px-3 pb-2 text-xs text-green-200">
          <span>{me.playerId}</span>
          <span>籌碼 {me.stack}{me.betThisStreet > 0 && ` · 本街下 ${me.betThisStreet}`}</span>
        </div>

        <div className="flex justify-center gap-2 pb-3">
          <CardView card={me.holeCards[0]} />
          <CardView card={me.holeCards[1]} />
        </div>

        <div className="grid grid-cols-2 gap-2 px-3 pb-2 sm:grid-cols-4">
          <button
            disabled={!isMyTurn}
            onClick={() => send({ type: "fold" })}
            className="rounded-lg bg-gray-600 py-2 font-bold text-white disabled:opacity-40"
          >棄牌</button>
          <button
            disabled={!canCheck}
            onClick={() => send({ type: "check" })}
            className="rounded-lg bg-green-700 py-2 font-bold text-green-100 disabled:opacity-40"
          >過牌</button>
          <button
            disabled={!canCall}
            onClick={() => send({ type: "call" })}
            className="rounded-lg bg-blue-500 py-2 font-bold text-white disabled:opacity-40"
          >跟注 {owe}</button>
          <button
            disabled={!canRaise || raise <= view.currentBet}
            onClick={() => send({ type: "raise", raiseAmount: raise })}
            className="rounded-lg bg-yellow-400 py-2 font-bold text-green-950 disabled:opacity-40"
          >加注 → {raise}</button>
        </div>

        <div className="flex items-center gap-3 px-3 pb-1">
          <input
            type="range"
            min={view.currentBet + view.minRaise}
            max={me.stack + me.betThisStreet}
            value={Math.max(view.currentBet + view.minRaise, Math.min(me.stack + me.betThisStreet, raise))}
            onChange={e => setRaise(Number(e.target.value))}
            disabled={!canRaise}
            className="flex-1 accent-yellow-400"
          />
          <button
            disabled={!canRaise}
            onClick={() => send({ type: "raise", raiseAmount: me.stack + me.betThisStreet })}
            className="rounded-lg bg-red-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40"
          >All-in</button>
        </div>

        {/* 加注金額提示列：最低 / 最高 / 底池倍數 */}
        <div className="flex justify-between px-3 pb-3 text-[10px] text-green-400">
          <span>最低 {view.currentBet + view.minRaise}</span>
          <span>底池 ×{totalPot > 0 ? (raise / totalPot).toFixed(1) : "—"}</span>
          <span>最高 {me.stack + me.betThisStreet}</span>
        </div>
      </div>
    </div>
  );
}
