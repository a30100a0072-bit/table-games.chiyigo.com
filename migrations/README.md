# D1 migrations

Forward-only via `wrangler d1 migrations apply`. Rollback is **manual**
(see "Rollback playbook" below) — wrangler's tracker is one-way, so we
keep a matching `.down.sql` next to every `.sql` from `0002_` onward
to make manual reversal a one-liner.

## Layout
- `0001_initial.sql` — the baseline absorbed from the legacy single-file
  `src/db/schema.sql` (which is now a tombstone redirect). Idempotent; safe
  to re-run on a prod DB that already has every table. **No matching down**
  — rolling back the baseline = wiping the DB; if you need that, do it
  out-of-band, not via a migration.
- `000N_short_name.sql` — every subsequent schema change goes in its own
  numbered file. **Delta-only**: do not repeat `CREATE TABLE IF NOT EXISTS`
  for tables already in 0001. ALTER / new index / one-shot backfill only.
- `000N_short_name.down.sql` — **required** for every `000N_short_name.sql`
  where N >= 2. Must invert the up file: drop the column/index/table the
  up created, restore old defaults, etc. Smoke test enforces presence
  (see `test/migrations.test.ts`). If a change is truly irreversible (e.g.
  data destruction), commit a `.down.sql` that contains only a comment
  documenting the irreversibility — silent missing files are not allowed.

## Workflow

### Local (preview / dev)
```bash
npm run db:migrate:local        # apply pending against the local D1 sandbox
npm run db:migrate:list:local   # show applied + pending
```

### Production
```bash
npm run db:migrate:prod         # apply pending against the prod D1
npm run db:migrate:list:prod    # show applied + pending
```

CI runs `npm run db:migrate:prod` before deploying the Worker — see
`.github/workflows/cloudflare-deploy.yml`.

## Tracking table
`wrangler` writes one row per applied file into a managed table
(`d1_migrations`). Don't touch it by hand.

## Conventions
- Number files monotonically: `0001_`, `0002_`, ... Four-digit zero-padded.
- One concern per file. Two unrelated changes in one PR get two files.
- SQLite lacks `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so a column
  migration is one statement and runs exactly once per DB.
- Don't edit a file that's already been applied to prod. Add a new one.
- `INSERT OR IGNORE` for one-shot backfills so re-running is safe (even
  though wrangler's tracker should prevent that).
- Every `000N_*.sql` (N >= 2) ships with a matching `000N_*.down.sql`
  in the same commit. Smoke test fails CI if missing.

## Rollback playbook

Wrangler doesn't track downs; rolling back a bad migration is manual.

```bash
# 1. Identify the broken migration
npm run db:migrate:list:prod

# 2. Run its down file against prod
wrangler d1 execute big-two-db --env production --remote \
  --file=migrations/000N_short_name.down.sql

# 3. Remove the row from the tracker so the next apply re-runs the (fixed) up
wrangler d1 execute big-two-db --env production --remote \
  --command="DELETE FROM d1_migrations WHERE name='000N_short_name.sql'"

# 4. Push the fixed up file and re-run db:migrate:prod
```

`.down.sql` files MUST be safe to run twice — use `DROP ... IF EXISTS`
and conditional `ALTER` (or document an "intentionally irreversible"
header if the up destroyed data).
