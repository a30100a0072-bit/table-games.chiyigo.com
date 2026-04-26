import React, { useState } from "react";
import type { SettlementResult } from "./shared/types";
import LoginScreen  from "./components/LoginScreen";
import LobbyScreen  from "./components/LobbyScreen";
import GameScreen   from "./components/GameScreen";
import ResultScreen from "./components/ResultScreen";

type Screen =
  | { name: "login" }
  | { name: "lobby";  playerId: string; token: string }
  | { name: "game";   playerId: string; token: string; roomId: string; wsUrl: string; players: string[] }
  | { name: "result"; playerId: string; settlement: SettlementResult };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "login" });

  if (screen.name === "login")
    return (
      <LoginScreen
        onLoggedIn={(playerId, token) =>
          setScreen({ name: "lobby", playerId, token })
        }
      />
    );

  if (screen.name === "lobby")
    return (
      <LobbyScreen
        playerId={screen.playerId}
        token={screen.token}
        onMatched={(roomId, wsUrl, players) =>
          setScreen({ name: "game", playerId: screen.playerId, token: screen.token, roomId, wsUrl, players })
        }
      />
    );

  if (screen.name === "game")
    return (
      <GameScreen
        playerId={screen.playerId}
        token={screen.token}
        roomId={screen.roomId}
        wsUrl={screen.wsUrl}
        onSettled={(result) =>
          setScreen({ name: "result", playerId: screen.playerId, settlement: result })
        }
      />
    );

  return (
    <ResultScreen
      playerId={screen.playerId}
      settlement={screen.settlement}
      onPlayAgain={() => setScreen({ name: "login" })}
    />
  );
}
