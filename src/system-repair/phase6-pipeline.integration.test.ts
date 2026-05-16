/**
 * DX-566 Phase 6 — end-to-end pipeline integration test ("free fake-claude").
 *
 * This is the integration test fronted by `make test-system-self-repair`
 * (AC6). It exercises every Phase 6 state transition in one pass against
 * a real Postgres + a mock danxbot_complete (no real Claude API,
 * no real worker boot). The "fake claude" is the test itself — it
 * inserts the YAML's `## Repair Report` comment and calls
 * `finalizeSelfRepair` directly to mimic the post-dispatch hook the
 * worker fires when the real agent calls `danxbot_complete`.
 *
 * Pipeline walk:
 *
 *   1. seed   — `recordError` x N raises count above threshold
 *   2. pick   — `getDispatchCandidate` returns the row
 *   3. fix    — fake-claude writes the report + finalize with "fixed"
 *               → `system_errors.status` flips to `fixed`
 *   4. recur1 — same signature fires again → `status` flips back to
 *               `open` AND `recurrence_count=1`
 *   5. recur2 — second recurrence → status='open', recurrence_count=2
 *   6. recur3 — third recurrence → straight to `unfixable`,
 *               recurrence_count=3 (cap exhausted)
 *   7. dispatcher refuses to pick — `getDispatchCandidate` returns null
 *      while the row is `unfixable` (status filter)
 *   8. operator reset — `resetRepairError` clears attempts AND zeroes
 *      recurrence_count, status='open'
 *   9. 3-attempt cap — three `failed` verdicts on a different signature
 *      land the row at `unfixable` via the finalize cap rule
 *
 * Skipped when local Postgres is unreachable (mirrors every other
 * `*.integration.test.ts` skip). Run via `docker compose up -d`.
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolClient } from "pg";

import { createTestDb, type TestDbHandle } from "../db/test-db.js";
import { up as up021 } from "../db/migrations/021_system_errors.js";
import { up as up022 } from "../db/migrations/022_system_errors_recurrence.js";
import { recordError } from "./categorize.js";
import {
  getDispatchCandidate,
  insertRepairAttempt,
  setRepairAttemptCard,
} from "./dispatch-pick.js";
import { finalizeSelfRepair } from "./finalize.js";
import { resetRepairError } from "./db-reads.js";

const handle: TestDbHandle | null = await createTestDb();

if (!handle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[phase6-pipeline.integration.test] skipping — local Postgres not reachable",
  );
} else {
  await runMigration(handle.pool, up021);
  await runMigration(handle.pool, up022);
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

function makeRepoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "phase6-pipeline-"));
  mkdirSync(join(dir, ".danxbot", "issues", "open"), { recursive: true });
  return dir;
}

function writeRepairReportYaml(
  repoLocalPath: string,
  cardId: string,
  reportText: string,
): void {
  const open = join(repoLocalPath, ".danxbot", "issues", "open");
  mkdirSync(open, { recursive: true });
  const yaml = [
    "schema_version: 9",
    'tracker: "memory"',
    `id: ${cardId}`,
    'external_id: ""',
    "parent_id: DX-560",
    "children: []",
    "dispatch: null",
    "status: Done",
    "type: Bug",
    'title: "self-repair test"',
    'description: ""',
    "priority: 3",
    "position: null",
    "triage:",
    '  expires_at: ""',
    '  reassess_hint: ""',
    '  last_status: ""',
    '  last_explain: ""',
    "  ice: { total: 0, i: 0, c: 0, e: 0 }",
    "  history: []",
    "ac: []",
    "comments:",
    "  - id: r1",
    "    author: danxbot",
    "    timestamp: 2026-05-15T00:00:00Z",
    `    text: ${JSON.stringify(reportText)}`,
    "retro: { good: '', bad: '', action_item_ids: [], commits: [] }",
    "assigned_agent: null",
    "waiting_on: null",
    "blocked: null",
    "requires_human: null",
    "conflict_on: []",
    "effort_level: medium",
    "history: []",
    "db_updated_at: 2026-05-15T00:00:00Z",
  ].join("\n");
  writeFileSync(join(open, `${cardId}.yml`), yaml);
}

/**
 * Mimic the worker's post-dispatch chain (insert attempt row, write
 * card_id, then the agent's `danxbot_complete` hook calls
 * `finalizeSelfRepair`). One helper instead of inlining the four
 * statements in every test step.
 */
