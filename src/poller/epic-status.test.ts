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
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseIssue } from "../issue-tracker/yaml.js";
import { canonicalize, sha256 } from "../db/canonicalize.js";
import { createTestDb, type TestDbHandle } from "../db/test-db.js";
import { up as upIssuesMirror } from "../db/migrations/016_issues_mirror.js";
import type { Issue, IssueStatus } from "../issue-tracker/interface.js";
import { deriveStatus, recomputeParentStatuses } from "./epic-status.js";
import {
  resetIssueDbQueryFn,
  setIssueDbQueryFn,
} from "./issues-db.js";
import { clearAllRepoNames, setRepoName } from "./repo-name.js";
import { ensureIssuesDirs } from "../issue-tracker/paths.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const merged: Issue = {
    schema_version: 12,
    tracker: "trello",
    id: "ISS-1",
    external_id: "ext-1",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Sample",
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
    ac: [{ check_item_id: "", title: "AC1", checked: false }],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    requires_human: null,
    assigned_agent: null,
    waiting_on: null,
    conflict_on: [],
    effort_level: null,
    history: [],
    ...overrides,
    db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: null,
  };

  return merged;
}

function child(id: string, status: IssueStatus): Issue {
  return makeIssue({
    id,
    external_id: `ext-${id}`,
    status,
    parent_id: "ISS-1",
  });
}

describe("deriveStatus", () => {
  it("returns null for empty children", () => {
    expect(deriveStatus([])).toBeNull();
  });

  // DX-658 retired the `any child Blocked → parent Blocked` rule
  // (Blocked is no longer a status; blocked is a pure dispatch gate
  // not propagated to parents). DX-231 retired the Needs Approval
  // parking status. Tests for those rules were removed.

  describe("priority rule 2 — any In Progress (without Blocked)", () => {
    it("In Progress wins over ToDo / Review / Done / Cancelled", () => {
      const result = deriveStatus([
        child("ISS-1", "In Progress"),
        child("ISS-2", "ToDo"),
        child("ISS-3", "Review"),
      ]);
      expect(result?.status).toBe("In Progress");
    });
  });

  describe("priority rule 3 — any ToDo (without higher priorities)", () => {
    it("ToDo wins over Review / Done / Cancelled", () => {
      const result = deriveStatus([
        child("ISS-1", "ToDo"),
        child("ISS-2", "Review"),
        child("ISS-3", "Done"),
      ]);
      expect(result?.status).toBe("ToDo");
    });
  });

  describe("priority rule 4 — all non-cancelled children Review", () => {
    it("All Review (no Cancelled) → Review", () => {
      const result = deriveStatus([
        child("ISS-1", "Review"),
        child("ISS-2", "Review"),
      ]);
      expect(result?.status).toBe("Review");
    });

    it("Cancelled siblings excluded from Review-all check", () => {
      const result = deriveStatus([
        child("ISS-1", "Review"),
        child("ISS-2", "Cancelled"),
      ]);
      expect(result?.status).toBe("Review");
    });
  });

  describe("priority rule 5 — all non-cancelled children Done", () => {
    it("All Done (no Cancelled) → Done", () => {
      const result = deriveStatus([
        child("ISS-1", "Done"),
        child("ISS-2", "Done"),
      ]);
      expect(result?.status).toBe("Done");
    });

    it("Cancelled siblings excluded from Done-all check", () => {
      const result = deriveStatus([
        child("ISS-1", "Done"),
        child("ISS-2", "Cancelled"),
      ]);
      expect(result?.status).toBe("Done");
    });
  });

  describe("priority rule 6 — all children Cancelled (no exclusion)", () => {
    it("Every child Cancelled → Cancelled", () => {
      const result = deriveStatus([
        child("ISS-1", "Cancelled"),
        child("ISS-2", "Cancelled"),
      ]);
      expect(result?.status).toBe("Cancelled");
    });
  });

  describe("edge cases", () => {
    it("Mixed Review + Done returns null (no priority rule fires)", () => {
      const result = deriveStatus([
        child("ISS-1", "Review"),
        child("ISS-2", "Done"),
      ]);
      expect(result).toBeNull();
    });
  });
});

// Integration tests — DB-backed since DX-155.
const handle: TestDbHandle | null = await createTestDb();

