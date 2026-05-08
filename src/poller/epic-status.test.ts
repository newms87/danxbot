import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseIssue, serializeIssue } from "../issue-tracker/yaml.js";
import type { Issue, IssueStatus } from "../issue-tracker/interface.js";
import { deriveStatus, recomputeParentStatuses } from "./epic-status.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    schema_version: 3,
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
    ...overrides,
  };
}

function child(id: string, status: IssueStatus): Issue {
  return makeIssue({ id, external_id: `ext-${id}`, status });
}

function writeOpen(repoRoot: string, issue: Issue, state: "open" | "closed" = "open"): string {
  const dir = resolve(repoRoot, ".danxbot", "issues", state);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${issue.id}.yml`);
  writeFileSync(path, serializeIssue(issue));
  return path;
}

describe("deriveStatus", () => {
  it("returns null for empty children", () => {
    expect(deriveStatus([])).toBeNull();
  });

  describe("priority rule 1 — any Needs Help / Needs Approval lifts to parent", () => {
    it("Needs Help wins over In Progress / ToDo / Review / Done / Cancelled", () => {
      const result = deriveStatus([
        child("ISS-1", "In Progress"),
        child("ISS-2", "ToDo"),
        child("ISS-3", "Needs Help"),
        child("ISS-4", "Done"),
      ]);
      expect(result).toBe("Needs Help");
    });

    it("Needs Approval lifts to parent (preserves distinction from Needs Help)", () => {
      const result = deriveStatus([
        child("ISS-1", "In Progress"),
        child("ISS-2", "Needs Approval"),
      ]);
      expect(result).toBe("Needs Approval");
    });

    it("Needs Help wins over Needs Approval when both present", () => {
      const result = deriveStatus([
        child("ISS-1", "Needs Approval"),
        child("ISS-2", "Needs Help"),
      ]);
      expect(result).toBe("Needs Help");
    });
  });

  describe("priority rule 2 — any In Progress (without Needs Help/Approval)", () => {
    it("In Progress wins over ToDo / Review / Done / Cancelled", () => {
      const result = deriveStatus([
        child("ISS-1", "Done"),
        child("ISS-2", "ToDo"),
        child("ISS-3", "In Progress"),
        child("ISS-4", "Review"),
      ]);
      expect(result).toBe("In Progress");
    });
  });

  describe("priority rule 3 — any ToDo (without higher priorities)", () => {
    it("ToDo wins over Review / Done / Cancelled", () => {
      const result = deriveStatus([
        child("ISS-1", "Done"),
        child("ISS-2", "Review"),
        child("ISS-3", "ToDo"),
        child("ISS-4", "Cancelled"),
      ]);
      expect(result).toBe("ToDo");
    });
  });

  describe("priority rule 4 — all non-cancelled children Review", () => {
    it("returns Review when all are Review", () => {
      const result = deriveStatus([
        child("ISS-1", "Review"),
        child("ISS-2", "Review"),
      ]);
      expect(result).toBe("Review");
    });

    it("returns Review when all non-cancelled are Review (cancelled excluded)", () => {
      const result = deriveStatus([
        child("ISS-1", "Review"),
        child("ISS-2", "Cancelled"),
        child("ISS-3", "Review"),
      ]);
      expect(result).toBe("Review");
    });
  });

  describe("priority rule 5 — all non-cancelled children Done", () => {
    it("returns Done when all are Done", () => {
      const result = deriveStatus([
        child("ISS-1", "Done"),
        child("ISS-2", "Done"),
      ]);
      expect(result).toBe("Done");
    });

    it("returns Done when all non-cancelled are Done (cancelled excluded)", () => {
      const result = deriveStatus([
        child("ISS-1", "Done"),
        child("ISS-2", "Cancelled"),
        child("ISS-3", "Done"),
      ]);
      expect(result).toBe("Done");
    });
  });

  describe("priority rule 6 — all children Cancelled (no exclusion)", () => {
    it("returns Cancelled when every child is Cancelled", () => {
      const result = deriveStatus([
        child("ISS-1", "Cancelled"),
        child("ISS-2", "Cancelled"),
      ]);
      expect(result).toBe("Cancelled");
    });

    it("does NOT return Cancelled when at least one child is non-Cancelled (rule 5 fires for Done)", () => {
      const result = deriveStatus([
        child("ISS-1", "Cancelled"),
        child("ISS-2", "Done"),
      ]);
      expect(result).toBe("Done");
    });
  });

  describe("edge cases", () => {
    it("returns null for unresolvable mix (Review + Done, no Cancelled)", () => {
      // Neither rule 4 (all Review) nor rule 5 (all Done) fires.
      const result = deriveStatus([
        child("ISS-1", "Review"),
        child("ISS-2", "Done"),
      ]);
      expect(result).toBeNull();
    });

    it("treats single Cancelled child as rule 6", () => {
      const result = deriveStatus([child("ISS-1", "Cancelled")]);
      expect(result).toBe("Cancelled");
    });

    it("Done + Cancelled mix excludes Cancelled and returns Done", () => {
      const result = deriveStatus([
        child("ISS-1", "Cancelled"),
        child("ISS-2", "Cancelled"),
        child("ISS-3", "Done"),
      ]);
      expect(result).toBe("Done");
    });
  });
});

describe("recomputeParentStatuses (integration)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-epic-status-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function loadStatus(id: string, state: "open" | "closed" = "open"): IssueStatus {
    const path = resolve(repoRoot, ".danxbot", "issues", state, `${id}.yml`);
    return parseIssue(readFileSync(path, "utf-8")).status;
  }

  it("writes parent only when derived status differs", () => {
    writeOpen(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        type: "Epic",
        status: "ToDo",
        children: ["ISS-2", "ISS-3"],
      }),
    );
    writeOpen(repoRoot, child("ISS-2", "In Progress"));
    writeOpen(repoRoot, child("ISS-3", "ToDo"));

    const changes = recomputeParentStatuses(repoRoot);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      id: "ISS-1",
      before: "ToDo",
      after: "In Progress",
    });
    expect(loadStatus("ISS-1")).toBe("In Progress");
  });

  it("no-op when derived status equals current status", () => {
    writeOpen(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        type: "Epic",
        status: "In Progress",
        children: ["ISS-2"],
      }),
    );
    writeOpen(repoRoot, child("ISS-2", "In Progress"));

    const changes = recomputeParentStatuses(repoRoot);
    expect(changes).toEqual([]);
    expect(loadStatus("ISS-1")).toBe("In Progress");
  });

  it("walks every parent with non-empty children[] (epic OR non-epic)", () => {
    writeOpen(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        type: "Epic",
        status: "ToDo",
        children: ["ISS-2"],
      }),
    );
    writeOpen(
      repoRoot,
      makeIssue({
        id: "ISS-3",
        type: "Feature",
        status: "ToDo",
        children: ["ISS-4"],
      }),
    );
    writeOpen(repoRoot, child("ISS-2", "Done"));
    writeOpen(repoRoot, child("ISS-4", "In Progress"));

    const changes = recomputeParentStatuses(repoRoot);
    const ids = changes.map((c) => c.id).sort();
    expect(ids).toEqual(["ISS-1", "ISS-3"]);
    expect(loadStatus("ISS-1")).toBe("Done");
    expect(loadStatus("ISS-3")).toBe("In Progress");
  });

  it("reads children from open/ AND closed/ (terminal children carry Done/Cancelled)", () => {
    writeOpen(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        type: "Epic",
        status: "ToDo",
        children: ["ISS-2", "ISS-3"],
      }),
    );
    // Both children Done — one in open/, one already moved to closed/.
    writeOpen(repoRoot, child("ISS-2", "Done"), "open");
    writeOpen(repoRoot, child("ISS-3", "Done"), "closed");

    const changes = recomputeParentStatuses(repoRoot);
    expect(changes).toHaveLength(1);
    expect(loadStatus("ISS-1")).toBe("Done");
  });

  it("ignores YAMLs with empty children[]", () => {
    writeOpen(
      repoRoot,
      makeIssue({ id: "ISS-1", type: "Feature", status: "ToDo", children: [] }),
    );
    const changes = recomputeParentStatuses(repoRoot);
    expect(changes).toEqual([]);
  });

  it("skips parents with non-null blocked (worker normalizes status to ToDo on save)", () => {
    writeOpen(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        type: "Epic",
        status: "ToDo",
        children: ["ISS-2"],
        blocked: {
          reason: "Waits on something external",
          timestamp: "2026-05-01T00:00:00Z",
          by: ["ISS-99"],
        },
      }),
    );
    writeOpen(repoRoot, child("ISS-2", "In Progress"));

    const changes = recomputeParentStatuses(repoRoot);
    expect(changes).toEqual([]);
    expect(loadStatus("ISS-1")).toBe("ToDo");
  });

  it("skips defensive child whose YAML is missing", () => {
    writeOpen(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        type: "Epic",
        status: "ToDo",
        children: ["ISS-2", "ISS-99"],
      }),
    );
    writeOpen(repoRoot, child("ISS-2", "Done"));
    // ISS-99 is referenced in children[] but has no YAML on disk.

    const changes = recomputeParentStatuses(repoRoot);
    expect(changes).toHaveLength(1);
    expect(loadStatus("ISS-1")).toBe("Done");
  });

  it("skips malformed YAMLs without crashing", () => {
    writeOpen(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        type: "Epic",
        status: "ToDo",
        children: ["ISS-2"],
      }),
    );
    writeOpen(repoRoot, child("ISS-2", "In Progress"));
    // Drop a malformed YAML alongside the valid ones to simulate a
    // partially-written file or hand-edited corruption. The matching
    // filename pattern (ISS-N.yml) ensures it's actually walked.
    const badPath = resolve(
      repoRoot,
      ".danxbot",
      "issues",
      "open",
      "ISS-99.yml",
    );
    writeFileSync(badPath, "not: a: valid: issue:\n  yaml here");

    const changes = recomputeParentStatuses(repoRoot);
    expect(changes).toHaveLength(1);
    expect(loadStatus("ISS-1")).toBe("In Progress");
  });

  it("skips a malformed CHILD YAML and still derives from the resolvable subset", () => {
    writeOpen(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        type: "Epic",
        status: "ToDo",
        children: ["ISS-2", "ISS-3"],
      }),
    );
    writeOpen(repoRoot, child("ISS-2", "Done"));
    // Corrupt ISS-3 — parseIssue throws when we try to load it. The
    // walker must continue and derive from {ISS-2: Done} alone.
    const badPath = resolve(
      repoRoot,
      ".danxbot",
      "issues",
      "open",
      "ISS-3.yml",
    );
    writeFileSync(badPath, "not: a: valid: issue:\n  yaml here");

    const changes = recomputeParentStatuses(repoRoot);
    expect(changes).toHaveLength(1);
    expect(loadStatus("ISS-1")).toBe("Done");
  });

  it("propagates Needs Help up an Epic chain on the same call", () => {
    writeOpen(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        type: "Epic",
        status: "ToDo",
        children: ["ISS-2", "ISS-3"],
      }),
    );
    writeOpen(repoRoot, child("ISS-2", "Done"));
    writeOpen(repoRoot, child("ISS-3", "Needs Help"));

    const changes = recomputeParentStatuses(repoRoot);
    expect(changes).toHaveLength(1);
    expect(loadStatus("ISS-1")).toBe("Needs Help");
  });
});
