/**
 * DX-563 AC7 — integration test: seed 1 error row at count=threshold,
 * run the dispatcher tick, expect 1 new DX-* card on disk +
 * 1 `system_error_repairs` row with `attempt_n=1` linked to the card.
 *
 * Skipped automatically when local Postgres is not reachable (mirrors
 * the existing `report.integration.test.ts` pattern). Run via
 * `docker compose up -d` first.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type TestDbHandle } from "../db/test-db.js";
import { up as up021 } from "../db/migrations/021_system_errors.js";
import { recordError } from "./categorize.js";
import { runSelfRepairDispatch } from "../cron/jobs/self-repair-dispatch.js";
import {
  getDispatchCandidate,
  insertRepairAttempt,
} from "./dispatch-pick.js";
import type { PoolClient } from "pg";

const handle: TestDbHandle | null = await createTestDb();

if (!handle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[self-repair-dispatch.integration.test] skipping — local Postgres not reachable",
  );
} else {
  await runMigration(handle.pool, up021);
}

afterAll(async () => {
  if (handle) await handle.close();
});

async function runMigration(
  pool: import("pg").Pool,
  fn: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

function makeRepoDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `self-repair-int-${name}-`));
  mkdirSync(join(dir, ".danxbot", "issues", "open"), { recursive: true });
  // issue-prefix config (real loader is strict)
  mkdirSync(join(dir, ".danxbot", "config"), { recursive: true });
  writeFileSync(
    join(dir, ".danxbot", "config", "config.yml"),
    "issue_prefix: DX\n",
    "utf-8",
  );
  return dir;
}

describe.skipIf(!handle)(
  "runSelfRepairDispatch — integration with system_errors + system_error_repairs",
  () => {
    it("seeds 1 error row at threshold → 1 tick → 1 new DX-* card on disk + 1 repair row attempt_n=1, card_id=DX-*", async () => {
      const repo = `self-repair-int-${Date.now()}`;
      const repoDir = makeRepoDir(`disk-${Date.now()}`);

      // Seed: record one error 3 times to reach the default threshold=3.
      for (let i = 0; i < 3; i++) {
        await recordError({
          db: handle!.pool,
          repo,
          component: "worker",
          err: new Error("TypeError: cannot read 'foo' of undefined"),
          samplePayload: { raw_msg: "boom", path: "src/x.ts" },
        });
      }

      // Run the dispatcher tick. `getCandidate`/`getPrior`/`insertAttempt`/
      // `setCard`/`flipStatus` use real DB defaults; `danxIssueCreate`
      // uses the in-process create path which allocates the real
      // DX-* id and writes the final file.
      const result = await runSelfRepairDispatch({
        ctx: { repoName: repo, repoRoot: repoDir },
        epicId: "DX-560",
        readThreshold: () => 3,
        ensureDisplayMirror: async () => undefined,
        getCandidate: async (args) => {
          const { rows } = await handle!.pool.query<any>(
            `SELECT e.id, e.signature_hash, e.category_key, e.component, e.err_class,
                    e.normalized_msg, e.sample_payload, e.count, e.first_seen, e.last_seen,
                    e.status, e.repo
             FROM system_errors e
             WHERE e.repo = $1 AND e.status = 'open' AND e.count >= $2
             ORDER BY e.count DESC, e.last_seen DESC LIMIT 1`,
            [args.repo, args.threshold],
          );
          return rows[0] ?? null;
        },
        getPrior: async (args) => {
          const { rows } = await handle!.pool.query<any>(
            `SELECT id, error_id, attempt_n, card_id, dispatch_id,
                    started_at, ended_at, verdict, report_md
             FROM system_error_repairs WHERE error_id = $1 ORDER BY attempt_n ASC`,
            [args.errorId],
          );
          return rows;
        },
        insertAttempt: async (args) => {
          const { rows } = await handle!.pool.query<any>(
            `INSERT INTO system_error_repairs (error_id, attempt_n, started_at)
             VALUES ($1, $2, NOW())
             RETURNING id, error_id, attempt_n, card_id, dispatch_id,
                       started_at, ended_at, verdict, report_md`,
            [args.errorId, args.attemptN],
          );
          return rows[0];
        },
        setCard: async (args) => {
          await handle!.pool.query(
            `UPDATE system_error_repairs SET card_id = $1 WHERE id = $2`,
            [args.cardId, args.attemptId],
          );
        },
        flipStatus: async (args) => {
          await handle!.pool.query(
            `UPDATE system_errors SET status = $1 WHERE id = $2`,
            [args.status, args.errorId],
          );
        },
      });

      expect(result.kind).toBe("dispatched");
      if (result.kind !== "dispatched") throw new Error("expected dispatched");
      expect(result.attemptN).toBe(1);
      expect(result.cardId).toMatch(/^DX-\d+$/);

      // 1 new DX-* card on disk
      const open = readdirSync(join(repoDir, ".danxbot", "issues", "open"));
      const yml = open.find((f) => f.startsWith("DX-") && f.endsWith(".yml"));
      expect(yml).toBeDefined();
      const cardContent = readFileSync(
        join(repoDir, ".danxbot", "issues", "open", yml!),
        "utf-8",
      );
      expect(cardContent).toContain("parent_id: DX-560");
      expect(cardContent).toContain("type: Bug");
      expect(cardContent).toContain("Self-Repair > Attempt 1");

      // 1 repair row, attempt_n=1, card_id=the DX-* id
      const { rows: repairRows } = await handle!.pool.query<{
        attempt_n: number;
        card_id: string;
        error_id: number;
      }>(
        `SELECT attempt_n, card_id, error_id FROM system_error_repairs
         WHERE card_id = $1`,
        [result.cardId],
      );
      expect(repairRows).toHaveLength(1);
      expect(Number(repairRows[0].attempt_n)).toBe(1);
      expect(repairRows[0].card_id).toBe(result.cardId);

      // system_errors row flipped to 'repairing'
      const { rows: errRows } = await handle!.pool.query<{ status: string }>(
        `SELECT status FROM system_errors WHERE id = $1`,
        [repairRows[0].error_id],
      );
      expect(errRows[0].status).toBe("repairing");
    });

    it("count BELOW threshold → getDispatchCandidate returns null (no dispatch)", async () => {
      const repo = `self-repair-int-below-${Date.now()}`;
      // Only 2 recordError calls → count=2 < threshold=3.
      for (let i = 0; i < 2; i++) {
        await recordError({
          db: handle!.pool,
          repo,
          component: "worker",
          err: new Error("below-threshold error"),
          samplePayload: { raw_msg: "x" },
        });
      }
      const candidate = await getDispatchCandidate({
        db: handle!.pool,
        repo,
        threshold: 3,
      });
      expect(candidate).toBeNull();
    });

    it("3 prior attempts → getDispatchCandidate returns null (cap respected)", async () => {
      const repo = `self-repair-int-cap-${Date.now()}`;
      for (let i = 0; i < 5; i++) {
        await recordError({
          db: handle!.pool,
          repo,
          component: "worker",
          err: new Error("recurring at cap"),
          samplePayload: { raw_msg: "x" },
        });
      }
      const errorRow = await getDispatchCandidate({
        db: handle!.pool,
        repo,
        threshold: 3,
      });
      expect(errorRow).not.toBeNull();

      // Seed 3 prior attempts (closed, verdict=failed) for this error.
      for (let n = 1; n <= 3; n++) {
        const attemptRow = await insertRepairAttempt({
          db: handle!.pool,
          errorId: errorRow!.id,
          attemptN: n,
        });
        await handle!.pool.query(
          `UPDATE system_error_repairs SET ended_at = NOW(), verdict = 'failed' WHERE id = $1`,
          [attemptRow.id],
        );
      }

      const candidate = await getDispatchCandidate({
        db: handle!.pool,
        repo,
        threshold: 3,
      });
      expect(candidate).toBeNull();
    });

    it("in-flight repair row (ended_at IS NULL) → getDispatchCandidate skips the error", async () => {
      const repo = `self-repair-int-inflight-${Date.now()}`;
      for (let i = 0; i < 5; i++) {
        await recordError({
          db: handle!.pool,
          repo,
          component: "worker",
          err: new Error("recurring with in-flight repair"),
          samplePayload: { raw_msg: "x" },
        });
      }
      const errorRow = await getDispatchCandidate({
        db: handle!.pool,
        repo,
        threshold: 3,
      });
      expect(errorRow).not.toBeNull();

      // Insert one in-flight attempt (ended_at IS NULL).
      await insertRepairAttempt({
        db: handle!.pool,
        errorId: errorRow!.id,
        attemptN: 1,
      });

      const candidate = await getDispatchCandidate({
        db: handle!.pool,
        repo,
        threshold: 3,
      });
      expect(candidate).toBeNull();
    });
  },
);
