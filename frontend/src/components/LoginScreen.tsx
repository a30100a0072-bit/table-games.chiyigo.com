import React, { useState } from "react";
import { getToken } from "../api/http";

interface Props {
  onLoggedIn: (playerId: string, token: string) => void;
}

export default function LoginScreen({ onLoggedIn }: Props) {
  const [name,    setName]    = useState("");
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setLoading(true); setError("");
    try {
      const { token, playerId } = await getToken(trimmed);
      onLoggedIn(playerId, token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "連線失敗");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-green-950">
      <div className="w-80 rounded-2xl bg-green-900 p-8 shadow-xl">
        <h1 className="mb-2 text-center text-3xl font-bold text-yellow-300">大老二</h1>
        <p className="mb-6 text-center text-sm text-green-300">四人制線上對戰</p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            className="rounded-lg bg-green-800 px-4 py-3 text-white placeholder-green-400 outline-none focus:ring-2 focus:ring-yellow-400"
            placeholder="輸入暱稱"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={16}
            disabled={loading}
            autoFocus
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading || !name.trim()}
            className="rounded-lg bg-yellow-400 py-3 font-bold text-green-950 transition hover:bg-yellow-300 disabled:opacity-50"
          >
            {loading ? "連線中…" : "開始遊戲"}
          </button>
        </form>
      </div>
    </div>
  );
}
