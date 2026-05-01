import { useEffect, useRef, useState } from "react";
import {
  listFriendsApi, requestFriendApi, respondFriendApi, unfriendApi,
  listDmConversationApi, sendDmApi,
} from "../api/http";
import type { FriendsResponse, DmMessage } from "../api/http";
import { useT } from "../i18n/useT";

interface Props {
  token:    string;
  onClose:  () => void;
}

type Tab = "accepted" | "incoming" | "outgoing";

function DmPanel({ token, peer, onBack }: { token: string; peer: string; onBack: () => void }) {
  const [msgs, setMsgs] = useState<DmMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function refresh() {
    try {
      const r = await listDmConversationApi(token, peer);
      setMsgs(r.messages);
    } catch { /* keep last view */ }
  }
  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 5_000);
    return () => clearInterval(id);
  }, [peer]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs.length]);

  async function send() {
    const body = draft.trim();
    if (body.length === 0 || body.length > 500) return;
    setBusy(true); setErr(null);
    try {
      await sendDmApi(token, peer, body);
      setDraft("");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally { setBusy(false); }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center gap-2">
        <button
          onClick={onBack}
          className="rounded bg-green-800 px-2 py-1 text-[10px] text-green-200 hover:bg-green-700"
        >← back</button>
        <span className="text-sm font-bold text-yellow-200">💬 {peer}</span>
      </div>
      <div ref={scrollRef} className="flex-1 space-y-1 overflow-y-auto rounded-md bg-green-950/60 p-2 text-xs">
        {msgs.length === 0 && <p className="text-center text-green-500">no messages yet</p>}
        {msgs.map(m => (
          <div
            key={m.id}
            className={[
              "max-w-[80%] rounded-lg px-2 py-1",
              m.sender === peer
                ? "self-start bg-green-800 text-yellow-100"
                : "ml-auto bg-yellow-700/80 text-yellow-50",
            ].join(" ")}
          >
            <div className="break-words">{m.body}</div>
            <div className="mt-0.5 text-[9px] text-green-300">
              {new Date(m.created_at).toLocaleTimeString()}
            </div>
          </div>
        ))}
      </div>
      {err && <p className="mt-1 text-[10px] text-red-300">{err}</p>}
      <div className="mt-2 flex gap-1">
        <input
          type="text"
          value={draft}
          maxLength={500}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void send(); }}
          disabled={busy}
          placeholder="say something (≤500)"
          className="flex-1 rounded-lg bg-green-800 px-2 py-1.5 text-xs text-yellow-100 placeholder:text-green-500"
        />
        <button
          onClick={send}
          disabled={busy || draft.trim().length === 0}
          className="rounded-lg bg-yellow-500 px-3 py-1.5 text-xs font-bold text-green-950 disabled:bg-gray-700 disabled:text-gray-500"
        >send</button>
      </div>
    </div>
  );
}

