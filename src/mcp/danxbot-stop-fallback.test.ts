/**
 * Unit tests for the danxbot MCP fallback module (DX-242).
 *
 * `tryDirectDbWrite` is exercised by the MCP regression suite (which
 * spawns the real server with no DB creds, forcing the fs-queue
 * branch) — testing it here against a real postgres would couple the
 * unit suite to db state, and mocking pg deeply is brittle. Instead
 * this suite covers:
 *
 *   - `writeFsQueueEntry` — atomic file write contract.
 *   - `readFallbackDbConfig` — env parsing, partial-config rejection.
 *
 * The DB direct-write path is covered end-to-end via the spawn-based
 * regression in `danxbot-mcp-server.test.ts` and through the worker
 * boot replay's tests (which assert dispatch rows are correctly
 * finalized when files exist on disk — if the DB write had succeeded
 * upstream, the file wouldn't exist).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import {
  readFallbackDbConfig,
  tryDirectDbWrite,
  writeFsQueueEntry,
  type FallbackDbConfig,
} from "./danxbot-stop-fallback.js";
import {
  probePgReachable,
  resolveTestPgHost,
} from "../__tests__/helpers/test-pg.js";

describe("writeFsQueueEntry (DX-242)", () => {
  let workArea: string;

  beforeEach(() => {
    workArea = mkdtempSync(join(tmpdir(), "danxbot-fb-"));
  });

  afterEach(() => {
    rmSync(workArea, { recursive: true, force: true });
  });

  it("creates the dispatch-stops dir and writes the JSON entry", () => {
    const ok = writeFsQueueEntry(
      { dispatchId: "d1", status: "completed", summary: "ok" },
      workArea,
    );
    expect(ok).toBe(true);
    const file = join(workArea, ".danxbot", "dispatch-stops", "d1.json");
    expect(existsSync(file)).toBe(true);
    const body = JSON.parse(readFileSync(file, "utf-8"));
    expect(body).toMatchObject({
      dispatchId: "d1",
      status: "completed",
      summary: "ok",
    });
    expect(typeof body.timestamp).toBe("string");
  });

  it("preserves the original CompleteStatus (not collapsed to DB shape)", () => {
    // The replay path needs the original `critical_failure` value to
    // route correctly (writeFlag + row failed). Collapsing here would
    // erase the signal.
    writeFsQueueEntry(
      {
        dispatchId: "d2",
        status: "critical_failure",
        summary: "MCP not loaded",
      },
      workArea,
    );
    const file = join(workArea, ".danxbot", "dispatch-stops", "d2.json");
    const body = JSON.parse(readFileSync(file, "utf-8"));
    expect(body.status).toBe("critical_failure");
  });

  it("is idempotent — writing the same dispatchId twice overwrites cleanly", () => {
    writeFsQueueEntry(
      { dispatchId: "d3", status: "failed", summary: "first" },
      workArea,
    );
    writeFsQueueEntry(
      { dispatchId: "d3", status: "completed", summary: "second" },
      workArea,
    );
    const file = join(workArea, ".danxbot", "dispatch-stops", "d3.json");
    const body = JSON.parse(readFileSync(file, "utf-8"));
    // Second write wins (the agent's most recent intent).
    expect(body.summary).toBe("second");
    expect(body.status).toBe("completed");
  });

  it("returns false on IO failure (returns rather than throws)", () => {
    // Point at a path under a regular file — mkdir will throw EEXIST/
    // ENOTDIR depending on platform. The caller relies on the boolean
    // return rather than catching, so we MUST NOT throw.
    const blocker = join(workArea, "blocker");
    writeFileSync(blocker, "block\n");
    const ok = writeFsQueueEntry(
      { dispatchId: "d4", status: "completed", summary: "ok" },
      blocker, // file, not dir — mkdirSync(.danxbot under it) fails
    );
    expect(ok).toBe(false);
  });

  it("the temp file is renamed atomically (no .tmp.* leftover on success)", () => {
    writeFsQueueEntry(
      { dispatchId: "d5", status: "completed", summary: "ok" },
      workArea,
    );
    const dir = join(workArea, ".danxbot", "dispatch-stops");
    const entries = require("node:fs").readdirSync(dir);
    // Exactly one file, no `.tmp.*` siblings.
    expect(entries.length).toBe(1);
    expect(entries[0]).toBe("d5.json");
  });
});

/**
 * Real-pg integration coverage for the DB-write happy path. Skips when
 * `DANXBOT_DB_*` env is absent — local Layer 1 runs without postgres
 * stay green. CI / dev runs against the dev pg pool exercise the full
 * UPDATE / idempotency contract.
 *
 * The danxbot pg pool's `dispatches` table is the same table the live
 * MCP fallback writes to; using it directly catches column-name
 * regressions, status-enum drift, and the `WHERE NOT IN (terminal)`
 * idempotent-skip clause (load-bearing per the file header).
 */
