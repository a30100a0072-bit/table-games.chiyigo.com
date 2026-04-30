import { useState } from "react";
import { isMuted, setMuted } from "../shared/sound";

export default function MuteToggle({ className }: { className?: string }) {
  const [muted, setLocal] = useState(isMuted());
  return (
    <button
      onClick={() => { const n = !muted; setMuted(n); setLocal(n); }}
      title={muted ? "Unmute" : "Mute"}
      className={["rounded-full bg-green-800/80 px-2 py-1 text-xs font-bold text-yellow-200 hover:bg-green-700", className ?? ""].join(" ")}
    >
      {muted ? "🔇" : "🔊"}
    </button>
  );
}
