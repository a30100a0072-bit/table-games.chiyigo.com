# D1 migrations

Forward-only migrations applied via `wrangler d1 migrations apply`.

## Layout
- `0001_initial.sql` — the baseline absorbed from the legacy single-file
  `src/db/schema.sql` (which is now a tombstone redirect). Idempotent; safe
  to re-run on a prod DB that already has every table.
- `000N_short_name.sql` — every subsequent schema change goes in its own
  numbered file. **Delta-only**: do not repeat `CREATE TABLE IF NOT EXISTS`
  for tables already in 0001. ALTER / new index / one-shot backfill only.

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
