import { formatApiError } from "../api/http";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  MahjongStateView, MahjongTile, MahjongOpponentView, ExposedMeld,
  PlayerAction, SettlementResult,
} from "../shared/types";
import { GameSocket } from "../shared/GameSocket";
import { useT } from "../i18n/useT";
import { sfx } from "../shared/sound";
import RotateHint from "./RotateHint";

// ─── chow / ankan / kakan helpers (unchanged from P1 baseline) ───────────────
function findChowOptions(hand: MahjongTile[], discard: MahjongTile): MahjongTile[][] {
  if (discard.suit === "z") return [];
  const opts: MahjongTile[][] = [];
  const r = discard.rank;
  const same = hand.filter(t => t.suit === discard.suit);
  const has = (rk: number): MahjongTile | undefined => same.find(t => t.rank === rk);
  const windows: [number, number][] = [[r - 2, r - 1], [r - 1, r + 1], [r + 1, r + 2]];
  for (const [a, b] of windows) {
    const ta = has(a); const tb = has(b);
    if (ta && tb) opts.push([ta, tb, discard]);
  }
  return opts;
}

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

// ─── tile helpers ────────────────────────────────────────────────────────────

const SUIT_LABEL: Record<string, string> = { m: "萬", p: "筒", s: "條", z: "字", f: "花" };
const HONOR_NAMES  = ["", "東", "南", "西", "北", "中", "發", "白"];
const FLOWER_NAMES = ["", "春", "夏", "秋", "冬", "梅", "蘭", "竹", "菊"];

function tileLabel(t: MahjongTile): string {
  if (t.suit === "z") return HONOR_NAMES[t.rank]  ?? `?${t.rank}`;
  if (t.suit === "f") return FLOWER_NAMES[t.rank] ?? `花${t.rank}`;
  return `${t.rank}${SUIT_LABEL[t.suit] ?? t.suit}`;
}
function tileKey(t: MahjongTile): string { return `${t.suit}${t.rank}`; }
function tileEq(a: MahjongTile, b: MahjongTile): boolean {
  return a.suit === b.suit && a.rank === b.rank;
}
function tileColor(t: MahjongTile): string {
  if (t.suit === "z") {
    if (t.rank === 5) return "text-red-600";
    if (t.rank === 6) return "text-green-700";
    return "text-gray-900";
  }
  if (t.suit === "f") {
    return t.rank <= 4 ? "text-amber-600" : "text-emerald-700";
  }
  return t.suit === "p" ? "text-blue-700" : t.suit === "s" ? "text-green-700" : "text-gray-900";
}

const SUIT_ORDER: Record<string, number> = { m: 0, p: 1, s: 2, z: 3 };
function sortTiles(tiles: MahjongTile[]): MahjongTile[] {
  return [...tiles].sort((a, b) =>
    (SUIT_ORDER[a.suit]! - SUIT_ORDER[b.suit]!) || (a.rank - b.rank),
  );
}

/**
 * Group tiles by suit (m / p / s / z) so the hand visually segments by colour.
 * Order within each group matches sortTiles output.
 */
function groupBySuit(tiles: MahjongTile[]): MahjongTile[][] {
  const groups: Record<string, MahjongTile[]> = { m: [], p: [], s: [], z: [] };
  for (const t of sortTiles(tiles)) (groups[t.suit] ?? (groups[t.suit] = [])).push(t);
  return [groups.m, groups.p, groups.s, groups.z].filter(g => g.length > 0);
}

// ─── Tile views (white-face, thick bottom border, soft inner shadow) ─────────

