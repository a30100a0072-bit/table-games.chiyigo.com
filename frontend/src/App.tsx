import { useState } from "react";
import type { GameType, SettlementResult } from "./shared/types";
import LoginScreen      from "./components/LoginScreen";
import GameSelectScreen from "./components/GameSelectScreen";
import LobbyScreen      from "./components/LobbyScreen";
import GameScreen       from "./components/GameScreen";
import ResultScreen     from "./components/ResultScreen";

type Screen =
  | { name: "login" }
  | { name: "select"; playerId: string; token: string; dailyBonus: number | null }
  | { name: "lobby";  playerId: string; token: string; gameType: GameType }
  | { name: "game";   playerId: string; token: string; roomId: string; wsUrl: string; gameType: GameType }
  | { name: "result"; playerId: string; settlement: SettlementResult };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "login" });

  if (screen.name === "login")
    return (
      <LoginScreen
        onLoggedIn={(playerId, token, dailyBonus) => setScreen({ name: "select", playerId, token, dailyBonus })}
      />
    );

  if (screen.name === "select")
    return (
      <GameSelectScreen
        playerId={screen.playerId}
        token={screen.token}
        dailyBonus={screen.dailyBonus}
        onPick={(gameType) =>
          setScreen({ name: "lobby", playerId: screen.playerId, token: screen.token, gameType })
        }
      />
    );

  if (screen.name === "lobby")
    return (
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

  if (screen.name === "game")
    return (
      <GameScreen
        playerId={screen.playerId}
        token={screen.token}
        roomId={screen.roomId}
        wsUrl={screen.wsUrl}
        gameType={screen.gameType}
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