export default function FriendsModal({ token, onClose }: Props) {
  const { t } = useT();
  const [data,    setData]    = useState<FriendsResponse | null>(null);
  const [tab,     setTab]     = useState<Tab>("accepted");
  const [target,  setTarget]  = useState("");
  const [busy,    setBusy]    = useState(false);
  const [err,     setErr]     = useState<string | null>(null);
  const [dmPeer,  setDmPeer]  = useState<string | null>(null);

  async function refresh() {
    try { setData(await listFriendsApi(token)); }
    catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
  }
  useEffect(() => { void refresh(); }, []);

  async function add() {
    const id = target.trim();
    if (id.length === 0) return;
    setBusy(true); setErr(null);
    try {
      await requestFriendApi(token, id);
      setTarget("");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed");
    } finally { setBusy(false); }
  }

  async function respond(other: string, action: "accept" | "decline") {
    setBusy(true); setErr(null);
    try { await respondFriendApi(token, other, action); await refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
    finally { setBusy(false); }
  }

  async function remove(other: string) {
    setBusy(true); setErr(null);
    try { await unfriendApi(token, other); await refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : "failed"); }
    finally { setBusy(false); }
  }

  const counts = data
    ? { accepted: data.accepted.length, incoming: data.incoming.length, outgoing: data.outgoing.length }
    : { accepted: 0, incoming: 0, outgoing: 0 };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 px-4">
      <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-2xl bg-green-900 p-5 shadow-2xl">
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-bold text-yellow-300">👥 {t("friends.title")}</h2>
          <button
            onClick={onClose}
            className="rounded-full bg-green-800 px-3 py-1 text-xs text-green-200 hover:bg-green-700"
          >{t("common.close")}</button>
        </div>

        {dmPeer && (
          <div className="mt-3 flex flex-1 flex-col">
            <DmPanel token={token} peer={dmPeer} onBack={() => setDmPeer(null)} />
          </div>
        )}
        {!dmPeer && (<>
        <div className="mt-4 flex gap-2">
          <input
            type="text"
            value={target}
            onChange={e => setTarget(e.target.value)}
            placeholder={t("friends.addPlaceholder")}
            disabled={busy}
            className="flex-1 rounded-lg bg-green-800 px-3 py-2 text-sm text-yellow-100 placeholder:text-green-500"
          />
          <button
            onClick={add}
            disabled={busy || target.trim().length === 0}
            className="rounded-lg bg-yellow-500 px-3 py-2 text-sm font-bold text-green-950 disabled:bg-gray-700 disabled:text-gray-500"
          >{t("friends.add")}</button>
        </div>
        {err && <p className="mt-2 text-xs text-red-300">{err}</p>}

        <div className="mt-4 flex gap-1 border-b border-green-800 text-xs">
          {(["accepted", "incoming", "outgoing"] as Tab[]).map(k => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={[
                "rounded-t-md px-3 py-1.5 font-bold transition",
                tab === k ? "bg-green-800 text-yellow-300" : "text-green-400 hover:text-yellow-200",
              ].join(" ")}
            >
              {t(`friends.tab.${k}` as `friends.tab.${Tab}`)} {counts[k] > 0 && `(${counts[k]})`}
            </button>
          ))}
        </div>

        <div className="mt-3 flex-1 overflow-y-auto">
          {!data && <p className="text-center text-xs text-green-500">{t("friends.loading")}</p>}
          {data && tab === "accepted" && (
            data.accepted.length === 0
              ? <p className="text-center text-xs text-green-500">{t("friends.empty.accepted")}</p>
              : <ul className="flex flex-col gap-1.5">
                  {data.accepted.map(f => (
                    <li key={f.playerId} className="flex items-center justify-between rounded-md bg-green-800/60 px-3 py-2">
                      <span className="text-sm text-yellow-100">{f.playerId}</span>
                      <div className="flex gap-1">
                        <button
                          onClick={() => setDmPeer(f.playerId)}
                          disabled={busy}
                          className="rounded bg-yellow-600 px-2 py-1 text-[10px] font-bold text-yellow-50 hover:bg-yellow-500 disabled:opacity-50"
                          title="DM"
                        >💬</button>
                        <button
                          onClick={() => remove(f.playerId)}
                          disabled={busy}
                          className="rounded bg-red-700 px-2 py-1 text-[10px] font-bold text-red-50 hover:bg-red-600 disabled:opacity-50"
                        >{t("friends.unfriend")}</button>
                      </div>
                    </li>
                  ))}
                </ul>
          )}
          {data && tab === "incoming" && (
            data.incoming.length === 0
              ? <p className="text-center text-xs text-green-500">{t("friends.empty.incoming")}</p>
              : <ul className="flex flex-col gap-1.5">
                  {data.incoming.map(f => (
                    <li key={f.playerId} className="flex items-center justify-between rounded-md bg-green-800/60 px-3 py-2">
                      <span className="text-sm text-yellow-100">{f.playerId}</span>
                      <div className="flex gap-1">
                        <button
                          onClick={() => respond(f.playerId, "accept")}
                          disabled={busy}
                          className="rounded bg-green-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-green-500 disabled:opacity-50"
                        >{t("friends.accept")}</button>
                        <button
                          onClick={() => respond(f.playerId, "decline")}
                          disabled={busy}
                          className="rounded bg-gray-700 px-2 py-1 text-[10px] font-bold text-gray-200 hover:bg-gray-600 disabled:opacity-50"
                        >{t("friends.decline")}</button>
                      </div>
                    </li>
                  ))}
                </ul>
          )}
          {data && tab === "outgoing" && (
            data.outgoing.length === 0
              ? <p className="text-center text-xs text-green-500">{t("friends.empty.outgoing")}</p>
              : <ul className="flex flex-col gap-1.5">
                  {data.outgoing.map(f => (
                    <li key={f.playerId} className="flex items-center justify-between rounded-md bg-green-800/60 px-3 py-2">
                      <span className="text-sm text-yellow-100">{f.playerId}</span>
                      <button
                        onClick={() => remove(f.playerId)}
                        disabled={busy}
                        className="rounded bg-gray-700 px-2 py-1 text-[10px] font-bold text-gray-200 hover:bg-gray-600 disabled:opacity-50"
                      >{t("friends.cancel")}</button>
                    </li>
                  ))}
                </ul>
          )}
        </div>
        </>)}
      </div>
    </div>
  );
}
