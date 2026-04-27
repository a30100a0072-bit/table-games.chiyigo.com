// /src/index.ts
// Cloudflare Worker entry point — routes HTTP/WS requests and binds all exports.
// This file is intentionally thin: all logic lives in the imported modules. // L3_架構含防禦觀測

import { handleRequest }       from "./workers/gateway";
import { handleQueue }         from "./workers/settlementConsumer";
import type { GatewayEnv }     from "./workers/gateway";
import type { SettlementQueueMessage } from "./types/game";

// ── Re-export Durable Object classes so wrangler can locate them ──────── L2_實作
// wrangler.toml `class_name` must match these exact exported identifiers.
export { GameRoomDO } from "./do/GameRoomDO";
export { LobbyDO }    from "./api/lobby";

// ── Combined Worker env (all wrangler.toml bindings) ─────────────────── L2_模組
// GatewayEnv already extends LobbyEnv which covers every required binding.
type Env = GatewayEnv;

// ── Default export: Worker fetch + queue handlers ─────────────────────── L2_實作
export default {
  /**
   * HTTP / WebSocket entry point.
   * Stateless: no game state is held here; all state lives in Durable Objects.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env);
  },

  /**
   * Queue consumer entry point.
   * Bound to the `big-two-settlement` queue in wrangler.toml.             // L3_架構含防禦觀測
   */
  async queue(
    batch: MessageBatch<unknown>,
    env:   Env,
    _ctx:  ExecutionContext,
  ): Promise<void> {
    await handleQueue(batch as MessageBatch<SettlementQueueMessage>, env); // L2_隔離 wrangler 綁定保證型別
  },
} satisfies ExportedHandler<Env>;
