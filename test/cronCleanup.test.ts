// /test/cronCleanup.test.ts
// Unit tests for the daily retention sweep. The mock D1 records every
// statement and lets each `.run()` return a configurable changes count
// or throw, so we can prove that one failure doesn't abort the others.

import { describe, expect, it } from "vitest";
import { runCleanup } from "../src/workers/cronCleanup";

interface Recorded { sql: string; args: unknown[] }

class MockDb {
  statements: Recorded[] = [];
  // Map SQL fragment → behaviour. Default: 0 changes.
  responses: Array<{ match: string; changes?: number; throws?: string }> = [];
  prepare(sql: string) { return new MockStmt(this, sql); }
}
class MockStmt {
  args: unknown[] = [];
  constructor(public db: MockDb, public sql: string) {}
  bind(...a: unknown[]) { this.args = a; return this; }
  async run() {
    this.db.statements.push({ sql: this.sql, args: this.args });
    const r = this.db.responses.find(x => this.sql.includes(x.match));
    if (r?.throws) throw new Error(r.throws);
    return { success: true, meta: { changes: r?.changes ?? 0 } };
  }
}

const ENV = (db: MockDb) => ({ DB: db as unknown as D1Database });

describe("runCleanup", () => {
  it("issues one DELETE per retention sweep, in a stable order, then audits the run", async () => {
    const db = new MockDb();
    await runCleanup(ENV(db), 10_000_000_000);
    const sqls = db.statements.map(s => s.sql);
    expect(sqls).toHaveLength(6);
    expect(sqls[0]).toContain("DELETE FROM dms");
    expect(sqls[1]).toContain("DELETE FROM room_tokens");
    // featured rows must precede shares — FK dependency.                    // L3_邏輯安防
    expect(sqls[2]).toContain("DELETE FROM replay_featured");
    expect(sqls[3]).toContain("DELETE FROM replay_shares");
    expect(sqls[4]).toContain("DELETE FROM room_invites");
    // The audit row goes last so a partial sweep still records what got done.
    expect(sqls[5]).toContain("INSERT INTO cron_runs");
  });

  it("audit row carries per-section counts and null errors when clean", async () => {
    const db = new MockDb();
    db.responses = [{ match: "FROM room_tokens", changes: 4 }];
    await runCleanup(ENV(db), 10_000_000_000);
    const audit = db.statements[5]!;
    expect(audit.sql).toContain("INSERT INTO cron_runs");
    // ran_at, dms, room_tokens, replay_shares, room_invites, replay_featured, errors_json
    expect(audit.args[0]).toBe(10_000_000_000);
    expect(audit.args[1]).toBe(0);     // dms
    expect(audit.args[2]).toBe(4);     // room_tokens (matched response)
    expect(audit.args[3]).toBe(0);     // replay_shares
    expect(audit.args[4]).toBe(0);     // room_invites
    expect(audit.args[5]).toBe(0);     // replay_featured
    expect(audit.args[6]).toBeNull();  // no errors
  });

  it("audit row carries the JSON-serialised error list when a section failed", async () => {
    const db = new MockDb();
    db.responses = [{ match: "FROM dms", throws: "no such table" }];
    await runCleanup(ENV(db), 1);
    const audit = db.statements[5]!;
    const errs = JSON.parse(audit.args[6] as string) as string[];
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("dmsPurged");
  });

  it("uses now-7d for the dms cutoff and `now` for expiry-based prunes", async () => {
    const db = new MockDb();
    const now = 10_000_000_000;
    await runCleanup(ENV(db), now);
    const dmsCutoff = db.statements[0]!.args[0] as number;
    expect(dmsCutoff).toBe(now - 7 * 24 * 60 * 60 * 1000);
    expect(db.statements[1]!.args[0]).toBe(now);
    expect(db.statements[2]!.args[0]).toBe(now);
    expect(db.statements[3]!.args[0]).toBe(now);
    expect(db.statements[4]!.args[0]).toBe(now);
  });

  it("returns per-section changes counts", async () => {
    const db = new MockDb();
    db.responses = [
      { match: "FROM dms",           changes: 12 },
      { match: "FROM room_tokens",   changes: 3 },
      { match: "FROM replay_shares", changes: 0 },
      { match: "FROM room_invites",  changes: 7 },
    ];
    const r = await runCleanup(ENV(db));
    expect(r.dmsPurged).toBe(12);
    expect(r.roomTokensPurged).toBe(3);
    expect(r.replaySharesPurged).toBe(0);
    expect(r.roomInvitesPurged).toBe(7);
    expect(r.errors).toEqual([]);
  });

  it("isolates failures so one bad query doesn't abort the rest", async () => {
    const db = new MockDb();
    db.responses = [
      { match: "FROM dms",           throws: "no such table" },
      { match: "FROM room_tokens",   changes: 5 },
    ];
    const r = await runCleanup(ENV(db));
    expect(r.dmsPurged).toBe(0);
    expect(r.roomTokensPurged).toBe(5);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("dmsPurged");
    expect(r.errors[0]).toContain("no such table");
  });
});
