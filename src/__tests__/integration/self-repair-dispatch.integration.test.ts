/**
 * DX-651 integration test — real Postgres against the local `danxbot-postgres`
 * instance, mocked `dispatch()` entry-point (no real claude spawn). Verifies:
 *
 *   - Seeded worker-fault row past threshold → ONE dispatch fires.
 *   - DB residue is correct: `system_error_repairs` row exists with the
 *     pre-generated dispatch UUID, `system_errors.status = 'repairing'`,
 *     `attempt_n = 1`, `card_id = null`, `ended_at = null`, `verdict = null`.
 *   - Compensating delete path: when the injected `dispatch()` throws, the
 *     repair row is gone AND status is back to `open`.
 *
 * Skip semantics: if PG isn't reachable, `createTestDb()` returns `null` and
 * the test self-skips (same pattern as `issues-mirror.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "../../db/test-db.js";
import { up as upSystemErrors } from "../../db/migrations/021_system_errors.js";
import { up as upRecurrence } from "../../db/migrations/022_system_errors_recurrence.js";
import {
  runSelfRepairDispatch,
  type CandidateRow,
  type InsertRepairInput,
  type CompensateInput,
} from "../../cron/jobs/self-repair-dispatch.js";
import { finalizeRepairByDispatchId } from "../../system-repair/finalize-by-dispatch-id.js";
import { REPAIR_CAP } from "../../system-repair/types.js";
import { makeRepoContext } from "../helpers/fixtures.js";
import type { CronJobContext } from "../../cron/types.js";

const handle: TestDbHandle | null = await createTestDb();

if (!handle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[self-repair-dispatch.integration] skipping — local Postgres not reachable; run `docker compose up -d` to enable",
  );
} else {
  const client = await handle.pool.connect();
  try {
    await client.query("BEGIN");
    await upSystemErrors(client);
    await upRecurrence(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function seedWorkerFaultRow(): Promise<number> {
  const { rows } = await handle!.pool.query<{ id: number }>(
    `INSERT INTO system_errors
       (signature_hash, category_key, component, err_class, normalized_msg,
        sample_payload, count, first_seen, last_seen, status, repo)
     VALUES
       ('aaaa1111bbbb2222', 'worker-boot:DispatchSpawnError', 'worker-boot',
        'DispatchSpawnError', 'spawnAgent threw before claude PID landed',
        '{"raw_msg":"ENOENT"}'::jsonb, 5, NOW(), NOW(), 'open', 'danxbot')
     RETURNING id`,
  );
  return rows[0].id;
}

async function clearRepairTables(): Promise<void> {
  await handle!.pool.query("TRUNCATE system_error_repairs RESTART IDENTITY");
  await handle!.pool.query("TRUNCATE system_errors RESTART IDENTITY CASCADE");
}

function ctx(): CronJobContext {
  return { repoName: "danxbot", repoRoot: "/repos/danxbot" };
}

function fakeRepo() {
  return makeRepoContext({
    name: "danxbot",
    localPath: "/repos/danxbot",
    workerPort: 5562,
    issuePrefix: "DX",
  });
}

/**
 * Production candidate query against the live pool — mirrors the
 * `defaultQueryCandidates` SQL in `self-repair-dispatch.ts` so the
 * integration test exercises the same join the production cron uses.
 */
async function realQueryCandidates(): Promise<CandidateRow[]> {
  const { rows } = await handle!.pool.query<CandidateRow & { status: string }>(
    `
    SELECT
      e.id, e.signature_hash, e.category_key, e.component, e.err_class,
      e.normalized_msg, e.sample_payload, e.count, e.first_seen, e.last_seen,
      e.status, e.repo, e.recurrence_count,
      COALESCE(MAX(r.attempt_n), 0)::int AS max_attempt_n,
      COALESCE(
        BOOL_OR(r.id IS NOT NULL AND r.verdict IS NULL),
        false
      ) AS has_in_flight
    FROM system_errors e
    LEFT JOIN system_error_repairs r ON r.error_id = e.id
    WHERE e.status = 'open' AND e.count >= 3
    GROUP BY e.id
    ORDER BY e.count DESC, e.last_seen DESC
    LIMIT 50
    `,
  );
  return rows.map((r) => ({
    ...r,
    status: r.status as CandidateRow["status"],
    max_attempt_n: Number(r.max_attempt_n),
    has_in_flight: Boolean(r.has_in_flight),
  }));
}