function maybeSkip(): FallbackDbConfig | undefined {
  const raw = readFallbackDbConfig(process.env);
  if (!raw) return undefined;
  // Host portability — see `resolveTestPgHost` (DX-256).
  return { ...raw, host: resolveTestPgHost(raw.host) };
}

describe("tryDirectDbWrite (DX-242, real pg)", () => {
  const db = maybeSkip();
  // `beforeAll` probes the pool once with a 2s timeout so the suite
  // skips cleanly when pg is down — without the probe, every test's
  // `beforeEach` would hang for 10s before vitest's hookTimeout
  // fired, plus an `afterEach` cascade of `Called end on pool more
  // than once` errors from the partially-initialized pool.
  let pgReachable = false;
  beforeAll(async () => {
    if (db) pgReachable = await probePgReachable(db);
  });
  const itIfDb = db ? it : it.skip;
  let pool: Pool | undefined;
  let dispatchId: string;

  beforeEach(async (ctx) => {
    if (!db || !pgReachable) {
      ctx.skip();
      return;
    }
    pool = new Pool({
      host: db.host,
      ...(db.port ? { port: db.port } : {}),
      user: db.user,
      password: db.password,
      ...(db.database ? { database: db.database } : {}),
      max: 2,
    });
    dispatchId = `test-fb-${randomUUID()}`;
    // Seed a non-terminal `dispatches` row matching the live schema
    // (migration 009 + downstream column additions). Only the columns
    // `tryDirectDbWrite` touches matter for this assertion; others
    // get their NOT NULL DEFAULTs or are nullable.
    await pool.query(
      `INSERT INTO dispatches
        (id, repo_name, "trigger", trigger_metadata,
         "status", started_at, runtime_mode)
       VALUES ($1, 'test-repo', 'api', '{}'::jsonb,
               'running', $2, 'host')`,
      [dispatchId, Date.now()],
    );
  });

  afterEach(async () => {
    // `if (pool)` guard: when `beforeEach` skipped or threw before
    // assigning, `pool` is `undefined` and the old `await pool.end()`
    // would cascade as `Called end on pool more than once` against
    // the previous test's already-closed pool.
    if (!pool) return;
    try {
      await pool.query("DELETE FROM dispatches WHERE id = $1", [dispatchId]);
    } finally {
      await pool.end();
      pool = undefined;
    }
  });

  itIfDb("UPDATEs the dispatches row to terminal status on a non-terminal row", async () => {
    // beforeEach ctx.skip()s when !pool; this narrows for tsc.
    if (!db || !pool) return;
    const ok = await tryDirectDbWrite(
      {
        dispatchId,
        dbStatus: "completed",
        summary: "agent finished while worker was down",
      },
      db,
    );
    expect(ok).toBe(true);
    const { rows } = await pool.query<{
      status: string;
      summary: string;
      completed_at: number | string | null;
      pid_terminated_at: number | string | null;
    }>(
      `SELECT "status", summary, completed_at, pid_terminated_at
       FROM dispatches WHERE id = $1`,
      [dispatchId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
    expect(rows[0].summary).toBe("agent finished while worker was down");
    expect(Number(rows[0].completed_at)).toBeGreaterThan(0);
    // Same value as completed_at (single Date.now() reused — load-
    // bearing per DX-140 lifecycle stamp comment).
    expect(rows[0].pid_terminated_at).toEqual(rows[0].completed_at);
  });

  itIfDb("returns false on already-terminal row and preserves the original summary (idempotent)", async () => {
    if (!db || !pool) return;
    // Pre-finalize the row with a recognizable summary.
    await pool.query(
      `UPDATE dispatches SET "status" = 'failed', summary = 'original-reason' WHERE id = $1`,
      [dispatchId],
    );
    const ok = await tryDirectDbWrite(
      {
        dispatchId,
        dbStatus: "completed",
        summary: "should NOT overwrite",
      },
      db,
    );
    expect(ok).toBe(false);
    const { rows } = await pool.query<{ status: string; summary: string }>(
      `SELECT "status", summary FROM dispatches WHERE id = $1`,
      [dispatchId],
    );
    // Original terminal reason wins — mirrors the worker's
    // `handleStopFromDb` short-circuit on `isTerminalStatus`.
    expect(rows[0].status).toBe("failed");
    expect(rows[0].summary).toBe("original-reason");
  });

  itIfDb("returns false when the dispatch row does not exist (no rows updated)", async () => {
    if (!db || !pool) return;
    const ok = await tryDirectDbWrite(
      {
        dispatchId: `does-not-exist-${randomUUID()}`,
        dbStatus: "completed",
        summary: "nope",
      },
      db,
    );
    expect(ok).toBe(false);
  });
});

describe("tryDirectDbWrite — connection failures fall through cleanly (DX-242)", () => {
  it("returns false (does NOT throw) when the host is unreachable", async () => {
    // Loopback port 1 is reserved + nothing listens. The connection
    // attempt fails immediately; our caller relies on `false` to chain
    // to the filesystem-queue fallback.
    const ok = await tryDirectDbWrite(
      {
        dispatchId: "x",
        dbStatus: "completed",
        summary: "ok",
      },
      {
        host: "127.0.0.1",
        port: 1,
        user: "no-one",
        password: "nothing",
        database: "nope",
      },
    );
    expect(ok).toBe(false);
  });
});

describe("readFallbackDbConfig (DX-242)", () => {
  it("returns undefined when host is missing", () => {
    expect(
      readFallbackDbConfig({
        DANXBOT_DB_USER: "u",
        DANXBOT_DB_PASSWORD: "p",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when user is missing", () => {
    expect(
      readFallbackDbConfig({
        DANXBOT_DB_HOST: "h",
        DANXBOT_DB_PASSWORD: "p",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when password is missing", () => {
    expect(
      readFallbackDbConfig({
        DANXBOT_DB_HOST: "h",
        DANXBOT_DB_USER: "u",
      }),
    ).toBeUndefined();
  });

  it("parses a complete env block", () => {
    expect(
      readFallbackDbConfig({
        DANXBOT_DB_HOST: "h",
        DANXBOT_DB_PORT: "5432",
        DANXBOT_DB_USER: "u",
        DANXBOT_DB_PASSWORD: "p",
        DANXBOT_DB_NAME: "danxbot_chat",
      }),
    ).toEqual({
      host: "h",
      port: 5432,
      user: "u",
      password: "p",
      database: "danxbot_chat",
    });
  });

  it("omits port when absent (caller's pg default takes over)", () => {
    const cfg = readFallbackDbConfig({
      DANXBOT_DB_HOST: "h",
      DANXBOT_DB_USER: "u",
      DANXBOT_DB_PASSWORD: "p",
    });
    expect(cfg).toEqual({ host: "h", user: "u", password: "p" });
    expect("port" in (cfg ?? {})).toBe(false);
  });

  it("omits port when the env value is non-numeric (defensive)", () => {
    const cfg = readFallbackDbConfig({
      DANXBOT_DB_HOST: "h",
      DANXBOT_DB_PORT: "not-a-number",
      DANXBOT_DB_USER: "u",
      DANXBOT_DB_PASSWORD: "p",
    });
    // `parseInt("not-a-number", 10) === NaN`; we omit the field rather
    // than send NaN into pg.
    expect("port" in (cfg ?? {})).toBe(false);
  });
});