interface TileVProps {
  tile: MahjongTile;
  selected?: boolean;
  onClick?: () => void;
  danger?: boolean;
  dangerTitle?: string;
  size?: "sm" | "md" | "lg";
}
function TileView({ tile, selected, onClick, danger, dangerTitle, size = "md" }: TileVProps) {
  const dim = size === "sm" ? "h-10 w-7 text-[11px]"
            : size === "lg" ? "h-16 w-11 text-base"
            : "h-14 w-10 text-sm";
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={[
        "relative flex flex-shrink-0 items-center justify-center rounded-md border-2 border-b-4",
        "bg-gradient-to-b from-white to-stone-100 font-bold shadow-md",
        "transition-transform active:scale-95 disabled:cursor-default",
        dim,
        selected ? "-translate-y-3 border-yellow-400 border-b-yellow-500 ring-2 ring-yellow-300/70 shadow-yellow-300/60"
          : danger ? "border-red-500 border-b-red-600 ring-2 ring-red-400/60"
          : "border-stone-200 border-b-stone-400",
        tileColor(tile),
      ].join(" ")}
      title={danger ? dangerTitle : undefined}
    >
      {tileLabel(tile)}
    </button>
  );
}

/**
 * Tile-back: a single rectangle drawn as the back of a face-down tile.
 * Used to visualise opponents' remaining hand counts.
 */
function TileBack({ size = "sm" }: { size?: "sm" | "xs" }) {
  const dim = size === "xs" ? "h-5 w-3.5" : "h-7 w-4.5";
  return (
    <span
      className={[
        "inline-block flex-shrink-0 rounded-sm border border-emerald-900",
        "bg-gradient-to-b from-emerald-700 to-emerald-800 shadow-sm",
        dim,
      ].join(" ")}
    />
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
            "flex h-9 w-6 items-center justify-center rounded-sm border-b-2 text-[10px] font-bold",
            concealed && (i === 0 || i === 3)
              ? "border-emerald-900 bg-gradient-to-b from-emerald-700 to-emerald-800 text-emerald-700"
              : `border-stone-400 bg-gradient-to-b from-white to-stone-100 ${tileColor(t)}`,
          ].join(" ")}
        >
          {concealed && (i === 0 || i === 3) ? "" : tileLabel(t)}
        </div>
      ))}
    </div>
  );
}

// ─── Seat (per-opponent) ─────────────────────────────────────────────────────

type SeatPos = "across" | "right" | "left";

interface SeatProps {
  pos: SeatPos;
  op: MahjongOpponentView;
  isCurrentTurn: boolean;
  isBanker: boolean;
}
function SeatView({ pos, op, isCurrentTurn, isBanker }: SeatProps) {
  const { t } = useT();
  const initial = (op.playerId.replace(/^oidc:/, "") || "?").slice(0, 1).toUpperCase();
  // Limit hand-back stack visualisation to keep narrow seats legible.
  const stackCount = Math.min(op.handCount, 16);
  const seatLabel = pos === "across" ? t("mj.seat.across")
                  : pos === "right"  ? t("mj.seat.right")
                  :                    t("mj.seat.left");
  // Conservative tenpai-likely heuristic for 放槍提示: opponents we can't
  // see hands for, but the count of exposed melds is a public signal —
  // 3+ exposed (chow/pong/kong) means they're 1–2 tiles from a winning
  // structure. Engine-side discarder attribution would be more accurate
  // but is out of P5 scope (UI-only).
  const dangerLevel: 0 | 1 | 2 = op.exposed.length >= 3 ? 2 : op.exposed.length >= 2 ? 1 : 0;

  const wrapper = pos === "across"
    ? "flex flex-col items-center gap-1"
    : pos === "right"
      ? "flex flex-col items-center gap-1"
      : "flex flex-col items-center gap-1";

  return (
    <div className={wrapper}>
      <div className="flex items-center gap-1.5">
        <div className={[
          "relative flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold",
          isCurrentTurn
            ? "bg-yellow-400 text-green-950 ring-2 ring-yellow-300/80 shadow-lg"
            : "bg-green-700 text-yellow-100 ring-1 ring-green-600",
        ].join(" ")}>
          {initial}
          {isBanker && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-600 px-1 text-[9px] font-bold text-white shadow">
              {t("mj.banker")}
            </span>
          )}
          {dangerLevel > 0 && (
            <span
              className={[
                "absolute -left-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full text-[9px] shadow ring-1",
                dangerLevel === 2
                  ? "bg-red-600 text-white ring-red-300 animate-pulse"
                  : "bg-amber-500 text-amber-50 ring-amber-300",
              ].join(" ")}
              title={t(dangerLevel === 2 ? "mj.danger.high" : "mj.danger.med")}
              aria-label={t(dangerLevel === 2 ? "mj.danger.high" : "mj.danger.med")}
            >⚠</span>
          )}
        </div>
        <div className="flex flex-col leading-tight">
          <span className="max-w-[60px] truncate text-[10px] font-bold text-yellow-100">
            {op.playerId.replace(/^oidc:/, "")}
          </span>
          <span className="text-[9px] text-green-300">{seatLabel}</span>
        </div>
      </div>

      {/* Hand-back stack visualisation */}
      <div className={[
        "flex flex-wrap gap-[1px]",
        pos === "across" ? "max-w-[220px] justify-center" : "max-w-[80px] justify-center",
      ].join(" ")}>
        {Array.from({ length: stackCount }).map((_, i) => <TileBack key={i} size="xs" />)}
      </div>
      <span className="text-[9px] text-green-400">×{op.handCount}{op.flowersCount > 0 ? ` · 🌸${op.flowersCount}` : ""}</span>

      {op.exposed.length > 0 && (
        <div className="flex flex-wrap justify-center gap-1">
          {op.exposed.map((m, i) => <MeldView key={i} meld={m} />)}
        </div>
      )}
    </div>
  );
}

