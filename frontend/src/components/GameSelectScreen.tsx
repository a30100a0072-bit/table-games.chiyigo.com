import { useEffect, useState } from "react";
import { GAME_TYPES } from "../shared/types";
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
};

const LABEL_KEY: Record<GameType, "select.bigTwo" | "select.mahjong" | "select.texas"> = {
  bigTwo:  "select.bigTwo",
  mahjong: "select.mahjong",
  texas:   "select.texas",
};
const TAG_KEY: Record<GameType, "select.tag.bigTwo" | "select.tag.mahjong" | "select.tag.texas"> = {
  bigTwo:  "select.tag.bigTwo",
  mahjong: "select.tag.mahjong",
  texas:   "select.tag.texas",
};

const ANTE: Record<GameType, number> = {
  bigTwo:  100,
  mahjong: 100,
  texas:   200,
};

interface Props {
  playerId:    string;
  token:       string;
  dailyBonus?: number | null;
  onPick:      (gameType: GameType, mahjongHands?: number) => void;
  onJoinedTournamentRoom?: (roomId: string, gameType: GameType) => void;
  onSpectate?: (roomId: string, gameType: GameType) => void;
  onPrivateEnter?: (roomId: string, gameType: GameType) => void;
  /** When the user landed with `?join=<token>` we open the private-room
   *  modal pre-populated on the join tab. */
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
  const MJ_HAND_OPTIONS = [1, 4, 8, 16] as const;

