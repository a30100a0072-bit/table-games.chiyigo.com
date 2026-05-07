import { useEffect, useMemo, useState } from "react";
import type { GameType } from "../shared/types";
import WalletBadge from "./WalletBadge";
import StatsModal  from "./StatsModal";
import TournamentModal from "./TournamentModal";
import FriendsModal from "./FriendsModal";
import PrivateRoomModal from "./PrivateRoomModal";
import InvitesModal from "./InvitesModal";
import ReplaysModal from "./ReplaysModal";
import FeaturedReplaysModal from "./FeaturedReplaysModal";
import LocaleToggle from "./LocaleToggle";
import MuteToggle from "./MuteToggle";
import { listInvitesApi, listLiveRoomsApi } from "../api/http";
import type { LiveRoom } from "../api/http";
import { useT } from "../i18n/useT";

const ICON: Record<GameType, string> = {
  bigTwo:  "🃏",
  mahjong: "🀄",
  texas:   "♠️",
  uno:     "🎴",
  yahtzee: "🎲",
};

type LabelKey =
  | "select.bigTwo" | "select.mahjong" | "select.texas"
  | "select.uno"    | "select.yahtzee";
const LABEL_KEY: Record<GameType, LabelKey> = {
  bigTwo:  "select.bigTwo",
  mahjong: "select.mahjong",
  texas:   "select.texas",
  uno:     "select.uno",
  yahtzee: "select.yahtzee",
};
type TagKey =
  | "select.tag.bigTwo" | "select.tag.mahjong" | "select.tag.texas"
  | "select.tag.uno"    | "select.tag.yahtzee";
const TAG_KEY: Record<GameType, TagKey> = {
  bigTwo:  "select.tag.bigTwo",
  mahjong: "select.tag.mahjong",
  texas:   "select.tag.texas",
  uno:     "select.tag.uno",
  yahtzee: "select.tag.yahtzee",
};

const ANTE: Record<GameType, number> = {
  bigTwo:  100,
  mahjong: 100,
  texas:   200,
  uno:     100,
  yahtzee: 100,
};

const POKER_GAMES: GameType[] = ["bigTwo", "texas", "uno"];

const LAST_PICK_KEY = "ux.lastPickedGame";

function readLastPick(): GameType | null {
  try {
    const v = localStorage.getItem(LAST_PICK_KEY);
    if (v === "bigTwo" || v === "mahjong" || v === "texas" || v === "uno" || v === "yahtzee") {
      return v;
    }
  } catch { /* localStorage may be blocked */ }
  return null;
}

function writeLastPick(g: GameType) {
  try { localStorage.setItem(LAST_PICK_KEY, g); } catch { /* ignore */ }
}

interface Props {
  playerId:    string;
  token:       string;
  dailyBonus?: number | null;
  onPick:      (gameType: GameType, mahjongHands?: number) => void;
  onJoinedTournamentRoom?: (roomId: string, gameType: GameType) => void;
  onSpectate?: (roomId: string, gameType: GameType) => void;
  onPrivateEnter?: (roomId: string, gameType: GameType) => void;
  initialJoinToken?: string | null;
  onLogout?:   () => void;
}