async function realInsertRepairAndFlipStatus(
  input: InsertRepairInput,
): Promise<boolean> {
  const c = await handle!.pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO system_error_repairs
         (error_id, attempt_n, card_id, dispatch_id, started_at,
          ended_at, verdict, report_md)
       VALUES ($1, $2, NULL, $3, $4, NULL, NULL, NULL)`,
      [input.errorId, input.attemptN, input.dispatchId, input.startedAt],
    );
    const upd = await c.query(
      `UPDATE system_errors SET status = 'repairing'
        WHERE id = $1 AND status = 'open'`,
      [input.errorId],
    );
    if (upd.rowCount === 0) {
      await c.query("ROLLBACK");
      return false;
    }
    await c.query("COMMIT");
    return true;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

async function realCompensate(input: CompensateInput): Promise<void> {
  await handle!.pool.query(
    `DELETE FROM system_error_repairs WHERE error_id = $1 AND attempt_n = $2`,
    [input.errorId, input.attemptN],
  );
  await handle!.pool.query(
    `UPDATE system_errors SET status = 'open' WHERE id = $1 AND status = 'repairing'`,
    [input.errorId],
  );
}

describe("self-repair-dispatch integration", () => {
  it.skipIf(!handle)(
    "seeds a worker-fault row past threshold → real DB residue matches the contract",
    async () => {
      await clearRepairTables();
      const errorId = await seedWorkerFaultRow();

      const dispatchCalls: unknown[] = [];
      await runSelfRepairDispatch(ctx(), {
        queryCandidates: realQueryCandidates,
        insertRepairAndFlipStatus: realInsertRepairAndFlipStatus,
        compensateFailedDispatch: realCompensate,
        getRepoContext: () => fakeRepo(),
        uuid: () => "dispatch-uuid-integration-1",
        // Mock at the dispatch() level — no real claude spawn.
        dispatchFn: async (input) => {
          dispatchCalls.push(input);
          return {
            dispatchId: input.dispatchId ?? "stub",
            job: {} as never,
          };
        },
        log: () => {},
      });

      // Exactly ONE dispatch fired with the right shape.
      expect(dispatchCalls.length).toBe(1);
      const call = dispatchCalls[0] as {
        workspace: string;
        issueId: string | null;
        dispatchId: string;
      };
      expect(call.workspace).toBe("worker-repair");
      expect(call.issueId).toBeNull();
      expect(call.dispatchId).toBe("dispatch-uuid-integration-1");

      // system_errors row flipped to 'repairing'.
      const errAfter = await handle!.pool.query<{ status: string }>(
        "SELECT status FROM system_errors WHERE id = $1",
        [errorId],
      );
      expect(errAfter.rows[0].status).toBe("repairing");

      // system_error_repairs row exists pointing at the dispatch_id.
      const repairRows = await handle!.pool.query<{
        attempt_n: number;
        card_id: string | null;
        dispatch_id: string;
        ended_at: Date | null;
        verdict: string | null;
        report_md: string | null;
      }>(
        `SELECT attempt_n, card_id, dispatch_id, ended_at, verdict, report_md
         FROM system_error_repairs WHERE error_id = $1`,
        [errorId],
      );
      expect(repairRows.rows.length).toBe(1);
      expect(repairRows.rows[0]).toMatchObject({
        attempt_n: 1,
        card_id: null,
        dispatch_id: "dispatch-uuid-integration-1",
        ended_at: null,
        verdict: null,
        report_md: null,
      });
    },
  );

  // DX-652 (Phase 3) — end-to-end finalize hook loop. Each test
  // seeds a worker-fault row → runs the dispatcher → simulates
  // `handleStop` calling `finalizeRepairByDispatchId` with one of
  // the four verdict shapes → asserts the post-finalize state on
  // `system_errors` + `system_error_repairs`.
  async function runDispatchAndFinalize(opts: {
    seed: { attemptN: number; status?: "open" | "repairing" };
    summary: string;
    terminalStatus: "completed" | "failed";
  }): Promise<{ errorId: number }> {
    await clearRepairTables();
    const errorId = await seedWorkerFaultRow();
    // Bump count so the dispatcher's threshold filter accepts it
    // even at higher attempt counts (REPAIR_CAP scenarios).
    if (opts.seed.attemptN > 1) {
      await handle!.pool.query(
        `INSERT INTO system_error_repairs
           (error_id, attempt_n, card_id, dispatch_id, started_at,
            ended_at, verdict, report_md)
         SELECT $1, n, NULL, 'past-attempt-' || n, NOW(),
                NOW(), 'failed', 'prior attempt'
         FROM generate_series(1, $2) AS n`,
        [errorId, opts.seed.attemptN - 1],
      );
    }
    const dispatchId = `dispatch-uuid-finalize-${opts.seed.attemptN}`;
    await runSelfRepairDispatch(ctx(), {
      queryCandidates: realQueryCandidates,
      insertRepairAndFlipStatus: realInsertRepairAndFlipStatus,
      compensateFailedDispatch: realCompensate,
      getRepoContext: () => fakeRepo(),
      uuid: () => dispatchId,
      dispatchFn: async () => ({ dispatchId, job: {} as never }),
      log: () => {},
    });
    // Now simulate the worker's handleStop call.
    const result = await finalizeRepairByDispatchId({
      db: handle!.pool,
      dispatchId,
      summary: opts.summary,
      terminalStatus: opts.terminalStatus,
    });
    expect(result.finalized).toBe(true);
    return { errorId };
  }

  it.skipIf(!handle)(
    "DX-652 finalize hook: `fixed:` summary → system_errors.status='fixed', repair row stamped",
    async () => {
      const { errorId } = await runDispatchAndFinalize({
        seed: { attemptN: 1 },
        summary: "fixed: applied the schema bump",
        terminalStatus: "completed",
      });
      const err = await handle!.pool.query<{ status: string }>(
        "SELECT status FROM system_errors WHERE id = $1",
        [errorId],
      );
      expect(err.rows[0].status).toBe("fixed");
      const repair = await handle!.pool.query<{
        verdict: string | null;
        ended_at: Date | null;
        report_md: string | null;
      }>(
        `SELECT verdict, ended_at, report_md FROM system_error_repairs
           WHERE error_id = $1 AND attempt_n = 1`,
        [errorId],
      );
      expect(repair.rows[0].verdict).toBe("fixed");
      expect(repair.rows[0].ended_at).not.toBeNull();
      expect(repair.rows[0].report_md).toBe("fixed: applied the schema bump");
    },
  );

  it.skipIf(!handle)(
    "DX-652 finalize hook: `unfixable:` summary → system_errors.status='unfixable'",
    async () => {
      const { errorId } = await runDispatchAndFinalize({
        seed: { attemptN: 1 },
        summary: "unfixable: requires manual migration",
        terminalStatus: "completed",
      });
      const err = await handle!.pool.query<{ status: string }>(
        "SELECT status FROM system_errors WHERE id = $1",
        [errorId],
      );
      expect(err.rows[0].status).toBe("unfixable");
    },
  );

  it.skipIf(!handle)(
    "DX-652 finalize hook: `failed:` below cap → system_errors.status back to 'open' (next tick may retry)",
    async () => {
      const { errorId } = await runDispatchAndFinalize({
        seed: { attemptN: 1 },
        summary: "failed: stack still throws",
        terminalStatus: "failed",
      });
      const err = await handle!.pool.query<{ status: string }>(
        "SELECT status FROM system_errors WHERE id = $1",
        [errorId],
      );
      expect(err.rows[0].status).toBe("open");
    },
  );

  it.skipIf(!handle)(
    "DX-652 finalize hook: `failed:` at REPAIR_CAP → system_errors.status='unfixable' (cap exhausted)",
    async () => {
      const { errorId } = await runDispatchAndFinalize({
        seed: { attemptN: REPAIR_CAP },
        summary: "failed: exhausted attempts",
        terminalStatus: "failed",
      });
      const err = await handle!.pool.query<{ status: string }>(
        "SELECT status FROM system_errors WHERE id = $1",
        [errorId],
      );
      expect(err.rows[0].status).toBe("unfixable");
    },
  );

  it.skipIf(!handle)(
    "DX-652 finalize hook: no matching dispatch_id → no-op, no DB writes",
    async () => {
      await clearRepairTables();
      const errorId = await seedWorkerFaultRow();
      const result = await finalizeRepairByDispatchId({
        db: handle!.pool,
        dispatchId: "no-such-dispatch",
        summary: "fixed: doesn't matter",
        terminalStatus: "completed",
      });
      expect(result.finalized).toBe(false);
      // system_errors row untouched.
      const err = await handle!.pool.query<{ status: string }>(
        "SELECT status FROM system_errors WHERE id = $1",
        [errorId],
      );
      expect(err.rows[0].status).toBe("open");
    },
  );

  it.skipIf(!handle)(
    "dispatch() throw triggers the compensator — no DB residue, status back to 'open'",
    async () => {
      await clearRepairTables();
      const errorId = await seedWorkerFaultRow();

      await runSelfRepairDispatch(ctx(), {
        queryCandidates: realQueryCandidates,
        insertRepairAndFlipStatus: realInsertRepairAndFlipStatus,
        compensateFailedDispatch: realCompensate,
        getRepoContext: () => fakeRepo(),
        uuid: () => "dispatch-uuid-integration-throw",
        dispatchFn: async () => {
          throw new Error("simulated spawn failure");
        },
        log: () => {},
      });

      // Status reverted to 'open' by the compensator.
      const errAfter = await handle!.pool.query<{ status: string }>(
        "SELECT status FROM system_errors WHERE id = $1",
        [errorId],
      );
      expect(errAfter.rows[0].status).toBe("open");

      // Repair row deleted.
      const repairRows = await handle!.pool.query<{ id: number }>(
        "SELECT id FROM system_error_repairs WHERE error_id = $1",
        [errorId],
      );
      expect(repairRows.rows.length).toBe(0);
    },
  );
});

if (handle) {
  // Close the pool on exit so the suite doesn't hang.
  // eslint-disable-next-line no-undef
  globalThis.process.on("beforeExit", () => {
    void handle.close();
  });
}
