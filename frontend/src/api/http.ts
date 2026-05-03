import type { GameType } from "../shared/types";
import { readApiError } from "../i18n/errorCodes";
export { ApiError, formatApiError } from "../i18n/errorCodes";

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
  nextLedgerCursor: number | null;
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
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function findMatch(token: string, gameType: GameType, mahjongHands?: number): Promise<MatchResponse> {
  const res = await fetch(`${BASE}/api/match`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      gameType,
      ...(gameType === "mahjong" && mahjongHands && mahjongHands > 1 ? { mahjongHands } : {}),
    }),
  });
  if (res.status === 402) {
    const body = await res.json().catch(() => ({})) as { balance?: number; required?: number };
    throw new InsufficientChipsError(body.balance ?? 0, body.required ?? 0, gameType);
  }
  if (!res.ok) throw await readApiError(res);
  // Backend returns { matched, roomId, gameType, players }; wsUrl is derived client-side. // L2_鎖定
  const data = await res.json() as { roomId: string; gameType: GameType; players: string[] };
  const wsBase = BASE.replace(/^http/, "ws");
  const wsUrl  = `${wsBase}/rooms/${data.roomId}/join`;
  return { roomId: data.roomId, wsUrl, players: data.players, gameType: data.gameType };
}

export async function getWallet(token: string, ledgerCursor?: number): Promise<WalletResponse> {
  const url = ledgerCursor !== undefined
    ? `${BASE}/api/me/wallet?ledgerCursor=${ledgerCursor}`
    : `${BASE}/api/me/wallet`;
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) throw await readApiError(res);
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
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export interface LeaderboardRow {
  player_id:    string;
  display_name: string;
  chip_balance: number;
}
export async function getLeaderboard(): Promise<{ updatedAt: number; rows: LeaderboardRow[] }> {
  const res = await fetch(`${BASE}/api/leaderboard`);
  if (!res.ok) throw await readApiError(res);
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
export interface TournamentRoundResult {
  round:      number;
  finishedAt: number;
  deltas:     Record<string, number>;
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
  entries:      TournamentEntry[];
  currentRoom:  string | null;
  roundResults: TournamentRoundResult[];
}

export interface MyTournamentRow {
  tournament_id: string;
  game_type:     GameType;
  buy_in:        number;
  prize_pool:    number;
  status:        "registering" | "running" | "settled";
  rounds_total:  number;
  rounds_done:   number;
  created_at:    number;
  finished_at:   number | null;
  winner_id:     string | null;
  currentRoom:   string | null;
}

export async function listMyTournamentsApi(token: string): Promise<{ rows: MyTournamentRow[] }> {
  const res = await fetch(`${BASE}/api/me/tournaments`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function listTournaments(): Promise<{ rows: TournamentRow[]; required: number }> {
  const res = await fetch(`${BASE}/api/tournaments`);
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function getTournament(id: string): Promise<TournamentDetail> {
  const res = await fetch(`${BASE}/api/tournaments/${id}`);
  if (!res.ok) throw await readApiError(res);
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
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function joinTournamentApi(token: string, id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/tournaments/${id}/join`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 402) throw new Error("insufficient chips");
  if (!res.ok) throw await readApiError(res);
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
  if (!res.ok) throw await readApiError(res);
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
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function respondFriendApi(
  token: string, other: string, action: "accept" | "decline",
): Promise<void> {
  const res = await fetch(`${BASE}/api/friends/${encodeURIComponent(other)}/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await readApiError(res);
}

export async function unfriendApi(token: string, other: string): Promise<void> {
  const res = await fetch(`${BASE}/api/friends/${encodeURIComponent(other)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await readApiError(res);
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
  if (!res.ok) throw await readApiError(res);
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
  if (!res.ok) throw await readApiError(res);
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
  if (!res.ok) throw await readApiError(res);
}

export async function listInvitesApi(token: string): Promise<{ invites: RoomInvite[] }> {
  const res = await fetch(`${BASE}/api/rooms/invites`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function declineInviteApi(token: string, id: number): Promise<void> {
  const res = await fetch(`${BASE}/api/rooms/invites/${id}/decline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await readApiError(res);
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
  kind:     "action" | "tick" | "hand_boundary";
  seq?:     number;
  playerId?: string;
  action?:  unknown;
  ts:       number;
  // hand_boundary only:
  handNumber?:  number;
  dealerIdx?:   number;
  bankerStreak?: number;
  snapshot?:    unknown;
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
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function shareReplayApi(token: string, gameId: string, ttlMs?: number)
  : Promise<{ token: string; expiresAt: number }> {
  const res = await fetch(`${BASE}/api/replays/${encodeURIComponent(gameId)}/share`, {
    method:  "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body:    JSON.stringify(ttlMs !== undefined ? { ttlMs } : {}),
  });
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export interface MyShareEntry {
  token: string; gameId: string;
  createdAt: number; expiresAt: number;
  viewCount: number;
  lastViewedAt: number | null;
}
export async function listMySharesApi(token: string): Promise<{ shares: MyShareEntry[] }> {
  const res = await fetch(`${BASE}/api/me/shares`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function revokeShareApi(token: string, shareToken: string): Promise<void> {
  const res = await fetch(`${BASE}/api/replays/share/${encodeURIComponent(shareToken)}`, {
    method:  "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) throw new Error("share not found");
  if (!res.ok) throw await readApiError(res);
}

export interface FeaturedReplay {
  gameId:     string;
  gameType:   GameType;
  playerIds:  string[];
  finishedAt: number;
  winnerId:   string | null;
  note:       string | null;
  shareToken: string;
  featuredAt: number;
  expiresAt:  number;
  viewCount:  number;
}
export async function listFeaturedReplaysApi(before?: number, limit?: number)
  : Promise<{ featured: FeaturedReplay[]; nextCursor: number | null }> {
  const qs = new URLSearchParams();
  if (before !== undefined) qs.set("before", String(before));
  if (limit  !== undefined) qs.set("limit",  String(limit));
  const url = `${BASE}/api/replays/featured${qs.toString() ? "?" + qs : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function adminFeatureReplayApi(secret: string, gameId: string, note?: string, ttlDays?: number)
  : Promise<{ gameId: string; shareToken: string; expiresAt: number }> {
  const res = await fetch(`${BASE}/api/admin/replays/feature`, {
    method: "POST",
    headers: { "X-Admin-Secret": secret, "Content-Type": "application/json" },
    body: JSON.stringify({ gameId, ...(note ? { note } : {}), ...(ttlDays ? { ttlDays } : {}) }),
  });
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function adminUnfeatureReplayApi(secret: string, gameId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/admin/replays/feature/${encodeURIComponent(gameId)}`, {
    method: "DELETE",
    headers: { "X-Admin-Secret": secret },
  });
  if (!res.ok) throw await readApiError(res);
}

export interface FriendRecommendation { playerId: string; together: number; lastPlayed: number; }
export async function getFriendRecommendationsApi(token: string): Promise<{ recommendations: FriendRecommendation[] }> {
  const res = await fetch(`${BASE}/api/friends/recommendations`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

// ── Blocks ──────────────────────────────────────────────────────────
export interface BlockEntry { playerId: string; createdAt: number; }

export async function listMyBlocksApi(token: string): Promise<{ blocks: BlockEntry[] }> {
  const res = await fetch(`${BASE}/api/blocks`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function blockPlayerApi(token: string, targetPlayerId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/blocks`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body:    JSON.stringify({ targetPlayerId }),
  });
  if (!res.ok) throw await readApiError(res);
}

export async function unblockPlayerApi(token: string, targetPlayerId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/blocks/${encodeURIComponent(targetPlayerId)}`, {
    method:  "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await readApiError(res);
}

export interface AdminHealth {
  now: number;
  cron: {
    lastRunAt: number | null;
    lastResult: {
      dmsPurged: number;
      roomTokensPurged: number;
      replaySharesPurged: number;
      roomInvitesPurged: number;
      errors: string[];
    } | null;
    runsLast7d:     number;
    failuresLast7d: number;
  };
  counts: {
    frozenUsers:        number;
    ledgerRowsLast24h:  number;
    replayRows:         number;
    dmRows:             number;
    activeReplayShares: number;
  };
}

export async function getAdminHealthApi(secret: string): Promise<AdminHealth> {
  const res = await fetch(`${BASE}/api/admin/health`, {
    headers: { "X-Admin-Secret": secret },
  });
  if (res.status === 401) throw new Error("invalid admin secret");
  if (res.status === 503) throw new Error("admin endpoints disabled");
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function getSharedReplayApi(token: string): Promise<ReplayDetail & { sharedBy: string }> {
  const res = await fetch(`${BASE}/api/replays/by-token/${encodeURIComponent(token)}`);
  if (res.status === 404) throw new Error("share link not found");
  if (res.status === 410) throw new Error("share link expired");
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function getReplayApi(token: string, gameId: string): Promise<ReplayDetail> {
  const res = await fetch(`${BASE}/api/replays/${encodeURIComponent(gameId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) throw new Error("replay not found");
  if (res.status === 403) throw new Error("not your game");
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export interface DmMessage {
  id:         number;
  sender:     string;
  recipient:  string;
  body:       string;
  created_at: number;
  read_at:    number | null;
}

export async function sendDmApi(token: string, to: string, body: string): Promise<{ id: number; createdAt: number }> {
  const res = await fetch(`${BASE}/api/dm/send`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to, body }),
  });
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function listDmConversationApi(token: string, peer: string): Promise<{ messages: DmMessage[] }> {
  const res = await fetch(`${BASE}/api/dm/inbox?with=${encodeURIComponent(peer)}`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) return { messages: [] };
  return res.json();
}

export async function unreadDmCountApi(token: string): Promise<{ unread: number }> {
  const res = await fetch(`${BASE}/api/dm/unread`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) return { unread: 0 };
  return res.json();
}

export interface LiveRoom {
  roomId:      string;
  gameType:    GameType;
  playerCount: number;
  capacity:    number;
  startedAt:   number;
}

export async function listLiveRoomsApi(): Promise<{ rooms: LiveRoom[] }> {
  const res = await fetch(`${BASE}/api/rooms/live`);
  if (!res.ok) return { rooms: [] };
  return res.json();
}

/** Triggers a browser download of the user's full data export.
 *  Resolves once the file is offered (no ack from the user). */
export async function exportAccountApi(token: string): Promise<void> {
  const res = await fetch(`${BASE}/api/me/export`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  if (!res.ok) throw await readApiError(res);
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  // Server set Content-Disposition; browsers honour it for blob downloads
  // when we forward the suggested filename via a manual anchor.
  a.href     = url;
  const cd   = res.headers.get("content-disposition") ?? "";
  const m    = cd.match(/filename="?([^"]+)"?/);
  a.download = m?.[1] ?? "big-two-export.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function deleteAccountApi(token: string): Promise<{ tombstone: string }> {
  const res = await fetch(`${BASE}/api/me`, {
    method: "DELETE",
    headers: {
      "Authorization":     `Bearer ${token}`,
      "X-Confirm-Delete":  "yes",
    },
  });
  if (!res.ok) throw await readApiError(res);
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
  if (!res.ok) throw await readApiError(res);
  return res.json();
}