  // Refresh live rooms list whenever the spectator modal opens; cheap +
  // accurate enough for an opt-in panel.                                  // L2_實作
  useEffect(() => {
    if (!specOpen) return;
    let alive = true;
    async function tick() {
      try {
        const r = await listLiveRoomsApi();
        if (alive) setLiveRooms(r.rooms);
      } catch { /* ignore — modal still allows manual roomId entry */ }
    }
    void tick();
    const id = setInterval(tick, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, [specOpen]);

  // Poll incoming invites every 30 s so the badge stays roughly current
  // without us having to wire WS notifications. The cost is one D1 query
  // per minute per logged-in tab — fine at our scale.
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const r = await listInvitesApi(token);
        if (alive) setInviteCount(r.invites.length);
      } catch { /* ignore network blips; badge just won't update this tick */ }
    }
    void tick();
    const id = setInterval(tick, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, [token, invites, priv]);   // refresh after closing related modals
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-green-950 p-6">
      <div className="absolute left-4 top-4 flex items-center gap-2">
        <button
          onClick={() => setStats(true)}
          className="rounded-full bg-green-800 px-4 py-1.5 text-sm font-bold text-yellow-200 shadow-lg transition hover:bg-green-700 active:scale-95"
        >
          {t("select.stats")}
        </button>
        <button
          onClick={() => setTour(true)}
          className="rounded-full bg-green-800 px-4 py-1.5 text-sm font-bold text-yellow-200 shadow-lg transition hover:bg-green-700 active:scale-95"
        >
          🏆
        </button>
        <button
          onClick={() => setFriends(true)}
          title={t("friends.title")}
          className="rounded-full bg-green-800 px-4 py-1.5 text-sm font-bold text-yellow-200 shadow-lg transition hover:bg-green-700 active:scale-95"
        >
          👥
        </button>
        {onPrivateEnter && (
          <button
            onClick={() => setPriv(true)}
            title={t("priv.title")}
            className="rounded-full bg-green-800 px-4 py-1.5 text-sm font-bold text-yellow-200 shadow-lg transition hover:bg-green-700 active:scale-95"
          >
            🔒
          </button>
        )}
        {onPrivateEnter && (
          <button
            onClick={() => setInvites(true)}
            title={t("inv.title")}
            className="relative rounded-full bg-green-800 px-4 py-1.5 text-sm font-bold text-yellow-200 shadow-lg transition hover:bg-green-700 active:scale-95"
          >
            📨
            {inviteCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white shadow">
                {inviteCount > 9 ? "9+" : inviteCount}
              </span>
            )}
          </button>
        )}
        <button
          onClick={() => setReplays(true)}
          title={t("rep.title")}
          className="rounded-full bg-green-800 px-4 py-1.5 text-sm font-bold text-yellow-200 shadow-lg transition hover:bg-green-700 active:scale-95"
        >
          🎬
        </button>
        <button
          onClick={() => setFeatured(true)}
          title={t("rep.featured")}
          className="rounded-full bg-green-800 px-4 py-1.5 text-sm font-bold text-yellow-200 shadow-lg transition hover:bg-green-700 active:scale-95"
        >
          ⭐
        </button>
        {onSpectate && (
          <button
            onClick={() => setSpecOpen(true)}
            title={t("spec.title")}
            className="rounded-full bg-green-800 px-4 py-1.5 text-sm font-bold text-yellow-200 shadow-lg transition hover:bg-green-700 active:scale-95"
          >
            👁️
          </button>
        )}
        <LocaleToggle />
        <MuteToggle />
      </div>
      <div className="absolute right-4 top-4">
        <WalletBadge token={token} onAccountDeleted={onLogout} />
      </div>
      {stats && <StatsModal playerId={playerId} token={token} onClose={() => setStats(false)} />}
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
      {specOpen && onSpectate && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-green-900 p-5 shadow-2xl">
            <h2 className="text-center text-lg font-bold text-yellow-300">👁️ {t("spec.title")}</h2>
            <p className="mt-1 text-center text-xs text-green-400">{t("spec.enterRoomId")}</p>

            <div className="mt-4 flex flex-col gap-3">
              {liveRooms.length > 0 && (
                <div className="max-h-40 overflow-y-auto rounded-lg bg-green-950/60 p-2">
                  <div className="mb-1 text-[11px] text-green-400">進行中（點擊進場）</div>
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
                {GAME_TYPES.map(g => (
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

      <div className="text-center">
        <h1 className="text-2xl font-bold text-yellow-300">{t("select.title")}</h1>
        <div className="mt-1 flex items-center justify-center gap-2 text-sm text-green-300">
          <span>{playerId}</span>
          {onLogout && (
            <button
              onClick={onLogout}
              className="rounded-full bg-green-800/80 px-2 py-0.5 text-[10px] text-green-300 hover:bg-red-700 hover:text-red-100"
            >{t("common.logout")}</button>
          )}
        </div>
        {dailyBonus !== null && dailyBonus !== undefined && dailyBonus > 0 && (
          <p className="mt-3 inline-block rounded-full bg-yellow-700/40 px-4 py-1 text-sm text-yellow-200 ring-1 ring-yellow-500/40">
            {t("select.dailyBonus", { n: dailyBonus })}
          </p>
        )}
      </div>

      <div className="flex w-full max-w-md flex-col gap-3">
        {GAME_TYPES.map(g => {
          const ante = ANTE[g] * (g === "mahjong" ? mjHands : 1);
          return (
            <div key={g} className="flex flex-col gap-2">
              <button
                onClick={() => onPick(g, g === "mahjong" ? mjHands : undefined)}
                className="flex items-center gap-4 rounded-2xl bg-green-900 p-4 text-left shadow-lg transition hover:bg-green-800 active:scale-[0.98]"
              >
                <span className="text-4xl">{ICON[g]}</span>
                <span className="flex flex-col">
                  <span className="text-lg font-bold text-yellow-300">{t(LABEL_KEY[g])}</span>
                  <span className="text-xs text-green-400">{t(TAG_KEY[g])}</span>
                  <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-full bg-yellow-900/40 px-2 py-0.5 text-[10px] font-bold text-yellow-300 ring-1 ring-yellow-600/40">
                    💰 {t("select.minAnte", { n: ante })}
                  </span>
                </span>
              </button>
              {g === "mahjong" && (
                <div className="flex items-center gap-2 px-2">
                  <span className="text-[11px] text-green-400">{t("select.mjHands")}</span>
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
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
