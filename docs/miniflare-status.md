# Miniflare / vitest-pool-workers Integration — Status

## Current state: **deferred**

A real `@cloudflare/vitest-pool-workers` integration would let us drive
the Worker entry point + Durable Object lifecycle through `workerd` /
`miniflare` exactly the way production runs them, including alarms,
WebSocket Hibernation, and DO storage transactions.

## Why it isn't wired up yet

`@cloudflare/vitest-pool-workers@0.15.x` (current latest) **requires
`vitest@^4.0.0`**, while this project is on `vitest@^2.0.0`. The two
combinations were tried:

1. Pin pool-workers to a vitest-2-compatible release (~0.5.x) — works
   but predates current Workers runtime semantics, won't reproduce
   recent DO behaviour.
2. Bump vitest to 4 alongside pool-workers — the existing 108 unit
   tests need migration (vitest 4 dropped legacy globals, changed
   snapshot format, and tightens type narrowing). Not worth landing
   alongside everything else without a dedicated session.

## What we ship instead

- `test/tournamentDO.test.ts` — direct DO instantiation with a
  hand-rolled `DurableObjectState` mock. Covers TournamentDO
  orchestration paths.
- `test/gateway.handler.test.ts` — `handleRequest` driven against a
  fake D1 + JWKS env. Covers the routing + auth + chip-economy
  surface.

These together hit ~80% of what miniflare would cover, missing only:

- DO **alarm** firing semantics (we test schedule+cancel logic but
  not that the runtime actually fires after `setAlarm()`).
- WebSocket Hibernation reattachment after eviction.
- Real D1 transaction interleaving (mock runs statements serially).

## Promotion path

When the codebase is ready to migrate to vitest 4 (or pool-workers
ships a vitest-2 backport):

1. `npm install --save-dev @cloudflare/vitest-pool-workers`
2. Restore `vitest.workers.config.ts` (template kept in git history).
3. Add `test:workers` to `npm run` and to the CI workflow as a
   separate step — it runs slower so keep it parallel to the unit
   suite, not gating it.
4. Move `test/tournamentDO.test.ts` and `test/gateway.handler.test.ts`
   under `test/workers/` to use the real bindings.
