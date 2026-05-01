import { useEffect, useRef, useState } from "react";
import { listMyReplaysApi, getReplayApi } from "../api/http";
import type { ReplayDetail, ReplaySummary, ReplayEvent } from "../api/http";
import type { GameType } from "../shared/types";
import { useT } from "../i18n/useT";

interface Props {
  token:   string;
  onClose: () => void;
}

const ICON: Record<GameType, string> = { bigTwo: "🃏", mahjong: "🀄", texas: "♠️" };
const LABEL_KEY: Record<GameType, "select.bigTwo" | "select.mahjong" | "select.texas"> = {
  bigTwo: "select.bigTwo", mahjong: "select.mahjong", texas: "select.texas",
};

const STEP_INTERVAL_BY_SPEED = { 1: 1500, 2: 800, 4: 400 } as const;
type Speed = keyof typeof STEP_INTERVAL_BY_SPEED;

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ─── Compact visual primitives ───────────────────────────────────────────
// These deliberately mirror the in-game card / tile shapes but at smaller
// scale so we can fit a full event card into the modal without reflow.

const SUIT_SYMBOL: Record<string, string> = {
  spades: "♠", hearts: "♥", clubs: "♣", diamonds: "♦",
};
const SUIT_RED = new Set(["hearts", "diamonds"]);

function PokerCardChip({ card }: { card: { suit: string; rank: string } }) {
  return (
    <span className={[
      "inline-flex h-8 w-6 items-center justify-center rounded border bg-white text-[11px] font-bold shadow-sm",
      SUIT_RED.has(card.suit) ? "text-red-600 border-red-300" : "text-gray-900 border-gray-300",
    ].join(" ")}>
      {card.rank}{SUIT_SYMBOL[card.suit] ?? ""}
    </span>
  );
}

const MJ_SUIT_LABEL: Record<string, string> = { m: "萬", p: "筒", s: "條", z: "字", f: "花" };
const HONOR_NAMES = ["", "東", "南", "西", "北", "中", "發", "白"];

function MahjongTileChip({ tile }: { tile: { suit: string; rank: number } }) {
  const label = tile.suit === "z"
    ? (HONOR_NAMES[tile.rank] ?? `?${tile.rank}`)
    : `${tile.rank}${MJ_SUIT_LABEL[tile.suit] ?? tile.suit}`;
  const color =
    tile.suit === "z" && tile.rank === 5 ? "text-red-600"
    : tile.suit === "z" && tile.rank === 6 ? "text-green-700"
    : tile.suit === "p" ? "text-blue-700"
    : tile.suit === "s" ? "text-green-700"
    : "text-gray-900";
  return (
    <span className={[
      "inline-flex h-8 w-6 items-center justify-center rounded border border-gray-300 bg-white text-[11px] font-bold shadow-sm",
      color,
    ].join(" ")}>
      {label}
    </span>
  );
}

// ─── Event rendering ─────────────────────────────────────────────────────

interface ActionShape {
  type?: string;
  cards?: { suit: string; rank: string }[];
  combo?: string;
  tile?:  { suit: string; rank: number };
  tiles?: { suit: string; rank: number }[];
  raiseAmount?: number;
  selfDrawn?: boolean;
}

function EventCard({ ev, idx }: { ev: ReplayEvent; idx: number }) {
  if (ev.kind === "tick") {
    return (
      <div className="rounded-lg bg-amber-700/30 p-3 text-center text-xs text-amber-200">
        <span className="text-green-500">{String(idx + 1).padStart(3, "0")}</span>{" "}
        ⏱️ 反應視窗結束
      </div>
    );
  }

  const a   = (ev.action as ActionShape) ?? {};
  const who = ev.playerId ?? "?";

  let body: JSX.Element;
  let badge = "";
  switch (a.type) {
    case "play":
      badge = `▶ ${a.combo ?? "play"}`;
      body = (
        <div className="flex flex-wrap gap-1">
          {(a.cards ?? []).map((c, i) => <PokerCardChip key={i} card={c} />)}
        </div>
      );
      break;
    case "pass":
      badge = "PASS";
      body  = <span className="text-2xl">🔁</span>;
      break;
    case "discard":
      badge = "打牌";
      body  = a.tile ? <MahjongTileChip tile={a.tile} /> : <span>?</span>;
      break;
    case "chow":
      badge = "吃";
      body  = (
        <div className="flex gap-1">
          {(a.tiles ?? []).map((t, i) => <MahjongTileChip key={i} tile={t} />)}
        </div>
      );
      break;
    case "pong":
      badge = "碰";
      body  = a.tile ? <MahjongTileChip tile={a.tile} /> : <span>?</span>;
      break;
    case "kong":
      badge = "槓";
      body  = a.tile ? <MahjongTileChip tile={a.tile} /> : <span>?</span>;
      break;
    case "hu":
      badge = a.selfDrawn ? "自摸" : "胡";
      body  = <span className="text-2xl">🀄</span>;
      break;
    case "mj_pass":
      badge = "過";
      body  = <span className="text-xl text-green-400">⏭</span>;
      break;
    case "fold":
      badge = "FOLD";
      body  = <span className="text-2xl">🚫</span>;
      break;
    case "check":
      badge = "CHECK";
      body  = <span className="text-2xl">✓</span>;
      break;
    case "call":
      badge = "CALL";
      body  = <span className="text-2xl">📞</span>;
      break;
    case "raise":
      badge = `RAISE → ${a.raiseAmount ?? "?"}`;
      body  = <span className="text-2xl">📈</span>;
      break;
    default:
      badge = a.type ?? "?";
      body  = <span>{a.type}</span>;
  }

  return (
    <div className="rounded-lg bg-green-800/60 p-3">
      <div className="flex items-center justify-between text-[10px] text-green-300">
        <span>
          <span className="text-green-500">{String(idx + 1).padStart(3, "0")}</span>{" "}
          <span className="font-bold text-yellow-200">{who}</span>
        </span>
        <span className="rounded-full bg-yellow-700/40 px-2 py-0.5 font-bold text-yellow-200">{badge}</span>
      </div>
      <div className="mt-2 flex min-h-[2rem] items-center justify-center">
        {body}
      </div>
    </div>
  );
}

