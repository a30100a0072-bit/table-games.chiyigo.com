import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Card, HeartsStateView, HeartsPassDirection, PlayerAction, SettlementResult,
} from "../shared/types";
import { GameSocket } from "../shared/GameSocket";
import { useT } from "../i18n/useT";
import type { DictKey } from "../i18n/dict";
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

// ─── card helpers (mirrors BigTwo styling) ─────────────────────────────────
const SUIT_SYMBOL: Record<string, string> = {
  spades: "♠", hearts: "♥", clubs: "♣", diamonds: "♦",
};
const SUIT_COLOR: Record<string, string> = {
  spades: "text-gray-900", hearts: "text-red-600", clubs: "text-gray-900", diamonds: "text-red-600",
};
const RANK_ORDER = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const;
const SUIT_ORDER: Record<string, number> = { clubs: 0, diamonds: 1, spades: 2, hearts: 3 };
function cardKey(c: Card) { return `${c.rank}-${c.suit}`; }
function sortHand(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => {
    const s = SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
    if (s !== 0) return s;
    return RANK_ORDER.indexOf(a.rank as typeof RANK_ORDER[number])
         - RANK_ORDER.indexOf(b.rank as typeof RANK_ORDER[number]);
  });
}

function PlayingCard({
  card, selected, dimmed, onClick, size = "md",
}: {
  card: Card;
  selected?: boolean;
  dimmed?: boolean;
  onClick?: () => void;
  size?: "sm" | "md";
}) {
  const sym = SUIT_SYMBOL[card.suit] ?? card.suit;
  const color = SUIT_COLOR[card.suit] ?? "text-gray-900";
  const dims = size === "sm" ? "h-14 w-10 rounded-md" : "h-24 w-16 rounded-lg";
  const rankFs = size === "sm" ? "text-[10px]" : "text-sm";
  const symFs = size === "sm" ? "text-base" : "text-2xl";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={[
        "relative flex flex-shrink-0 select-none flex-col border-2 bg-white shadow-md",
        "transition-transform duration-150 active:scale-95",
        dims,
        selected ? "-translate-y-5 border-yellow-400 shadow-yellow-300/60" : "border-gray-300",
        dimmed ? "opacity-40" : "",
      ].join(" ")}
    >
      <span className={`absolute left-1 top-0.5 font-bold leading-none ${rankFs} ${color}`}>{card.rank}</span>
      <span className={`absolute right-1 bottom-0.5 rotate-180 font-bold leading-none ${rankFs} ${color}`}>{card.rank}</span>
      <span className={`m-auto leading-none ${symFs} ${color}`}>{sym}</span>
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

// ─── opponent seat ─────────────────────────────────────────────────────────
function OpponentSeat({
  op, isTurn, hasPassed, passingPhase, t,
}: {
  op: HeartsStateView["opponents"][number];
  isTurn: boolean;
  hasPassed: boolean;
  passingPhase: boolean;
  t: (k: DictKey, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={[
        "rounded-full px-3 py-1 text-xs font-bold",
        isTurn ? "bg-yellow-400 text-green-950 ring-2 ring-yellow-200" : "bg-green-800 text-green-200",
      ].join(" ")}>
        {op.playerId.replace(/^oidc:/, "")} · {op.cardCount}
      </div>
      <div className="flex flex-row [&>*+*]:-ml-4">
        {Array.from({ length: Math.min(op.cardCount, 8) }).map((_, i) => (
          <CardBack key={i} small />
        ))}
      </div>
      <div className="flex items-center gap-1 text-[10px] text-green-300">
        {passingPhase ? (
          <span className={hasPassed ? "text-emerald-300" : "text-amber-300"}>
            {hasPassed ? "✓" : "…"}
          </span>
        ) : (
          <span>{t("hearts.takenCount", { n: op.takenCount })}</span>
        )}
      </div>
    </div>
  );
}

// ─── direction label ───────────────────────────────────────────────────────
function dirKey(d: HeartsPassDirection): DictKey {
  switch (d) {
    case "left":   return "hearts.dir.left";
    case "right":  return "hearts.dir.right";
    case "across": return "hearts.dir.across";
    case "none":   return "hearts.dir.none";
  }
}

// ─── main ──────────────────────────────────────────────────────────────────
export default function HeartsGameScreen({ playerId, token, roomId, wsUrl, spectator, onSettled }: Props) {
  const { t } = useT();
  const [view, setView] = useState<HeartsStateView | null>(null);
  const [connMsg, setConnMsg] = useState(t("ws.connecting"));
  const [sysMsg, setSysMsg] = useState("");
  const [timeLeft, setTimeLeft] = useState(0);
  const [picked, setPicked] = useState<Card[]>([]);   // pass-phase selection
  const socketRef = useRef<GameSocket | null>(null);
  const watching = !!spectator;

  useEffect(() => {
    const sock = new GameSocket({ url: wsUrl, playerId, gameId: roomId, token, spectator: watching });
    socketRef.current = sock;
    sock.on("connected",    ()     => setConnMsg(""));
    sock.on("disconnected", (info) => setConnMsg(info.willReconnect ? t("ws.reconnecting", { attempt: info.attempt + 1 }) : t("ws.disconnected")));
    sock.on("state", (v) => {
      const next = v as unknown as HeartsStateView;
      setView(prev => {
        const wasMine = prev?.currentTurn === playerId && prev.phase === "playing";
        const nowMine = next.currentTurn === playerId && next.phase === "playing";
        // In passing phase, "my turn" means I haven't submitted yet — beep
        // on transition into not-yet-submitted state.
        const wasPassPending = prev?.phase === "passing" && prev.self.myPass === null;
        const nowPassPending = next.phase === "passing" && next.self.myPass === null;
        if ((!wasMine && nowMine) || (!wasPassPending && nowPassPending)) sfx.myTurn();
        return next;
      });
      // Reset pass selection when phase shifts off passing OR when our pass
      // got committed (myPass moves from null → tuple).
      if (next.phase !== "passing" || next.self.myPass !== null) setPicked([]);
    });
    sock.on("settlement", (r) => {
      const me = r.players.find(p => p.playerId === playerId);
      // Mid-hand settlements carry scoreDelta=0 (chip pot saved for final);
      // still play a soft cue but skip win/lose so we don't double-cheer.
      if (me && r.matchOver !== false) (me.finalRank === 1 ? sfx.win : sfx.lose)();
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
    // Deliberate: depend only on the deadline, not whole `view`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.turnDeadlineMs]);

  const sortedHand = useMemo(
    () => view ? sortHand(view.self.hand) : [],
    // Deliberate: re-sort only when hand identity changes, not on every `view` push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view?.self.hand],
  );
  const legalSet = useMemo(() => {
    if (!view) return new Set<string>();
    return new Set(view.legalCards.map(cardKey));
    // Deliberate: depend only on legalCards array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.legalCards]);
  const passedCount = useMemo(() => {
    if (!view) return 0;
    let n = 0;
    if (view.self.myPass) n++;
    for (const op of view.opponents) if (op.hasPassed) n++;
    return n;
  }, [view]);

  if (!view) {
    return (
      <div className="flex h-full items-center justify-center bg-green-950">
        <p className="text-green-300">{connMsg || t("ws.waitingGame")}</p>
      </div>
    );
  }

  const passingPhase = view.phase === "passing";
  const playingPhase = view.phase === "playing";
  const isMyPlayTurn = playingPhase && view.currentTurn === playerId && !watching;
  const needsToPass = passingPhase && view.self.myPass === null && !watching;
  const firstTrick = playingPhase && view.currentTrick.length < 4
    && view.opponents.every(o => o.takenCount === 0) && view.self.takenCount === 0;

  function send(action: PlayerAction) {
    try { socketRef.current?.send(action); }
    catch { /* ignore */ }
  }

  function togglePick(c: Card) {
    if (!needsToPass) return;
    setPicked(prev => {
      const k = cardKey(c);
      const exists = prev.find(x => cardKey(x) === k);
      if (exists) return prev.filter(x => cardKey(x) !== k);
      if (prev.length >= 3) return prev;
      return [...prev, c];
    });
  }

  function submitPass() {
    if (picked.length !== 3) return;
    send({
      type: "hearts_pass",
      cards: [picked[0], picked[1], picked[2]],
    });
    sfx.cardPlay();
  }

  function tryPlay(c: Card) {
    if (!isMyPlayTurn) return;
    if (!legalSet.has(cardKey(c))) return;
    send({ type: "hearts_play", card: c });
    sfx.cardPlay();
  }

  // Order trick plays by seat order starting from leader (currentTrick[0])
  // so the visualisation reads N→E→S→W naturally.
  const trick = view.currentTrick;

  return (
    <>
      <RotateHint />
      <div className="fixed inset-0 flex flex-col bg-green-950 text-white">
        {/* ── top: hand header + cumulative scores ── */}
        <div className="flex items-start justify-between gap-2 px-3 pt-2 text-[11px] text-green-200">
          <div className="flex flex-col gap-1">
            <span className="rounded-full bg-green-800 px-2 py-0.5 text-[10px] font-bold text-yellow-200">
              {t("hearts.hand", { n: view.handIndex + 1 })} · {t(dirKey(view.passDirection))}
            </span>
            <span className={view.heartsBroken ? "text-red-300" : "text-green-400"}>
              {view.heartsBroken ? t("hearts.broken") : t("hearts.notBroken")}
            </span>
            {firstTrick && (
              <span className="text-amber-300">{t("hearts.firstTrick")}</span>
            )}
          </div>
          <div className="rounded-lg bg-green-900/70 px-2 py-1 text-[10px] ring-1 ring-green-700/40">
            <div className="mb-0.5 font-bold text-yellow-200">{t("hearts.cumulative")}</div>
            {Object.entries(view.cumulativeScores)
              .sort(([, a], [, b]) => a - b)
              .map(([pid, score]) => (
                <div key={pid} className="flex items-center justify-between gap-2 font-mono">
                  <span className={pid === playerId ? "text-yellow-300" : "text-green-200"}>
                    {pid.replace(/^oidc:/, "").slice(0, 8)}
                  </span>
                  <span className={score >= 50 ? "text-red-300" : "text-green-100"}>{score}</span>
                </div>
              ))}
          </div>
        </div>

        {/* ── opponents row ── */}
        <div className="mt-1 flex items-start justify-around p-2">
          {view.opponents.map(op => (
            <OpponentSeat
              key={op.playerId}
              op={op}
              isTurn={playingPhase && view.currentTurn === op.playerId}
              hasPassed={op.hasPassed}
              passingPhase={passingPhase}
              t={t}
            />
          ))}
        </div>

        {/* ── center: trick / pass prompt ── */}
        <div className="flex flex-1 items-center justify-center px-4">
          {passingPhase ? (
            <div className="flex flex-col items-center gap-3">
              {needsToPass ? (
                <>
                  <p className="text-center text-sm font-bold text-yellow-200">
                    {t("hearts.passPrompt", { dir: t(dirKey(view.passDirection)) })}
                  </p>
                  <div className="flex gap-2">
                    {picked.length === 3 ? picked.map((c, i) => (
                      <PlayingCard key={cardKey(c) + i} card={c} size="sm" />
                    )) : (
                      <div className="flex gap-2">
                        {Array.from({ length: 3 }).map((_, i) => (
                          <div key={i} className={[
                            "h-14 w-10 rounded-md border-2 border-dashed",
                            i < picked.length ? "border-yellow-300" : "border-green-700",
                          ].join(" ")}>
                            {picked[i] && <PlayingCard card={picked[i]} size="sm" />}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={picked.length !== 3}
                    onClick={submitPass}
                    className="rounded-lg bg-yellow-400 px-5 py-2 text-sm font-bold text-green-950 shadow-lg disabled:cursor-not-allowed disabled:opacity-50"
                  >{t("hearts.passSubmit")}</button>
                </>
              ) : (
                <div className="rounded-xl bg-green-900/70 px-4 py-3 text-center text-sm text-yellow-200 ring-1 ring-green-700/40">
                  <div>{watching ? t("hearts.thinking") : t("hearts.passWait")}</div>
                  <div className="mt-1 text-[11px] text-green-300">
                    {t("hearts.passWaitCount", { n: passedCount })}
                  </div>
                </div>
              )}
            </div>
          ) : playingPhase ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {trick.length === 0 ? (
                <div className="col-span-2 text-center text-xs text-green-400 sm:col-span-4">
                  {view.currentTurn === playerId ? t("hearts.yourTurn") : t("hearts.waitingFor", { id: view.currentTurn.replace(/^oidc:/, "") })}
                </div>
              ) : (
                trick.map((p, i) => (
                  <div key={p.playerId + i} className="flex flex-col items-center gap-1">
                    <span className="text-[10px] text-green-300">
                      {p.playerId === playerId ? "★" : ""}
                      {p.playerId.replace(/^oidc:/, "").slice(0, 8)}
                      {i === 0 ? " ▶" : ""}
                    </span>
                    <PlayingCard card={p.card} />
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="text-sm text-green-300">{t("ws.waitingGame")}</div>
          )}
        </div>

        {/* ── status / countdown / sys msg ── */}
        <div className="flex items-center justify-between px-4 pb-1 text-xs">
          <span className="text-green-300">
            {passingPhase
              ? (needsToPass ? t("hearts.passPrompt", { dir: t(dirKey(view.passDirection)) }) : t("hearts.passWait"))
              : (isMyPlayTurn ? t("hearts.yourTurn") : `${view.currentTurn.replace(/^oidc:/, "")} · ${t("hearts.thinking")}`)
            }
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
            {sortedHand.map(c => {
              const k = cardKey(c);
              const isPicked = picked.some(p => cardKey(p) === k);
              if (passingPhase) {
                return (
                  <PlayingCard
                    key={k}
                    card={c}
                    selected={isPicked}
                    onClick={needsToPass ? () => togglePick(c) : undefined}
                  />
                );
              }
              if (playingPhase) {
                const legal = !isMyPlayTurn || legalSet.has(k);
                return (
                  <PlayingCard
                    key={k}
                    card={c}
                    dimmed={isMyPlayTurn && !legalSet.has(k)}
                    onClick={isMyPlayTurn && legal ? () => tryPlay(c) : undefined}
                  />
                );
              }
              return <PlayingCard key={k} card={c} />;
            })}
          </div>
        </div>
      </div>
    </>
  );
}
