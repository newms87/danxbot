import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { canonicalize, sha256 } from "../db/canonicalize.js";
import { parseIssue, serializeIssue } from "../issue-tracker/yaml.js";
import { createTestDb, type TestDbHandle } from "../db/test-db.js";
import { up as upIssuesMirror } from "../db/migrations/016_issues_mirror.js";
import {
  resetIssueDbQueryFn,
  setIssueDbQueryFn,
} from "../poller/issues-db.js";
import { clearAllRepoNames, setRepoName } from "../poller/repo-name.js";
import type { Issue, IssueStatus } from "../issue-tracker/interface.js";
import {
  reconcileIssue,
  _hasReconcileMutex,
  _resetReconcileMutexes,
  _resetDispatchableCache,
  _resetTriageExpiresCache,
  setReconcileSchedulerHookForRepo,
  clearReconcileSchedulerHookForRepo,
  type ReconcileRepoContext,
} from "./reconcile.js";
import { ReconcileValidationError, type ReconcileResult } from "./reconcile-types.js";

function makeIssue(id: string, status: IssueStatus = "ToDo"): Issue {
  return {
    schema_version: 9,
    tracker: "memory",
    id,
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status,
    type: "Feature",
    title: `Title for ${id}`,
    description: "Body",
    priority: 3.0,
    position: null,
    triage: {
      expires_at: "",
      reassess_hint: "",
      last_status: "",
      last_explain: "",
      ice: { total: 0, i: 0, c: 0, e: 0 },
      history: [],
    },
    ac: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    assigned_agent: null,
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    effort_level: null,
    history: [],
    db_updated_at: "",
  };
}