// ─── Main modal ──────────────────────────────────────────────────────────

export default function ReplaysModal({ token, onClose }: Props) {
  const { t } = useT();
  const [list,    setList]    = useState<ReplaySummary[] | null>(null);
  const [detail,  setDetail]  = useState<ReplayDetail | null>(null);
  const [busy,    setBusy]    = useState(false);
  const [err,     setErr]     = useState<string | null>(null);

  // Player state — only meaningful when `detail` is set.
  const [step,    setStep]    = useState(0);   // 0 = nothing played yet; events.length = all done
  const [playing, setPlaying] = useState(false);
  const [speed,   setSpeed]   = useState<Speed>(1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    listMyReplaysApi(token)
      .then(d => setList(d.replays))
      .catch(e => setErr(e instanceof Error ? e.message : "failed"));
  }, [token]);

  // Auto-advance while playing. Stops at the end (no infinite re-render).
  useEffect(() => {
    if (!playing || !detail) return;
    if (step >= detail.events.length) { setPlaying(false); return; }
    const id = setTimeout(() => setStep(s => s + 1), STEP_INTERVAL_BY_SPEED[speed]);
    timerRef.current = id;
    return () => clearTimeout(id);
  }, [playing, step, speed, detail]);

  async function open(gameId: string) {
    setBusy(true); setErr(null);
    try {
      const d = await getReplayApi(token, gameId);
      setDetail(d);
      setStep(0); setPlaying(false); setSpeed(1);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally { setBusy(false); }
  }

  function backToList() {
    if (timerRef.current) clearTimeout(timerRef.current);
    setDetail(null); setPlaying(false);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 px-4">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl bg-green-900 p-5 shadow-2xl">
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-bold text-yellow-300">
            🎬 {detail ? `${ICON[detail.gameType]} ${t(LABEL_KEY[detail.gameType])}` : t("rep.title")}
          </h2>
          <div className="flex gap-1">
            {detail && (
              <button
                onClick={backToList}
                className="rounded-full bg-green-800 px-3 py-1 text-xs text-green-200 hover:bg-green-700"
              >{t("common.back")}</button>
            )}
            <button
              onClick={onClose}
              className="rounded-full bg-green-800 px-3 py-1 text-xs text-green-200 hover:bg-green-700"
            >{t("common.close")}</button>
          </div>
        </div>

        {err && <p className="mt-2 text-xs text-red-300">{err}</p>}

        <div className="mt-3 flex-1 overflow-y-auto">
          {!detail && (
            <>
              {!list && <p className="text-center text-xs text-green-500">{t("friends.loading")}</p>}
              {list && list.length === 0 && (
                <p className="text-center text-xs text-green-500">{t("rep.empty")}</p>
              )}
              {list && list.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {list.map(r => (
                    <li
                      key={r.gameId}
                      className="flex items-center justify-between gap-2 rounded-md bg-green-800/60 px-3 py-2"
                    >
                      <div className="flex flex-1 flex-col text-xs">
                        <span className="font-bold text-yellow-100">
                          {ICON[r.gameType]} {t(LABEL_KEY[r.gameType])}
                          {r.winnerId && <span className="ml-2 text-green-300">🏆 {r.winnerId}</span>}
                        </span>
                        <span className="text-[10px] text-green-400">{fmtTime(r.finishedAt)}</span>
                        {!r.replayable && (
                          <span className="text-[10px] text-amber-400">{t("rep.versionOld")}</span>
                        )}
                      </div>
                      <button
                        onClick={() => open(r.gameId)}
                        disabled={busy}
                        className="rounded bg-purple-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-purple-500 disabled:opacity-50"
                      >{t("rep.view")}</button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {detail && (
            <div className="flex flex-col gap-3 text-xs">
              <p className="text-green-300">
                {fmtTime(detail.startedAt)} · {detail.playerIds.join(" / ")}
              </p>
              {detail.winnerId && (
                <p className="text-yellow-200">🏆 {detail.winnerId} ({detail.reason ?? "?"})</p>
              )}

              {!detail.replayable && (
                <p className="rounded bg-amber-700/40 p-2 text-[11px] text-amber-200">
                  {t("rep.versionOldDetail", {
                    saved: detail.engineVersion, current: detail.currentVersion,
                  })}
                </p>
              )}

              {detail.replayable && detail.events.length === 0 && (
                <p className="text-center italic text-green-500">{t("rep.noEvents")}</p>
              )}

              {detail.replayable && detail.events.length > 0 && (
                <>
                  {/* Current step focus card */}
                  <div className="min-h-[110px]">
                    {step === 0 ? (
                      <div className="rounded-lg bg-green-950/60 p-3 text-center text-[11px] text-green-400">
                        {t("rep.startPrompt")}
                      </div>
                    ) : (
                      <EventCard
                        ev={detail.events[step - 1]!}
                        idx={step - 1}
                      />
                    )}
                  </div>

                  {/* Scrubber */}
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-green-400">
                      {String(step).padStart(3, "0")}/{String(detail.events.length).padStart(3, "0")}
                    </span>
                    <input
                      type="range"
                      min={0} max={detail.events.length} step={1}
                      value={step}
                      onChange={e => { setPlaying(false); setStep(Number(e.target.value)); }}
                      className="flex-1 accent-yellow-400"
                    />
                  </div>

                  {/* Transport controls */}
                  <div className="flex items-center justify-center gap-2">
                    <button
                      onClick={() => { setPlaying(false); setStep(0); }}
                      className="rounded-lg bg-green-800 px-3 py-1.5 text-xs font-bold text-yellow-200 hover:bg-green-700"
                    >{t("rep.reset")}</button>
                    <button
                      onClick={() => { setPlaying(false); setStep(s => Math.max(0, s - 1)); }}
                      disabled={step === 0}
                      className="rounded-lg bg-green-800 px-3 py-1.5 text-xs font-bold text-yellow-200 hover:bg-green-700 disabled:opacity-40"
                    >◀</button>
                    <button
                      onClick={() => setPlaying(p => !p)}
                      disabled={step >= detail.events.length}
                      className="rounded-lg bg-yellow-500 px-4 py-1.5 text-xs font-bold text-green-950 hover:bg-yellow-400 disabled:opacity-40"
                    >{playing ? `❚❚ ${t("rep.pause")}` : `▶ ${t("rep.play")}`}</button>
                    <button
                      onClick={() => { setPlaying(false); setStep(s => Math.min(detail.events.length, s + 1)); }}
                      disabled={step >= detail.events.length}
                      className="rounded-lg bg-green-800 px-3 py-1.5 text-xs font-bold text-yellow-200 hover:bg-green-700 disabled:opacity-40"
                    >▶</button>
                    <select
                      value={speed}
                      onChange={e => setSpeed(Number(e.target.value) as Speed)}
                      className="rounded-lg bg-green-800 px-2 py-1.5 text-xs font-bold text-yellow-200"
                    >
                      <option value={1}>1×</option>
                      <option value={2}>2×</option>
                      <option value={4}>4×</option>
                    </select>
                  </div>

                  {/* Compact full log below for context — clicking jumps to that step. */}
                  <details className="text-[10px] text-green-300">
                    <summary className="cursor-pointer font-bold text-green-400">
                      {t("rep.fullLog")}
                    </summary>
                    <ol className="mt-2 max-h-40 overflow-y-auto rounded bg-green-950/60 p-2 font-mono">
                      {detail.events.map((e, i) => (
                        <li
                          key={i}
                          onClick={() => { setPlaying(false); setStep(i + 1); }}
                          className={[
                            "cursor-pointer truncate hover:text-yellow-200",
                            i + 1 === step ? "text-yellow-300" : "",
                          ].join(" ")}
                        >
                          <span className="text-green-500">{String(i + 1).padStart(3, "0")}</span>{" "}
                          {fmtEventOneLine(e)}
                        </li>
                      ))}
                    </ol>
                  </details>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One-line text fallback for the collapsed log. */
function fmtEventOneLine(e: ReplayEvent): string {
  if (e.kind === "tick") return "tick";
  const a = (e.action as ActionShape) ?? {};
  const who = e.playerId ?? "?";
  switch (a.type) {
    case "play":   return `${who} play ${(a.cards ?? []).length} (${a.combo ?? "?"})`;
    case "pass":   return `${who} pass`;
    case "discard":return `${who} discard ${a.tile?.rank}${a.tile?.suit}`;
    case "raise":  return `${who} raise ${a.raiseAmount ?? "?"}`;
    case "hu":     return `${who} ${a.selfDrawn ? "tsumo" : "hu"}`;
    default:       return `${who} ${a.type ?? "?"}`;
  }
}