if (!handle) {
  // eslint-disable-next-line no-console
  console.warn(
    "[epic-status] skipping integration suite — local Postgres not reachable",
  );
} else {
  const client = await handle.pool.connect();
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

afterAll(async () => {
  resetIssueDbQueryFn();
  clearAllRepoNames();
  if (handle) await handle.close();
});

if (handle) {
  beforeAll(() => {
    setIssueDbQueryFn(async (sql, params) => {
      const result = await handle.pool.query(sql, params ?? []);
      return result.rows as never;
    });
  });
}

describe("recomputeParentStatuses (integration)", () => {
  let repoRoot: string;
  const REPO_NAME = "epic-status-test-repo";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-epic-status-"));
    if (handle) {
      await handle.pool.query("DELETE FROM issues");
      setRepoName(repoRoot, REPO_NAME);
      ensureIssuesDirs(repoRoot);
    }
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  async function seed(issue: Issue): Promise<void> {
    if (!handle) return;
    const data = issue as unknown as Record<string, unknown>;
    const contentHash = sha256(canonicalize(data));
    await handle.pool.query(
      `INSERT INTO issues
         (repo_name, data, content_hash, mirror_updated_at)
       VALUES ($1, $2::jsonb, $3, now())`,
      [REPO_NAME, JSON.stringify(data), contentHash],
    );
  }

  function loadStatus(id: string): IssueStatus {
    const path = resolve(repoRoot, ".danxbot", "issues", "open", `${id}.yml`);
    return parseIssue(readFileSync(path, "utf-8"), { expectedPrefix: "ISS" })
      .status;
  }

  function loadIssue(id: string): Issue {
    const path = resolve(repoRoot, ".danxbot", "issues", "open", `${id}.yml`);
    return parseIssue(readFileSync(path, "utf-8"), { expectedPrefix: "ISS" });
  }

  it.skipIf(!handle)("writes parent only when derived status differs", async () => {
    await seed(
      makeIssue({
        id: "ISS-1",
        type: "Epic",
        status: "ToDo",
        children: ["ISS-2", "ISS-3"],
      }),
    );
    await seed(child("ISS-2", "In Progress"));
    await seed(child("ISS-3", "ToDo"));

    const changes = await recomputeParentStatuses(repoRoot, "ISS");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      id: "ISS-1",
      before: "ToDo",
      after: "In Progress",
    });
    expect(loadStatus("ISS-1")).toBe("In Progress");
  });

  it.skipIf(!handle)(
    "no-op when derived status equals current status",
    async () => {
      await seed(
        makeIssue({
          id: "ISS-1",
          type: "Epic",
          status: "In Progress",
          children: ["ISS-2"],
        }),
      );
      await seed(child("ISS-2", "In Progress"));

      const changes = await recomputeParentStatuses(repoRoot, "ISS");
      expect(changes).toEqual([]);
    },
  );

  it.skipIf(!handle)(
    "walks every parent with non-empty children[] (epic OR non-epic)",
    async () => {
      await seed(
        makeIssue({
          id: "ISS-1",
          type: "Epic",
          status: "ToDo",
          children: ["ISS-2"],
        }),
      );
      await seed(
        makeIssue({
          id: "ISS-3",
          type: "Feature",
          status: "ToDo",
          children: ["ISS-4"],
        }),
      );
      await seed(makeIssue({
        id: "ISS-2",
        external_id: "ext-2",
        status: "Done",
        parent_id: "ISS-1",
      }));
      await seed(makeIssue({
        id: "ISS-4",
        external_id: "ext-4",
        status: "In Progress",
        parent_id: "ISS-3",
      }));

      const changes = await recomputeParentStatuses(repoRoot, "ISS");
      const ids = changes.map((c) => c.id).sort();
      expect(ids).toEqual(["ISS-1", "ISS-3"]);
      expect(loadStatus("ISS-1")).toBe("Done");
      expect(loadStatus("ISS-3")).toBe("In Progress");
    },
  );

  it.skipIf(!handle)(
    "reads children from ALL statuses (terminal children carry Done/Cancelled)",
    async () => {
      await seed(
        makeIssue({
          id: "ISS-1",
          type: "Epic",
          status: "ToDo",
          children: ["ISS-2", "ISS-3"],
        }),
      );
      // Both children Done — mirrored in the DB whether their YAML
      // lives in open/ or closed/ on disk.
      await seed(child("ISS-2", "Done"));
      await seed(child("ISS-3", "Done"));

      const changes = await recomputeParentStatuses(repoRoot, "ISS");
      expect(changes).toHaveLength(1);
      expect(loadStatus("ISS-1")).toBe("Done");
    },
  );

  it.skipIf(!handle)("ignores rows with empty children[]", async () => {
    await seed(
      makeIssue({
        id: "ISS-1",
        type: "Feature",
        status: "ToDo",
        children: [],
      }),
    );
    const changes = await recomputeParentStatuses(repoRoot, "ISS");
    expect(changes).toEqual([]);
  });

  it.skipIf(!handle)(
    "skips parents with non-null waiting_on (worker normalizes status to ToDo on save)",
    async () => {
      await seed(
        makeIssue({
          id: "ISS-1",
          type: "Epic",
          status: "ToDo",
          children: ["ISS-2"],
          waiting_on: {
            reason: "Waits on something external",
            timestamp: "2026-05-01T00:00:00Z",
            by: ["ISS-99"],
          },
        }),
      );
      await seed(child("ISS-2", "In Progress"));

      const changes = await recomputeParentStatuses(repoRoot, "ISS");
      expect(changes).toEqual([]);
    },
  );

  it.skipIf(!handle)(
    "skips defensively a child whose row is missing",
    async () => {
      await seed(
        makeIssue({
          id: "ISS-1",
          type: "Epic",
          status: "ToDo",
          children: ["ISS-2", "ISS-99"],
        }),
      );
      await seed(child("ISS-2", "Done"));
      // ISS-99 is referenced in children[] but has no row in the DB.

      const changes = await recomputeParentStatuses(repoRoot, "ISS");
      expect(changes).toHaveLength(1);
      expect(loadStatus("ISS-1")).toBe("Done");
    },
  );

  // ----- DX-147 — history-append on auto-derive -----

  it.skipIf(!handle)(
    "DX-147: derive flip appends exactly one worker:auto-derive status_change entry with rule note",
    async () => {
      await seed(
        makeIssue({
          id: "ISS-1",
          type: "Epic",
          status: "In Progress",
          children: ["ISS-2", "ISS-3"],
          history: [],
        }),
      );
      await seed(child("ISS-2", "Done"));
      await seed(child("ISS-3", "Done"));

      const changes = await recomputeParentStatuses(repoRoot, "ISS");
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        id: "ISS-1",
        before: "In Progress",
        after: "Done",
      });
      expect(changes[0].rule).toMatch(/Done/);

      const reloaded = loadIssue("ISS-1");
      expect(reloaded.history).toHaveLength(1);
      const entry = reloaded.history[0];
      expect(entry.actor).toBe("worker:auto-derive");
      expect(entry.event).toBe("status_change");
      expect(entry.from).toBe("In Progress");
      expect(entry.to).toBe("Done");
      expect(entry.note).toBeTruthy();
      expect(entry.note!.length).toBeGreaterThan(5);
      expect(entry.note).toMatch(/Done/);
      expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);
    },
  );

  it.skipIf(!handle)(
    "DX-147: no flip means zero history entries appended (idempotent steady state)",
    async () => {
      await seed(
        makeIssue({
          id: "ISS-1",
          type: "Epic",
          status: "In Progress",
          children: ["ISS-2"],
          history: [],
        }),
      );
      await seed(child("ISS-2", "In Progress"));

      const changes = await recomputeParentStatuses(repoRoot, "ISS");
      expect(changes).toEqual([]);
      // Parent file does not exist on disk because we never wrote it
      // (DB-only seed + no flip). The "no history entries appended"
      // check is implicit — no write means no append.
    },
  );

  it.skipIf(!handle)(
    "DX-147: derive flip preserves any prior history entries — append, not replace",
    async () => {
      const prior = {
        timestamp: "2026-05-01T00:00:00.000Z",
        actor: "dispatch:abc",
        event: "status_change" as const,
        from: "ToDo" as IssueStatus,
        to: "In Progress" as IssueStatus,
      };
      await seed(
        makeIssue({
          id: "ISS-1",
          type: "Epic",
          status: "In Progress",
          children: ["ISS-2"],
          history: [prior],
        }),
      );
      await seed(child("ISS-2", "Done"));

      const changes = await recomputeParentStatuses(repoRoot, "ISS");
      expect(changes).toHaveLength(1);

      const reloaded = loadIssue("ISS-1");
      expect(reloaded.history).toHaveLength(2);
      expect(reloaded.history[0]).toMatchObject(prior);
      expect(reloaded.history[1].actor).toBe("worker:auto-derive");
      expect(reloaded.history[1].event).toBe("status_change");
    },
  );

  // Per-rule note accuracy.
  it.skipIf(!handle)(
    "DX-147: rule 2 — In Progress flip note describes the In Progress rule",
    async () => {
      await seed(
        makeIssue({
          id: "ISS-1",
          type: "Epic",
          status: "ToDo",
          children: ["ISS-2", "ISS-3"],
        }),
      );
      await seed(child("ISS-2", "In Progress"));
      await seed(child("ISS-3", "ToDo"));

      await recomputeParentStatuses(repoRoot, "ISS");
      const note = loadIssue("ISS-1").history[0].note ?? "";
      expect(note).toMatch(/In Progress/);
    },
  );

  it.skipIf(!handle)(
    "DX-147: rule 4 — Review flip note describes the Review rule",
    async () => {
      await seed(
        makeIssue({
          id: "ISS-1",
          type: "Epic",
          status: "ToDo",
          children: ["ISS-2", "ISS-3"],
        }),
      );
      await seed(child("ISS-2", "Review"));
      await seed(child("ISS-3", "Review"));

      await recomputeParentStatuses(repoRoot, "ISS");
      const note = loadIssue("ISS-1").history[0].note ?? "";
      expect(note).toMatch(/Review/);
    },
  );

  it.skipIf(!handle)(
    "DX-147: rule 6 — Cancelled flip note describes the Cancelled rule (every child Cancelled)",
    async () => {
      await seed(
        makeIssue({
          id: "ISS-1",
          type: "Epic",
          status: "In Progress",
          children: ["ISS-2", "ISS-3"],
        }),
      );
      await seed(child("ISS-2", "Cancelled"));
      await seed(child("ISS-3", "Cancelled"));

      await recomputeParentStatuses(repoRoot, "ISS");
      const note = loadIssue("ISS-1").history[0].note ?? "";
      expect(note).toMatch(/Cancelled/);
    },
  );
});
