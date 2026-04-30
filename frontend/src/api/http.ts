import type { GameType } from "../shared/types";

const BASE = import.meta.env.VITE_WORKER_URL as string;

export interface TokenResponse  { token: string; playerId: string; dailyBonus?: number | null; }
export interface MatchResponse  { roomId: string; wsUrl: string; players: string[]; gameType: GameType; }

export interface LedgerEntry {
  ledger_id:  number;
  game_id:    string | null;
  delta:      number;
  reason:     string;
  created_at: number;
}
export interface WalletResponse {
  playerId:    string;
  displayName: string;
  chipBalance: number;
  updatedAt:   number;
  ledger:      LedgerEntry[];
}

export class InsufficientChipsError extends Error {
  constructor(public balance: number, public required: number, public gameType: GameType) {
    super(`需要 ${required} 籌碼，目前 ${balance}`);
    this.name = "InsufficientChipsError";
  }
}

export async function getToken(playerId: string): Promise<TokenResponse> {
  const res = await fetch(`${BASE}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId }),
  });
  if (!res.ok) throw new Error(`auth failed: ${res.status}`);
  return res.json();
}

export async function findMatch(token: string, gameType: GameType): Promise<MatchResponse> {
  const res = await fetch(`${BASE}/api/match`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ gameType }),
  });
  if (res.status === 402) {
    const body = await res.json().catch(() => ({})) as { balance?: number; required?: number };
    throw new InsufficientChipsError(body.balance ?? 0, body.required ?? 0, gameType);
  }
  if (!res.ok) throw new Error(`match failed: ${res.status}`);
  // Backend returns { matched, roomId, gameType, players }; wsUrl is derived client-side. // L2_鎖定
  const data = await res.json() as { roomId: string; gameType: GameType; players: string[] };
  const wsBase = BASE.replace(/^http/, "ws");
  const wsUrl  = `${wsBase}/rooms/${data.roomId}/join`;
  return { roomId: data.roomId, wsUrl, players: data.players, gameType: data.gameType };
}

export async function getWallet(token: string): Promise<WalletResponse> {
  const res = await fetch(`${BASE}/api/me/wallet`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`wallet failed: ${res.status}`);
  return res.json();
}

export interface BailoutResponse {
  granted:        number;
  chipBalance:    number;
  nextEligibleAt: number;
}

export interface BailoutBlocked {
  error:          string;
  balance?:       number;
  nextEligibleAt?: number;
}

export class BailoutError extends Error {
  constructor(public detail: BailoutBlocked) {
    super(detail.error);
    this.name = "BailoutError";
  }
}

export interface HistoryEntry {
  game_id:     string;
  finished_at: number;
  reason:      string;
  winner_id:   string;
  final_rank:  number;
  score_delta: number;
}
export async function getHistory(token: string): Promise<{ playerId: string; games: HistoryEntry[] }> {
  const res = await fetch(`${BASE}/api/me/history`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`history failed: ${res.status}`);
  return res.json();
}

export interface LeaderboardRow {
  player_id:    string;
  display_name: string;
  chip_balance: number;
}
export async function getLeaderboard(): Promise<{ updatedAt: number; rows: LeaderboardRow[] }> {
  const res = await fetch(`${BASE}/api/leaderboard`);
  if (!res.ok) throw new Error(`leaderboard failed: ${res.status}`);
  return res.json();
}

export async function claimBailout(token: string): Promise<BailoutResponse> {
  const res = await fetch(`${BASE}/api/me/bailout`, {
    method:  "POST",
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({})) as BailoutBlocked;
    throw new BailoutError(body);
  }
  if (!res.ok) throw new Error(`bailout failed: ${res.status}`);
  return res.json();
}
