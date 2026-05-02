import { lazy, Suspense } from "react";
import type { GameType, SettlementResult } from "../shared/types";

// Game screens are the heaviest bundles (each pulls its own card art,
// engine view types, and action UI). Lazy-load so login + lobby ship
// a tiny chunk; the chosen game's chunk is fetched in parallel with
// matchmaking, which usually hides the network round-trip entirely.
const BigTwoGameScreen      = lazy(() => import("./BigTwoGameScreen"));
const MahjongGameScreen     = lazy(() => import("./MahjongGameScreen"));
const TexasHoldemGameScreen = lazy(() => import("./TexasHoldemGameScreen"));

interface Props {
  playerId:   string;
  token:      string;
  roomId:     string;
  wsUrl:      string;
  gameType:   GameType;
  /** Read-only spectator session — backend will redact private fields
   *  and reject any inbound action frames. */
  spectator?: boolean;
  onSettled:  (result: SettlementResult) => void;
}

export default function GameScreen({ gameType, ...rest }: Props) {
  let inner: JSX.Element;
  switch (gameType) {
    case "mahjong": inner = <MahjongGameScreen     {...rest} />; break;
    case "texas":   inner = <TexasHoldemGameScreen {...rest} />; break;
    case "bigTwo":  inner = <BigTwoGameScreen      {...rest} />; break;
  }
  return (
    <Suspense fallback={
      <div className="flex h-screen items-center justify-center bg-green-900 text-yellow-200">
        <div className="animate-pulse text-sm">…</div>
      </div>
    }>
      {inner}
    </Suspense>
  );
}
