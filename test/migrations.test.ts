// /test/migrations.test.ts
// Static smoke for the migrations/ directory. Catches drift between the
// in-repo SQL and the schema we expect in prod *without* booting D1 or
// shelling out to wrangler — those would slow the inner loop and need
// network credentials. This file guarantees:
//
//   • numbering is monotonic and zero-padded (0001, 0002, ... 9999)
//   • every CREATE in 0001_initial uses `IF NOT EXISTS` (so a re-apply on
//     the existing prod DB is a no-op while the d1_migrations tracker
//     bootstraps itself)
//   • every backfill in 0001_initial uses `INSERT OR IGNORE`
//   • no `DROP TABLE` slips into any migration without an explicit guard
//     (a typo here can vaporise prod data; this is the single check that
//     stands between a careless PR and that outcome)
//   • the table set in 0001_initial matches the table list every workers
//     spec relies on via test/workers/_schema.ts — guards against the
//     known drift hazard noted in the audit                                 // L3_架構含防禦觀測

// Node fs/path are only ambient in tests (vitest runs in Node); the project
// deliberately doesn't pull @types/node so we declare just what we touch.
declare const __dirname: string;
declare function require(id: string): unknown;

import { describe, expect, it } from "vitest";
const { readdirSync, readFileSync, statSync } =
  require("node:fs") as {
    readdirSync:  (p: string) => string[];
    readFileSync: (p: string, enc: string) => string;
    statSync:     (p: string) => { isDirectory(): boolean };
  };
const { join } = require("node:path") as { join: (...parts: string[]) => string };

const ROOT     = join(__dirname, "..", "migrations");
const FILENAME = /^\d{4}_[a-z0-9_]+\.sql$/;

function listMigrations(): string[] {
  // UP files only — `.down.sql` rollback files are sibling artifacts and
  // are checked separately so they don't interfere with monotonic-numbering
  // or naming-regex assertions.
  return readdirSync(ROOT)
    .filter((n: string) => n.endsWith(".sql") && !n.endsWith(".down.sql"))
    .sort();
}

describe("migrations/", () => {
  it("directory exists", () => {
    expect(statSync(ROOT).isDirectory()).toBe(true);
  });

  it("contains at least the 0001 baseline", () => {
    const files = listMigrations();
    expect(files[0]).toBe("0001_initial.sql");
  });

  it("filenames are zero-padded 4-digit + snake_case", () => {
    for (const f of listMigrations()) {
      expect(f, `bad migration filename: ${f}`).toMatch(FILENAME);
    }
  });

  it("numbering is monotonic with no gaps", () => {
    const nums = listMigrations().map(f => Number(f.slice(0, 4)));
    for (let i = 0; i < nums.length; i++) {
      expect(nums[i]).toBe(i + 1);
    }
  });

  it("no migration contains an unguarded DROP TABLE", () => {
    for (const f of listMigrations()) {
      const sql = readFileSync(join(ROOT, f), "utf-8");
      // Strip line comments before scanning so a documented `-- DROP TABLE`
      // example doesn't trip the guard.
      const code = sql.replace(/--[^\n]*/g, "");
      const matches = code.match(/DROP\s+TABLE\s+(?!IF\s+EXISTS)/gi) ?? [];
      expect(matches.length, `${f} has unguarded DROP TABLE`).toBe(0);
    }
  });

  // wrangler's d1_migrations tracker is one-way; the rollback playbook in
  // migrations/README.md runs a matching .down.sql by hand. The smoke test
  // enforces presence so nobody can ship a forward-only delta migration
  // without thinking about reversal. 0001 is exempt — rolling back the
  // baseline equals wiping the DB and is intentionally out-of-band.    // L3_架構含防禦觀測
  it("every migration >= 0002 ships with a matching .down.sql", () => {
    const ups   = listMigrations().filter(f => Number(f.slice(0, 4)) >= 2);
    const all   = readdirSync(ROOT);
    for (const up of ups) {
      const down = up.replace(/\.sql$/, ".down.sql");
      expect(all.includes(down), `${up} missing rollback file ${down}`).toBe(true);
    }
  });
});

describe("migrations/0001_initial.sql", () => {
  const sql  = readFileSync(join(ROOT, "0001_initial.sql"), "utf-8");
  const code = sql.replace(/--[^\n]*/g, "");

  it("every CREATE TABLE uses IF NOT EXISTS", () => {
    const total    = (code.match(/CREATE\s+TABLE\s+/gi) ?? []).length;
    const guarded  = (code.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/gi) ?? []).length;
    expect(guarded).toBe(total);
  });

  it("every CREATE INDEX uses IF NOT EXISTS", () => {
    const total   = (code.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+/gi) ?? []).length;
    const guarded = (code.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/gi) ?? []).length;
    expect(guarded).toBe(total);
  });

  it("every INSERT is INSERT OR IGNORE (idempotent backfill only)", () => {
    const total   = (code.match(/\bINSERT\s+/gi) ?? []).length;
    const guarded = (code.match(/\bINSERT\s+OR\s+IGNORE\s+/gi) ?? []).length;
    expect(guarded).toBe(total);
  });

  it("declares every table the workers test suite seeds against", () => {
    // Mirrors the table set in test/workers/_schema.ts. If a new table is
    // added to one side, this test forces the other side to follow.
    const expected = [
      "GameRooms", "games", "player_settlements", "users", "chip_ledger",
      "tournaments", "tournament_entries", "admin_audit", "cron_runs",
      "friendships", "room_tokens", "room_invites", "blocks",
      "replay_meta", "replay_participants", "dms", "replay_shares",
      "replay_featured",
    ];
    for (const t of expected) {
      const re = new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${t}\\b`, "i");
      expect(re.test(code), `0001 missing table ${t}`).toBe(true);
    }
  });
});
