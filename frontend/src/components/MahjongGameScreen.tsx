import { useEffect, useRef, useState } from "react";
import type {
  MahjongStateView, MahjongTile, ExposedMeld, PlayerAction, SettlementResult,
} from "../shared/types";
import { GameSocket } from "../shared/GameSocket";

// ─── tile helpers ─────────────────────────────────────────────────────────────

const SUIT_LABEL: Record<string, string> = { m: "萬", p: "筒", s: "條", z: "字" };
const HONOR_NAMES = ["", "東", "南", "西", "北", "中", "發", "白"]; // z 1–7

function tileLabel(t: MahjongTile): string {
  if (t.suit === "z") return HONOR_NAMES[t.rank] ?? `?${t.rank}`;
  return `${t.rank}${SUIT_LABEL[t.suit] ?? t.suit}`;
}
function tileKey(t: MahjongTile): string { return `${t.suit}${t.rank}`; }
function tileEq(a: MahjongTile, b: MahjongTile): boolean {
  return a.suit === b.suit && a.rank === b.rank;
}
function tileColor(t: MahjongTile): string {
  if (t.suit === "z") {
    if (t.rank === 5) return "text-red-600";   // 中
    if (t.rank === 6) return "text-green-700"; // 發
    return "text-gray-900";
  }
  return t.suit === "p" ? "text-blue-700" : t.suit === "s" ? "text-green-700" : "text-gray-900";
}
function sortTiles(tiles: MahjongTile[]): MahjongTile[] {
  const order: Record<string, number> = { m: 0, p: 1, s: 2, z: 3 };
  return [...tiles].sort((a, b) =>
    (order[a.suit]! - order[b.suit]!) || (a.rank - b.rank),
  );
}

// ─── views ────────────────────────────────────────────────────────────────────

function TileView({ tile, selected, onClick }: { tile: MahjongTile; selected: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={[
        "flex h-14 w-10 flex-shrink-0 items-center justify-center rounded-md border-2 bg-white text-sm font-bold shadow-md",
        "transition-transform active:scale-95 disabled:cursor-default",
        selected ? "-translate-y-3 border-yellow-400 shadow-yellow-300/50" : "border-gray-300",
        tileColor(tile),
      ].join(" ")}
    >
      {tileLabel(tile)}
    </button>
  );
}

function MeldView({ meld }: { meld: ExposedMeld }) {
  const concealed = meld.kind === "kong_concealed";
  return (
    <div className="flex gap-0.5">
      {meld.tiles.map((t, i) => (
        <div
          key={i}
          className={[
            "flex h-10 w-7 items-center justify-center rounded border text-[10px] font-bold",
            concealed && (i === 0 || i === 3) ? "bg-green-700 text-green-700" : `bg-white ${tileColor(t)}`,
          ].join(" ")}
        >
          {concealed && (i === 0 || i === 3) ? "■" : tileLabel(t)}
        </div>
      ))}
    </div>
  );
}