export default function GameSelectScreen({
  playerId, token, dailyBonus, onPick,
  onJoinedTournamentRoom, onSpectate, onPrivateEnter, initialJoinToken, onLogout,
}: Props) {
  const { t } = useT();
  const [stats,    setStats]    = useState(false);
  const [tour,     setTour]     = useState(false);
  const [friends,  setFriends]  = useState(false);
  const [priv,     setPriv]     = useState<boolean>(!!initialJoinToken);
  const [invites,  setInvites]  = useState(false);
  const [inviteCount, setInviteCount] = useState(0);
  const [replays,  setReplays]  = useState(false);
  const [featured, setFeatured] = useState(false);
  const [sharedToken, setSharedToken] = useState<string | null>(null);
  const [specOpen, setSpecOpen] = useState(false);
  const [specRoom, setSpecRoom] = useState("");
  const [specType, setSpecType] = useState<GameType>("bigTwo");
  const [liveRooms, setLiveRooms] = useState<LiveRoom[]>([]);
  const [mjHands, setMjHands] = useState<number>(1);
  const [pokerOpen, setPokerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const MJ_HAND_OPTIONS = [1, 4, 8, 16] as const;

  const lastPick = useMemo(() => readLastPick(), []);
  const quickGame: GameType = lastPick ?? "bigTwo";

  function pick(g: GameType, hands?: number) {
    writeLastPick(g);
    onPick(g, g === "mahjong" ? (hands ?? mjHands) : undefined);
  }

  // Refresh live rooms list whenever the spectator modal opens.
  useEffect(() => {
    if (!specOpen) return;
    let alive = true;
    async function tick() {
      try {
        const r = await listLiveRoomsApi();
        if (alive) setLiveRooms(r.rooms);
      } catch { /* ignore */ }
    }
    void tick();
    const id = setInterval(tick, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, [specOpen]);

  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const r = await listInvitesApi(token);
        if (alive) setInviteCount(r.invites.length);
      } catch { /* ignore */ }
    }
    void tick();
    const id = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [token, invites, priv]);

  const initial = (playerId.replace(/^oidc:/, "") || "?").slice(0, 1).toUpperCase();

  return (
    <div className="min-h-full overflow-y-auto bg-gradient-to-b from-green-950 via-green-900 to-green-950 px-4 pb-8 pt-4">
      {/* ───── top bar ───── */}
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-yellow-500 text-base font-bold text-green-950 shadow ring-2 ring-yellow-300/50">
            {initial}
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-bold text-yellow-200">
              {t("select.greeting", { p: playerId.replace(/^oidc:/, "") })}
            </span>
            {onLogout && (
              <button
                onClick={onLogout}
                className="self-start rounded-full bg-green-800/80 px-2 py-0.5 text-[10px] text-green-300 hover:bg-red-700 hover:text-red-100"
              >{t("common.logout")}</button>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <LocaleToggle />
          <MuteToggle />
          <WalletBadge token={token} onAccountDeleted={onLogout} />
        </div>
      </div>

      {dailyBonus !== null && dailyBonus !== undefined && dailyBonus > 0 && (
        <div className="mx-auto mt-3 w-full max-w-2xl">
          <p className="inline-block rounded-full bg-yellow-700/40 px-4 py-1 text-sm text-yellow-200 ring-1 ring-yellow-500/40">
            {t("select.dailyBonus", { n: dailyBonus })}
          </p>
        </div>
      )}

      {/* ───── quick start CTA ───── */}
      <div className="mx-auto mt-5 w-full max-w-2xl">
        <button
          onClick={() => pick(quickGame, mjHands)}
          className="group flex w-full items-center justify-between gap-4 rounded-2xl bg-gradient-to-br from-yellow-400 to-amber-500 p-5 text-left shadow-2xl ring-2 ring-yellow-300/40 transition hover:from-yellow-300 hover:to-amber-400 active:scale-[0.99]"
        >
          <div className="flex min-w-0 items-center gap-4">
            <span className="text-5xl drop-shadow">{ICON[quickGame]}</span>
            <div className="flex min-w-0 flex-col">
              <span className="text-xs font-bold uppercase tracking-wide text-amber-900/80">
                {t("select.quickStart")}
              </span>
              <span className="truncate text-2xl font-extrabold text-green-950">
                {t(LABEL_KEY[quickGame])}
              </span>
              <span className="mt-0.5 truncate text-[11px] text-amber-900/80">
                {lastPick
                  ? t("select.quickStartHint", { g: t(LABEL_KEY[quickGame]) })
                  : t("select.quickStartFirst")}
              </span>
            </div>
          </div>
          <span className="hidden shrink-0 rounded-full bg-green-950 px-4 py-2 text-sm font-bold text-yellow-300 shadow group-hover:bg-green-900 sm:inline-block">
            ▶ {t("select.quickStartGo")}
          </span>
        </button>
      </div>

      {/* ───── category cards ───── */}
      <div className="mx-auto mt-6 w-full max-w-2xl">
        <h2 className="mb-2 text-xs font-bold uppercase tracking-widest text-green-300/80">
          {t("select.cat.heading")}
        </h2>
        <div className="grid grid-cols-2 gap-3">
          {/* Mahjong */}
          <button
            onClick={() => pick("mahjong", mjHands)}
            className="flex flex-col items-start gap-1 rounded-2xl bg-green-800/80 p-4 text-left shadow-lg ring-1 ring-green-700/60 transition hover:bg-green-700 active:scale-[0.98]"
          >
            <span className="text-3xl">🀄</span>
            <span className="text-base font-bold text-yellow-200">{t("select.cat.mahjong")}</span>
            <span className="text-[11px] text-green-300">{t("select.cat.mahjong.desc")}</span>
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-yellow-900/40 px-2 py-0.5 text-[10px] font-bold text-yellow-300 ring-1 ring-yellow-600/40">
              💰 {t("select.minAnte", { n: ANTE.mahjong * mjHands })}
            </span>
          </button>

          {/* Card / poker (sub-picker) */}
          <button
            onClick={() => setPokerOpen(true)}
            className="flex flex-col items-start gap-1 rounded-2xl bg-green-800/80 p-4 text-left shadow-lg ring-1 ring-green-700/60 transition hover:bg-green-700 active:scale-[0.98]"
          >
            <span className="text-3xl">🃏</span>
            <span className="text-base font-bold text-yellow-200">{t("select.cat.poker")}</span>
            <span className="text-[11px] text-green-300">{t("select.cat.poker.desc")}</span>
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-green-950/60 px-2 py-0.5 text-[10px] text-green-200">
              ♠️ ♥️ ♦️ ♣️
            </span>
          </button>

          {/* Dice */}
          <button
            onClick={() => pick("yahtzee")}
            className="flex flex-col items-start gap-1 rounded-2xl bg-green-800/80 p-4 text-left shadow-lg ring-1 ring-green-700/60 transition hover:bg-green-700 active:scale-[0.98]"
          >
            <span className="text-3xl">🎲</span>
            <span className="text-base font-bold text-yellow-200">{t("select.cat.dice")}</span>
            <span className="text-[11px] text-green-300">{t("select.cat.dice.desc")}</span>
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-yellow-900/40 px-2 py-0.5 text-[10px] font-bold text-yellow-300 ring-1 ring-yellow-600/40">
              💰 {t("select.minAnte", { n: ANTE.yahtzee })}
            </span>
          </button>

          {/* Private room */}
          {onPrivateEnter && (
            <button
              onClick={() => setPriv(true)}
              className="relative flex flex-col items-start gap-1 rounded-2xl bg-green-800/80 p-4 text-left shadow-lg ring-1 ring-green-700/60 transition hover:bg-green-700 active:scale-[0.98]"
            >
              <span className="text-3xl">🔒</span>
              <span className="text-base font-bold text-yellow-200">{t("select.cat.private")}</span>
              <span className="text-[11px] text-green-300">{t("select.cat.private.desc")}</span>
              {inviteCount > 0 && (
                <span className="absolute right-3 top-3 flex h-6 min-w-[24px] items-center justify-center rounded-full bg-red-600 px-1 text-[11px] font-bold text-white shadow">
                  {inviteCount > 9 ? "9+" : inviteCount}
                </span>
              )}
            </button>
          )}

          {/* Tournament */}
          <button
            onClick={() => setTour(true)}
            className="col-span-2 flex items-center gap-3 rounded-2xl bg-gradient-to-r from-purple-800/80 to-purple-900/80 p-4 text-left shadow-lg ring-1 ring-purple-600/40 transition hover:from-purple-700/80 hover:to-purple-800/80 active:scale-[0.98]"
          >
            <span className="text-3xl">🏆</span>
            <div className="flex flex-col">
              <span className="text-base font-bold text-yellow-200">{t("select.cat.tournament")}</span>
              <span className="text-[11px] text-purple-200">{t("select.cat.tournament.desc")}</span>
            </div>
          </button>
        </div>

        {/* mahjong hand-count picker (kept under the cards, only relevant when picking mahjong) */}
        <div className="mt-3 flex items-center gap-2 px-1">
          <span className="text-[11px] text-green-400">🀄 {t("select.mjHands")}</span>
          {MJ_HAND_OPTIONS.map(n => (
            <button
              key={n}
              onClick={() => setMjHands(n)}
              className={[
                "rounded-full px-3 py-0.5 text-xs ring-1 transition",
                mjHands === n
                  ? "bg-yellow-400 text-green-950 ring-yellow-300"
                  : "bg-green-900/50 text-green-300 ring-green-700 hover:bg-green-800",
              ].join(" ")}
            >{n}</button>
          ))}
        </div>
      </div>

      {/* ───── more drawer ───── */}
      <div className="mx-auto mt-6 w-full max-w-2xl">
        <button
          onClick={() => setMoreOpen(o => !o)}
          className="flex w-full items-center justify-between rounded-xl bg-green-900/70 px-4 py-2 text-sm font-bold text-yellow-200 ring-1 ring-green-700/40 hover:bg-green-800"
        >
          <span>＋ {t("select.more")}</span>
          <span className="text-xs text-green-400">{moreOpen ? "▲" : "▼"}</span>
        </button>
        {moreOpen && (
          <div className="mt-2 grid grid-cols-3 gap-2 rounded-xl bg-green-900/40 p-3 ring-1 ring-green-700/30 sm:grid-cols-5">
            <DrawerBtn icon="📊" label={t("select.more.stats")}    onClick={() => setStats(true)} />
            <DrawerBtn icon="👥" label={t("select.more.friends")}  onClick={() => setFriends(true)} />
            {onPrivateEnter && (
              <DrawerBtn
                icon="📨"
                label={t("select.more.invites")}
                badge={inviteCount}
                onClick={() => setInvites(true)}
              />
            )}
            <DrawerBtn icon="🎬" label={t("select.more.replays")}  onClick={() => setReplays(true)} />
            <DrawerBtn icon="⭐" label={t("select.cat.featured")}  onClick={() => setFeatured(true)} />
            {onSpectate && (
              <DrawerBtn icon="👁️" label={t("select.more.spectate")} onClick={() => setSpecOpen(true)} />
            )}
          </div>
        )}
      </div>

      {/* ───── modals (unchanged wiring) ───── */}
      {stats   && <StatsModal   playerId={playerId} token={token} onClose={() => setStats(false)} />}
      {friends && <FriendsModal token={token} onClose={() => setFriends(false)} />}
      {priv && onPrivateEnter && (
        <PrivateRoomModal
          token={token}
          onClose={() => setPriv(false)}
          onEnter={(roomId, gameType) => { setPriv(false); onPrivateEnter(roomId, gameType); }}
        />
      )}
      {invites && onPrivateEnter && (
        <InvitesModal
          token={token}
          onClose={() => setInvites(false)}
          onEnter={(roomId, gameType) => { setInvites(false); onPrivateEnter(roomId, gameType); }}
        />
      )}
      {replays && <ReplaysModal token={token} playerId={playerId} onClose={() => setReplays(false)} />}
      {featured && (
        <FeaturedReplaysModal
          onOpenShared={(tok) => { setFeatured(false); setSharedToken(tok); }}
          onClose={() => setFeatured(false)}
        />
      )}
      {sharedToken && (
        <ReplaysModal
          token={token}
          playerId={playerId}
          sharedReplayToken={sharedToken}
          onClose={() => setSharedToken(null)}
        />
      )}

      {/* ───── poker sub-picker ───── */}
      {pokerOpen && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 px-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setPokerOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-green-900 p-5 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-center text-lg font-bold text-yellow-300">🃏 {t("select.pokerPickTitle")}</h2>
            <div className="mt-4 flex flex-col gap-2">
              {POKER_GAMES.map(g => (
                <button
                  key={g}
                  onClick={() => { setPokerOpen(false); pick(g); }}
                  className="flex items-center gap-3 rounded-xl bg-green-800 p-3 text-left transition hover:bg-green-700 active:scale-[0.98]"
                >
                  <span className="text-3xl">{ICON[g]}</span>
                  <div className="flex flex-col">
                    <span className="font-bold text-yellow-200">{t(LABEL_KEY[g])}</span>
                    <span className="text-[11px] text-green-300">{t(TAG_KEY[g])}</span>
                    <span className="mt-0.5 inline-flex w-fit items-center gap-1 rounded-full bg-yellow-900/40 px-2 py-0.5 text-[10px] font-bold text-yellow-300 ring-1 ring-yellow-600/40">
                      💰 {t("select.minAnte", { n: ANTE[g] })}
                    </span>
                  </div>
                </button>
              ))}
            </div>
            <button
              onClick={() => setPokerOpen(false)}
              className="mt-4 w-full rounded-lg bg-gray-700 py-2 text-sm font-bold text-gray-200 hover:bg-gray-600"
            >{t("common.cancel")}</button>
          </div>
        </div>
      )}

      {/* ───── spectator modal (kept) ───── */}
      {specOpen && onSpectate && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 px-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-sm rounded-2xl bg-green-900 p-5 shadow-2xl">
            <h2 className="text-center text-lg font-bold text-yellow-300">👁️ {t("spec.title")}</h2>
            <p className="mt-1 text-center text-xs text-green-400">{t("spec.enterRoomId")}</p>

            <div className="mt-4 flex flex-col gap-3">
              {liveRooms.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-lg bg-green-950/60 p-2">
                  <div className="mb-1 text-[11px] text-green-400">{t("spec.live.heading")}</div>
                  <ul className="space-y-1">
                    {liveRooms.map(r => {
                      const ageMin = Math.floor((Date.now() - r.startedAt) / 60_000);
                      return (
                        <li key={r.roomId}>
                          <button
                            onClick={() => {
                              setSpecOpen(false); setSpecRoom("");
                              onSpectate(r.roomId, r.gameType);
                            }}
                            className="flex w-full items-center justify-between rounded-md bg-green-800/70 px-2 py-1 text-left text-[12px] text-yellow-100 hover:bg-green-700"
                          >
                            <span className="truncate">{ICON[r.gameType]} {r.roomId.slice(0, 8)}…</span>
                            <span className="ml-2 shrink-0 text-[10px] text-green-300">
                              {r.playerCount}/{r.capacity} · {ageMin}m
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              <select
                value={specType}
                onChange={e => setSpecType(e.target.value as GameType)}
                className="rounded-lg bg-green-800 px-3 py-2 text-sm text-yellow-100"
              >
                {(["bigTwo", "mahjong", "texas", "uno", "yahtzee"] as GameType[]).map(g => (
                  <option key={g} value={g}>{ICON[g]} {t(LABEL_KEY[g])}</option>
                ))}
              </select>
              <input
                type="text"
                value={specRoom}
                onChange={e => setSpecRoom(e.target.value.trim())}
                placeholder="room-id"
                className="rounded-lg bg-green-800 px-3 py-2 text-sm text-yellow-100 placeholder:text-green-500"
              />
            </div>

            <div className="mt-4 flex gap-2">
              <button
                onClick={() => { setSpecOpen(false); setSpecRoom(""); }}
                className="flex-1 rounded-lg bg-gray-700 py-2 text-sm font-bold text-gray-200"
              >{t("common.cancel")}</button>
              <button
                disabled={specRoom.length < 4}
                onClick={() => {
                  const id = specRoom;
                  setSpecOpen(false); setSpecRoom("");
                  onSpectate(id, specType);
                }}
                className="flex-1 rounded-lg bg-purple-600 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500"
              >{t("spec.start")}</button>
            </div>
          </div>
        </div>
      )}
      {tour && (
        <TournamentModal
          playerId={playerId}
          token={token}
          onClose={() => setTour(false)}
          onJoinedRoom={(roomId, gt) => {
            setTour(false);
            onJoinedTournamentRoom?.(roomId, gt);
          }}
        />
      )}
    </div>
  );
}

interface DrawerBtnProps {
  icon: string;
  label: string;
  badge?: number;
  onClick: () => void;
}
function DrawerBtn({ icon, label, badge, onClick }: DrawerBtnProps) {
  return (
    <button
      onClick={onClick}
      className="relative flex flex-col items-center gap-1 rounded-lg bg-green-800/70 px-2 py-3 text-center text-xs text-yellow-200 ring-1 ring-green-700/40 transition hover:bg-green-700 active:scale-95"
    >
      <span className="text-2xl">{icon}</span>
      <span className="truncate">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="absolute right-1 top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white shadow">
          {badge > 9 ? "9+" : badge}
        </span>
      )}
    </button>
  );
}