function makeRepoCtx(): {
  cleanup: () => void;
  repo: ReconcileRepoContext;
  openDir: string;
  closedDir: string;
} {
  const root = mkdtempSync(resolve(tmpdir(), "danxbot-reconcile-"));
  const openDir = resolve(root, ".danxbot", "issues", "open");
  const closedDir = resolve(root, ".danxbot", "issues", "closed");
  mkdirSync(openDir, { recursive: true });
  mkdirSync(closedDir, { recursive: true });
  return {
    repo: { name: "test-repo", localPath: root, issuePrefix: "DX" },
    openDir,
    closedDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeYaml(dir: string, id: string, issue: Issue): string {
  const path = resolve(dir, `${id}.yml`);
  writeFileSync(path, serializeIssue(issue));
  return path;
}

beforeEach(async () => {
  _resetReconcileMutexes();
  _resetDispatchableCache();
  _resetTriageExpiresCache();
  // Drain any triage timers armed by prior tests in this file. Without
  // this, a Review/Blocked card from one describe block can leave a
  // setTimeout in the global module map that fires `reconcileIssue(...,
  // "audit")` during the next test's run and trips assertions on
  // scheduler-hook fire counts.
  const triageTimer = await import("../dispatch/triage-timer.js");
  triageTimer._clearAllTriageTimers();
});

describe("reconcileIssue — Phase 1 chokepoint", () => {
  let ctx: ReturnType<typeof makeRepoCtx>;

  beforeEach(() => {
    ctx = makeRepoCtx();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("returns no-op result for a parseable, valid YAML in open/", async () => {
    const issue = makeIssue("DX-1");
    const path = writeYaml(ctx.openDir, "DX-1", issue);
    // Mirror's hash recipe: parse the on-disk text via parseYamlText,
    // canonicalize the resulting object, sha256. Reconcile MUST agree
    // on this byte sequence so the chokidar watcher's content-hash
    // dedup correctly skips the writer's own pre-populated row.
    const { parse: parseYamlText } = await import("yaml");
    const onDiskText = readFileSync(path, "utf-8");
    const expectedHash = sha256(
      canonicalize(parseYamlText(onDiskText) as Record<string, unknown>),
    );

    const result = await reconcileIssue(ctx.repo, "DX-1", "watcher");

    expect(result.changed).toBe(false);
    expect(result.errors).toEqual([]);
    // dispatchableChanged is `true` on first-observation of a
    // dispatchable card (Phase 4b.1 / DX-288). The fixture is a fresh
    // ToDo with no blockers, so the cache is cold → poke fires.
    expect(result.fanout).toEqual({
      parentId: null,
      dependents: [],
      dispatchableChanged: true,
    });
    // The hash MUST match what the mirror would compute on the same
    // file — parity is load-bearing for the watcher's hash-dedup
    // skip-match path.
    expect(result.prevHash).toBe(expectedHash);
    expect(result.nextHash).toBe(result.prevHash);
    // File is unchanged on disk (no write happened).
    expect(readFileSync(path, "utf-8")).toBe(serializeIssue(issue));
  });

  it("locates a YAML in closed/ when open/ is absent", async () => {
    const issue = makeIssue("DX-2", "Done");
    writeYaml(ctx.closedDir, "DX-2", issue);

    const result = await reconcileIssue(ctx.repo, "DX-2", "watcher");

    expect(result.changed).toBe(false);
    expect(result.prevHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("prefers open/ when both open/ and closed/ exist (open-wins)", async () => {
    const openIssue = makeIssue("DX-3", "In Progress");
    const closedIssue = makeIssue("DX-3", "Done");
    writeYaml(ctx.openDir, "DX-3", openIssue);
    writeYaml(ctx.closedDir, "DX-3", closedIssue);

    const result = await reconcileIssue(ctx.repo, "DX-3", "watcher");

    expect(result.changed).toBe(false);
    // Hash matches the open/ file, not closed/.
    const openHash = sha256(
      canonicalize(JSON.parse(JSON.stringify(openIssue))),
    );
    const closedHash = sha256(
      canonicalize(JSON.parse(JSON.stringify(closedIssue))),
    );
    expect(result.prevHash).toBe(openHash);
    expect(result.prevHash).not.toBe(closedHash);
  });

  it("returns tombstone result when the YAML is missing from both directories", async () => {
    const result = await reconcileIssue(ctx.repo, "DX-99", "watcher");

    expect(result.changed).toBe(false);
    expect(result.prevHash).toBeNull();
    expect(result.nextHash).toBe("");
    expect(result.errors).toEqual([]);
    expect(result.fanout.dependents).toEqual([]);
  });

  it("throws ReconcileValidationError on malformed YAML", async () => {
    const path = resolve(ctx.openDir, "DX-4.yml");
    writeFileSync(path, "id: DX-4\n  not: { valid yaml :::");

    await expect(
      reconcileIssue(ctx.repo, "DX-4", "watcher"),
    ).rejects.toBeInstanceOf(ReconcileValidationError);
  });

  it("throws ReconcileValidationError on shape violation (missing required fields)", async () => {
    const path = resolve(ctx.openDir, "DX-5.yml");
    // Parses as YAML, but lacks the required fields the strict
    // `parseIssue` validator demands.
    writeFileSync(path, "id: DX-5\nstatus: ToDo\n");

    await expect(
      reconcileIssue(ctx.repo, "DX-5", "watcher"),
    ).rejects.toBeInstanceOf(ReconcileValidationError);
  });

  it("throws ReconcileValidationError on prefix mismatch (wrong PREFIX-N)", async () => {
    const issue = makeIssue("DX-6");
    // Stamp the wrong prefix into the YAML — validator should reject.
    const text = serializeIssue(issue).replace(/^id: DX-6$/m, "id: WRONG-1");
    writeFileSync(resolve(ctx.openDir, "DX-6.yml"), text);

    await expect(
      reconcileIssue(ctx.repo, "DX-6", "watcher"),
    ).rejects.toBeInstanceOf(ReconcileValidationError);
  });

  it("ReconcileValidationError carries the id + path of the offending file", async () => {
    const path = resolve(ctx.openDir, "DX-7.yml");
    writeFileSync(path, "{not valid: yaml at all\n  bare colon: :");

    try {
      await reconcileIssue(ctx.repo, "DX-7", "watcher");
      throw new Error("expected ReconcileValidationError to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ReconcileValidationError);
      const verr = err as ReconcileValidationError;
      expect(verr.id).toBe("DX-7");
      expect(verr.path).toBe(path);
    }
  });
});

describe("reconcileIssue — behaviour parity (no-op chokepoint)", () => {
  let ctx: ReturnType<typeof makeRepoCtx>;

  beforeEach(() => {
    ctx = makeRepoCtx();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // Phase 1 parity claim: for every fixture the existing poller helpers
  // operate on, reconcile produces an IDENTICAL canonical YAML on disk
  // (because Phase 1 body is a no-op chokepoint). Phase 2 absorbs the
  // helpers and converts these table entries into "reconcile produces
  // what runSync did" assertions.
  const fixtures: Array<{ name: string; status: IssueStatus; dir: "open" | "closed" }> = [
    { name: "ToDo card", status: "ToDo", dir: "open" },
    { name: "In Progress card", status: "In Progress", dir: "open" },
    { name: "Done in closed/", status: "Done", dir: "closed" },
    { name: "Cancelled in closed/", status: "Cancelled", dir: "closed" },
  ];

  for (const f of fixtures) {
    it(`${f.name} round-trips through reconcile unchanged`, async () => {
      const issue = makeIssue("DX-100", f.status);
      const targetDir = f.dir === "open" ? ctx.openDir : ctx.closedDir;
      const path = writeYaml(targetDir, "DX-100", issue);
      const before = readFileSync(path, "utf-8");
      const { parse: parseYamlText } = await import("yaml");
      const expectedHash = sha256(
        canonicalize(parseYamlText(before) as Record<string, unknown>),
      );

      const result = await reconcileIssue(ctx.repo, "DX-100", "watcher");

      expect(result.changed).toBe(false);
      expect(result.prevHash).toBe(expectedHash);
      expect(readFileSync(path, "utf-8")).toBe(before);
    });
  }
});

describe("reconcileIssue — per-card mutex", () => {
  let ctx: ReturnType<typeof makeRepoCtx>;

  beforeEach(() => {
    ctx = makeRepoCtx();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("concurrent calls for the same id queue (serialized)", async () => {
    const issue = makeIssue("DX-200");
    writeYaml(ctx.openDir, "DX-200", issue);

    // Track concurrency: increment on entry, decrement on exit; a custom
    // tracker is necessary because reconcile's body is fast — we can't
    // observe interleaving without instrumentation. Wrap the file system
    // so we can inject a delay and detect overlap.
    const order: string[] = [];

    // Issue three concurrent calls. With a per-id mutex they should
    // resolve in submission order; without, they could resolve in any
    // order.
    const p1 = reconcileIssue(ctx.repo, "DX-200", "watcher").then(() =>
      order.push("a"),
    );
    const p2 = reconcileIssue(ctx.repo, "DX-200", "watcher").then(() =>
      order.push("b"),
    );
    const p3 = reconcileIssue(ctx.repo, "DX-200", "watcher").then(() =>
      order.push("c"),
    );

    await Promise.all([p1, p2, p3]);

    // The mutex chains promises; serial chain → submission order
    // preserved. Independent of speed because each `then` runs on its
    // predecessor.
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("different ids run in parallel (no cross-id serialization)", async () => {
    const a = makeIssue("DX-201");
    const b = makeIssue("DX-202");
    writeYaml(ctx.openDir, "DX-201", a);
    writeYaml(ctx.openDir, "DX-202", b);

    // Issue both concurrently. Both should resolve without either
    // blocking on the other's mutex slot.
    const [ra, rb] = await Promise.all([
      reconcileIssue(ctx.repo, "DX-201", "watcher"),
      reconcileIssue(ctx.repo, "DX-202", "watcher"),
    ]);

    expect(ra.changed).toBe(false);
    expect(rb.changed).toBe(false);
  });

  it("a rejected reconcile does NOT block subsequent calls for the same id", async () => {
    // Round 1: malformed YAML → throws. Round 2: replace with valid YAML
    // and confirm reconcile runs cleanly (the mutex chain tolerated the
    // prior rejection).
    const path = resolve(ctx.openDir, "DX-203.yml");
    writeFileSync(path, "{not valid: at all");

    await expect(
      reconcileIssue(ctx.repo, "DX-203", "watcher"),
    ).rejects.toBeInstanceOf(ReconcileValidationError);

    unlinkSync(path);
    writeYaml(ctx.openDir, "DX-203", makeIssue("DX-203"));

    const result = await reconcileIssue(ctx.repo, "DX-203", "watcher");
    expect(result.changed).toBe(false);
  });

  it("releases the mutex slot after the body completes", async () => {
    const issue = makeIssue("DX-204");
    writeYaml(ctx.openDir, "DX-204", issue);

    expect(_hasReconcileMutex(ctx.repo.name, "DX-204")).toBe(false);

    await reconcileIssue(ctx.repo, "DX-204", "watcher");

    // Allow the cleanup microtask to run.
    await new Promise<void>((res) => setImmediate(res));
    expect(_hasReconcileMutex(ctx.repo.name, "DX-204")).toBe(false);
  });
});

describe("reconcileIssue — trigger tagging", () => {
  let ctx: ReturnType<typeof makeRepoCtx>;

  beforeEach(() => {
    ctx = makeRepoCtx();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  // Phase 1 body is identical regardless of trigger; trigger drives log
  // prefix + future metric tagging only. One spot-check that every
  // variant accepts is enough — the rest is type-level.
  it("accepts every ReconcileTrigger variant without throwing", async () => {
    const issue = makeIssue("DX-300");
    writeYaml(ctx.openDir, "DX-300", issue);
    const triggers = [
      "watcher",
      "lifecycle",
      "scheduler",
      "audit",
      "hydrate",
    ] as const;

    for (const trigger of triggers) {
      const result = await reconcileIssue(ctx.repo, "DX-300", trigger);
      expect(result.changed).toBe(false);
    }
  });
});

describe("reconcileIssue — Phase 2 healer (open ↔ closed file move)", () => {
  let ctx: ReturnType<typeof makeRepoCtx>;

  beforeEach(() => {
    ctx = makeRepoCtx();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("moves a Done YAML from open/ → closed/ on reconcile (no history entry)", async () => {
    const issue = makeIssue("DX-400", "Done");
    const openPath = writeYaml(ctx.openDir, "DX-400", issue);

    const result = await reconcileIssue(ctx.repo, "DX-400", "watcher");

    expect(result.changed).toBe(true);
    expect(existsSync(openPath)).toBe(false);
    const closedPath = resolve(ctx.closedDir, "DX-400.yml");
    expect(existsSync(closedPath)).toBe(true);
    // No `worker:heal` history entry on the open→closed direction
    // (DX-147 AC #3: filesystem-noise fix is not a state change).
    const reread = parseIssue(readFileSync(closedPath, "utf-8"), {
      expectedPrefix: "DX",
    });
    expect(
      reread.history.some(
        (h) => h.actor === "worker:heal" && h.event === "status_change",
      ),
    ).toBe(false);
  });

  it("moves a Cancelled YAML from open/ → closed/ on reconcile", async () => {
    const issue = makeIssue("DX-401", "Cancelled");
    writeYaml(ctx.openDir, "DX-401", issue);

    await reconcileIssue(ctx.repo, "DX-401", "watcher");

    expect(existsSync(resolve(ctx.openDir, "DX-401.yml"))).toBe(false);
    expect(existsSync(resolve(ctx.closedDir, "DX-401.yml"))).toBe(true);
  });

  it("moves a non-terminal YAML from closed/ → open/ AND stamps a worker:heal entry", async () => {
    const issue = makeIssue("DX-402", "ToDo");
    const closedPath = writeYaml(ctx.closedDir, "DX-402", issue);

    const result = await reconcileIssue(ctx.repo, "DX-402", "watcher");

    expect(result.changed).toBe(true);
    expect(existsSync(closedPath)).toBe(false);
    const openPath = resolve(ctx.openDir, "DX-402.yml");
    expect(existsSync(openPath)).toBe(true);
    const reread = parseIssue(readFileSync(openPath, "utf-8"), {
      expectedPrefix: "DX",
    });
    const healEntry = reread.history.find((h) => h.actor === "worker:heal");
    expect(healEntry).toBeDefined();
    expect(healEntry!.event).toBe("status_change");
    // Default `from` for an empty-history fixture is `Done` per the
    // pure helper's contract.
    expect(healEntry!.from).toBe("Done");
    expect(healEntry!.to).toBe("ToDo");
    expect(healEntry!.timestamp).not.toBe("");
  });

  it("leaves a Done YAML in closed/ untouched (idempotency)", async () => {
    const issue = makeIssue("DX-403", "Done");
    const closedPath = writeYaml(ctx.closedDir, "DX-403", issue);
    const before = readFileSync(closedPath, "utf-8");

    const result = await reconcileIssue(ctx.repo, "DX-403", "watcher");

    expect(result.changed).toBe(false);
    expect(readFileSync(closedPath, "utf-8")).toBe(before);
    expect(existsSync(resolve(ctx.openDir, "DX-403.yml"))).toBe(false);
  });

  it("leaves a ToDo YAML in open/ untouched (idempotency)", async () => {
    const issue = makeIssue("DX-404", "ToDo");
    const openPath = writeYaml(ctx.openDir, "DX-404", issue);
    const before = readFileSync(openPath, "utf-8");

    const result = await reconcileIssue(ctx.repo, "DX-404", "watcher");

    expect(result.changed).toBe(false);
    expect(readFileSync(openPath, "utf-8")).toBe(before);
  });
});

// ---- Integration tests (DB-backed) ---------------------------------
// Phase 2 reconcile bodies for parent-derive, waiting_on durability,
// and recursion all hit `src/poller/issues-db.ts` SQL helpers. These
// suites use a real Postgres test DB; they're skipped when local PG is
// unreachable (matches `epic-status.test.ts` pattern).

const dbHandle: TestDbHandle | null = await createTestDb();

if (!dbHandle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[reconcile] skipping integration suite — local Postgres not reachable",
  );
} else {
  const client = await dbHandle.pool.connect();
  try {
    await client.query("BEGIN");
    await upIssuesMirror(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

if (dbHandle) {
  beforeAll(() => {
    setIssueDbQueryFn(async (sql, params) => {
      const result = await dbHandle.pool.query(sql, params ?? []);
      return result.rows as never;
    });
  });
}

afterAll(async () => {
  resetIssueDbQueryFn();
  clearAllRepoNames();
  if (dbHandle) await dbHandle.close();
});

interface DbCtx {
  cleanup: () => void;
  repo: ReconcileRepoContext;
  openDir: string;
  closedDir: string;
}

function makeDbCtx(repoName: string): DbCtx {
  const root = mkdtempSync(resolve(tmpdir(), "danxbot-reconcile-db-"));
  const openDir = resolve(root, ".danxbot", "issues", "open");
  const closedDir = resolve(root, ".danxbot", "issues", "closed");
  mkdirSync(openDir, { recursive: true });
  mkdirSync(closedDir, { recursive: true });
  setRepoName(root, repoName);
  return {
    repo: { name: repoName, localPath: root, issuePrefix: "DX" },
    openDir,
    closedDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function seedDb(repoName: string, issue: Issue): Promise<void> {
  if (!dbHandle) return;
  const data = issue as unknown as Record<string, unknown>;
  const contentHash = sha256(canonicalize(data));
  await dbHandle.pool.query(
    `INSERT INTO issues
       (repo_name, data, content_hash, mirror_updated_at)
     VALUES ($1, $2::jsonb, $3, now())`,
    [repoName, JSON.stringify(data), contentHash],
  );
}

describe("reconcileIssue — Phase 2 parent-derive (DX-217)", () => {
  let dbCtx: DbCtx;
  const REPO = "reconcile-parent-test";

  beforeEach(async () => {
    if (dbHandle) await dbHandle.pool.query("DELETE FROM issues");
    dbCtx = makeDbCtx(REPO);
  });

  afterEach(() => {
    dbCtx.cleanup();
  });

  it.skipIf(!dbHandle)(
    "flips parent's status when union-of-children rule fires",
    async () => {
      const parent: Issue = {
        ...makeIssue("DX-500", "ToDo"),
        type: "Epic",
        children: ["DX-501", "DX-502"],
      };
      writeYaml(dbCtx.openDir, "DX-500", parent);
      await seedDb(REPO, parent);
      await seedDb(REPO, {
        ...makeIssue("DX-501", "In Progress"),
        parent_id: "DX-500",
      });
      await seedDb(REPO, {
        ...makeIssue("DX-502", "ToDo"),
        parent_id: "DX-500",
      });

      const result = await reconcileIssue(dbCtx.repo, "DX-500", "audit");

      expect(result.changed).toBe(true);
      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-500.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.status).toBe("In Progress");
      const deriveEntry = updated.history.find(
        (h) => h.actor === "worker:auto-derive" && h.event === "status_change",
      );
      expect(deriveEntry).toBeDefined();
      expect(deriveEntry!.from).toBe("ToDo");
      expect(deriveEntry!.to).toBe("In Progress");
      expect(deriveEntry!.note).toContain("In Progress");
    },
  );

  it.skipIf(!dbHandle)(
    "flips parent to Done AND moves to closed/ when all children Done",
    async () => {
      const parent: Issue = {
        ...makeIssue("DX-510", "In Progress"),
        type: "Epic",
        children: ["DX-511"],
      };
      writeYaml(dbCtx.openDir, "DX-510", parent);
      await seedDb(REPO, parent);
      await seedDb(REPO, {
        ...makeIssue("DX-511", "Done"),
        parent_id: "DX-510",
      });

      const result = await reconcileIssue(dbCtx.repo, "DX-510", "audit");

      expect(result.changed).toBe(true);
      // Parent flipped to Done AND the file moved to closed/ (heal step
      // 3c runs after parent-derive on the same body).
      expect(existsSync(resolve(dbCtx.openDir, "DX-510.yml"))).toBe(false);
      const closed = parseIssue(
        readFileSync(resolve(dbCtx.closedDir, "DX-510.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(closed.status).toBe("Done");
    },
  );

  it.skipIf(!dbHandle)(
    "no-ops when derived status equals current",
    async () => {
      const parent: Issue = {
        ...makeIssue("DX-520", "In Progress"),
        type: "Epic",
        children: ["DX-521"],
      };
      writeYaml(dbCtx.openDir, "DX-520", parent);
      await seedDb(REPO, parent);
      await seedDb(REPO, {
        ...makeIssue("DX-521", "In Progress"),
        parent_id: "DX-520",
      });

      const result = await reconcileIssue(dbCtx.repo, "DX-520", "audit");

      expect(result.changed).toBe(false);
    },
  );

  it.skipIf(!dbHandle)(
    "skips parent-status derivation when parent has waiting_on != null",
    async () => {
      const parent: Issue = {
        ...makeIssue("DX-530", "ToDo"),
        type: "Epic",
        children: ["DX-531"],
        waiting_on: {
          reason: "waits on DX-9999",
          timestamp: "2026-01-01T00:00:00.000Z",
          by: ["DX-9999"],
        },
      };
      writeYaml(dbCtx.openDir, "DX-530", parent);
      await seedDb(REPO, parent);
      await seedDb(REPO, {
        ...makeIssue("DX-531", "In Progress"),
        parent_id: "DX-530",
      });
      // DX-9999 missing from DB → waiting_on cannot clear, so the
      // skip-parent-derive guard remains in effect.

      const result = await reconcileIssue(dbCtx.repo, "DX-530", "audit");

      // Parent-derive skipped (would have flipped to In Progress); no
      // mutation, no write.
      expect(result.changed).toBe(false);
    },
  );

  it.skipIf(!dbHandle)(
    "stamps blocked record when derived status is Blocked",
    async () => {
      const parent: Issue = {
        ...makeIssue("DX-540", "In Progress"),
        type: "Epic",
        children: ["DX-541"],
      };
      writeYaml(dbCtx.openDir, "DX-540", parent);
      await seedDb(REPO, parent);
      await seedDb(REPO, {
        ...makeIssue("DX-541", "Blocked"),
        parent_id: "DX-540",
      });

      const result = await reconcileIssue(dbCtx.repo, "DX-540", "audit");

      expect(result.changed).toBe(true);
      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-540.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.status).toBe("Blocked");
      expect(updated.blocked).not.toBeNull();
      expect(updated.blocked!.reason).toContain("Auto-derived");
    },
  );

  it.skipIf(!dbHandle)(
    "clears blocked record when derived flips Blocked → non-Blocked (invariant)",
    async () => {
      // Parent currently Blocked with auto-derived self-block; child
      // resolves out of Blocked so derive should flip parent to
      // In Progress AND clear `blocked` to maintain
      // status === Blocked ⟺ blocked !== null.
      const parent: Issue = {
        ...makeIssue("DX-550", "Blocked"),
        type: "Epic",
        children: ["DX-551"],
        blocked: {
          reason:
            "Auto-derived from children: Any child Blocked — parent Blocked",
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      };
      writeYaml(dbCtx.openDir, "DX-550", parent);
      await seedDb(REPO, parent);
      await seedDb(REPO, {
        ...makeIssue("DX-551", "In Progress"),
        parent_id: "DX-550",
      });

      const result = await reconcileIssue(dbCtx.repo, "DX-550", "audit");

      expect(result.changed).toBe(true);
      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-550.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.status).toBe("In Progress");
      expect(updated.blocked).toBeNull();
    },
  );
});

describe("reconcileIssue — waiting_on is durable (DX-219 follow-up)", () => {
  let dbCtx: DbCtx;
  const REPO = "reconcile-waiting-test";

  beforeEach(async () => {
    if (dbHandle) await dbHandle.pool.query("DELETE FROM issues");
    dbCtx = makeDbCtx(REPO);
  });

  afterEach(() => {
    dbCtx.cleanup();
  });

  it.skipIf(!dbHandle)(
    "does NOT clear waiting_on when every dep is terminal — the link is a durable record",
    async () => {
      const waiterWaitingOn = {
        reason: "waits on DX-601",
        timestamp: "2026-01-01T00:00:00.000Z",
        by: ["DX-601"],
      };
      const waiter: Issue = {
        ...makeIssue("DX-600", "ToDo"),
        waiting_on: waiterWaitingOn,
      };
      writeYaml(dbCtx.openDir, "DX-600", waiter);
      await seedDb(REPO, waiter);
      await seedDb(REPO, makeIssue("DX-601", "Done"));

      await reconcileIssue(dbCtx.repo, "DX-600", "watcher");

      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-600.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.waiting_on).toEqual(waiterWaitingOn);
      const unblock = updated.history.find(
        (h) => h.event === "unblocked" && h.actor === "worker:auto-derive",
      );
      expect(unblock).toBeUndefined();
    },
  );

  it.skipIf(!dbHandle)(
    "leaves waiting_on intact when any dep is non-terminal",
    async () => {
      const waiter: Issue = {
        ...makeIssue("DX-610", "ToDo"),
        waiting_on: {
          reason: "waits on DX-611",
          timestamp: "2026-01-01T00:00:00.000Z",
          by: ["DX-611"],
        },
      };
      writeYaml(dbCtx.openDir, "DX-610", waiter);
      await seedDb(REPO, waiter);
      await seedDb(REPO, makeIssue("DX-611", "In Progress"));

      await reconcileIssue(dbCtx.repo, "DX-610", "watcher");

      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-610.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.waiting_on).not.toBeNull();
    },
  );
});

describe("reconcileIssue — Phase 2 step 9 + 10 recursion (DX-217)", () => {
  let dbCtx: DbCtx;
  const REPO = "reconcile-recurse-test";

  beforeEach(async () => {
    if (dbHandle) await dbHandle.pool.query("DELETE FROM issues");
    dbCtx = makeDbCtx(REPO);
  });

  afterEach(() => {
    dbCtx.cleanup();
  });

  it.skipIf(!dbHandle)(
    "step 9: writing a child triggers parent-derive on the parent",
    async () => {
      // Parent at In Progress; sole child at In Progress. We change the
      // child to Done in the seeded YAML AND DB, then reconcile the
      // child. Step 9 should recurse on the parent which then sees
      // all-Done children and flips itself to Done.
      const parent: Issue = {
        ...makeIssue("DX-700", "In Progress"),
        type: "Epic",
        children: ["DX-701"],
      };
      const child: Issue = {
        ...makeIssue("DX-701", "Done"),
        parent_id: "DX-700",
      };
      writeYaml(dbCtx.openDir, "DX-700", parent);
      writeYaml(dbCtx.openDir, "DX-701", child);
      await seedDb(REPO, parent);
      await seedDb(REPO, child);

      const result = await reconcileIssue(dbCtx.repo, "DX-701", "watcher");

      // Child reconcile: heal moves DX-701 to closed/, no parent-derive
      // on self (no children), step 9 fires for DX-700.
      expect(result.fanout.parentId).toBe("DX-700");
      expect(existsSync(resolve(dbCtx.closedDir, "DX-701.yml"))).toBe(true);

      // Parent recursion: DX-700 reconciled, derived status = Done,
      // moved to closed/.
      expect(existsSync(resolve(dbCtx.closedDir, "DX-700.yml"))).toBe(true);
      const reread = parseIssue(
        readFileSync(resolve(dbCtx.closedDir, "DX-700.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(reread.status).toBe("Done");
    },
  );

  it.skipIf(!dbHandle)(
    "step 10: writing a card surfaces dependents in fanout (waiting_on link preserved)",
    async () => {
      // DX-801 waits on DX-800. We seed DX-800 as Done both in YAML and
      // DB, and DX-801 as still-waiting. Reconciling DX-800 should
      // surface DX-801 in fanout.dependents (so downstream consumers can
      // re-evaluate effective state) WITHOUT mutating DX-801's durable
      // waiting_on record.
      const blocker: Issue = makeIssue("DX-800", "Done");
      const waiterWaitingOn = {
        reason: "waits on DX-800",
        timestamp: "2026-01-01T00:00:00.000Z",
        by: ["DX-800"],
      };
      const waiter: Issue = {
        ...makeIssue("DX-801", "ToDo"),
        waiting_on: waiterWaitingOn,
      };
      writeYaml(dbCtx.openDir, "DX-800", blocker);
      writeYaml(dbCtx.openDir, "DX-801", waiter);
      await seedDb(REPO, blocker);
      await seedDb(REPO, waiter);

      const result = await reconcileIssue(dbCtx.repo, "DX-800", "watcher");

      expect(result.fanout.dependents).toContain("DX-801");
      expect(existsSync(resolve(dbCtx.closedDir, "DX-800.yml"))).toBe(true);

      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-801.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.waiting_on).toEqual(waiterWaitingOn);
    },
  );

  it.skipIf(!dbHandle)(
    "step 10: multiple dependents all surface in fanout without mutation",
    async () => {
      const blocker: Issue = makeIssue("DX-810", "Done");
      const baseWaitingOn = {
        reason: "waits on DX-810",
        timestamp: "2026-01-01T00:00:00.000Z",
        by: ["DX-810"],
      };
      const waiter = (id: string): Issue => ({
        ...makeIssue(id, "ToDo"),
        waiting_on: baseWaitingOn,
      });
      writeYaml(dbCtx.openDir, "DX-810", blocker);
      writeYaml(dbCtx.openDir, "DX-811", waiter("DX-811"));
      writeYaml(dbCtx.openDir, "DX-812", waiter("DX-812"));
      writeYaml(dbCtx.openDir, "DX-813", waiter("DX-813"));
      await seedDb(REPO, blocker);
      await seedDb(REPO, waiter("DX-811"));
      await seedDb(REPO, waiter("DX-812"));
      await seedDb(REPO, waiter("DX-813"));

      const result = await reconcileIssue(dbCtx.repo, "DX-810", "watcher");

      expect(result.fanout.dependents.sort()).toEqual([
        "DX-811",
        "DX-812",
        "DX-813",
      ]);
      for (const id of ["DX-811", "DX-812", "DX-813"]) {
        const updated = parseIssue(
          readFileSync(resolve(dbCtx.openDir, `${id}.yml`), "utf-8"),
          { expectedPrefix: "DX" },
        );
        expect(updated.waiting_on).toEqual(baseWaitingOn);
      }
    },
  );

  it.skipIf(!dbHandle)(
    "recursion is bounded by MAX_RECURSION_DEPTH (deep parent chain stops at 5)",
    async () => {
      // Set up a 7-deep parent chain where every card flips on reconcile:
      //   DX-1000 (Done) → DX-1 (its parent, In Progress)
      //              → DX-2 (parent of DX-1)
      //              → ... → DX-7 (top, no parent)
      // Reconciling DX-1 (after seeding DX-1000 as Done) fires step 3a:
      // DX-1's children = [DX-1000, all Done] → derived = Done → DX-1
      // flips. Step 9 recurses on DX-2; DX-2's children = [DX-1, now
      // Done] → flips. Cascade continues. With depth cap = 5, the
      // chain stops at DX-6 (depth 5 — depth at DX-7 would be 6,
      // exceeds cap). DX-7 stays In Progress.
      const z = { ...makeIssue("DX-1000", "Done") };
      writeYaml(dbCtx.closedDir, "DX-1000", z);
      await seedDb(REPO, z);

      const ids = [
        "DX-1001",
        "DX-1002",
        "DX-1003",
        "DX-1004",
        "DX-1005",
        "DX-1006",
        "DX-1007",
      ];
      for (let i = 0; i < ids.length; i++) {
        const issue: Issue = {
          ...makeIssue(ids[i], "In Progress"),
          type: "Epic",
          parent_id: i + 1 < ids.length ? ids[i + 1] : null,
          children: i === 0 ? ["DX-1000"] : [ids[i - 1]],
        };
        writeYaml(dbCtx.openDir, ids[i], issue);
        await seedDb(REPO, issue);
        // Mirror the parent_id linkage in the DB so
        // dbListChildrenByParent finds children of each ids[i].
      }
      // Stamp DX-1000's parent_id so dbListChildrenByParent("DX-1001")
      // returns DX-1000.
      await dbHandle!.pool.query(
        `UPDATE issues SET data = jsonb_set(data, '{parent_id}', '"DX-1001"') WHERE repo_name = $1 AND id = $2`,
        [REPO, "DX-1000"],
      );

      const result = await reconcileIssue(dbCtx.repo, "DX-1001", "watcher");

      // DX-1001 flipped (children all Done → Done) and step 9 fanned
      // out up the chain. The mere fact this resolves without a
      // timeout / stack overflow is the load-bearing assertion: an
      // unbounded recursion (no depth cap) would loop forever as each
      // ancestor's parent recursion fans back into its children's
      // reconciles.
      expect(result.changed).toBe(true);
      expect(result.fanout.parentId).toBe("DX-1002");

      // Verify the cap engaged: walking up the chain, cards at depth
      // ≤ 5 (DX-1001 through DX-1006) reconciled. DX-1007 (would be
      // depth 6) NEVER ran, so it remains In Progress on disk.
      // Concrete proof of the cap: depth 5 reconcile was DX-1006; it
      // tried to recurse on DX-1007 but the depth check at
      // `rec.depth < MAX_RECURSION_DEPTH` (5 < 5 is false) prevented
      // the recursive call.
      const top = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-1007.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(top.status).toBe("In Progress"); // Cap stopped propagation here.
    },
  );

  it.skipIf(!dbHandle)(
    "step 10 error branch — failed dep reconcile is captured non-fatally",
    async () => {
      // Plant a malformed YAML for DX-941, the dependent. DX-940 (the
      // primary reconcile target) is well-formed and reaches step 10,
      // which tries to reconcile DX-941 → throws ReconcileValidationError.
      // The error must surface in `result.errors` with step
      // `recurse-dependents` AND fatal: false; the primary reconcile
      // still returns successfully.
      const blocker: Issue = makeIssue("DX-940", "Done");
      writeYaml(dbCtx.openDir, "DX-940", blocker);
      await seedDb(REPO, blocker);
      // Malformed YAML for DX-941 (parses as YAML but fails parseIssue
      // shape check).
      writeFileSync(
        resolve(dbCtx.openDir, "DX-941.yml"),
        "id: DX-941\nstatus: ToDo\n",
      );
      // Seed DB row pointing at DX-940 so step 10 finds it.
      await seedDb(REPO, {
        ...makeIssue("DX-941", "ToDo"),
        waiting_on: {
          reason: "waits on DX-940",
          timestamp: "2026-01-01T00:00:00.000Z",
          by: ["DX-940"],
        },
      });

      const result = await reconcileIssue(dbCtx.repo, "DX-940", "watcher");

      // Primary still succeeded (heal moved DX-940 to closed/).
      expect(existsSync(resolve(dbCtx.closedDir, "DX-940.yml"))).toBe(true);
      // Error captured non-fatally.
      const depErrors = result.errors.filter(
        (e) => e.step === "recurse-dependents",
      );
      expect(depErrors).toHaveLength(1);
      expect(depErrors[0].fatal).toBe(false);
      expect(depErrors[0].message).toContain("DX-941");
    },
  );

  it.skipIf(!dbHandle)(
    "recursion respects the visited set (no infinite loop on parent ↔ child cycle)",
    async () => {
      // Pathological seed: DX-900 lists DX-901 as a child but DX-901's
      // parent_id ALSO points at DX-900 — normal. The cycle hazard
      // arises when DX-900's reconcile fires step 9 for DX-901 (no
      // parent_id is set on DX-900 itself), which fires step 9 for
      // DX-900 again. The visited set prevents the second hop.
      const a: Issue = {
        ...makeIssue("DX-900", "In Progress"),
        type: "Epic",
        children: ["DX-901"],
      };
      const b: Issue = {
        ...makeIssue("DX-901", "Done"),
        parent_id: "DX-900",
      };
      writeYaml(dbCtx.openDir, "DX-900", a);
      writeYaml(dbCtx.openDir, "DX-901", b);
      await seedDb(REPO, a);
      await seedDb(REPO, b);

      // Reconcile completes without timeout / stack overflow — the
      // mere fact this test resolves proves the cycle guard.
      const result = await reconcileIssue(dbCtx.repo, "DX-901", "watcher");
      expect(result).toBeDefined();
      expect(result.fanout.parentId).toBe("DX-900");
    },
  );
});

describe("reconcileIssue — fanout.dispatchableChanged (Phase 4b.1 / DX-288)", () => {
  let ctx: ReturnType<typeof makeRepoCtx>;

  beforeEach(() => {
    ctx = makeRepoCtx();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("first observation of a dispatchable card → dispatchableChanged === true", async () => {
    const issue = makeIssue("DX-1001", "ToDo");
    writeYaml(ctx.openDir, "DX-1001", issue);

    const result = await reconcileIssue(ctx.repo, "DX-1001", "watcher");

    expect(result.fanout.dispatchableChanged).toBe(true);
  });

  it("first observation of a non-dispatchable card (In Progress) → dispatchableChanged === false", async () => {
    const issue = makeIssue("DX-1002", "In Progress");
    writeYaml(ctx.openDir, "DX-1002", issue);

    const result = await reconcileIssue(ctx.repo, "DX-1002", "watcher");

    expect(result.fanout.dispatchableChanged).toBe(false);
  });

  it("first observation of a card with blocked != null → dispatchableChanged === false", async () => {
    const issue: Issue = {
      ...makeIssue("DX-1003", "Blocked"),
      blocked: {
        reason: "Awaiting design decision",
        timestamp: "2026-05-11T10:00:00Z",
      },
    };
    writeYaml(ctx.openDir, "DX-1003", issue);

    const result = await reconcileIssue(ctx.repo, "DX-1003", "watcher");

    expect(result.fanout.dispatchableChanged).toBe(false);
  });

  it("first observation of a card with waiting_on != null → dispatchableChanged === false", async () => {
    const issue: Issue = {
      ...makeIssue("DX-1004", "ToDo"),
      waiting_on: {
        reason: "Waiting on DX-D3",
        timestamp: "2026-05-11T10:00:00Z",
        by: ["DX-1003"],
      },
    };
    writeYaml(ctx.openDir, "DX-1004", issue);

    const result = await reconcileIssue(ctx.repo, "DX-1004", "watcher");

    expect(result.fanout.dispatchableChanged).toBe(false);
  });

  it("first observation of a card with requires_human != null → dispatchableChanged === false", async () => {
    const issue: Issue = {
      ...makeIssue("DX-1005", "ToDo"),
      requires_human: {
        reason: "API key rotation needed",
        steps: ["Rotate the Stripe key"],
        set_by: "agent",
        set_at: "2026-05-11T10:00:00Z",
      },
    };
    writeYaml(ctx.openDir, "DX-1005", issue);

    const result = await reconcileIssue(ctx.repo, "DX-1005", "watcher");

    expect(result.fanout.dispatchableChanged).toBe(false);
  });

  it("first observation of a card with dispatch != null → dispatchableChanged === false", async () => {
    const issue: Issue = {
      ...makeIssue("DX-1006", "ToDo"),
      dispatch: {
        id: "dispatch-abc",
        pid: 1234,
        host: "test-host",
        kind: "work",
        started_at: "2026-05-11T10:00:00Z",
        ttl_seconds: 7200,
      },
    };
    writeYaml(ctx.openDir, "DX-1006", issue);

    const result = await reconcileIssue(ctx.repo, "DX-1006", "watcher");

    expect(result.fanout.dispatchableChanged).toBe(false);
  });

  it("no-op reconcile (same state, second call) → dispatchableChanged === false", async () => {
    const issue = makeIssue("DX-1007", "ToDo");
    writeYaml(ctx.openDir, "DX-1007", issue);

    const first = await reconcileIssue(ctx.repo, "DX-1007", "watcher");
    expect(first.fanout.dispatchableChanged).toBe(true); // first observation

    const second = await reconcileIssue(ctx.repo, "DX-1007", "watcher");
    expect(second.fanout.dispatchableChanged).toBe(false); // no change
  });

  it("flips true when dispatch field is stamped (ToDo → ToDo+dispatch)", async () => {
    const issue = makeIssue("DX-1008", "ToDo");
    writeYaml(ctx.openDir, "DX-1008", issue);
    await reconcileIssue(ctx.repo, "DX-1008", "watcher"); // first observation primes cache (dispatchable)

    // Stamp dispatch — card is no longer dispatchable.
    const stamped: Issue = {
      ...issue,
      dispatch: {
        id: "d-1",
        pid: 9999,
        host: "test",
        kind: "work",
        started_at: "2026-05-11T10:00:00Z",
        ttl_seconds: 7200,
      },
    };
    writeYaml(ctx.openDir, "DX-1008", stamped);

    const result = await reconcileIssue(ctx.repo, "DX-1008", "watcher");
    expect(result.fanout.dispatchableChanged).toBe(true); // flipped true→false
  });

  it("flips true when blocked clears (Blocked → ToDo)", async () => {
    const blockedIssue: Issue = {
      ...makeIssue("DX-1009", "Blocked"),
      blocked: { reason: "Initial block", timestamp: "2026-05-11T10:00:00Z" },
    };
    writeYaml(ctx.openDir, "DX-1009", blockedIssue);
    await reconcileIssue(ctx.repo, "DX-1009", "watcher"); // prime: non-dispatchable

    const cleared: Issue = {
      ...blockedIssue,
      status: "ToDo",
      blocked: null,
    };
    writeYaml(ctx.openDir, "DX-1009", cleared);

    const result = await reconcileIssue(ctx.repo, "DX-1009", "watcher");
    expect(result.fanout.dispatchableChanged).toBe(true); // flipped false→true
  });

  it("stays false when an unrelated field changes but dispatchability is unchanged (title only)", async () => {
    const issue = makeIssue("DX-1010", "ToDo");
    writeYaml(ctx.openDir, "DX-1010", issue);
    await reconcileIssue(ctx.repo, "DX-1010", "watcher"); // prime

    const renamed: Issue = { ...issue, title: "New title" };
    writeYaml(ctx.openDir, "DX-1010", renamed);

    const result = await reconcileIssue(ctx.repo, "DX-1010", "watcher");
    expect(result.fanout.dispatchableChanged).toBe(false); // dispatchability unchanged
  });

  it("cache survives a body throw — next reconcile observes the prior cache entry, not a half-written stamp", async () => {
    // Prime the cache by reconciling a valid, dispatchable card.
    const issue = makeIssue("DX-1012", "ToDo");
    const path = writeYaml(ctx.openDir, "DX-1012", issue);
    const primed = await reconcileIssue(ctx.repo, "DX-1012", "watcher");
    expect(primed.fanout.dispatchableChanged).toBe(true); // primes cache to "true"

    // Corrupt the YAML so the next reconcile throws ReconcileValidationError
    // INSIDE the body (post-load, during validate). The cache write at
    // step 8 lives AFTER the throw site; the prior entry must survive
    // intact.
    writeFileSync(path, "id: not-valid-yaml-at-all {{{ broken\n");
    await expect(
      reconcileIssue(ctx.repo, "DX-1012", "watcher"),
    ).rejects.toBeInstanceOf(ReconcileValidationError);

    // Restore valid YAML in the same dispatchable state. If the throw
    // had clobbered the cache, this third reconcile would see
    // `prior === undefined` and report `dispatchableChanged: true`.
    // Surviving cache means `prior === true`, current === true, flip
    // === false.
    writeFileSync(path, serializeIssue(issue));
    const after = await reconcileIssue(ctx.repo, "DX-1012", "watcher");
    expect(after.fanout.dispatchableChanged).toBe(false);
  });

  it("tombstone clears the cache — re-creating the card triggers a fresh first-observation", async () => {
    const issue = makeIssue("DX-1011", "ToDo");
    const path = writeYaml(ctx.openDir, "DX-1011", issue);
    await reconcileIssue(ctx.repo, "DX-1011", "watcher"); // prime cache to "dispatchable"

    // Tombstone: delete the file.
    unlinkSync(path);
    const tombstone = await reconcileIssue(ctx.repo, "DX-1011", "watcher");
    expect(tombstone.fanout.dispatchableChanged).toBe(false); // tombstone result is no-op

    // Re-create the card — should be observed as fresh (true again).
    writeYaml(ctx.openDir, "DX-1011", issue);
    const recreated = await reconcileIssue(ctx.repo, "DX-1011", "watcher");
    expect(recreated.fanout.dispatchableChanged).toBe(true);
  });
});

describe("reconcileIssue — scheduler hook invocation (Phase 4b.1 / DX-288)", () => {
  let ctx: ReturnType<typeof makeRepoCtx>;

  beforeEach(() => {
    ctx = makeRepoCtx();
  });

  afterEach(() => {
    ctx.cleanup();
    clearReconcileSchedulerHookForRepo(ctx.repo.name);
  });

  it("invokes the registered scheduler hook after reconcile resolves (non-lifecycle trigger)", async () => {
    const issue = makeIssue("DX-2001", "ToDo");
    writeYaml(ctx.openDir, "DX-2001", issue);

    const calls: Array<{ repoName: string; dispatchableChanged: boolean }> = [];
    setReconcileSchedulerHookForRepo(ctx.repo.name, ({ repo, result }) => {
      calls.push({
        repoName: repo.name,
        dispatchableChanged: result.fanout.dispatchableChanged,
      });
    });

    await reconcileIssue(ctx.repo, "DX-2001", "watcher");
    // Hook is fire-and-forget on a microtask; wait one microtask cycle.
    await new Promise((r) => setImmediate(r));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.repoName).toBe(ctx.repo.name);
    expect(calls[0]?.dispatchableChanged).toBe(true);
  });

  it("does NOT invoke the scheduler hook for lifecycle triggers (avoid lag re-introduction)", async () => {
    const issue = makeIssue("DX-2002", "ToDo");
    writeYaml(ctx.openDir, "DX-2002", issue);

    const calls: ReconcileResult[] = [];
    setReconcileSchedulerHookForRepo(ctx.repo.name, ({ result }) => {
      calls.push(result);
    });

    await reconcileIssue(ctx.repo, "DX-2002", "lifecycle");
    await new Promise((r) => setImmediate(r));

    expect(calls).toHaveLength(0);
  });

  it("invokes the hook even when dispatchableChanged is false (hook decides what to do with the flag)", async () => {
    const issue = makeIssue("DX-2003", "In Progress");
    writeYaml(ctx.openDir, "DX-2003", issue);

    const calls: ReconcileResult[] = [];
    setReconcileSchedulerHookForRepo(ctx.repo.name, ({ result }) => {
      calls.push(result);
    });

    await reconcileIssue(ctx.repo, "DX-2003", "watcher");
    await new Promise((r) => setImmediate(r));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.fanout.dispatchableChanged).toBe(false);
  });

  it("clearReconcileSchedulerHookForRepo unregisters the hook so subsequent reconciles do not fire it", async () => {
    const issue = makeIssue("DX-2004", "ToDo");
    writeYaml(ctx.openDir, "DX-2004", issue);

    const calls: ReconcileResult[] = [];
    setReconcileSchedulerHookForRepo(ctx.repo.name, ({ result }) => {
      calls.push(result);
    });
    clearReconcileSchedulerHookForRepo(ctx.repo.name);

    await reconcileIssue(ctx.repo, "DX-2004", "watcher");
    await new Promise((r) => setImmediate(r));

    expect(calls).toHaveLength(0);
  });

  it("a throwing scheduler hook does NOT propagate to reconcile's caller", async () => {
    const issue = makeIssue("DX-2005", "ToDo");
    writeYaml(ctx.openDir, "DX-2005", issue);

    setReconcileSchedulerHookForRepo(ctx.repo.name, () => {
      throw new Error("hook explosion");
    });

    // Must not throw — reconcileIssue's promise resolves normally.
    await expect(
      reconcileIssue(ctx.repo, "DX-2005", "watcher"),
    ).resolves.toBeDefined();
    await new Promise((r) => setImmediate(r));
  });
});

describe("reconcileIssue — triage-timer re-arm (Phase 4b.2 / DX-289)", () => {
  let ctx: ReturnType<typeof makeRepoCtx>;

  beforeEach(async () => {
    ctx = makeRepoCtx();
    const triageTimer = await import("../dispatch/triage-timer.js");
    triageTimer._clearAllTriageTimers();
  });

  afterEach(async () => {
    const triageTimer = await import("../dispatch/triage-timer.js");
    triageTimer._clearAllTriageTimers();
    ctx.cleanup();
  });

  function makeIssueWithExpiry(
    id: string,
    status: IssueStatus,
    expiresAt: string,
  ): Issue {
    return {
      ...makeIssue(id, status),
      triage: {
        expires_at: expiresAt,
        reassess_hint: "",
        last_status: "",
        last_explain: "",
        ice: { total: 0, i: 0, c: 0, e: 0 },
        history: [],
      },
    };
  }

  it("arms a triage timer with the new expires_at when reconcile observes a change", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    writeYaml(
      ctx.openDir,
      "DX-3001",
      makeIssueWithExpiry("DX-3001", "Review", future),
    );

    await reconcileIssue(ctx.repo, "DX-3001", "watcher");

    const triageTimer = await import("../dispatch/triage-timer.js");
    expect(triageTimer._isTriageTimerArmed(ctx.repo.name, "DX-3001")).toBe(
      true,
    );
    expect(
      triageTimer._getTriageTimerExpiresAt(ctx.repo.name, "DX-3001"),
    ).toBe(Date.parse(future));
  });

  it("re-arms with the updated expires_at when the YAML's triage.expires_at changes", async () => {
    const initial = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const updated = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    const path = writeYaml(
      ctx.openDir,
      "DX-3002",
      makeIssueWithExpiry("DX-3002", "Review", initial),
    );

    await reconcileIssue(ctx.repo, "DX-3002", "watcher");
    const triageTimer = await import("../dispatch/triage-timer.js");
    expect(
      triageTimer._getTriageTimerExpiresAt(ctx.repo.name, "DX-3002"),
    ).toBe(Date.parse(initial));

    // Triage agent rewrites the YAML with a fresh expires_at — same
    // file path; the next reconcile fires from chokidar.
    writeFileSync(
      path,
      serializeIssue(makeIssueWithExpiry("DX-3002", "Review", updated)),
    );

    await reconcileIssue(ctx.repo, "DX-3002", "watcher");
    expect(
      triageTimer._getTriageTimerExpiresAt(ctx.repo.name, "DX-3002"),
    ).toBe(Date.parse(updated));
  });

  it("clears the triage timer when the card moves to a terminal status", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const path = writeYaml(
      ctx.openDir,
      "DX-3003",
      makeIssueWithExpiry("DX-3003", "Review", future),
    );

    await reconcileIssue(ctx.repo, "DX-3003", "watcher");
    const triageTimer = await import("../dispatch/triage-timer.js");
    expect(triageTimer._isTriageTimerArmed(ctx.repo.name, "DX-3003")).toBe(
      true,
    );

    // Terminal status — agent stamped Done.
    writeFileSync(
      path,
      serializeIssue(makeIssueWithExpiry("DX-3003", "Done", future)),
    );

    await reconcileIssue(ctx.repo, "DX-3003", "watcher");
    expect(triageTimer._isTriageTimerArmed(ctx.repo.name, "DX-3003")).toBe(
      false,
    );
  });

  it("does NOT arm a timer for a ToDo card outside triage scope (prevents immediate-fire infinite loop)", async () => {
    // ToDo + waiting_on=null + status not Review/Blocked = outside the
    // triage agent's scope. If we armed an immediate-fire timer here
    // (empty expires_at → 0ms), the timer would fire, reconcile audit
    // would re-observe the same empty value, and the loop would re-arm
    // forever. Guard exists in step 7b of reconcile.ts.
    writeYaml(
      ctx.openDir,
      "DX-3006",
      makeIssueWithExpiry("DX-3006", "ToDo", ""),
    );

    await reconcileIssue(ctx.repo, "DX-3006", "watcher");

    const triageTimer = await import("../dispatch/triage-timer.js");
    expect(triageTimer._isTriageTimerArmed(ctx.repo.name, "DX-3006")).toBe(
      false,
    );
  });

  it("arms a timer for a ToDo card that has waiting_on != null (in-scope via waiting_on)", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const issue: Issue = {
      ...makeIssueWithExpiry("DX-3007", "ToDo", future),
      waiting_on: {
        reason: "Pending another card",
        timestamp: "2026-05-01T00:00:00Z",
        by: ["DX-1"],
      },
    };
    writeYaml(ctx.openDir, "DX-3007", issue);

    await reconcileIssue(ctx.repo, "DX-3007", "watcher");

    const triageTimer = await import("../dispatch/triage-timer.js");
    expect(triageTimer._isTriageTimerArmed(ctx.repo.name, "DX-3007")).toBe(
      true,
    );
  });

  it("does NOT re-arm when expires_at is unchanged across reconciles (cache hit)", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    writeYaml(
      ctx.openDir,
      "DX-3008",
      makeIssueWithExpiry("DX-3008", "Review", future),
    );

    await reconcileIssue(ctx.repo, "DX-3008", "watcher");
    const triageTimer = await import("../dispatch/triage-timer.js");
    const firstExpiry = triageTimer._getTriageTimerExpiresAt(
      ctx.repo.name,
      "DX-3008",
    );
    expect(firstExpiry).toBe(Date.parse(future));

    // Identical content — chokidar fires a second event but reconcile
    // observes no triage.expires_at change and short-circuits the arm.
    // Same value remains; armed entry unchanged.
    await reconcileIssue(ctx.repo, "DX-3008", "watcher");
    expect(
      triageTimer._getTriageTimerExpiresAt(ctx.repo.name, "DX-3008"),
    ).toBe(firstExpiry);
  });

  it("tombstone reconcile clears the triage timer", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const path = writeYaml(
      ctx.openDir,
      "DX-3004",
      makeIssueWithExpiry("DX-3004", "Review", future),
    );

    await reconcileIssue(ctx.repo, "DX-3004", "watcher");
    const triageTimer = await import("../dispatch/triage-timer.js");
    expect(triageTimer._isTriageTimerArmed(ctx.repo.name, "DX-3004")).toBe(
      true,
    );

    // YAML deleted (operator unlinked) — reconcile sees a tombstone.
    unlinkSync(path);
    await reconcileIssue(ctx.repo, "DX-3004", "watcher");
    expect(triageTimer._isTriageTimerArmed(ctx.repo.name, "DX-3004")).toBe(
      false,
    );
  });
});

// DX-342 — explicit assertion that the full reconcile pipeline runs in
// YAML-only mode (no tracker registered for the repo). Every other test
// in this file relies on the same implicit branch — none of them call
// `setReconcileTrackerForRepo` either — but naming the contract here
// keeps the no-tracker path observable in a single named test and
// guards against a regression that would silently register a default
// tracker at module-init.
describe("reconcileIssue — YAML-only mode (no tracker registered, DX-342)", () => {
  let ctx: ReturnType<typeof makeRepoCtx>;

  beforeEach(() => {
    ctx = makeRepoCtx();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("runs the full reconcile pass on a Done child (derive + file-move heal) with no tracker registered", async () => {
    // Setup: parent + one Done child. Parent in open/ as ToDo, child in
    // open/ as Done — reconcile must heal the file-move (Done →
    // closed/) AND derive the parent's status (one child Done → still
    // ToDo since the other-child-default is ToDo for the parent's own
    // status). The whole pipeline must run despite the absence of any
    // registered tracker for `ctx.repo.name`.
    const parent = makeIssue("DX-4200", "ToDo");
    const child = makeIssue("DX-4201", "Done");
    (child as Issue).parent_id = "DX-4200";
    (parent as Issue).children = ["DX-4201"];

    writeYaml(ctx.openDir, "DX-4200", parent);
    const childOpenPath = writeYaml(ctx.openDir, "DX-4201", child);

    // Run reconcile on the child — expect derive to bubble up to the
    // parent (no throw on missing tracker registry entry) AND the
    // child's file to move open/ → closed/ via the heal step.
    const result = await reconcileIssue(ctx.repo, "DX-4201", "watcher");

    expect(result.errors).toEqual([]);
    // File moved — open/ copy gone, closed/ copy now present.
    expect(existsSync(childOpenPath)).toBe(false);
    expect(existsSync(resolve(ctx.closedDir, "DX-4201.yml"))).toBe(true);
  });

  it("returns a normal result on a fresh ToDo with no tracker registered (step 7 push is a silent no-op)", async () => {
    const issue = makeIssue("DX-4202");
    writeYaml(ctx.openDir, "DX-4202", issue);

    const result = await reconcileIssue(ctx.repo, "DX-4202", "watcher");

    // No throw. No errors recorded. The lack of tracker registry entry
    // makes step 7 a silent no-op via the `trackersByRepo.get` ?? skip
    // path; the rest of the pipeline still produces a normal result.
    expect(result.errors).toEqual([]);
    expect(result.changed).toBe(false);
    expect(result.fanout.parentId).toBeNull();
  });
});
