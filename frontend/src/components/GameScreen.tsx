import type { GameType, SettlementResult } from "../shared/types";
import BigTwoGameScreen      from "./BigTwoGameScreen";
import MahjongGameScreen     from "./MahjongGameScreen";
import TexasHoldemGameScreen from "./TexasHoldemGameScreen";

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
  switch (gameType) {
    case "mahjong": return <MahjongGameScreen     {...rest} />;
    case "texas":   return <TexasHoldemGameScreen {...rest} />;
    case "bigTwo":  return <BigTwoGameScreen      {...rest} />;
  }
}
