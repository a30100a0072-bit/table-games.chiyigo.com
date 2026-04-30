import { useEffect, useMemo, useRef, useState } from "react";
import type {
  MahjongStateView, MahjongTile, ExposedMeld, PlayerAction, SettlementResult,
} from "../shared/types";
import { GameSocket } from "../shared/GameSocket";

// 給定手牌與對手剛打出的牌，回傳所有可吃的 [t1, t2, discard] 三張組合。 // L2_實作
// 規則：discard 只能在 m/p/s（萬筒條），三張連號同花色。
function findChowOptions(hand: MahjongTile[], discard: MahjongTile): MahjongTile[][] {
  if (discard.suit === "z") return [];
  const opts: MahjongTile[][] = [];
  const r = discard.rank;
  const same = hand.filter(t => t.suit === discard.suit);
  const has = (rk: number): MahjongTile | undefined => same.find(t => t.rank === rk);
  // (r-2, r-1) | (r-1, r+1) | (r+1, r+2)
  const windows: [number, number][] = [[r - 2, r - 1], [r - 1, r + 1], [r + 1, r + 2]];
  for (const [a, b] of windows) {
    const ta = has(a); const tb = has(b);
    if (ta && tb) opts.push([ta, tb, discard]);
  }
  return opts;
}

// 暗槓候選：手中 4 張同牌的 rank
function findAnkanRanks(hand: MahjongTile[]): MahjongTile[] {
  const counts = new Map<string, MahjongTile[]>();
  for (const t of hand) {
    const k = `${t.suit}${t.rank}`;
    const list = counts.get(k) ?? [];
    list.push(t);
    counts.set(k, list);
  }
  const out: MahjongTile[] = [];
  for (const list of counts.values()) {
    if (list.length >= 4) out.push(list[0]);
  }
  return out;
}

// 加槓候選：手中有牌可升級為已碰過的對外明刻
function findKakanTiles(hand: MahjongTile[], exposed: ExposedMeld[]): MahjongTile[] {
  const out: MahjongTile[] = [];
  for (const m of exposed) {
    if (m.kind !== "pong") continue;
    const t = m.tiles[0];
    const inHand = hand.find(h => h.suit === t.suit && h.rank === t.rank);
    if (inHand) out.push(inHand);
  }
  return out;
}

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
  const [reactLeft, setReactLeft] = useState(0);  // reaction phase countdown (s)
  const [chowPicker, setChowPicker] = useState(false);
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

  // ── 反應視窗倒數 (L2_鎖定) ─────────────────────────────────────────────
  useEffect(() => {
    if (!view || view.phase !== "pending_reactions") { setReactLeft(0); return; }
    const tick = () => setReactLeft(Math.max(0, Math.round((view.reactionDeadlineMs - Date.now()) / 100) / 10));
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [view?.phase, view?.reactionDeadlineMs]);

  // ── 動作候選計算（每次 view 變才算）────────────────────────────────── L2_實作
  const chowOptions = useMemo(() => {
    if (!view || view.phase !== "pending_reactions") return [];
    if (!view.awaitingReactionsFrom.includes(playerId)) return [];
    if (!view.lastDiscard) return [];
    return findChowOptions(view.self.hand, view.lastDiscard.tile);
  }, [view, playerId]);

  const ankanCandidates = useMemo(
    () => view ? findAnkanRanks(view.self.hand) : [],
    [view],
  );
  const kakanCandidates = useMemo(
    () => view ? findKakanTiles(view.self.hand, view.self.exposed) : [],
    [view],
  );

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
  const canChow    = inReact && chowOptions.length > 0;
  const canHu      = inReact && ld !== null;     // server validates canWin
  const canPass    = inReact;
  // 暗槓 / 加槓只在自己回合的 playing phase 可用
  const turnAction = isMyTurn && view.phase === "playing";
  const canAnkan   = turnAction && ankanCandidates.length > 0;
  const canKakan   = turnAction && kakanCandidates.length > 0;

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
          {isMyTurn
            ? "輪到你打牌"
            : inReact
              ? `可吃碰槓胡 · ${reactLeft.toFixed(1)}s`
              : `${view.currentTurn} 行動中`}
        </div>
      </div>

      {/* 吃牌選項 modal (L2_實作) — 只有可吃時顯示 */}
      {chowPicker && chowOptions.length > 0 && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-green-900 p-4 shadow-2xl">
            <div className="mb-3 text-center text-sm font-bold text-yellow-300">選擇吃牌組合</div>
            <div className="flex flex-col gap-2">
              {chowOptions.map((opt, i) => (
                <button
                  key={i}
                  onClick={() => {
                    send({ type: "chow", tiles: [opt[0], opt[1], opt[2]] });
                    setChowPicker(false);
                  }}
                  className="flex items-center justify-center gap-1 rounded-lg bg-green-800 p-2 transition hover:bg-green-700"
                >
                  {opt.map((t, j) => <TileView key={j} tile={t} selected={false} />)}
                </button>
              ))}
            </div>
            <button
              onClick={() => setChowPicker(false)}
              className="mt-3 w-full rounded-lg bg-gray-700 py-2 text-sm font-bold text-gray-200"
            >取消</button>
          </div>
        </div>
      )}

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

        <div className="grid grid-cols-4 gap-2 px-3 pb-3 sm:grid-cols-8">
          <button
            disabled={!canDiscard}
            onClick={() => pickedTile && send({ type: "discard", tile: pickedTile })}
            className="rounded-lg bg-yellow-400 py-2 font-bold text-green-950 disabled:opacity-40"
          >打牌</button>
          <button
            disabled={!canChow}
            onClick={() => setChowPicker(true)}
            title={canChow ? `${chowOptions.length} 種吃法` : "無法吃"}
            className="rounded-lg bg-cyan-600 py-2 font-bold text-white disabled:opacity-40"
          >吃{canChow && chowOptions.length > 1 ? ` (${chowOptions.length})` : ""}</button>
          <button
            disabled={!canPong}
            onClick={() => ld && send({ type: "pong", tile: ld.tile })}
            className="rounded-lg bg-blue-500 py-2 font-bold text-white disabled:opacity-40"
          >碰</button>
          <button
            disabled={!canKong}
            onClick={() => ld && send({ type: "kong", tile: ld.tile, source: "exposed" })}
            className="rounded-lg bg-purple-600 py-2 font-bold text-white disabled:opacity-40"
          >明槓</button>
          <button
            disabled={!canAnkan}
            onClick={() => ankanCandidates[0] && send({ type: "kong", tile: ankanCandidates[0], source: "concealed" })}
            title={canAnkan ? `暗槓 ${tileLabel(ankanCandidates[0])}` : "需手中 4 張同牌"}
            className="rounded-lg bg-purple-800 py-2 font-bold text-white disabled:opacity-40"
          >暗槓</button>
          <button
            disabled={!canKakan}
            onClick={() => kakanCandidates[0] && send({ type: "kong", tile: kakanCandidates[0], source: "added" })}
            title={canKakan ? `加槓 ${tileLabel(kakanCandidates[0])}` : "需有對外明刻並補進第 4 張"}
            className="rounded-lg bg-fuchsia-700 py-2 font-bold text-white disabled:opacity-40"
          >加槓</button>
          <button
            disabled={!canHu && !(isMyTurn && view.phase === "playing")}
            onClick={() => send({ type: "hu", selfDrawn: isMyTurn && view.phase === "playing" })}
            className="rounded-lg bg-red-600 py-2 font-bold text-white disabled:opacity-40"
          >{isMyTurn && view.phase === "playing" ? "自摸" : "胡"}</button>
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
