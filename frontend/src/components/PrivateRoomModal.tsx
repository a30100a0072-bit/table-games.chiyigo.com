import { useEffect, useState } from "react";
import { useEscapeClose } from "../hooks/useEscapeClose";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { GAME_TYPES } from "../shared/types";
import type { GameType } from "../shared/types";
import {
  createPrivateRoomApi, resolvePrivateRoomApi,
  listFriendsApi, inviteFriendToRoomApi, formatApiError,
} from "../api/http";
import { useT } from "../i18n/useT";

interface Props {
  token:    string;
  onClose:  () => void;
  onEnter:  (roomId: string, gameType: GameType) => void;
}

const ICON: Record<GameType, string> = { bigTwo: "🃏", mahjong: "🀄", texas: "♠️" };
const LABEL_KEY: Record<GameType, "select.bigTwo" | "select.mahjong" | "select.texas"> = {
  bigTwo: "select.bigTwo", mahjong: "select.mahjong", texas: "select.texas",
};

type Tab = "create" | "join";

/** Pull just the token out, whether the user pasted a full URL or only the token. */
function parseToken(input: string): string {
  const s = input.trim();
  if (s.length === 0) return "";
  // Try URL parse — any ?join=… wins. Otherwise treat as raw token.
  try {
    const u = new URL(s);
    const t = u.searchParams.get("join");
    if (t) return t;
  } catch { /* not a URL */ }
  return s;
}