function OpponentRow({ view, currentTurn }: { view: MahjongStateView; currentTurn: string }) {
  return (
    <div className="flex flex-wrap justify-center gap-3">
      {view.opponents.map(op => (
        <div key={op.playerId} className="flex flex-col items-center gap-1">
          <div className={[
            "rounded-full px-3 py-1 text-xs font-bold",
            currentTurn === op.playerId ? "bg-yellow-400 text-green-950" : "bg-green-800 text-green-200",
          ].join(" ")}>
            {op.playerId}
          </div>
          <div className="text-[10px] text-green-300">手牌 {op.handCount}</div>
          {op.exposed.length > 0 && (
            <div className="flex gap-1">
              {op.exposed.map((m, i) => <MeldView key={i} meld={m} />)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── main ─────────────────────────────────────────────────────────────────────

interface Props {
  playerId: string;
  token:    string;
  roomId:   string;
  wsUrl:    string;
  onSettled: (result: SettlementResult) => void;
}

export default function MahjongGameScreen({ playerId, token, roomId, wsUrl, onSettled }: Props) {
  const [view,     setView]     = useState<MahjongStateView | null>(null);
  const [picked,   setPicked]   = useState<string | null>(null);  // tile key
  const [sysMsg,   setSysMsg]   = useState("");
  const [connMsg,  setConnMsg]  = useState("連線中…");
  const socketRef = useRef<GameSocket | null>(null);

  useEffect(() => {
    const sock = new GameSocket({ url: wsUrl, playerId, gameId: roomId, token });
    socketRef.current = sock;

    sock.on("connected",    ()    => setConnMsg(""));
    sock.on("disconnected", (i)   => setConnMsg(i.willReconnect ? "重新連線中…" : "連線中斷"));
    sock.on("state",        (v)   => { setView(v as unknown as MahjongStateView); setPicked(null); });
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

  const isMyTurn  = view.currentTurn === playerId;
  const inReact   = view.phase === "pending_reactions" && view.awaitingReactionsFrom.includes(playerId);
  const handSorted = sortTiles(view.self.hand);
  const pickedTile = handSorted.find(t => tileKey(t) === picked) ?? null;
  const ld = view.lastDiscard;

  // ─── action availability ─────
  const canDiscard = isMyTurn && pickedTile !== null && view.phase === "playing";
  const canPong    = inReact && ld !== null && view.self.hand.filter(t => tileEq(t, ld.tile)).length >= 2;
  const canKong    = inReact && ld !== null && view.self.hand.filter(t => tileEq(t, ld.tile)).length >= 3;
  const canHu      = inReact && ld !== null;     // server validates canWin
  const canPass    = inReact;

  return (
    <div className="flex h-full flex-col bg-green-950 text-white">
      {(connMsg || sysMsg) && (
        <div className="bg-yellow-700 px-4 py-1 text-center text-xs text-yellow-100">
          {connMsg || sysMsg}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 pt-3">
        <OpponentRow view={view} currentTurn={view.currentTurn} />

        <div className="mt-4 flex flex-col items-center gap-2">
          <div className="text-[10px] text-green-400">牌牆剩餘 {view.wall.remaining} · {view.phase}</div>
          {ld
            ? (
              <div className="flex flex-col items-center gap-1">
                <div className="text-[10px] text-green-300">{ld.playerId} 打出</div>
                <TileView tile={ld.tile} selected={false} />
              </div>
            )
            : <div className="text-xs text-green-500">尚無打牌</div>}
        </div>

        <div className={[
          "mt-3 mx-auto w-fit rounded-full px-4 py-1 text-sm font-bold",
          isMyTurn ? "bg-yellow-400 text-green-950"
          : inReact ? "bg-blue-500 text-white"
          : "bg-green-800 text-green-300",
        ].join(" ")}>
          {isMyTurn ? "輪到你打牌" : inReact ? "可吃碰槓胡" : `${view.currentTurn} 行動中`}
        </div>
      </div>

      <div className="shrink-0">
        {view.self.exposed.length > 0 && (
          <div className="flex gap-2 px-3 pb-1">
            {view.self.exposed.map((m, i) => <MeldView key={i} meld={m} />)}
          </div>
        )}

        <div className="hand-scroll flex gap-1 overflow-x-auto px-3 pb-2 pt-4">
          {handSorted.map(t => (
            <TileView
              key={tileKey(t)}
              tile={t}
              selected={picked === tileKey(t)}
              onClick={() => setPicked(p => p === tileKey(t) ? null : tileKey(t))}
            />
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2 px-3 pb-3 sm:grid-cols-6">
          <button
            disabled={!canDiscard}
            onClick={() => pickedTile && send({ type: "discard", tile: pickedTile })}
            className="rounded-lg bg-yellow-400 py-2 font-bold text-green-950 disabled:opacity-40"
          >打牌</button>
          <button
            disabled={!canPong}
            onClick={() => ld && send({ type: "pong", tile: ld.tile })}
            className="rounded-lg bg-blue-500 py-2 font-bold text-white disabled:opacity-40"
          >碰</button>
          <button
            disabled={!canKong}
            onClick={() => ld && send({ type: "kong", tile: ld.tile, source: "exposed" })}
            className="rounded-lg bg-purple-600 py-2 font-bold text-white disabled:opacity-40"
          >槓</button>
          <button
            disabled={!canHu}
            onClick={() => send({ type: "hu", selfDrawn: false })}
            className="rounded-lg bg-red-500 py-2 font-bold text-white disabled:opacity-40"
          >胡</button>
          <button
            disabled={!isMyTurn || view.phase !== "playing"}
            onClick={() => send({ type: "hu", selfDrawn: true })}
            className="rounded-lg bg-red-700 py-2 font-bold text-white disabled:opacity-40"
          >自摸</button>
          <button
            disabled={!canPass}
            onClick={() => send({ type: "mj_pass" })}
            className="rounded-lg bg-green-700 py-2 font-bold text-green-100 disabled:opacity-40"
          >過</button>
        </div>
      </div>
    </div>
  );
}