async function fakeAttempt(args: {
  errorId: number;
  attemptN: number;
  cardId: string;
  repoLocalPath: string;
  summary: string;
}): Promise<{ verdict: string; nextStatus: string }> {
  const { errorId, attemptN, cardId, repoLocalPath, summary } = args;
  const repair = await insertRepairAttempt({
    db: handle!.pool,
    errorId,
    attemptN,
  });
  await setRepairAttemptCard({
    db: handle!.pool,
    attemptId: repair.id,
    cardId,
  });
  // Flip status to 'repairing' as the dispatcher would.
  await handle!.pool.query(
    `UPDATE system_errors SET status='repairing' WHERE id=$1`,
    [errorId],
  );
  // Fake-claude writes the repair report comment + invokes finalize.
  writeRepairReportYaml(
    repoLocalPath,
    cardId,
    `## Repair Report\n\nAttempt ${attemptN}: ${summary}`,
  );
  const result = await finalizeSelfRepair({
    db: handle!.pool,
    issueId: cardId,
    summary,
    repoLocalPath,
  });
  if (result.kind !== "finalized") {
    throw new Error(`expected finalized, got ${result.kind}`);
  }
  return { verdict: result.verdict, nextStatus: result.nextErrorStatus };
}

async function readRow(errorId: number) {
  const { rows } = await handle!.pool.query<{
    status: string;
    recurrence_count: number;
    count: number;
  }>(
    `SELECT status, recurrence_count, count FROM system_errors WHERE id=$1`,
    [errorId],
  );
  return rows[0];
}