export default function PrivateRoomModal({ token, onClose, onEnter }: Props) {
  useEscapeClose(onClose);
  const trapRef = useFocusTrap<HTMLDivElement>();
  const { t } = useT();
  const [tab,      setTab]      = useState<Tab>("create");
  const [gameType, setGameType] = useState<GameType>("bigTwo");
  const [busy,     setBusy]     = useState(false);
  const [err,      setErr]      = useState<string | null>(null);
  const [created,  setCreated]  = useState<{ url: string; gameType: GameType; roomId: string; expiresAt: number; joinToken: string } | null>(null);
  const [copied,   setCopied]   = useState(false);
  const [joinIn,   setJoinIn]   = useState("");
  // Friend list loaded after creating a room — drives the "邀請好友" section.
  const [friends,  setFriends]  = useState<{ playerId: string }[] | null>(null);
  const [invited,  setInvited]  = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!created) return;
    listFriendsApi(token).then(d => setFriends(d.accepted)).catch(() => setFriends([]));
  }, [created, token]);

  async function inviteFriend(friendPlayerId: string) {
    if (!created) return;
    try {
      await inviteFriendToRoomApi(token, friendPlayerId, created.joinToken);
      setInvited(prev => { const n = new Set(prev); n.add(friendPlayerId); return n; });
    } catch (e) {
      setErr(formatApiError(e, t));
    }
  }

  async function handleCreate() {
    setBusy(true); setErr(null);
    try {
      const r = await createPrivateRoomApi(token, gameType);
      const url = `${location.origin}${location.pathname}?join=${r.joinToken}`;
      setCreated({ url, gameType: r.gameType, roomId: r.roomId, expiresAt: r.expiresAt, joinToken: r.joinToken });
    } catch (e) {
      setErr(formatApiError(e, t));
    } finally { setBusy(false); }
  }

  async function copy() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.url); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = created.url; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleJoin() {
    const tok = parseToken(joinIn);
    if (tok.length === 0) { setErr(t("priv.invalid")); return; }
    setBusy(true); setErr(null);
    try {
      const r = await resolvePrivateRoomApi(token, tok);
      onEnter(r.roomId, r.gameType);
    } catch (e) {
      setErr(formatApiError(e, t));
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 px-4" role="dialog" aria-modal="true" ref={trapRef}>
      <div className="w-full max-w-md rounded-2xl bg-green-900 p-5 shadow-2xl">
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-bold text-yellow-300">🔒 {t("priv.title")}</h2>
          <button
            onClick={onClose}
            className="rounded-full bg-green-800 px-3 py-1 text-xs text-green-200 hover:bg-green-700"
          >{t("common.close")}</button>
        </div>

        <div className="mt-4 flex gap-1 border-b border-green-800 text-xs">
          {(["create", "join"] as Tab[]).map(k => (
            <button
              key={k}
              onClick={() => { setTab(k); setErr(null); }}
              className={[
                "rounded-t-md px-3 py-1.5 font-bold transition",
                tab === k ? "bg-green-800 text-yellow-300" : "text-green-400 hover:text-yellow-200",
              ].join(" ")}
            >
              {t(`priv.tab.${k}` as `priv.tab.${Tab}`)}
            </button>
          ))}
        </div>

        {tab === "create" && (
          <div className="mt-4 flex flex-col gap-3">
            {!created && (
              <>
                <p className="text-xs text-green-400">{t("priv.createHint")}</p>
                <select
                  value={gameType}
                  onChange={e => setGameType(e.target.value as GameType)}
                  className="rounded-lg bg-green-800 px-3 py-2 text-sm text-yellow-100"
                >
                  {GAME_TYPES.map(g => (
                    <option key={g} value={g}>{ICON[g]} {t(LABEL_KEY[g])}</option>
                  ))}
                </select>
                <button
                  onClick={handleCreate}
                  disabled={busy}
                  className="rounded-lg bg-yellow-500 px-3 py-2 text-sm font-bold text-green-950 disabled:bg-gray-700 disabled:text-gray-500"
                >{busy ? t("priv.creating") : t("priv.create")}</button>
              </>
            )}
            {created && (
              <>
                <p className="text-xs text-green-300">
                  {t("priv.created", { gt: t(LABEL_KEY[created.gameType]) })}
                </p>
                <input
                  readOnly
                  value={created.url}
                  onClick={e => (e.target as HTMLInputElement).select()}
                  className="rounded-lg bg-green-800 px-3 py-2 text-xs text-yellow-100"
                />
                <button
                  onClick={copy}
                  className="rounded-lg bg-purple-600 px-3 py-2 text-sm font-bold text-white"
                >{copied ? `✅ ${t("game.copied")}` : `📋 ${t("priv.copyUrl")}`}</button>
                <button
                  onClick={() => onEnter(created.roomId, created.gameType)}
                  className="rounded-lg bg-green-700 px-3 py-2 text-sm font-bold text-green-50"
                >{t("priv.enterRoom")}</button>
                <p className="text-[10px] text-green-500">
                  {t("priv.expiresAt", { ts: new Date(created.expiresAt).toLocaleString() })}
                </p>

                <div className="mt-2 border-t border-green-800 pt-3">
                  <p className="text-xs font-bold text-yellow-200">{t("priv.inviteFriends")}</p>
                  {friends === null && <p className="text-[10px] text-green-500">{t("friends.loading")}</p>}
                  {friends && friends.length === 0 && (
                    <p className="text-[10px] text-green-500">{t("priv.noFriends")}</p>
                  )}
                  {friends && friends.length > 0 && (
                    <ul className="mt-1 max-h-40 overflow-y-auto">
                      {friends.map(f => (
                        <li key={f.playerId} className="flex items-center justify-between py-1 text-xs">
                          <span className="text-yellow-100">{f.playerId}</span>
                          {invited.has(f.playerId)
                            ? <span className="text-[10px] text-green-400">✓ {t("priv.invited")}</span>
                            : <button
                                onClick={() => inviteFriend(f.playerId)}
                                className="rounded bg-yellow-600 px-2 py-0.5 text-[10px] font-bold text-yellow-50 hover:bg-yellow-500"
                              >{t("priv.inviteOne")}</button>
                          }
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {tab === "join" && (
          <div className="mt-4 flex flex-col gap-3">
            <p className="text-xs text-green-400">{t("priv.joinHint")}</p>
            <input
              type="text"
              value={joinIn}
              onChange={e => setJoinIn(e.target.value)}
              placeholder={t("priv.joinPlaceholder")}
              className="rounded-lg bg-green-800 px-3 py-2 text-sm text-yellow-100 placeholder:text-green-500"
            />
            <button
              onClick={handleJoin}
              disabled={busy || joinIn.trim().length === 0}
              className="rounded-lg bg-yellow-500 px-3 py-2 text-sm font-bold text-green-950 disabled:bg-gray-700 disabled:text-gray-500"
            >{busy ? t("priv.joining") : t("priv.join")}</button>
          </div>
        )}

        {err && <p className="mt-3 text-xs text-red-300">{err}</p>}
      </div>
    </div>
  );
}
