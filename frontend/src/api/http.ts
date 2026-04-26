const BASE = import.meta.env.VITE_WORKER_URL as string;

export interface TokenResponse  { token: string; playerId: string; }
export interface MatchResponse  { roomId: string; wsUrl: string; players: string[]; }

export async function getToken(playerId: string): Promise<TokenResponse> {
  const res = await fetch(`${BASE}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId }),
  });
  if (!res.ok) throw new Error(`auth failed: ${res.status}`);
  return res.json();
}

export async function findMatch(token: string): Promise<MatchResponse> {
  const res = await fetch(`${BASE}/lobby/match`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`match failed: ${res.status}`);
  return res.json();
}