describe.skipIf(!handle)("DX-566 Phase 6 — self-repair pipeline end-to-end", () => {
  it("walks the full lifecycle: seed → fix → 3 recurrences → unfixable → reset → 3-attempt cap", async () => {
    const repo = `phase6-pipeline-${Date.now()}`;
    const repoDir = makeRepoDir();

    // 1. seed — three occurrences land the row above threshold=3 + status='open'.
    let row = await recordError({
      db: handle!.pool,
      repo,
      component: "phase6-test",
      err: new Error("YAMLParseError: bad anchor near foo.yml"),
      samplePayload: { raw_msg: "boom" },
    });
    for (let i = 0; i < 2; i++) {
      row = await recordError({
        db: handle!.pool,
        repo,
        component: "phase6-test",
        err: new Error("YAMLParseError: bad anchor near foo.yml"),
        samplePayload: { raw_msg: "boom" },
      });
    }
    expect(row.status).toBe("open");
    expect(row.count).toBe(3);
    expect(row.recurrence_count).toBe(0);

    // 2. pick — dispatcher would target this row.
    const picked = await getDispatchCandidate({
      db: handle!.pool,
      repo,
      threshold: 3,
    });
    expect(picked?.id).toBe(row.id);

    // 3. fix — fake-claude attempt 1 ends with verdict=fixed.
    const fix1 = await fakeAttempt({
      errorId: row.id,
      attemptN: 1,
      cardId: "DX-9001",
      repoLocalPath: repoDir,
      summary: "fixed: patched the YAML anchor",
    });
    expect(fix1.verdict).toBe("fixed");
    expect(fix1.nextStatus).toBe("fixed");
    let after = await readRow(row.id);
    expect(after.status).toBe("fixed");
    expect(after.recurrence_count).toBe(0);

    // 4. recur1 — same signature fires again post-fix.
    const r1 = await recordError({
      db: handle!.pool,
      repo,
      component: "phase6-test",
      err: new Error("YAMLParseError: bad anchor near foo.yml"),
      samplePayload: { raw_msg: "boom-again" },
    });
    expect(r1.status).toBe("open");
    expect(r1.recurrence_count).toBe(1);

    // Fix it again so the next recurrence transitions from 'fixed'.
    await fakeAttempt({
      errorId: row.id,
      attemptN: 2,
      cardId: "DX-9002",
      repoLocalPath: repoDir,
      summary: "fixed: re-patched anchor",
    });
    after = await readRow(row.id);
    expect(after.status).toBe("fixed");
    expect(after.recurrence_count).toBe(1);

    // 5. recur2 — second recurrence.
    const r2 = await recordError({
      db: handle!.pool,
      repo,
      component: "phase6-test",
      err: new Error("YAMLParseError: bad anchor near foo.yml"),
      samplePayload: { raw_msg: "boom-again-2" },
    });
    expect(r2.status).toBe("open");
    expect(r2.recurrence_count).toBe(2);

    await fakeAttempt({
      errorId: row.id,
      attemptN: 3,
      cardId: "DX-9003",
      repoLocalPath: repoDir,
      summary: "fixed: re-patched anchor (again)",
    });
    after = await readRow(row.id);
    expect(after.status).toBe("fixed");
    expect(after.recurrence_count).toBe(2);

    // 6. recur3 — third recurrence flips straight to unfixable.
    const r3 = await recordError({
      db: handle!.pool,
      repo,
      component: "phase6-test",
      err: new Error("YAMLParseError: bad anchor near foo.yml"),
      samplePayload: { raw_msg: "boom-again-3" },
    });
    expect(r3.recurrence_count).toBe(3);
    expect(r3.status).toBe("unfixable");

    // 7. dispatcher skips unfixable rows.
    const skipped = await getDispatchCandidate({
      db: handle!.pool,
      repo,
      threshold: 3,
    });
    expect(skipped).toBeNull();

    // 8. operator reset — clears attempts AND recurrence_count.
    const resetResult = await resetRepairError({
      db: handle!.pool,
      id: row.id,
    });
    expect(resetResult.kind).toBe("reset");
    after = await readRow(row.id);
    expect(after.status).toBe("open");
    expect(after.recurrence_count).toBe(0);
    const attemptsAfter = await handle!.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM system_error_repairs WHERE error_id=$1`,
      [row.id],
    );
    expect(attemptsAfter.rows[0].count).toBe("0");

    // 9. 3-attempt cap — DIFFERENT signature, three failed verdicts in
    //    a row land it at unfixable via the cap rule (no fixed step).
    const capRepo = `phase6-cap-${Date.now()}`;
    let capRow = await recordError({
      db: handle!.pool,
      repo: capRepo,
      component: "phase6-cap",
      err: new Error("CapError: never resolves"),
      samplePayload: { raw_msg: "cap" },
    });
    for (let i = 0; i < 2; i++) {
      capRow = await recordError({
        db: handle!.pool,
        repo: capRepo,
        component: "phase6-cap",
        err: new Error("CapError: never resolves"),
        samplePayload: { raw_msg: "cap" },
      });
    }
    expect(capRow.count).toBe(3);

    const cap1 = await fakeAttempt({
      errorId: capRow.id,
      attemptN: 1,
      cardId: "DX-9101",
      repoLocalPath: repoDir,
      summary: "failed: agent could not patch",
    });
    expect(cap1.nextStatus).toBe("open");

    const cap2 = await fakeAttempt({
      errorId: capRow.id,
      attemptN: 2,
      cardId: "DX-9102",
      repoLocalPath: repoDir,
      summary: "failed: still broken",
    });
    expect(cap2.nextStatus).toBe("open");

    const cap3 = await fakeAttempt({
      errorId: capRow.id,
      attemptN: 3,
      cardId: "DX-9103",
      repoLocalPath: repoDir,
      summary: "failed: out of ideas",
    });
    expect(cap3.nextStatus).toBe("unfixable");

    const capAfter = await readRow(capRow.id);
    expect(capAfter.status).toBe("unfixable");

    // Dispatcher should now skip this row too.
    const capSkipped = await getDispatchCandidate({
      db: handle!.pool,
      repo: capRepo,
      threshold: 3,
    });
    expect(capSkipped).toBeNull();
  });
});
