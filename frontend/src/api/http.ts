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

export class FrozenAccountError extends Error {
  constructor(public reason: string) {
    super(reason || "account frozen");
    this.name = "FrozenAccountError";
  }
}

export async function getToken(playerId: string): Promise<TokenResponse> {
  const res = await fetch(`${BASE}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId }),
  });
  if (res.status === 423) {
    const body = await res.json().catch(() => ({})) as { reason?: string };
    throw new FrozenAccountError(body.reason ?? "");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `auth failed: ${res.status}`);
  }
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

// ── Tournaments ─────────────────────────────────────────────────────
export interface TournamentRow {
  tournament_id: string;
  game_type:     GameType;
  buy_in:        number;
  prize_pool:    number;
  status:        string;
  created_at:    number;
  registered:    number;
}
export interface TournamentEntry {
  player_id:  string;
  agg_score:  number;
  final_rank: number | null;
}
export interface TournamentDetail {
  tournament: {
    tournament_id: string;
    game_type:     GameType;
    buy_in:        number;
    rounds_total:  number;
    rounds_done:   number;
    status:        string;
    prize_pool:    number;
    current_room:  string | null;
    started_at:    number | null;
    finished_at:   number | null;
    winner_id:     string | null;
  };
  entries:     TournamentEntry[];
  currentRoom: string | null;
}

export async function listTournaments(): Promise<{ rows: TournamentRow[]; required: number }> {
  const res = await fetch(`${BASE}/api/tournaments`);
  if (!res.ok) throw new Error(`list failed: ${res.status}`);
  return res.json();
}

export async function getTournament(id: string): Promise<TournamentDetail> {
  const res = await fetch(`${BASE}/api/tournaments/${id}`);
  if (!res.ok) throw new Error(`get failed: ${res.status}`);
  return res.json();
}

export async function createTournament(token: string, gameType: GameType, buyIn: number)
  : Promise<{ tournamentId: string; prizePool: number; required: number }> {
  const res = await fetch(`${BASE}/api/tournaments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ gameType, buyIn }),
  });
  if (res.status === 402) throw new Error("insufficient chips");
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return res.json();
}

export async function joinTournamentApi(token: string, id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/tournaments/${id}/join`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 402) throw new Error("insufficient chips");
  if (!res.ok) throw new Error(`join failed: ${res.status}`);
}

// ── Friends ─────────────────────────────────────────────────────────
export interface FriendsResponse {
  accepted: { playerId: string; since: number }[];
  incoming: { playerId: string; createdAt: number }[];
  outgoing: { playerId: string; createdAt: number }[];
}

export async function listFriendsApi(token: string): Promise<FriendsResponse> {
  const res = await fetch(`${BASE}/api/friends`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`friends list failed: ${res.status}`);
  return res.json();
}

export async function requestFriendApi(token: string, targetPlayerId: string)
  : Promise<{ status: "pending" | "accepted" }> {
  const res = await fetch(`${BASE}/api/friends/request`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ targetPlayerId }),
  });
  if (res.status === 404) throw new Error("target user not found");
  if (res.status === 409) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "conflict");
  }
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return res.json();
}

export async function respondFriendApi(
  token: string, other: string, action: "accept" | "decline",
): Promise<void> {
  const res = await fetch(`${BASE}/api/friends/${encodeURIComponent(other)}/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`${action} failed: ${res.status}`);
}

export async function unfriendApi(token: string, other: string): Promise<void> {
  const res = await fetch(`${BASE}/api/friends/${encodeURIComponent(other)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`unfriend failed: ${res.status}`);
}

// ── Private rooms ───────────────────────────────────────────────────
export interface PrivateRoomCreated {
  roomId:    string;
  gameType:  GameType;
  capacity:  number;
  joinToken: string;
  expiresAt: number;
}

export async function createPrivateRoomApi(
  token: string, gameType: GameType, ttlMinutes?: number,
): Promise<PrivateRoomCreated> {
  const res = await fetch(`${BASE}/api/rooms/private`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ gameType, ...(ttlMinutes ? { ttlMinutes } : {}) }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return res.json();
}

export async function resolvePrivateRoomApi(
  token: string, joinToken: string,
): Promise<{ roomId: string; gameType: GameType; capacity: number; expiresAt: number }> {
  const res = await fetch(`${BASE}/api/rooms/by-token/${encodeURIComponent(joinToken)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) throw new Error("token not found");
  if (res.status === 410) throw new Error("token expired");
  if (!res.ok) throw new Error(`resolve failed: ${res.status}`);
  return res.json();
}

// ── Room invites ────────────────────────────────────────────────────
export interface RoomInvite {
  id:        number;
  inviter:   string;
  joinToken: string;
  gameType:  GameType;
  createdAt: number;
  expiresAt: number;
}

export async function inviteFriendToRoomApi(
  token: string, friendPlayerId: string, joinToken: string,
): Promise<void> {
  const res = await fetch(`${BASE}/api/rooms/invite`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ friendPlayerId, joinToken }),
  });
  if (res.status === 403) throw new Error("not friends");
  if (res.status === 404) throw new Error("token not found");
  if (res.status === 410) throw new Error("token expired");
  if (!res.ok) throw new Error(`invite failed: ${res.status}`);
}

export async function listInvitesApi(token: string): Promise<{ invites: RoomInvite[] }> {
  const res = await fetch(`${BASE}/api/rooms/invites`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`list invites failed: ${res.status}`);
  return res.json();
}

export async function declineInviteApi(token: string, id: number): Promise<void> {
  const res = await fetch(`${BASE}/api/rooms/invites/${id}/decline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`decline failed: ${res.status}`);
}

// ── Replays ─────────────────────────────────────────────────────────
export interface ReplaySummary {
  gameId:        string;
  gameType:      GameType;
  engineVersion: number;
  playerIds:     string[];
  startedAt:     number;
  finishedAt:    number;
  winnerId:      string | null;
  reason:        string | null;
  replayable:    boolean;
}

export interface ReplayEvent {
  kind:     "action" | "tick";
  seq?:     number;
  playerId?: string;
  action?:  unknown;
  ts:       number;
}

export interface ReplayDetail extends ReplaySummary {
  currentVersion:  number;
  initialSnapshot: unknown | null;
  events:          ReplayEvent[];
}

export async function listMyReplaysApi(token: string)
  : Promise<{ engineVersion: number; replays: ReplaySummary[] }> {
  const res = await fetch(`${BASE}/api/me/replays`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`replays list failed: ${res.status}`);
  return res.json();
}

export async function getReplayApi(token: string, gameId: string): Promise<ReplayDetail> {
  const res = await fetch(`${BASE}/api/replays/${encodeURIComponent(gameId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) throw new Error("replay not found");
  if (res.status === 403) throw new Error("not your game");
  if (!res.ok) throw new Error(`replay get failed: ${res.status}`);
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
