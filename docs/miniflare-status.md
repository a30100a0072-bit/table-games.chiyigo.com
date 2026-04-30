# Miniflare / vitest-pool-workers Integration — Status

## Current state: **wired up ✅**

Real `@cloudflare/vitest-pool-workers@0.15.x` integration is live.
Tests under `test/workers/` boot the full Worker entry point inside
`workerd` / miniflare, with our `wrangler.toml` bindings overridden by
`vitest.workers.config.mts`.

## How to run

```bash
npm test                # vitest 4 — pure Node unit tests (~110)
npm run test:workers    # vitest 4 + miniflare — real Worker runtime
```

Both run in CI (`.github/workflows/cloudflare-deploy.yml`) and gate
deploy.

## What's covered

`test/workers/jwks.test.ts` (3 tests):
- /.well-known/jwks.json shape + kid match
- 404 on unknown routes
- CORS preflight on /api/match

`test/workers/auth-flow.test.ts` (3 tests):
- /auth/token issues a real ES256 token, verifies via /api/me/wallet,
  signup + daily ledger rows present
- Malformed JWT rejected with 401
- Admin freeze → /auth/token returns 423

The schema is bootstrapped per test run via the D1 binding exposed by
`cloudflare:test`'s `env`; no manual fixture loading needed.

## Migration history

The earlier vitest 2.x setup couldn't take pool-workers (which now
requires vitest@^4). Migration done in this commit:
- `vitest@^2 → ^4` + `@vitest/runner@^4` upgrade. All 110 existing
  Node tests pass on the new runner without changes.
- `vitest.workers.config.mts` (note `.mts` — vite needs ESM for the
  pool-workers plugin import). Uses the new vitest 4 plugin shape:
  `cloudflareTest({...})` as a plugin, **not** `pool` / `poolOptions`.
- A test-only ES256 P-256 JWK lives in the config (generated once with
  `npm run gen:jwk`); `ADMIN_SECRET=test-admin` is also set there.
  Both are inert outside the test isolate.

## Promotion path for new tests

When adding a new workers test:
1. Drop the file under `test/workers/*.test.ts`.
2. `import { SELF, env } from "cloudflare:test"`.
3. `SELF.fetch(...)` to drive the Worker; `env.DB` / `env.GAME_ROOM` /
   etc. for direct binding access.
4. If your test needs DB rows, run schema DDL in a `beforeAll` like
   `test/workers/auth-flow.test.ts` does.

## Limitations still open

- Alarm timing (`state.storage.setAlarm`) — miniflare does fire alarms
  but our tests don't yet exercise the wait path. Could add via
  `vi.useFakeTimers()` if needed.
- WebSocket Hibernation across DO eviction — testable but needs a
  test harness that explicitly evicts the DO.
- D1 transaction interleaving under concurrent writes — out of scope
  for our use cases (we batch, not interleave).
