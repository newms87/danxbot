import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createTestDb, type TestDbHandle } from "../../db/test-db.js";
import { up } from "../../db/migrations/016_issues_mirror.js";
import {
  startIssuesMirror,
  type IssuesMirror,
} from "../../db/issues-mirror.js";
import { canonicalize, sha256 } from "../../db/canonicalize.js";

/**
 * Phase 3 integration tests for the issues mirror — real chokidar against a
 * tmpdir repo, real Postgres against the local `danxbot-postgres` container.
 * Exercises:
 *
 *   - Watcher add → row + history.
 *   - Edit → second history row chained on prev_hash.
 *   - No-op edit (same content) → history count unchanged.
 *   - Delete → row tombstoned + history row with empty next_hash.
 *   - External write (sidesteps writeIssue) → watcher source=watcher.
 *   - reconcileNow → drift fix tagged source=reconcile.
 *   - Boot scan from a pre-populated tmpdir → N rows + N history rows.
 *
 * Top-level `await createTestDb()` matches the pattern from
 * `src/db/migrations/016_issues_mirror.test.ts`: vitest evaluates `skipIf`
 * eagerly at describe-collection time, so a `beforeAll`-built handle would
 * leave every test marked-skipped before setup runs.
 */

const handle: TestDbHandle | null = await createTestDb();

