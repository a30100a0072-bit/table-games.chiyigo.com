// /src/do/TournamentDO.ts
// Tournament orchestrator — one DO instance per tournament_id.
//
// Best-of-N flow:
//   register → registering → 4 players → start: spawn GameRoomDO → running
//   GameRoomDO settles → POST /round-result here → accumulate scores
//   if rounds_done < rounds_total → spawn next GameRoomDO
//   else → status=settled, payout to winner via chip_ledger.

import type { GameType, SettlementResult } from "../types/game";
import { isGameType }                        from "../types/game";
import { log, errStr }                       from "../utils/log";

const PRIZE_RAKE_PCT = 5;        // 5% house rake on prize pool
const ROUNDS         = 3;        // best-of-3
const REQUIRED       = 4;        // single tournament size for MVP

export interface TournamentEnv {
  GAME_ROOM:        DurableObjectNamespace;
  TOURNAMENT_DO:    DurableObjectNamespace;
  DB:               D1Database;
}

interface Entry {
  playerId:  string;
  aggScore:  number;
  finalRank: number | null;
}

/** Per-round breakdown captured at handleRoundResult so the bracket UI
 *  can show "X went +30 / -10 / +20 across rounds" instead of just
 *  the rolling total.                                                  // L2_實作 */
interface RoundResult {
  round:   number;                          // 1-indexed
  finishedAt: number;                       // Unix ms
  deltas:  Record<string, number>;          // playerId -> scoreDelta
}

interface State {
  tournamentId: string;
  gameType:     GameType;
  buyIn:        number;
  prizePool:    number;
  status:       "registering" | "running" | "settled";
  roundsDone:   number;
  entries:      Entry[];        // length 0..4
  currentRoom:  string | null;
  winnerId:     string | null;
  createdAt:    number;
  /** Length matches roundsDone. Optional in storage so legacy state
   *  hydrates as []. Bumped after each /round-result.                  // L3_架構 */
  roundResults?: RoundResult[];
}

const SK = "state";

