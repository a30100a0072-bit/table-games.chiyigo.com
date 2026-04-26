import React, { useEffect, useRef, useState } from "react";
import { findMatch } from "../api/http";

interface Props {
  playerId: string;
  token:    string;
  onMatched: (roomId: string, wsUrl: string, players: string[]) => void;
}

export default function LobbyScreen({ playerId, token, onMatched }: Props) {
  const [dots,  setDots]  = useState(".");
  const [error, setError] = useState("");
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;
    findMatch(token)
      .then(({ roomId, wsUrl, players }) => onMatched(roomId, wsUrl, players))
      .catch(err => setError(err instanceof Error ? err.message : "配對失敗"));
  }, [token, onMatched]);

  useEffect(() => {
    const id = setInterval(() => setDots(d => d.length >= 3 ? "." : d + "."), 500);
    return () => clearInterval(id);
  }, []);

  if (error)
    return (
      <div className="flex h-full items-center justify-center bg-green-950">
        <div className="rounded-2xl bg-green-900 p-8 text-center shadow-xl">
          <p className="mb-4 text-red-400">{error}</p>
          <button
            className="rounded-lg bg-yellow-400 px-6 py-2 font-bold text-green-950"
            onClick={() => { called.current = false; setError(""); }}
          >
            重試
          </button>
        </div>
      </div>
    );

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-green-950">
      <div className="text-6xl">🃏</div>
      <p className="text-xl font-bold text-yellow-300">等待玩家加入{dots}</p>
      <p className="text-sm text-green-400">{playerId}</p>
    </div>
  );
}