if (!handle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[issues-mirror.integration] skipping — local Postgres not reachable; run `docker compose up -d` to enable",
  );
} else {
  // Apply the Phase 2 migration so `issues` + `issue_history` exist.
  const client = await handle.pool.connect();
  try {
    await client.query("BEGIN");
    await up(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const REPO_NAME = "integration-test-repo";

function makeRepo(): { localPath: string; tmpdir: string } {
  const root = mkdtempSync(resolve(tmpdir(), "danxbot-mirror-int-"));
  mkdirSync(resolve(root, ".danxbot", "issues", "open"), { recursive: true });
  mkdirSync(resolve(root, ".danxbot", "issues", "closed"), { recursive: true });
  return { localPath: root, tmpdir: root };
}

function yamlPath(localPath: string, state: "open" | "closed", id: string): string {
  return resolve(localPath, ".danxbot", "issues", state, `${id}.yml`);
}

function writeIssueFile(
  localPath: string,
  state: "open" | "closed",
  id: string,
  content: string,
): string {
  const path = yamlPath(localPath, state, id);
  writeFileSync(path, content);
  return path;
}

const SAMPLE = (id: string, status = "ToDo") =>
  `id: ${id}\nstatus: ${status}\ntype: Feature\n`;

const PARSED = (id: string, status = "ToDo") => ({
  id,
  status,
  type: "Feature",
});

async function countHistory(
  pool: TestDbHandle["pool"],
  repoName: string,
  issueId: string,
): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM issue_history WHERE repo_name = $1 AND issue_id = $2`,
    [repoName, issueId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function fetchRow(
  pool: TestDbHandle["pool"],
  repoName: string,
  issueId: string,
): Promise<{ data: Record<string, unknown>; content_hash: string } | null> {
  const result = await pool.query<{
    data: Record<string, unknown>;
    content_hash: string;
  }>(
    `SELECT data, content_hash FROM issues WHERE repo_name = $1 AND id = $2`,
    [repoName, issueId],
  );
  return result.rows[0] ?? null;
}

async function lastSource(
  pool: TestDbHandle["pool"],
  repoName: string,
  issueId: string,
): Promise<string | null> {
  const result = await pool.query<{ source: string }>(
    `SELECT "source" FROM issue_history
       WHERE repo_name = $1 AND issue_id = $2
       ORDER BY id DESC LIMIT 1`,
    [repoName, issueId],
  );
  return result.rows[0]?.source ?? null;
}

async function clearTables(pool: TestDbHandle["pool"]): Promise<void> {
  await pool.query("DELETE FROM issue_history");
  await pool.query("DELETE FROM issues");
}

async function awaitOrTimeout(promise: Promise<void>, ms = 5000): Promise<void> {
  await promise;
  // Yield once to let any post-resolve microtasks settle before assertions.
  await new Promise((r) => setTimeout(r, 0));
  void ms;
}

async function startMirror(
  localPath: string,
): Promise<IssuesMirror> {
  return startIssuesMirror(
    { name: REPO_NAME, localPath },
    {
      pool: handle!.pool,
      reconcileIntervalMs: 0,
      awaitTimeoutMs: 5000,
    },
  );
}

afterAll(async () => {
  if (handle) await handle.close();
});

describe("issues-mirror — real chokidar + real PG", () => {
  beforeAll(async () => {
    if (handle) await clearTables(handle.pool);
  });

  it.skipIf(!handle)(
    "fresh YAML write → row present with the expected data",
    async () => {
      const repo = makeRepo();
      const mirror = await startMirror(repo.localPath);
      try {
        const expectedHash = sha256(canonicalize(PARSED("DX-100")));
        const awaited = mirror.awaitMirror(REPO_NAME, "DX-100", expectedHash);
        writeIssueFile(repo.localPath, "open", "DX-100", SAMPLE("DX-100"));
        await awaitOrTimeout(awaited);
        const row = await fetchRow(handle!.pool, REPO_NAME, "DX-100");
        expect(row).not.toBeNull();
        expect(row!.data).toMatchObject(PARSED("DX-100"));
        expect(row!.content_hash).toBe(expectedHash);
      } finally {
        await mirror.stop();
        rmSync(repo.tmpdir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!handle)(
    "edit YAML → row updated; history count incremented by 1",
    async () => {
      const repo = makeRepo();
      const mirror = await startMirror(repo.localPath);
      try {
        const path = writeIssueFile(
          repo.localPath,
          "open",
          "DX-101",
          SAMPLE("DX-101"),
        );
        const firstHash = sha256(canonicalize(PARSED("DX-101")));
        await mirror.awaitMirror(REPO_NAME, "DX-101", firstHash);

        const before = await countHistory(handle!.pool, REPO_NAME, "DX-101");
        const secondHash = sha256(
          canonicalize(PARSED("DX-101", "In Progress")),
        );
        const awaited = mirror.awaitMirror(REPO_NAME, "DX-101", secondHash);
        writeFileSync(path, SAMPLE("DX-101", "In Progress"));
        await awaitOrTimeout(awaited);
        const after = await countHistory(handle!.pool, REPO_NAME, "DX-101");
        expect(after).toBe(before + 1);
        const row = await fetchRow(handle!.pool, REPO_NAME, "DX-101");
        expect(row?.content_hash).toBe(secondHash);
      } finally {
        await mirror.stop();
        rmSync(repo.tmpdir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!handle)(
    "no-op write (same content) → history unchanged",
    async () => {
      const repo = makeRepo();
      const mirror = await startMirror(repo.localPath);
      try {
        const path = writeIssueFile(
          repo.localPath,
          "open",
          "DX-102",
          SAMPLE("DX-102"),
        );
        const hash = sha256(canonicalize(PARSED("DX-102")));
        await mirror.awaitMirror(REPO_NAME, "DX-102", hash);
        const before = await countHistory(handle!.pool, REPO_NAME, "DX-102");

        // Re-write same content — chokidar fires a `change` event but
        // content hash is unchanged, so no history row should be added.
        const awaited = mirror.awaitMirror(REPO_NAME, "DX-102", hash);
        writeFileSync(path, SAMPLE("DX-102"));
        await awaitOrTimeout(awaited);
        const after = await countHistory(handle!.pool, REPO_NAME, "DX-102");
        expect(after).toBe(before);
      } finally {
        await mirror.stop();
        rmSync(repo.tmpdir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!handle)(
    "delete YAML → row tombstoned; final history row has next_hash=''",
    async () => {
      const repo = makeRepo();
      const mirror = await startMirror(repo.localPath);
      try {
        const path = writeIssueFile(
          repo.localPath,
          "open",
          "DX-103",
          SAMPLE("DX-103"),
        );
        const hash = sha256(canonicalize(PARSED("DX-103")));
        await mirror.awaitMirror(REPO_NAME, "DX-103", hash);

        const before = await countHistory(handle!.pool, REPO_NAME, "DX-103");
        unlinkSync(path);
        // Poll for the tombstone — chokidar's unlink is async; the awaiter
        // helper only waits on hash matches, not deletes.
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const row = await fetchRow(handle!.pool, REPO_NAME, "DX-103");
          if (!row) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        const row = await fetchRow(handle!.pool, REPO_NAME, "DX-103");
        expect(row).toBeNull();
        const after = await countHistory(handle!.pool, REPO_NAME, "DX-103");
        expect(after).toBe(before + 1);

        const lastNext = await handle!.pool.query<{ next_hash: string }>(
          `SELECT next_hash FROM issue_history
             WHERE repo_name = $1 AND issue_id = $2
             ORDER BY id DESC LIMIT 1`,
          [REPO_NAME, "DX-103"],
        );
        expect(lastNext.rows[0]?.next_hash).toBe("");
      } finally {
        await mirror.stop();
        rmSync(repo.tmpdir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!handle)(
    "operator-style external write (raw fs.writeFileSync) → source=watcher",
    async () => {
      const repo = makeRepo();
      const mirror = await startMirror(repo.localPath);
      try {
        const expectedHash = sha256(canonicalize(PARSED("DX-104")));
        const awaited = mirror.awaitMirror(REPO_NAME, "DX-104", expectedHash);
        writeIssueFile(repo.localPath, "open", "DX-104", SAMPLE("DX-104"));
        await awaitOrTimeout(awaited);
        const src = await lastSource(handle!.pool, REPO_NAME, "DX-104");
        expect(src).toBe("watcher");
      } finally {
        await mirror.stop();
        rmSync(repo.tmpdir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!handle)(
    "reconcileNow re-syncs drift; history tagged source=reconcile",
    async () => {
      const repo = makeRepo();
      const mirror = await startMirror(repo.localPath);
      try {
        // Simulate a missed event: stop watcher work by writing the file
        // BEFORE the mirror has a chance to fire. Easiest reliable way:
        // disable chokidar entirely on a fresh mirror, write the file,
        // then call reconcileNow.
        await mirror.stop();
        const reconcileMirror = await startIssuesMirror(
          { name: REPO_NAME, localPath: repo.localPath },
          {
            pool: handle!.pool,
            reconcileIntervalMs: 0,
            disableWatcher: true,
          },
        );
        try {
          writeIssueFile(repo.localPath, "open", "DX-105", SAMPLE("DX-105"));
          await reconcileMirror.reconcileNow();
          const src = await lastSource(handle!.pool, REPO_NAME, "DX-105");
          expect(src).toBe("reconcile");
        } finally {
          await reconcileMirror.stop();
        }
      } finally {
        rmSync(repo.tmpdir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!handle)(
    "first-create RFC 6902 patch is from {} → newData; edit chains prev_hash",
    async () => {
      const repo = makeRepo();
      const mirror = await startMirror(repo.localPath);
      try {
        const path = writeIssueFile(
          repo.localPath,
          "open",
          "DX-110",
          SAMPLE("DX-110"),
        );
        const firstHash = sha256(canonicalize(PARSED("DX-110")));
        await mirror.awaitMirror(REPO_NAME, "DX-110", firstHash);

        // First-create patch must be a sequence of `add` ops against `{}`
        // — no `replace` / `remove` (those would imply prev had keys).
        const first = await handle!.pool.query<{
          patch: { op: string; path: string }[];
          prev_hash: string | null;
          next_hash: string;
          source: string;
        }>(
          `SELECT patch, prev_hash, next_hash, "source" FROM issue_history
             WHERE repo_name = $1 AND issue_id = $2
             ORDER BY id ASC LIMIT 1`,
          [REPO_NAME, "DX-110"],
        );
        expect(first.rows[0]).toBeDefined();
        expect(first.rows[0].prev_hash).toBeNull();
        expect(first.rows[0].next_hash).toBe(firstHash);
        for (const op of first.rows[0].patch) {
          expect(op.op).toBe("add");
        }

        // Edit chains prev_hash on the next row.
        const secondHash = sha256(
          canonicalize(PARSED("DX-110", "In Progress")),
        );
        const awaited = mirror.awaitMirror(REPO_NAME, "DX-110", secondHash);
        writeFileSync(path, SAMPLE("DX-110", "In Progress"));
        await awaitOrTimeout(awaited);
        const second = await handle!.pool.query<{
          prev_hash: string | null;
          next_hash: string;
        }>(
          `SELECT prev_hash, next_hash FROM issue_history
             WHERE repo_name = $1 AND issue_id = $2
             ORDER BY id DESC LIMIT 1`,
          [REPO_NAME, "DX-110"],
        );
        expect(second.rows[0].prev_hash).toBe(firstHash);
        expect(second.rows[0].next_hash).toBe(secondHash);
      } finally {
        await mirror.stop();
        rmSync(repo.tmpdir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!handle)(
    "DX-155: triage_expires_at column is populated from data.triage.expires_at",
    async () => {
      const repo = makeRepo();
      const mirror = await startMirror(repo.localPath);
      try {
        // Three rows with different triage states:
        //   - DX-700: triage.expires_at = ""        → column NULL (never-triaged sentinel)
        //   - DX-701: triage.expires_at = ISO       → column populated
        //   - DX-702: triage.expires_at = garbage    → column NULL (fail-open)
        const empty =
          `id: DX-700\nstatus: Review\ntype: Feature\ntriage:\n  expires_at: ""\n`;
        const valid =
          `id: DX-701\nstatus: Review\ntype: Feature\ntriage:\n  expires_at: "2026-09-01T00:00:00Z"\n`;
        const garbage =
          `id: DX-702\nstatus: Review\ntype: Feature\ntriage:\n  expires_at: "not-a-real-date"\n`;
        const emptyHash = sha256(
          canonicalize({
            id: "DX-700",
            status: "Review",
            type: "Feature",
            triage: { expires_at: "" },
          }),
        );
        const validHash = sha256(
          canonicalize({
            id: "DX-701",
            status: "Review",
            type: "Feature",
            triage: { expires_at: "2026-09-01T00:00:00Z" },
          }),
        );
        const garbageHash = sha256(
          canonicalize({
            id: "DX-702",
            status: "Review",
            type: "Feature",
            triage: { expires_at: "not-a-real-date" },
          }),
        );
        const awaitEmpty = mirror.awaitMirror(REPO_NAME, "DX-700", emptyHash);
        const awaitValid = mirror.awaitMirror(REPO_NAME, "DX-701", validHash);
        const awaitGarbage = mirror.awaitMirror(REPO_NAME, "DX-702", garbageHash);
        writeIssueFile(repo.localPath, "open", "DX-700", empty);
        writeIssueFile(repo.localPath, "open", "DX-701", valid);
        writeIssueFile(repo.localPath, "open", "DX-702", garbage);
        await awaitOrTimeout(awaitEmpty);
        await awaitOrTimeout(awaitValid);
        await awaitOrTimeout(awaitGarbage);

        const result = await handle!.pool.query<{
          id: string;
          triage_expires_at: Date | null;
        }>(
          `SELECT id, triage_expires_at FROM issues
             WHERE repo_name = $1 AND id IN ('DX-700', 'DX-701', 'DX-702')
             ORDER BY id`,
          [REPO_NAME],
        );
        expect(result.rows).toHaveLength(3);
        const byId = Object.fromEntries(
          result.rows.map((r) => [r.id, r.triage_expires_at]),
        );
        expect(byId["DX-700"]).toBeNull();
        expect(byId["DX-701"]).toEqual(new Date("2026-09-01T00:00:00Z"));
        expect(byId["DX-702"]).toBeNull();
      } finally {
        await mirror.stop();
        rmSync(repo.tmpdir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!handle)(
    "boot scan from a pre-populated tmpdir → N rows tagged source=boot-scan",
    async () => {
      const repo = makeRepo();
      // Pre-populate 5 YAMLs BEFORE startIssuesMirror runs.
      const ids = ["DX-200", "DX-201", "DX-202", "DX-203", "DX-204"];
      for (const id of ids) {
        writeIssueFile(repo.localPath, "open", id, SAMPLE(id));
      }
      const mirror = await startIssuesMirror(
        { name: REPO_NAME, localPath: repo.localPath },
        {
          pool: handle!.pool,
          reconcileIntervalMs: 0,
          disableWatcher: true,
        },
      );
      try {
        for (const id of ids) {
          const row = await fetchRow(handle!.pool, REPO_NAME, id);
          expect(row).not.toBeNull();
          const src = await lastSource(handle!.pool, REPO_NAME, id);
          expect(src).toBe("boot-scan");
        }
      } finally {
        await mirror.stop();
        rmSync(repo.tmpdir, { recursive: true, force: true });
      }
    },
  );
});