export class TournamentDO implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env:   TournamentEnv;
  private s: State | null = null;

  constructor(state: DurableObjectState, env: TournamentEnv) {
    this.state = state;
    this.env   = env;
    this.state.blockConcurrencyWhile(() => this.hydrate());
  }

  private async hydrate(): Promise<void> {
    this.s = (await this.state.storage.get<State>(SK)) ?? null;
  }

  private async persist(): Promise<void> {
    if (this.s) await this.state.storage.put(SK, this.s);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/init")          return this.handleInit(request);
    if (url.pathname === "/join")          return this.handleJoin(request);
    if (url.pathname === "/state")         return this.handleState();
    if (url.pathname === "/round-result")  return this.handleRoundResult(request);
    return new Response("not found", { status: 404 });
  }

  /**
   * POST /init { tournamentId, gameType, buyIn }
   * Called once by the gateway when a new tournament is created.
   */
  private async handleInit(request: Request): Promise<Response> {
    if (this.s) return new Response("already initialised", { status: 409 });
    const body = await request.json<{ tournamentId: string; gameType: string; buyIn: number }>();
    if (!isGameType(body.gameType)) return new Response("bad gameType", { status: 400 });
    if (!Number.isInteger(body.buyIn) || body.buyIn < 100)
      return new Response("buyIn must be ≥ 100", { status: 400 });

    const grossPool = body.buyIn * REQUIRED;
    const prizePool = grossPool - Math.floor(grossPool * PRIZE_RAKE_PCT / 100);

    this.s = {
      tournamentId: body.tournamentId,
      gameType:     body.gameType,
      buyIn:        body.buyIn,
      prizePool,
      status:       "registering",
      roundsDone:   0,
      entries:      [],
      currentRoom:  null,
      winnerId:     null,
      createdAt:    Date.now(),
      roundResults: [],
    };
    await this.persist();
    return Response.json({ ok: true, prizePool });
  }

  /**
   * POST /join { playerId }
   * Appends a new entry; auto-starts when 4 are registered. Buy-in
   * deduction is the gateway's job (so the DB transaction owns it).
   */
  private async handleJoin(request: Request): Promise<Response> {
    if (!this.s) return new Response("not initialised", { status: 400 });
    if (this.s.status !== "registering")
      return new Response("registration closed", { status: 409 });

    const { playerId } = await request.json<{ playerId: string }>();
    if (!playerId) return new Response("playerId required", { status: 400 });
    if (this.s.entries.some(e => e.playerId === playerId))
      return new Response("already registered", { status: 409 });
    if (this.s.entries.length >= REQUIRED)
      return new Response("tournament full", { status: 409 });

    this.s.entries.push({ playerId, aggScore: 0, finalRank: null });
    await this.persist();

    if (this.s.entries.length === REQUIRED) {
      await this.startNextRound();
    }
    return Response.json({ ok: true, registered: this.s.entries.length });
  }

  private async handleState(): Promise<Response> {
    if (!this.s) return new Response("not initialised", { status: 404 });
    return Response.json(this.s);
  }

  /**
   * POST /round-result { settlement }
   * Called by GameRoomDO when one tournament round ends. Accumulates
   * per-player scoreDelta into agg_score, then either spawns the next
   * round or finalises the tournament.
   */
  private async handleRoundResult(request: Request): Promise<Response> {
    if (!this.s) return new Response("not initialised", { status: 400 });
    if (this.s.status !== "running")
      return new Response("not running", { status: 409 });

    const { settlement } = await request.json<{ settlement: SettlementResult }>();
    const deltas: Record<string, number> = {};
    for (const p of settlement.players) {
      const e = this.s.entries.find(x => x.playerId === p.playerId);
      if (e) e.aggScore += p.scoreDelta;
      deltas[p.playerId] = p.scoreDelta;
    }
    this.s.roundsDone += 1;
    this.s.currentRoom = null;
    (this.s.roundResults ??= []).push({
      round:      this.s.roundsDone,
      finishedAt: settlement.finishedAt,
      deltas,
    });
    await this.persist();

    log("info", "tournament_round_done", {
      tournamentId: this.s.tournamentId,
      roundsDone:   this.s.roundsDone,
    });

    if (this.s.roundsDone >= ROUNDS) {
      await this.finalise();
    } else {
      await this.startNextRound();
    }
    return Response.json({ ok: true, roundsDone: this.s.roundsDone });
  }

  // ── private orchestration ─────────────────────────────────────────

  private async startNextRound(): Promise<void> {
    if (!this.s) return;
    this.s.status = "running";

    const roomId  = crypto.randomUUID();
    const roundId = crypto.randomUUID();
    const stub    = this.env.GAME_ROOM.get(this.env.GAME_ROOM.idFromName(roomId));

    // Hand the room our tournament_id so its post-settle hook can reach
    // back into this DO.                                                  // L2_實作
    const init = await stub.fetch(new Request("https://gameroom.internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gameId:       roomId,
        roundId,
        gameType:     this.s.gameType,
        capacity:     REQUIRED,
        tournamentId: this.s.tournamentId,
        prefilledPlayerIds: this.s.entries.map(e => e.playerId),
      }),
    }));

    if (!init.ok) {
      log("error", "tournament_round_init_failed", {
        tournamentId: this.s.tournamentId, status: init.status,
      });
      // Roll the round counter back so a manual retry path is feasible.
      return;
    }

    this.s.currentRoom = roomId;
    if (this.s.roundsDone === 0) await this.markStartedInDb();
    await this.persist();

    log("info", "tournament_round_started", {
      tournamentId: this.s.tournamentId, roomId, round: this.s.roundsDone + 1,
    });
  }

  private async markStartedInDb(): Promise<void> {
    if (!this.s) return;
    try {
      await this.env.DB
        .prepare("UPDATE tournaments SET status = 'running', started_at = ? WHERE tournament_id = ?")
        .bind(Date.now(), this.s.tournamentId)
        .run();
    } catch (err) {
      log("error", "tournament_db_update_failed", { err: errStr(err) });
    }
  }

  private async finalise(): Promise<void> {
    if (!this.s) return;
    // Rank by aggregate score (desc), tiebreak by registration order (stable).
    const ranked = [...this.s.entries]
      .map((e, i) => ({ ...e, regOrder: i }))
      .sort((a, b) => b.aggScore - a.aggScore || a.regOrder - b.regOrder);
    ranked.forEach((e, idx) => {
      const target = this.s!.entries.find(x => x.playerId === e.playerId)!;
      target.finalRank = idx + 1;
    });
    const winner = ranked[0]!;

    this.s.status      = "settled";
    this.s.winnerId    = winner.playerId;
    await this.persist();

    // Atomic payout: winner +prize_pool, ledger row, status update.
    // Buy-ins were already debited at registration; non-winners just
    // don't get paid back. INSERT OR IGNORE on UNIQUE keeps retries safe.
    const now = Date.now();
    try {
      await this.env.DB.batch([
        this.env.DB
          .prepare(
            "UPDATE users SET chip_balance = chip_balance + ?, updated_at = ?" +
            " WHERE player_id = ?",
          )
          .bind(this.s.prizePool, now, winner.playerId),
        this.env.DB
          .prepare(
            "INSERT OR IGNORE INTO chip_ledger (player_id, game_id, delta, reason, created_at)" +
            " VALUES (?, ?, ?, 'tournament', ?)",
          )
          .bind(winner.playerId, this.s.tournamentId, this.s.prizePool, now),
        this.env.DB
          .prepare(
            "UPDATE tournaments SET status='settled', finished_at=?, winner_id=?, rounds_done=?" +
            " WHERE tournament_id = ?",
          )
          .bind(now, winner.playerId, this.s.roundsDone, this.s.tournamentId),
        ...this.s.entries.map(e =>
          this.env.DB
            .prepare(
              "UPDATE tournament_entries SET agg_score = ?, final_rank = ?" +
              " WHERE tournament_id = ? AND player_id = ?",
            )
            .bind(e.aggScore, e.finalRank, this.s!.tournamentId, e.playerId),
        ),
      ]);
      log("info", "tournament_settled", {
        tournamentId: this.s.tournamentId,
        winnerId:     winner.playerId,
        prize:        this.s.prizePool,
      });
    } catch (err) {
      log("error", "tournament_settlement_db_failed", {
        tournamentId: this.s.tournamentId, err: errStr(err),
      });
    }
  }
}
