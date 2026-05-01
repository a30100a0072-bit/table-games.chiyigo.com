import { useEffect, useState } from "react";
import type { GameType, SettlementResult } from "./shared/types";
import LoginScreen      from "./components/LoginScreen";
import GameSelectScreen from "./components/GameSelectScreen";
import LobbyScreen      from "./components/LobbyScreen";
import GameScreen       from "./components/GameScreen";
import ResultScreen     from "./components/ResultScreen";
import { useT } from "./i18n/useT";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type Screen =
  | { name: "login" }
  | { name: "select"; playerId: string; token: string; dailyBonus: number | null }
  | { name: "lobby";  playerId: string; token: string; gameType: GameType }
  | { name: "game";   playerId: string; token: string; roomId: string; wsUrl: string; gameType: GameType; spectator?: boolean }
  | { name: "result"; playerId: string; settlement: SettlementResult };

export default function App() {
  const { t } = useT();
  const [screen, setScreen] = useState<Screen>({ name: "login" });
  const [offline, setOffline] = useState(typeof navigator !== "undefined" && !navigator.onLine);
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [copied, setCopied] = useState(false);
  // If the user landed via a `?join=<token>` deeplink, hold the token
  // until they're logged in (token resolution requires a JWT) and pass
  // it into GameSelectScreen so the private-room modal can pop open.
  const [pendingJoinToken, setPendingJoinToken] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const u = new URL(window.location.href);
    return u.searchParams.get("join");
  });

  async function copyRoomId(id: string) {
    try { await navigator.clipboard.writeText(id); }
    catch {
      // Insecure context fallback (dev / file://). Doesn't block the UX.
      const ta = document.createElement("textarea");
      ta.value = id; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
    }
    setCopied(true);
  }

  useEffect(() => {
    const onOnline  = () => setOffline(false);
    const onOffline = () => setOffline(true);
    const onInstall = (e: Event) => { e.preventDefault(); setInstallEvt(e as BeforeInstallPromptEvent); };
    window.addEventListener("online",  onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("beforeinstallprompt", onInstall);
    return () => {
      window.removeEventListener("online",  onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("beforeinstallprompt", onInstall);
    };
  }, []);

  // Auto-clear the "copied" toast after a brief window.
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  async function triggerInstall() {
    if (!installEvt) return;
    await installEvt.prompt();
    await installEvt.userChoice;
    setInstallEvt(null);
  }

  const banner = (
    <>
      {offline && (
        <div className="fixed left-0 right-0 top-0 z-40 bg-red-700 px-4 py-1 text-center text-xs font-bold text-red-50">
          {t("pwa.offline")}
        </div>
      )}
      {installEvt && (
        <button
          onClick={triggerInstall}
          className="fixed bottom-4 left-4 z-40 rounded-full bg-yellow-600 px-4 py-2 text-xs font-bold text-yellow-50 shadow-lg hover:bg-yellow-500"
        >
          {t("pwa.install")}
        </button>
      )}
      {screen.name === "game" && (
        <button
          onClick={() => copyRoomId(screen.roomId)}
          title={screen.roomId}
          className="fixed bottom-4 right-4 z-40 max-w-[60vw] truncate rounded-full bg-green-800/90 px-3 py-1.5 text-[11px] font-bold text-yellow-200 shadow-lg ring-1 ring-yellow-500/40 hover:bg-green-700"
        >
          {copied ? `✅ ${t("game.copied")}` : `📋 ${t("game.roomId")}: ${screen.roomId.slice(0, 8)}…`}
        </button>
      )}
    </>
  );

  let body: JSX.Element;
  if (screen.name === "login") {
    body = (
      <LoginScreen
        onLoggedIn={(playerId, token, dailyBonus) => setScreen({ name: "select", playerId, token, dailyBonus })}
      />
    );
  } else if (screen.name === "select") {
    const wsBase = (import.meta.env.VITE_WORKER_URL as string).replace(/^http/, "ws");
    body = (
      <GameSelectScreen
        playerId={screen.playerId}
        token={screen.token}
        dailyBonus={screen.dailyBonus}
        onPick={(gameType) =>
          setScreen({ name: "lobby", playerId: screen.playerId, token: screen.token, gameType })
        }
        onJoinedTournamentRoom={(roomId, gameType) =>
          setScreen({
            name: "game",
            playerId: screen.playerId,
            token: screen.token,
            roomId,
            wsUrl: `${wsBase}/rooms/${roomId}/join`,
            gameType,
          })
        }
        onSpectate={(roomId, gameType) =>
          setScreen({
            name: "game",
            playerId: screen.playerId,
            token: screen.token,
            roomId,
            wsUrl: `${wsBase}/rooms/${roomId}/join`,
            gameType,
            spectator: true,
          })
        }
        onPrivateEnter={(roomId, gameType) => {
          // Strip the deeplink param after consuming it so a future
          // logout-login cycle doesn't rehydrate the same modal.
          if (typeof window !== "undefined") {
            const url = new URL(window.location.href);
            if (url.searchParams.has("join")) {
              url.searchParams.delete("join");
              window.history.replaceState(null, "", url.toString());
            }
          }
          setPendingJoinToken(null);
          setScreen({
            name: "game",
            playerId: screen.playerId,
            token: screen.token,
            roomId,
            wsUrl: `${wsBase}/rooms/${roomId}/join`,
            gameType,
          });
        }}
        initialJoinToken={pendingJoinToken}
        onLogout={() => setScreen({ name: "login" })}
      />
    );
  } else if (screen.name === "lobby") {
    body = (
      <LobbyScreen
        playerId={screen.playerId}
        token={screen.token}
        gameType={screen.gameType}
        onMatched={(roomId, wsUrl, _players, gameType) =>
          setScreen({ name: "game", playerId: screen.playerId, token: screen.token, roomId, wsUrl, gameType })
        }
        onBack={() => setScreen({ name: "select", playerId: screen.playerId, token: screen.token, dailyBonus: null })}
      />
    );
  } else if (screen.name === "game") {
    body = (
      <GameScreen
        playerId={screen.playerId}
        token={screen.token}
        roomId={screen.roomId}
        wsUrl={screen.wsUrl}
        gameType={screen.gameType}
        spectator={screen.spectator}
        onSettled={(result) =>
          setScreen({ name: "result", playerId: screen.playerId, settlement: result })
        }
      />
    );
  } else {
    body = (
      <ResultScreen
        playerId={screen.playerId}
        settlement={screen.settlement}
        onPlayAgain={() => setScreen({ name: "login" })}
      />
    );
  }

  return <>{banner}{body}</>;
}
