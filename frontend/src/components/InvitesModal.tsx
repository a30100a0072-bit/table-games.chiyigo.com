import { useEffect, useState } from "react";
import { useEscapeClose } from "../hooks/useEscapeClose";
import {
  listInvitesApi, declineInviteApi, resolvePrivateRoomApi, formatApiError,
} from "../api/http";
import type { RoomInvite } from "../api/http";
import type { GameType } from "../shared/types";
import { useT } from "../i18n/useT";

interface Props {
  token:   string;
  onClose: () => void;
  onEnter: (roomId: string, gameType: GameType) => void;
}

const ICON: Record<GameType, string> = { bigTwo: "🃏", mahjong: "🀄", texas: "♠️" };
const LABEL_KEY: Record<GameType, "select.bigTwo" | "select.mahjong" | "select.texas"> = {
  bigTwo: "select.bigTwo", mahjong: "select.mahjong", texas: "select.texas",
};

export default function InvitesModal({ token, onClose, onEnter }: Props) {
  useEscapeClose(onClose);
  const { t } = useT();
  const [items, setItems] = useState<RoomInvite[] | null>(null);
  const [busy,  setBusy]  = useState(false);
  const [err,   setErr]   = useState<string | null>(null);

  async function refresh() {
    try { setItems((await listInvitesApi(token)).invites); }
    catch (e) { setErr(formatApiError(e, t)); }
  }
  useEffect(() => { void refresh(); }, []);

  async function accept(inv: RoomInvite) {
    setBusy(true); setErr(null);
    try {
      // Resolve to confirm the token is still valid before navigating
      // — covers the race where the room hit capacity / expired between
      // the list fetch and the click.
      const r = await resolvePrivateRoomApi(token, inv.joinToken);
      onEnter(r.roomId, r.gameType);
    } catch (e) {
      setErr(formatApiError(e, t));
    } finally { setBusy(false); }
  }

  async function decline(inv: RoomInvite) {
    setBusy(true); setErr(null);
    try { await declineInviteApi(token, inv.id); await refresh(); }
    catch (e) { setErr(formatApiError(e, t)); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 px-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl bg-green-900 p-5 shadow-2xl">
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-bold text-yellow-300">📨 {t("inv.title")}</h2>
          <button
            onClick={onClose}
            className="rounded-full bg-green-800 px-3 py-1 text-xs text-green-200 hover:bg-green-700"
          >{t("common.close")}</button>
        </div>

        {err && <p className="mt-2 text-xs text-red-300">{err}</p>}

        <div className="mt-4 flex-1 overflow-y-auto">
          {!items && <p className="text-center text-xs text-green-500">{t("friends.loading")}</p>}
          {items && items.length === 0 && (
            <p className="text-center text-xs text-green-500">{t("inv.empty")}</p>
          )}
          {items && items.length > 0 && (
            <ul className="flex flex-col gap-2">
              {items.map(inv => (
                <li
                  key={inv.id}
                  className="flex items-center justify-between gap-2 rounded-md bg-green-800/60 px-3 py-2"
                >
                  <div className="flex flex-1 flex-col text-xs text-yellow-100">
                    <span className="font-bold">
                      {ICON[inv.gameType]} {t(LABEL_KEY[inv.gameType])}
                    </span>
                    <span className="text-green-300">{t("inv.fromInviter", { p: inv.inviter })}</span>
                    <span className="text-[10px] text-green-500">
                      {t("inv.expiresAt", { ts: new Date(inv.expiresAt).toLocaleString() })}
                    </span>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => accept(inv)}
                      disabled={busy}
                      className="rounded bg-green-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-green-500 disabled:opacity-50"
                    >{t("inv.enter")}</button>
                    <button
                      onClick={() => decline(inv)}
                      disabled={busy}
                      className="rounded bg-gray-700 px-2 py-1 text-[10px] font-bold text-gray-200 hover:bg-gray-600 disabled:opacity-50"
                    >{t("friends.decline")}</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
