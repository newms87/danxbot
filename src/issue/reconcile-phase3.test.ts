/**
 * DX-641 — Phase 3 of the Computed Card State epic (DX-638).
 *
 * Tests for the sub-steps reconcile.ts gained in Phase 3:
 *
 *   3g — Epic-lifecycle reset (clears stale Epic completion / cancel
 *        / blocked / dispatch + ready_at when any child is
 *        non-terminal). Covers the DX-576 / DX-580 history-spam class.
 *   3d — Orphan dispatch heal (folded from
 *        `healOrphanInvariantViolations`). `dispatch != null` + dead
 *        PID/TTL → clear `dispatch`; flagged real-delta history.
 *   3e — Invariant heal (folded from the `blocked-with-assignment`
 *        branch). Derived-Blocked + `assigned_agent != null` →
 *        clear `assigned_agent`.
 *   3c — list_name audit (projection re-affirm; ZERO history).
 *   3f — Triage TTL refresh scheduler poke (`fanout.schedulerPokeReason
 *        = "triage-empty"`).
 *
 * Tests use the shared `makeIssue` + `makeDbCtx` test scaffolding mirror
 * to `reconcile.test.ts` so the fixtures are interchangeable.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  _resetReconcileMutexes,
  _resetDispatchableCache,
  _resetTriageExpiresCache,
  _resetSkipCache,
  type ReconcileRepoContext,
} from "./reconcile.js";
import { _resetEnvGen } from "./env-generation.js";

function makeIssue(id: string, status: IssueStatus = "ToDo"): Issue {
  return {
    schema_version: 12,
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
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
  };
}

interface DbCtx {
  cleanup: () => void;
  repo: ReconcileRepoContext;
  openDir: string;
  closedDir: string;
}

function makeDbCtx(repoName: string): DbCtx {
  const root = mkdtempSync(resolve(tmpdir(), "danxbot-recphase3-"));
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

function writeYaml(dir: string, id: string, issue: Issue): string {
  const path = resolve(dir, `${id}.yml`);
  writeFileSync(path, serializeIssue(issue));
  return path;
}

const dbHandle: TestDbHandle | null = await createTestDb();
if (dbHandle) {
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

beforeEach(async () => {
  _resetReconcileMutexes();
  _resetDispatchableCache();
  _resetTriageExpiresCache();
  _resetSkipCache();
  _resetEnvGen();
  if (dbHandle) await dbHandle.pool.query("DELETE FROM issues");
  const triageTimer = await import("../dispatch/triage-timer.js");
  triageTimer._clearAllTriageTimers();
});

describe("reconcileIssue — 3g epic-lifecycle reset (DX-641)", () => {
  const REPO = "phase3-3g-test";
  let dbCtx: DbCtx;

  beforeEach(() => {
    dbCtx = makeDbCtx(REPO);
  });

  it.skipIf(!dbHandle)(
    "DX-576/DX-580 regression — Epic with completed_at + 3 ToDo children clears completed_at on first reconcile (ONE history entry), second reconcile is a SKIP",
    async () => {
      const childIds = ["DX-1001", "DX-1002", "DX-1003"];
      const parent: Issue = {
        ...makeIssue("DX-1000", "Done"),
        type: "Epic",
        children: childIds,
        completed_at: "2026-01-01T00:00:00.000Z",
      };
      writeYaml(dbCtx.openDir, "DX-1000", parent);
      await seedDb(REPO, parent);
      for (const childId of childIds) {
        const child: Issue = {
          ...makeIssue(childId, "ToDo"),
          parent_id: "DX-1000",
        };
        await seedDb(REPO, child);
      }

      const result1 = await reconcileIssue(dbCtx.repo, "DX-1000", "audit");

      // First reconcile: 3g fires. Cleared all triggers, set raw to ToDo.
      // 3a parent-derive sees children's union "ToDo" matching raw "ToDo"
      // → no fire → single history entry from 3g.
      expect(result1.changed).toBe(true);
      const updated1 = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-1000.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated1.completed_at).toBeNull();
      expect(updated1.cancelled_at).toBeNull();
      expect(updated1.blocked).toBeNull();
      expect(updated1.dispatch).toBeNull();
      expect(updated1.ready_at).toBeNull();
      // deriveStatus rule 7 fallthrough → raw status = "ToDo"
      expect(updated1.status).toBe("ToDo");
      // ONE history entry from 3g — no parent-derive double-fire.
      const epicResetEntries = updated1.history.filter(
        (h) =>
          h.actor === "worker:auto-derive" &&
          h.note?.startsWith("Epic-lifecycle reset"),
      );
      expect(epicResetEntries).toHaveLength(1);
      // No oscillation — total history entries from this reconcile is 1.
      // (The fixture started with empty history, so all entries are from
      // this run.)
      expect(updated1.history).toHaveLength(1);

      // Second reconcile on steady state — skip-cache HIT, zero new
      // history entries, no file write. The DX-576 / DX-580 250-entry
      // oscillation cannot recur.
      const result2 = await reconcileIssue(dbCtx.repo, "DX-1000", "audit");
      expect(result2.changed).toBe(false);
      const updated2 = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-1000.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated2.history).toHaveLength(1);
    },
  );

  it.skipIf(!dbHandle)(
    "Epic-conversion regression — type flip clears residual dispatch + ready_at",
    async () => {
      // A Feature mid-life-cycle with dispatch + ready_at populated is
      // flipped to type=Epic via Edit. Next reconcile clears the
      // residual dispatch + ready_at AND emits one history entry. Card
      // returns to ready-ladder position (raw status "ToDo"; parent-
      // derive may overwrite from children's union on the same run).
      const converted: Issue = {
        ...makeIssue("DX-1100", "In Progress"),
        type: "Epic",
        children: ["DX-1101"],
        dispatch: {
          id: "stale-dispatch-uuid",
          pid: 99999,
          host: "old-host",
          kind: "work",
          started_at: "2026-01-01T00:00:00.000Z",
          ttl_seconds: 7200,
        },
        ready_at: "2026-01-01T00:00:00.000Z",
      };
      writeYaml(dbCtx.openDir, "DX-1100", converted);
      await seedDb(REPO, converted);
      await seedDb(REPO, {
        ...makeIssue("DX-1101", "ToDo"),
        parent_id: "DX-1100",
      });

      const result = await reconcileIssue(dbCtx.repo, "DX-1100", "audit");

      expect(result.changed).toBe(true);
      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-1100.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.dispatch).toBeNull();
      expect(updated.ready_at).toBeNull();
      expect(updated.status).toBe("ToDo");
      const epicResetEntries = updated.history.filter(
        (h) =>
          h.actor === "worker:auto-derive" &&
          h.note?.startsWith("Epic-lifecycle reset"),
      );
      expect(epicResetEntries).toHaveLength(1);
    },
  );

  it.skipIf(!dbHandle)(
    "skips when Epic has no residual triggers (idempotent on clean state)",
    async () => {
      const parent: Issue = {
        ...makeIssue("DX-1200", "ToDo"),
        type: "Epic",
        children: ["DX-1201"],
      };
      writeYaml(dbCtx.openDir, "DX-1200", parent);
      await seedDb(REPO, parent);
      await seedDb(REPO, {
        ...makeIssue("DX-1201", "ToDo"),
        parent_id: "DX-1200",
      });

      const result = await reconcileIssue(dbCtx.repo, "DX-1200", "audit");

      // No triggers populated → 3g skips. 3a sees children matching raw
      // → no fire. result.changed should be false.
      expect(result.changed).toBe(false);
      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-1200.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      const epicResetEntries = updated.history.filter(
        (h) =>
          h.actor === "worker:auto-derive" &&
          h.note?.startsWith("Epic-lifecycle reset"),
      );
      expect(epicResetEntries).toHaveLength(0);
    },
  );

  it.skipIf(!dbHandle)(
    "skips when Epic has residual trigger BUT all children are terminal (steady-state Done epic)",
    async () => {
      // Epic genuinely complete: completed_at stamped + every child is
      // Done. 3g must NOT fire — the residual trigger reflects real
      // completion, not the DX-576 oscillation pattern.
      const childIds = ["DX-1301", "DX-1302"];
      const parent: Issue = {
        ...makeIssue("DX-1300", "Done"),
        type: "Epic",
        children: childIds,
        completed_at: "2026-01-01T00:00:00.000Z",
      };
      writeYaml(dbCtx.closedDir, "DX-1300", parent);
      await seedDb(REPO, parent);
      for (const childId of childIds) {
        await seedDb(REPO, {
          ...makeIssue(childId, "Done"),
          parent_id: "DX-1300",
          completed_at: "2026-01-01T00:00:00.000Z",
        });
      }

      const result = await reconcileIssue(dbCtx.repo, "DX-1300", "audit");

      const updated = parseIssue(
        readFileSync(resolve(dbCtx.closedDir, "DX-1300.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.completed_at).toBe("2026-01-01T00:00:00.000Z");
      const epicResetEntries = updated.history.filter(
        (h) =>
          h.actor === "worker:auto-derive" &&
          h.note?.startsWith("Epic-lifecycle reset"),
      );
      expect(epicResetEntries).toHaveLength(0);
      // result.changed may be false (steady state) — assertion is on
      // the absence of an epic-reset history entry.
      void result;
    },
  );

  it.skipIf(!dbHandle)(
    "Epic + completed_at + mixed-status children — 3g fires + 3a parent-derive overrides raw status (TWO history entries; final derived non-ToDo)",
    async () => {
      // Pre-DX-641 failure pattern: Epic stuck at Done (via completed_at)
      // while a child is still In Progress. Post-fix:
      //   - 3g clears completed_at + sets raw status "ToDo"
      //   - 3a sees children's union "In Progress" → fires → raw "In Progress"
      //   - deriveStatus rule 7 fallthrough → final derived "In Progress"
      // Two history entries: 3g + 3a. The "single history entry" claim
      // applies ONLY when children's union already matches the "ToDo"
      // fallback; mixed-children intentionally produces two entries.
      const childIds = ["DX-1501", "DX-1502", "DX-1503"];
      const parent: Issue = {
        ...makeIssue("DX-1500", "Done"),
        type: "Epic",
        children: childIds,
        completed_at: "2026-01-01T00:00:00.000Z",
      };
      writeYaml(dbCtx.openDir, "DX-1500", parent);
      await seedDb(REPO, parent);
      await seedDb(REPO, {
        ...makeIssue("DX-1501", "Done"),
        parent_id: "DX-1500",
        completed_at: "2026-01-01T00:00:00.000Z",
      });
      await seedDb(REPO, {
        ...makeIssue("DX-1502", "ToDo"),
        parent_id: "DX-1500",
      });
      await seedDb(REPO, {
        ...makeIssue("DX-1503", "In Progress"),
        parent_id: "DX-1500",
      });

      const result = await reconcileIssue(dbCtx.repo, "DX-1500", "audit");

      expect(result.changed).toBe(true);
      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-1500.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.completed_at).toBeNull();
      expect(updated.status).toBe("In Progress");
      const epicResetEntries = updated.history.filter(
        (h) =>
          h.actor === "worker:auto-derive" &&
          h.note?.startsWith("Epic-lifecycle reset"),
      );
      expect(epicResetEntries).toHaveLength(1);
      const parentDeriveEntries = updated.history.filter(
        (h) =>
          h.actor === "worker:auto-derive" &&
          h.note?.startsWith("Any child In Progress"),
      );
      expect(parentDeriveEntries).toHaveLength(1);
      // Total: 1 (3g) + 1 (3a) = 2 history entries.
      expect(updated.history).toHaveLength(2);
    },
  );

  it.skipIf(!dbHandle)(
    "Epic + cancelled_at-only trigger + non-terminal child → 3g fires",
    async () => {
      const parent: Issue = {
        ...makeIssue("DX-1600", "Cancelled"),
        type: "Epic",
        children: ["DX-1601"],
        cancelled_at: "2026-01-01T00:00:00.000Z",
      };
      writeYaml(dbCtx.openDir, "DX-1600", parent);
      await seedDb(REPO, parent);
      await seedDb(REPO, {
        ...makeIssue("DX-1601", "ToDo"),
        parent_id: "DX-1600",
      });

      const result = await reconcileIssue(dbCtx.repo, "DX-1600", "audit");

      expect(result.changed).toBe(true);
      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-1600.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.cancelled_at).toBeNull();
      expect(updated.status).toBe("ToDo");
      const epicResetEntries = updated.history.filter(
        (h) =>
          h.actor === "worker:auto-derive" &&
          h.note?.startsWith("Epic-lifecycle reset"),
      );
      expect(epicResetEntries).toHaveLength(1);
    },
  );

  it.skipIf(!dbHandle)(
    "Epic + blocked-only trigger + non-terminal child → 3g fires and clears blocked",
    async () => {
      const parent: Issue = {
        ...makeIssue("DX-1700", "Blocked"),
        type: "Epic",
        children: ["DX-1701"],
        blocked: {
          at: "2026-01-01T00:00:00.000Z",
          reason: "stale-self-block",
        },
      };
      writeYaml(dbCtx.openDir, "DX-1700", parent);
      await seedDb(REPO, parent);
      await seedDb(REPO, {
        ...makeIssue("DX-1701", "ToDo"),
        parent_id: "DX-1700",
      });

      const result = await reconcileIssue(dbCtx.repo, "DX-1700", "audit");

      expect(result.changed).toBe(true);
      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-1700.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.blocked).toBeNull();
      expect(updated.status).toBe("ToDo");
      const epicResetEntries = updated.history.filter(
        (h) =>
          h.actor === "worker:auto-derive" &&
          h.note?.startsWith("Epic-lifecycle reset"),
      );
      expect(epicResetEntries).toHaveLength(1);
    },
  );

  it.skipIf(!dbHandle)(
    "Epic with empty children[] + residual trigger → 3g does NOT fire (no-children boundary)",
    async () => {
      // An Epic with empty `children: []` cannot have any non-terminal
      // child by definition; `epicChildren.some(...)` returns false on
      // an empty array, so the residual trigger is honored.
      const parent: Issue = {
        ...makeIssue("DX-1800", "Done"),
        type: "Epic",
        children: [],
        completed_at: "2026-01-01T00:00:00.000Z",
      };
      writeYaml(dbCtx.closedDir, "DX-1800", parent);
      await seedDb(REPO, parent);

      await reconcileIssue(dbCtx.repo, "DX-1800", "audit");

      const updated = parseIssue(
        readFileSync(resolve(dbCtx.closedDir, "DX-1800.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.completed_at).toBe("2026-01-01T00:00:00.000Z");
      const epicResetEntries = updated.history.filter(
        (h) =>
          h.actor === "worker:auto-derive" &&
          h.note?.startsWith("Epic-lifecycle reset"),
      );
      expect(epicResetEntries).toHaveLength(0);
    },
  );

  it.skipIf(!dbHandle)(
    "does NOT fire on non-Epic cards (Feature with completed_at + non-terminal child)",
    async () => {
      // Feature cards rely on the standard terminal flow; 3g is Epic-only.
      const parent: Issue = {
        ...makeIssue("DX-1400", "Done"),
        type: "Feature",
        children: ["DX-1401"],
        completed_at: "2026-01-01T00:00:00.000Z",
      };
      writeYaml(dbCtx.closedDir, "DX-1400", parent);
      await seedDb(REPO, parent);
      await seedDb(REPO, {
        ...makeIssue("DX-1401", "ToDo"),
        parent_id: "DX-1400",
      });

      const result = await reconcileIssue(dbCtx.repo, "DX-1400", "audit");

      const updated = parseIssue(
        readFileSync(resolve(dbCtx.closedDir, "DX-1400.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.completed_at).toBe("2026-01-01T00:00:00.000Z");
      const epicResetEntries = updated.history.filter(
        (h) =>
          h.actor === "worker:auto-derive" &&
          h.note?.startsWith("Epic-lifecycle reset"),
      );
      expect(epicResetEntries).toHaveLength(0);
      void result;
    },
  );
});

describe("reconcileIssue — 3d orphan dispatch heal (DX-641)", () => {
  const REPO = "phase3-3d-test";
  let dbCtx: DbCtx;

  beforeEach(() => {
    dbCtx = makeDbCtx(REPO);
  });

  it.skipIf(!dbHandle)(
    "clears orphan dispatch slot when PID is dead AND emits a worker:heal history entry",
    async () => {
      const card: Issue = {
        ...makeIssue("DX-2000", "In Progress"),
        dispatch: {
          id: "orphan-dispatch-uuid",
          pid: 1, // PID 1 always exists; we override via a synthetic case below
          host: "cross-host-different",
          kind: "work",
          started_at: "2020-01-01T00:00:00.000Z",
          ttl_seconds: 60, // expired by now
        },
        ready_at: "2025-01-01T00:00:00.000Z",
      };
      writeYaml(dbCtx.openDir, "DX-2000", card);
      await seedDb(REPO, card);

      const result = await reconcileIssue(dbCtx.repo, "DX-2000", "audit");

      // Either cross-host OR dead-ttl verdict triggers the clear.
      expect(result.changed).toBe(true);
      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-2000.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.dispatch).toBeNull();
      const healEntries = updated.history.filter(
        (h) => h.actor === "worker:heal" && h.note?.startsWith("Cleared orphan dispatch"),
      );
      expect(healEntries).toHaveLength(1);
    },
  );

  it.skipIf(!dbHandle)(
    "clears orphan dispatch via dead-pid verdict (matching host + valid TTL + dead PID)",
    async () => {
      const { hostname } = await import("node:os");
      const card: Issue = {
        ...makeIssue("DX-2020", "In Progress"),
        dispatch: {
          id: "deadpid-uuid",
          // 0 is the dead-pid sentinel handled by checkYamlDispatchLiveness.
          pid: 0,
          host: hostname(),
          kind: "work",
          started_at: new Date().toISOString(),
          ttl_seconds: 7200,
        },
      };
      writeYaml(dbCtx.openDir, "DX-2020", card);
      await seedDb(REPO, card);

      const result = await reconcileIssue(dbCtx.repo, "DX-2020", "audit");

      expect(result.changed).toBe(true);
      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-2020.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.dispatch).toBeNull();
      const healEntries = updated.history.filter(
        (h) => h.actor === "worker:heal" && h.note?.includes("(dead-pid)"),
      );
      expect(healEntries).toHaveLength(1);
    },
  );

  it.skipIf(!dbHandle)(
    "clears orphan dispatch via dead-ttl verdict (matching host + expired TTL + live PID)",
    async () => {
      const { hostname } = await import("node:os");
      // Started 1 day ago, TTL 60s — expired.
      const startedAt = new Date(Date.now() - 86_400_000).toISOString();
      const card: Issue = {
        ...makeIssue("DX-2030", "In Progress"),
        dispatch: {
          id: "deadttl-uuid",
          pid: process.pid,
          host: hostname(),
          kind: "work",
          started_at: startedAt,
          ttl_seconds: 60,
        },
      };
      writeYaml(dbCtx.openDir, "DX-2030", card);
      await seedDb(REPO, card);

      const result = await reconcileIssue(dbCtx.repo, "DX-2030", "audit");

      expect(result.changed).toBe(true);
      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-2030.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.dispatch).toBeNull();
      const healEntries = updated.history.filter(
        (h) => h.actor === "worker:heal" && h.note?.includes("(dead-ttl)"),
      );
      expect(healEntries).toHaveLength(1);
    },
  );

  it.skipIf(!dbHandle)(
    "3d clears `dispatch` only — `assigned_agent` / `waiting_on` / `requires_human` survive verbatim",
    async () => {
      const card: Issue = {
        ...makeIssue("DX-2040", "In Progress"),
        dispatch: {
          id: "orphan-uuid",
          pid: 0,
          host: "cross-host-different",
          kind: "work",
          started_at: "2020-01-01T00:00:00.000Z",
          ttl_seconds: 60,
        },
        assigned_agent: "alice",
        waiting_on: {
          reason: "Waits for DX-9999 to finish",
          timestamp: "2026-01-01T00:00:00.000Z",
          by: ["DX-9999"],
        },
        requires_human: {
          reason: "Need creds",
          steps: ["Rotate token", "Update env"],
          set_by: "agent",
          set_at: "2026-01-01T00:00:00.000Z",
        },
      };
      writeYaml(dbCtx.openDir, "DX-2040", card);
      await seedDb(REPO, card);

      await reconcileIssue(dbCtx.repo, "DX-2040", "audit");

      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-2040.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.dispatch).toBeNull();
      expect(updated.assigned_agent).toBe("alice");
      expect(updated.waiting_on).toEqual({
        reason: "Waits for DX-9999 to finish",
        timestamp: "2026-01-01T00:00:00.000Z",
        by: ["DX-9999"],
      });
      expect(updated.requires_human).toEqual({
        reason: "Need creds",
        steps: ["Rotate token", "Update env"],
        set_by: "agent",
        set_at: "2026-01-01T00:00:00.000Z",
      });
    },
  );

  it.skipIf(!dbHandle)(
    "does NOT clear when dispatch is alive (cross-host check passes via matching host)",
    async () => {
      const { hostname } = await import("node:os");
      const card: Issue = {
        ...makeIssue("DX-2010", "In Progress"),
        dispatch: {
          id: "live-dispatch-uuid",
          pid: process.pid, // current process is alive
          host: hostname(),
          kind: "work",
          started_at: new Date().toISOString(),
          ttl_seconds: 7200,
        },
      };
      writeYaml(dbCtx.openDir, "DX-2010", card);
      await seedDb(REPO, card);

      await reconcileIssue(dbCtx.repo, "DX-2010", "audit");

      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-2010.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.dispatch).not.toBeNull();
      const healEntries = updated.history.filter(
        (h) => h.actor === "worker:heal" && h.note?.startsWith("Cleared orphan dispatch"),
      );
      expect(healEntries).toHaveLength(0);
    },
  );
});

describe("reconcileIssue — 3e invariant heal (DX-641)", () => {
  const REPO = "phase3-3e-test";
  let dbCtx: DbCtx;

  beforeEach(() => {
    dbCtx = makeDbCtx(REPO);
  });

  it.skipIf(!dbHandle)(
    "clears assigned_agent when derived status is Blocked",
    async () => {
      const card: Issue = {
        ...makeIssue("DX-3000", "Blocked"),
        blocked: { at: "2026-01-01T00:00:00.000Z", reason: "operator-action" },
        assigned_agent: "alice",
      };
      writeYaml(dbCtx.openDir, "DX-3000", card);
      await seedDb(REPO, card);

      const result = await reconcileIssue(dbCtx.repo, "DX-3000", "audit");

      expect(result.changed).toBe(true);
      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-3000.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.assigned_agent).toBeNull();
      // blocked stays — the heal only clears the orphan assignment.
      expect(updated.blocked).not.toBeNull();
      const healEntries = updated.history.filter(
        (h) =>
          h.actor === "worker:heal" &&
          h.note?.startsWith("Cleared assigned_agent on Blocked card"),
      );
      expect(healEntries).toHaveLength(1);
    },
  );

  it.skipIf(!dbHandle)(
    "does NOT clobber `waiting_on` on a Blocked card with assigned_agent (no-clobber invariant)",
    async () => {
      const card: Issue = {
        ...makeIssue("DX-3020", "Blocked"),
        blocked: { at: "2026-01-01T00:00:00.000Z", reason: "operator-action" },
        assigned_agent: "alice",
        waiting_on: {
          reason: "Waits for DX-9998 to ship first",
          timestamp: "2026-01-02T00:00:00.000Z",
          by: ["DX-9998"],
        },
      };
      writeYaml(dbCtx.openDir, "DX-3020", card);
      await seedDb(REPO, card);

      await reconcileIssue(dbCtx.repo, "DX-3020", "audit");

      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-3020.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.assigned_agent).toBeNull();
      // waiting_on survives verbatim — only assigned_agent is cleared.
      expect(updated.waiting_on).toEqual({
        reason: "Waits for DX-9998 to ship first",
        timestamp: "2026-01-02T00:00:00.000Z",
        by: ["DX-9998"],
      });
    },
  );

  it.skipIf(!dbHandle)(
    "does NOT clobber `requires_human` on a Blocked card with assigned_agent (no-clobber invariant)",
    async () => {
      const card: Issue = {
        ...makeIssue("DX-3030", "Blocked"),
        blocked: { at: "2026-01-01T00:00:00.000Z", reason: "operator-action" },
        assigned_agent: "alice",
        requires_human: {
          reason: "Need creds",
          steps: ["Rotate token", "Update env"],
          set_by: "agent",
          set_at: "2026-01-01T00:00:00.000Z",
        },
      };
      writeYaml(dbCtx.openDir, "DX-3030", card);
      await seedDb(REPO, card);

      await reconcileIssue(dbCtx.repo, "DX-3030", "audit");

      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-3030.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(updated.assigned_agent).toBeNull();
      expect(updated.requires_human).toEqual({
        reason: "Need creds",
        steps: ["Rotate token", "Update env"],
        set_by: "agent",
        set_at: "2026-01-01T00:00:00.000Z",
      });
    },
  );

  it.skipIf(!dbHandle)(
    "does NOT fire on In Progress card with assigned_agent (assignment is legitimate)",
    async () => {
      const card: Issue = {
        ...makeIssue("DX-3040", "In Progress"),
        assigned_agent: "alice",
      };
      writeYaml(dbCtx.openDir, "DX-3040", card);
      await seedDb(REPO, card);

      const result = await reconcileIssue(dbCtx.repo, "DX-3040", "audit");

      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-3040.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      // assigned_agent survives — In Progress is the expected
      // assignment-holder state.
      expect(updated.assigned_agent).toBe("alice");
      // Cards without DB-derived state changes are no-ops.
      expect(result.changed).toBe(false);
    },
  );

  it.skipIf(!dbHandle)(
    "does NOT clobber in-flight conflict_on[] (no-clobber invariant)",
    async () => {
      // A ToDo card with `conflict_on[]` populated by the prep-verdict
      // route mid-dispatch — reconcile observes this AND must not touch
      // the field. 3e's invariant scope is `assigned_agent` only;
      // `conflict_on[]`, `waiting_on`, `requires_human` are NEVER
      // mutated by reconcile.
      const card: Issue = {
        ...makeIssue("DX-3010", "ToDo"),
        conflict_on: [
          { id: "DX-9999", reason: "Touches same module — partner in flight" },
        ],
      };
      writeYaml(dbCtx.openDir, "DX-3010", card);
      await seedDb(REPO, card);

      const result = await reconcileIssue(dbCtx.repo, "DX-3010", "audit");

      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-3010.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      // conflict_on[] survives reconcile verbatim.
      expect(updated.conflict_on).toEqual([
        { id: "DX-9999", reason: "Touches same module — partner in flight" },
      ]);
      void result;
    },
  );
});

describe("reconcileIssue — 3c list_name audit (DX-641)", () => {
  const REPO = "phase3-3c-test";
  let dbCtx: DbCtx;

  beforeEach(() => {
    dbCtx = makeDbCtx(REPO);
  });

  it.skipIf(!dbHandle)(
    "re-asserts list_name when stamped to a stale value (projection re-affirm, ZERO history)",
    async () => {
      // Card carries `list_name: "In Progress"` but `completed_at`
      // says Done. Audit corrects list_name without minting a history
      // entry. Covers the DX-624 class — stamp path raced with state
      // change.
      const card: Issue = {
        ...makeIssue("DX-4000", "Done"),
        completed_at: "2026-01-01T00:00:00.000Z",
        list_name: "In Progress", // stale
      };
      writeYaml(dbCtx.closedDir, "DX-4000", card);
      await seedDb(REPO, card);

      const result = await reconcileIssue(dbCtx.repo, "DX-4000", "audit");

      expect(result.changed).toBe(true);
      const updated = parseIssue(
        readFileSync(resolve(dbCtx.closedDir, "DX-4000.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      // Expected list name for a Done card is "Done" (per the seeded
      // lists.yaml default for the `completed` type).
      expect(updated.list_name).toBe("Done");
      // ZERO history entries from this audit run.
      expect(updated.history).toHaveLength(0);
    },
  );

  it.skipIf(!dbHandle)(
    "skips when list_name is null (treats null as unset, not auto-fill)",
    async () => {
      const card: Issue = {
        ...makeIssue("DX-4010", "ToDo"),
        list_name: null,
      };
      writeYaml(dbCtx.openDir, "DX-4010", card);
      await seedDb(REPO, card);

      const result = await reconcileIssue(dbCtx.repo, "DX-4010", "audit");

      const updated = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-4010.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      // list_name stays null — audit doesn't auto-fill.
      expect(updated.list_name).toBeNull();
      // No drift from this audit (the card was steady-state).
      expect(result.changed).toBe(false);
    },
  );

  it.skipIf(!dbHandle)(
    "is idempotent — running twice on same fix-target lands the same value with zero second-run history",
    async () => {
      const card: Issue = {
        ...makeIssue("DX-4020", "ToDo"),
        ready_at: "2026-01-01T00:00:00.000Z",
        list_name: "In Progress", // stale; expected = "To Do"
      };
      writeYaml(dbCtx.openDir, "DX-4020", card);
      await seedDb(REPO, card);

      await reconcileIssue(dbCtx.repo, "DX-4020", "audit");
      const after1 = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-4020.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(after1.list_name).toBe("To Do");
      expect(after1.history).toHaveLength(0);

      const result2 = await reconcileIssue(dbCtx.repo, "DX-4020", "audit");
      expect(result2.changed).toBe(false);
      const after2 = parseIssue(
        readFileSync(resolve(dbCtx.openDir, "DX-4020.yml"), "utf-8"),
        { expectedPrefix: "DX" },
      );
      expect(after2.list_name).toBe("To Do");
      expect(after2.history).toHaveLength(0);
    },
  );
});

describe("reconcileIssue — 3f triage TTL refresh scheduler poke (DX-641)", () => {
  const REPO = "phase3-3f-test";
  let dbCtx: DbCtx;

  beforeEach(() => {
    dbCtx = makeDbCtx(REPO);
  });

  it.skipIf(!dbHandle)(
    "emits schedulerPokeReason='triage-empty' when triage.expires_at is empty AND card is in triage scope (Review)",
    async () => {
      const card: Issue = {
        ...makeIssue("DX-5000", "Review"),
      };
      writeYaml(dbCtx.openDir, "DX-5000", card);
      await seedDb(REPO, card);

      const result = await reconcileIssue(dbCtx.repo, "DX-5000", "watcher");

      expect(result.fanout.schedulerPokeReason).toBe("triage-empty");
    },
  );

  it.skipIf(!dbHandle)(
    "does NOT emit poke when triage.expires_at is populated",
    async () => {
      const card: Issue = {
        ...makeIssue("DX-5010", "Review"),
        triage: {
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          reassess_hint: "",
          last_status: "",
          last_explain: "",
          ice: { total: 0, i: 0, c: 0, e: 0 },
          history: [],
        },
      };
      writeYaml(dbCtx.openDir, "DX-5010", card);
      await seedDb(REPO, card);

      const result = await reconcileIssue(dbCtx.repo, "DX-5010", "watcher");

      expect(result.fanout.schedulerPokeReason).toBeUndefined();
    },
  );

  it.skipIf(!dbHandle)(
    "is idempotent — second reconcile on same empty-expires_at state does NOT re-poke (cache holds the empty value)",
    async () => {
      const card: Issue = {
        ...makeIssue("DX-5020", "Review"),
      };
      writeYaml(dbCtx.openDir, "DX-5020", card);
      await seedDb(REPO, card);

      const r1 = await reconcileIssue(dbCtx.repo, "DX-5020", "watcher");
      expect(r1.fanout.schedulerPokeReason).toBe("triage-empty");
      const r2 = await reconcileIssue(dbCtx.repo, "DX-5020", "watcher");
      // Skip-cache (DX-640) absorbs the second reconcile — fanout is the
      // empty default; no re-poke for the same empty-expires_at state.
      expect(r2.fanout.schedulerPokeReason).toBeUndefined();
    },
  );

  it.skipIf(!dbHandle)(
    "emits triage-empty poke for a derived-Blocked card",
    async () => {
      const card: Issue = {
        ...makeIssue("DX-5040", "Blocked"),
        blocked: { at: "2026-01-01T00:00:00.000Z", reason: "operator-action" },
      };
      writeYaml(dbCtx.openDir, "DX-5040", card);
      await seedDb(REPO, card);

      const result = await reconcileIssue(dbCtx.repo, "DX-5040", "watcher");

      expect(result.fanout.schedulerPokeReason).toBe("triage-empty");
    },
  );

  it.skipIf(!dbHandle)(
    "emits triage-empty poke for a ToDo card with waiting_on != null (in-scope via waiting_on)",
    async () => {
      const card: Issue = {
        ...makeIssue("DX-5050", "ToDo"),
        waiting_on: {
          reason: "Waits for DX-9999",
          timestamp: "2026-01-01T00:00:00.000Z",
          by: ["DX-9999"],
        },
      };
      writeYaml(dbCtx.openDir, "DX-5050", card);
      await seedDb(REPO, card);

      const result = await reconcileIssue(dbCtx.repo, "DX-5050", "watcher");

      expect(result.fanout.schedulerPokeReason).toBe("triage-empty");
    },
  );

  it.skipIf(!dbHandle)(
    "does NOT poke for a ToDo card outside triage scope (terminal-status or non-Review/Blocked ToDo with no waiting_on)",
    async () => {
      const card: Issue = {
        ...makeIssue("DX-5030", "ToDo"),
      };
      writeYaml(dbCtx.openDir, "DX-5030", card);
      await seedDb(REPO, card);

      const result = await reconcileIssue(dbCtx.repo, "DX-5030", "watcher");
      expect(result.fanout.schedulerPokeReason).toBeUndefined();
    },
  );
});