// ─── main ────────────────────────────────────────────────────────────────────

interface Props {
  playerId:   string;
  token:      string;
  roomId:     string;
  wsUrl:      string;
  spectator?: boolean;
  onSettled:  (result: SettlementResult) => void;
}

export default function MahjongGameScreen({ playerId, token, roomId, wsUrl, spectator, onSettled }: Props) {
  const watching = !!spectator;
  const { t } = useT();
  const [view,     setView]     = useState<MahjongStateView | null>(null);
  const [picked,   setPicked]   = useState<string | null>(null);
  const [sysMsg,   setSysMsg]   = useState("");
  const [connMsg,  setConnMsg]  = useState(t("ws.connecting"));
  const [reactLeft, setReactLeft] = useState(0);
  const [chowPicker, setChowPicker] = useState(false);
  const socketRef = useRef<GameSocket | null>(null);

  useEffect(() => {
    const sock = new GameSocket({ url: wsUrl, playerId, gameId: roomId, token, spectator: watching });
    socketRef.current = sock;

    sock.on("connected",    ()    => setConnMsg(""));
    sock.on("disconnected", (i)   => setConnMsg(i.willReconnect ? t("ws.reconnecting", { attempt: i.attempt + 1 }) : t("ws.disconnected")));
    sock.on("state",        (v)   => {
      const next = v as unknown as MahjongStateView;
      setView(prev => {
        const wasMine = prev?.currentTurn === playerId && prev.phase === "playing";
        const nowMine = next.currentTurn === playerId && next.phase === "playing";
        const wasReact = prev?.phase === "pending_reactions" && prev.awaitingReactionsFrom.includes(playerId);
        const nowReact = next.phase === "pending_reactions" && next.awaitingReactionsFrom.includes(playerId);
        if ((!wasMine && nowMine) || (!wasReact && nowReact)) sfx.myTurn();
        return next;
      });
      setPicked(null);
    });
    sock.on("settlement",   (r)   => {
      const me = r.players.find(p => p.playerId === playerId);
      if (me) (me.finalRank === 1 ? sfx.win : sfx.lose)();
      onSettled(r);
    });
    sock.on("system",       (m)   => setSysMsg(m));
    sock.on("error",        (m)   => setSysMsg(m));

    sock.connect();
    return () => sock.disconnect();
    // Socket lifecycle: rebind only on identity change. `t` / `view` / `watching` snapshotted via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl, playerId, roomId, token, onSettled]);

  function send(action: PlayerAction) {
    try {
      socketRef.current?.send(action);
      if (action.type === "mj_pass") sfx.pass();
      else                            sfx.cardPlay();
    }
    catch (err) { setSysMsg(formatApiError(err, t)); }
  }

  useEffect(() => {
    if (!view || view.phase !== "pending_reactions") { setReactLeft(0); return; }
    const tick = () => setReactLeft(Math.max(0, Math.round((view.reactionDeadlineMs - Date.now()) / 100) / 10));
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
    // Deliberate: depend only on phase + deadline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.phase, view?.reactionDeadlineMs]);

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
        <p className="text-green-300">{connMsg || t("ws.waitingGame")}</p>
      </div>
    );

  const isMyTurn  = view.currentTurn === playerId;
  const inReact   = view.phase === "pending_reactions" && view.awaitingReactionsFrom.includes(playerId);
  const ld = view.lastDiscard;

  // Drawn-tile isolation: when it's my turn during play, the most-recently
  // drawn tile sits at the tail of the *unsorted* hand. Split it out so the
  // player can spot the new tile at a glance, the rest is suit-grouped.
  let drawnTile: MahjongTile | null = null;
  let restHand = view.self.hand;
  if (isMyTurn && view.phase === "playing" && view.self.hand.length > 0) {
    drawnTile = view.self.hand[view.self.hand.length - 1];
    restHand  = view.self.hand.slice(0, -1);
  }
  const handGroups = groupBySuit(restHand);
  const pickedTile = drawnTile && tileKey(drawnTile) === picked
    ? drawnTile
    : sortTiles(restHand).find(tile => tileKey(tile) === picked) ?? null;

  // Defensive highlighting: opponents with >=3 melds → mark their suits red.
  const dangerSuits = new Set<string>();
  for (const op of view.opponents) {
    if (op.exposed.length < 3) continue;
    for (const m of op.exposed) {
      const s = m.tiles[0]?.suit;
      if (s && s !== "f") dangerSuits.add(s);
    }
  }

  // Banker resolution: dealerIdx is an absolute seat index. Without explicit
  // seat-to-player mapping in the view, we mark the banker only when the
  // current viewer's "self" seat matches dealerIdx (i.e. self is dealer) —
  // for opponents we fall back to "no banker marker shown". This is a known
  // limitation; richer marking needs a backend seat-map field.
  const selfIsBanker = !!view.match && view.match.dealerIdx === 0; // assumes self at idx 0
  const opp = view.opponents;

  // Map opponents to seat positions: [0] right, [1] across, [2] left.
  const seatRight  = opp[0] ?? null;
  const seatAcross = opp[1] ?? null;
  const seatLeft   = opp[2] ?? null;

  const canDiscard = isMyTurn && pickedTile !== null && view.phase === "playing";
  const canPong    = inReact && ld !== null && view.self.hand.filter(t => tileEq(t, ld.tile)).length >= 2;
  const canKong    = inReact && ld !== null && view.self.hand.filter(t => tileEq(t, ld.tile)).length >= 3;
  const canChow    = inReact && chowOptions.length > 0;
  const canHu      = inReact && ld !== null;
  const canPass    = inReact;
  const turnAction = isMyTurn && view.phase === "playing";
  const canAnkan   = turnAction && ankanCandidates.length > 0;
  const canKakan   = turnAction && kakanCandidates.length > 0;

  return (
    <div className="flex h-full flex-col bg-gradient-to-b from-emerald-950 via-green-900 to-emerald-950 text-white">
      <RotateHint />
      {(connMsg || sysMsg) && (
        <div className="bg-yellow-700 px-4 py-1 text-center text-xs text-yellow-100">
          {connMsg || sysMsg}
        </div>
      )}
      {watching && (
        <div className="bg-purple-700 px-4 py-1 text-center text-xs font-bold text-purple-50">
          👁️ {t("spec.watching")}
        </div>
      )}

      {/* ─── Table area: 3×3 grid (across-top / left-mid / river-mid / right-mid / self-bottom) ─── */}
      <div className="flex-1 overflow-hidden p-2">
        <div className="grid h-full grid-cols-[minmax(80px,auto)_1fr_minmax(80px,auto)] grid-rows-[auto_1fr_auto] gap-2">
          <div /> {/* top-left corner */}
          <div className="flex justify-center">
            {seatAcross && (
              <SeatView pos="across" op={seatAcross}
                isCurrentTurn={view.currentTurn === seatAcross.playerId}
                isBanker={!!view.match && view.match.dealerIdx === 2} />
            )}
          </div>
          <div /> {/* top-right corner */}

          <div className="flex flex-col items-center justify-center">
            {seatLeft && (
              <SeatView pos="left" op={seatLeft}
                isCurrentTurn={view.currentTurn === seatLeft.playerId}
                isBanker={!!view.match && view.match.dealerIdx === 3} />
            )}
          </div>

          {/* River — central area showing last discard, match progress, turn pill, tenpai */}
          <div className="flex flex-col items-center justify-center gap-2 rounded-2xl bg-emerald-900/40 ring-1 ring-emerald-700/40 p-3">
            {view.match && view.match.targetHands > 1 && (
              <div className="flex items-center gap-2 rounded-full bg-green-900/60 px-3 py-0.5 ring-1 ring-green-700">
                <span className="text-[10px] font-bold text-yellow-300">
                  {t("mj.handProgress", { n: view.match.handNumber, m: view.match.targetHands })}
                </span>
                {view.match.bankerStreak > 0 && (
                  <span className="rounded-full bg-amber-600 px-2 py-0.5 text-[9px] font-bold text-amber-50">
                    {t("mj.bankerStreak", { n: view.match.bankerStreak })}
                  </span>
                )}
              </div>
            )}

            <div className="text-[10px] text-green-400">
              {t("mj.wallRemaining", { n: view.wall.remaining, phase: view.phase })}
            </div>

            {ld
              ? (
                <div className="flex flex-col items-center gap-1">
                  <div className="text-[10px] text-green-200">
                    {t("mj.discardedBy", { p: ld.playerId.replace(/^oidc:/, "") })}
                  </div>
                  <TileView tile={ld.tile} size="lg" />
                </div>
              )
              : <div className="text-xs text-green-500">{t("mj.noDiscard")}</div>}

            <div className={[
              "rounded-full px-3 py-0.5 text-xs font-bold",
              isMyTurn ? "bg-yellow-400 text-green-950"
              : inReact ? "bg-blue-500 text-white"
              : "bg-green-800 text-green-300",
            ].join(" ")}>
              {isMyTurn
                ? t("mj.yourTurnToDiscard")
                : inReact
                  ? t("mj.canReact", { n: reactLeft.toFixed(1) })
                  : t("mj.theirTurn", { p: view.currentTurn.replace(/^oidc:/, "") })}
            </div>

            {!watching && view.self.shanten === 0 && view.self.winningTiles.length > 0 && (
              <div className="rounded-lg bg-amber-500/20 ring-1 ring-amber-300 px-2 py-1">
                <div className="flex items-center gap-1">
                  <span className="text-[10px] font-bold text-amber-200">{t("mj.tenpai")}</span>
                  <div className="flex flex-wrap gap-0.5">
                    {view.self.winningTiles.map((wt, i) => (
                      <span key={i} className="scale-75"><TileView tile={wt} size="sm" /></span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col items-center justify-center">
            {seatRight && (
              <SeatView pos="right" op={seatRight}
                isCurrentTurn={view.currentTurn === seatRight.playerId}
                isBanker={!!view.match && view.match.dealerIdx === 1} />
            )}
          </div>
        </div>
      </div>

      {/* Chow picker modal */}
      {chowPicker && chowOptions.length > 0 && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-green-900 p-4 shadow-2xl">
            <div className="mb-3 text-center text-sm font-bold text-yellow-300">{t("mj.pickChow")}</div>
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
                  {opt.map((t, j) => <TileView key={j} tile={t} />)}
                </button>
              ))}
            </div>
            <button
              onClick={() => setChowPicker(false)}
              className="mt-3 w-full rounded-lg bg-gray-700 py-2 text-sm font-bold text-gray-200"
            >{t("common.cancel")}</button>
          </div>
        </div>
      )}

      {/* ─── Self area (bottom): name+banker / flowers / exposed / hand+drawn / actions ─── */}
      <div className="shrink-0 border-t-2 border-yellow-600/30 bg-emerald-950/60 px-2 pb-2 pt-1">
        <div className="flex items-center justify-between px-1 pb-1">
          <div className="flex items-center gap-2">
            <div className={[
              "relative flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold",
              isMyTurn || inReact
                ? "bg-yellow-400 text-green-950 ring-2 ring-yellow-300/80"
                : "bg-green-700 text-yellow-100 ring-1 ring-green-600",
            ].join(" ")}>
              {(playerId.replace(/^oidc:/, "") || "?").slice(0, 1).toUpperCase()}
              {selfIsBanker && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-600 px-1 text-[9px] font-bold text-white shadow">
                  {t("mj.banker")}
                </span>
              )}
            </div>
            <div className="flex flex-col leading-tight">
              <span className="text-xs font-bold text-yellow-100">{playerId.replace(/^oidc:/, "")}</span>
              <span className="text-[10px] text-green-300">{t("mj.seat.self")}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {view.self.flowers.length > 0 && (
              <div className="flex items-center gap-0.5 text-[10px] text-amber-300">
                <span>🌸</span>
                {view.self.flowers.map((f, i) => (
                  <span key={i} className="rounded bg-amber-700/40 px-1 font-bold">
                    {FLOWER_NAMES[f.rank] ?? `花${f.rank}`}
                  </span>
                ))}
              </div>
            )}
            {view.self.exposed.length > 0 && (
              <div className="flex gap-1">
                {view.self.exposed.map((m, i) => <MeldView key={i} meld={m} />)}
              </div>
            )}
          </div>
        </div>

        {/* Hand: suit-grouped + drawn tile isolated to the right */}
        <div className="hand-scroll flex items-end gap-3 overflow-x-auto px-1 pb-2 pt-3">
          {handGroups.map((group, gi) => (
            <div key={gi} className="flex gap-1">
              {group.map(tile => (
                <TileView
                  key={tileKey(tile)}
                  tile={tile}
                  selected={picked === tileKey(tile)}
                  danger={isMyTurn && dangerSuits.has(tile.suit)}
                  dangerTitle={t("mj.dangerSuit")}
                  onClick={() => setPicked(p => p === tileKey(tile) ? null : tileKey(tile))}
                />
              ))}
            </div>
          ))}
          {drawnTile && (
            <div className="ml-auto flex flex-col items-center gap-0.5 rounded-lg bg-yellow-500/10 px-2 pt-1 ring-1 ring-yellow-400/40">
              <span className="text-[9px] font-bold text-yellow-300">{t("mj.drawnTile")}</span>
              <TileView
                tile={drawnTile}
                selected={picked === tileKey(drawnTile)}
                danger={isMyTurn && dangerSuits.has(drawnTile.suit)}
                dangerTitle={t("mj.dangerSuit")}
                onClick={() => setPicked(p => p === tileKey(drawnTile!) ? null : tileKey(drawnTile!))}
              />
            </div>
          )}
        </div>

        <ActionBar
          mode={inReact ? "react" : turnAction ? "turn" : "idle"}
          reactLeft={reactLeft}
          // `send` closes over socketRef.current but only reads it on invocation, not during render.
          // eslint-disable-next-line react-hooks/refs
          actions={buildActions({
            t, view, isMyTurn, inReact, turnAction,
            canDiscard, canPong, canKong, canChow, canHu, canPass,
            canAnkan, canKakan,
            chowOptions, ankanCandidates, kakanCandidates, ld,
            pickedTile, send, openChowPicker: () => setChowPicker(true),
          })}
        />
      </div>
    </div>
  );
}

// ─── Contextual action bar (P3) ──────────────────────────────────────────────

interface ActionDescriptor {
  key: string;
  label: string;
  /** Lower number = lower priority. Buttons render left→right ascending so
   *  high-priority (胡/自摸) sits on the right where the thumb naturally goes
   *  on a landscape phone hold. */
  priority: number;
  onClick: () => void;
  /** Tailwind classes for the colour tier. */
  color: string;
  /** Optional emphasis for primary actions (extra ring + scale on hover). */
  primary?: boolean;
}

interface BuildArgs {
  t: ReturnType<typeof useT>["t"];
  view: MahjongStateView;
  isMyTurn: boolean;
  inReact: boolean;
  turnAction: boolean;
  canDiscard: boolean;
  canPong: boolean;
  canKong: boolean;
  canChow: boolean;
  canHu: boolean;
  canPass: boolean;
  canAnkan: boolean;
  canKakan: boolean;
  chowOptions: MahjongTile[][];
  ankanCandidates: MahjongTile[];
  kakanCandidates: MahjongTile[];
  ld: MahjongStateView["lastDiscard"];
  pickedTile: MahjongTile | null;
  send: (a: PlayerAction) => void;
  openChowPicker: () => void;
}

function buildActions(a: BuildArgs): ActionDescriptor[] {
  const out: ActionDescriptor[] = [];
  const PASS_GREY    = "bg-gray-600 text-gray-200 hover:bg-gray-500";
  const DISCARD_GOLD = "bg-yellow-400 text-green-950 hover:bg-yellow-300";
  const CHOW_CYAN    = "bg-cyan-600 text-white hover:bg-cyan-500";
  const PONG_BLUE    = "bg-blue-500 text-white hover:bg-blue-400";
  const KONG_PURPLE  = "bg-purple-600 text-white hover:bg-purple-500";
  const ANKAN_PURPLE = "bg-purple-800 text-white hover:bg-purple-700";
  const KAKAN_FUCH   = "bg-fuchsia-700 text-white hover:bg-fuchsia-600";
  const HU_GOLD_RED  = "bg-gradient-to-br from-red-500 to-amber-500 text-white shadow-yellow-300/60 ring-2 ring-yellow-300/70 hover:from-red-400 hover:to-amber-400";

  // Reaction window — only the reaction-eligible actions are drawn.
  if (a.inReact) {
    if (a.canPass) {
      out.push({
        key: "pass", priority: 1, color: PASS_GREY,
        label: a.t("mj.pass"),
        onClick: () => a.send({ type: "mj_pass" }),
      });
    }
    if (a.canChow) {
      out.push({
        key: "chow", priority: 2, color: CHOW_CYAN,
        label: a.chowOptions.length > 1 ? a.t("mj.chowN", { n: a.chowOptions.length }) : a.t("mj.chow"),
        onClick: a.openChowPicker,
      });
    }
    if (a.canPong) {
      out.push({
        key: "pong", priority: 3, color: PONG_BLUE,
        label: a.t("mj.pong"),
        onClick: () => a.ld && a.send({ type: "pong", tile: a.ld.tile }),
      });
    }
    if (a.canKong) {
      out.push({
        key: "kong", priority: 4, color: KONG_PURPLE,
        label: a.t("mj.kong"),
        onClick: () => a.ld && a.send({ type: "kong", tile: a.ld.tile, source: "exposed" }),
      });
    }
    if (a.canHu) {
      out.push({
        key: "hu", priority: 5, color: HU_GOLD_RED, primary: true,
        label: a.t("mj.hu"),
        onClick: () => a.send({ type: "hu", selfDrawn: false }),
      });
    }
    return out.sort((x, y) => x.priority - y.priority);
  }

  // Own turn during play — discard primary; ankan/kakan/tsumo when applicable.
  if (a.turnAction) {
    out.push({
      key: "discard", priority: 1, color: DISCARD_GOLD, primary: true,
      label: a.pickedTile ? a.t("mj.discard") : a.t("mj.discard"),
      onClick: () => { if (a.pickedTile) a.send({ type: "discard", tile: a.pickedTile }); },
    });
    if (a.canAnkan) {
      out.push({
        key: "ankan", priority: 2, color: ANKAN_PURPLE,
        label: a.t("mj.ankan"),
        onClick: () => a.ankanCandidates[0] && a.send({ type: "kong", tile: a.ankanCandidates[0], source: "concealed" }),
      });
    }
    if (a.canKakan) {
      out.push({
        key: "kakan", priority: 3, color: KAKAN_FUCH,
        label: a.t("mj.kakan"),
        onClick: () => a.kakanCandidates[0] && a.send({ type: "kong", tile: a.kakanCandidates[0], source: "added" }),
      });
    }
    // Self-drawn winning attempt — server validates can-win, so always offer
    // the option during own turn while in playing phase.
    out.push({
      key: "tsumo", priority: 4, color: HU_GOLD_RED, primary: true,
      label: a.t("mj.tsumo"),
      onClick: () => a.send({ type: "hu", selfDrawn: true }),
    });
    return out.sort((x, y) => x.priority - y.priority);
  }

  return out; // idle — opponent's turn, no actions
}

interface ActionBarProps {
  mode: "react" | "turn" | "idle";
  reactLeft: number;
  actions: ActionDescriptor[];
}
function ActionBar({ mode, reactLeft, actions }: ActionBarProps) {
  if (actions.length === 0 && mode !== "react") {
    return <div className="h-12" />; // reserve a strip so the layout doesn't jump
  }

  // Reaction phase: floating, elevated panel with countdown progress bar.
  if (mode === "react") {
    // 8s reaction window assumed (matches MahjongStateMachine). Bar fills
    // green→amber→red as time runs out.
    const total = 8;
    const pct = Math.max(0, Math.min(100, (reactLeft / total) * 100));
    const barColor = pct > 50 ? "bg-emerald-400" : pct > 25 ? "bg-amber-400" : "bg-red-500";
    return (
      <div className="relative -mt-2 rounded-xl bg-emerald-950/90 ring-2 ring-yellow-400/50 p-2 shadow-2xl shadow-yellow-300/20 backdrop-blur">
        <div className="mb-1.5 h-1 overflow-hidden rounded-full bg-emerald-900">
          <div className={["h-full transition-all", barColor].join(" ")} style={{ width: `${pct}%` }} />
        </div>
        <div className="flex items-center gap-2">
          {actions.map(act => (
            <ActionButton key={act.key} action={act} large />
          ))}
        </div>
      </div>
    );
  }

  // Own turn — inline row, primary actions slightly larger.
  return (
    <div className="flex items-center gap-2">
      {actions.map(act => (
        <ActionButton key={act.key} action={act} large={false} />
      ))}
    </div>
  );
}

function ActionButton({ action, large }: { action: ActionDescriptor; large: boolean }) {
  const size = large
    ? (action.primary ? "min-w-[88px] py-3 text-base" : "min-w-[72px] py-3 text-sm")
    : (action.primary ? "min-w-[80px] py-2.5 text-sm" : "min-w-[64px] py-2 text-sm");
  return (
    <button
      onClick={action.onClick}
      className={[
        "tap44 flex-1 rounded-lg font-bold shadow-md transition active:scale-95",
        size,
        action.color,
        action.primary ? "scale-105" : "",
      ].join(" ")}
    >
      {action.label}
    </button>
  );
}
