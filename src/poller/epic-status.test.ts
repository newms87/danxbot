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
  const merged: Issue = {
    schema_version: 4,
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
    waiting_on: null,
    history: [],
    ...overrides,
  };
  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "test self-block",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
  }
  return merged;
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

  describe("priority rule 1 — any Blocked / Needs Approval lifts to parent", () => {
    it("Blocked wins over In Progress / ToDo / Review / Done / Cancelled", () => {
      const result = deriveStatus([
        child("ISS-1", "In Progress"),
        child("ISS-2", "ToDo"),
        child("ISS-3", "Blocked"),
        child("ISS-4", "Done"),
      ]);
      expect(result?.status).toBe("Blocked");
      expect(result?.rule).toMatch(/Blocked/);
    });

    it("Needs Approval lifts to parent (preserves distinction from Blocked)", () => {
      const result = deriveStatus([
        child("ISS-1", "In Progress"),
        child("ISS-2", "Needs Approval"),
      ]);
      expect(result?.status).toBe("Needs Approval");
      expect(result?.rule).toMatch(/Needs Approval/);
    });

    it("Blocked wins over Needs Approval when both present", () => {
      const result = deriveStatus([
        child("ISS-1", "Needs Approval"),
        child("ISS-2", "Blocked"),
      ]);
      expect(result?.status).toBe("Blocked");
    });
  });

  describe("priority rule 2 — any In Progress (without Blocked/Approval)", () => {
    it("In Progress wins over ToDo / Review / Done / Cancelled", () => {
      const result = deriveStatus([
        child("ISS-1", "Done"),
        child("ISS-2", "ToDo"),
        child("ISS-3", "In Progress"),
        child("ISS-4", "Review"),
      ]);
      expect(result?.status).toBe("In Progress");
      expect(result?.rule).toMatch(/In Progress/);
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
      expect(result?.status).toBe("ToDo");
    });
  });

  describe("priority rule 4 — all non-cancelled children Review", () => {
    it("returns Review when all are Review", () => {
      const result = deriveStatus([
        child("ISS-1", "Review"),
        child("ISS-2", "Review"),
      ]);
      expect(result?.status).toBe("Review");
      expect(result?.rule).toMatch(/Review/);
    });

    it("returns Review when all non-cancelled are Review (cancelled excluded)", () => {
      const result = deriveStatus([
        child("ISS-1", "Review"),
        child("ISS-2", "Cancelled"),
        child("ISS-3", "Review"),
      ]);
      expect(result?.status).toBe("Review");
    });
  });

  describe("priority rule 5 — all non-cancelled children Done", () => {
    it("returns Done when all are Done", () => {
      const result = deriveStatus([
        child("ISS-1", "Done"),
        child("ISS-2", "Done"),
      ]);
      expect(result?.status).toBe("Done");
      expect(result?.rule).toMatch(/Done/);
    });

    it("returns Done when all non-cancelled are Done (cancelled excluded)", () => {
      const result = deriveStatus([
        child("ISS-1", "Done"),
        child("ISS-2", "Cancelled"),
        child("ISS-3", "Done"),
      ]);
      expect(result?.status).toBe("Done");
    });
  });

  describe("priority rule 6 — all children Cancelled (no exclusion)", () => {
    it("returns Cancelled when every child is Cancelled", () => {
      const result = deriveStatus([
        child("ISS-1", "Cancelled"),
        child("ISS-2", "Cancelled"),
      ]);
      expect(result?.status).toBe("Cancelled");
      expect(result?.rule).toMatch(/Cancelled/);
    });

    it("does NOT return Cancelled when at least one child is non-Cancelled (rule 5 fires for Done)", () => {
      const result = deriveStatus([
        child("ISS-1", "Cancelled"),
        child("ISS-2", "Done"),
      ]);
      expect(result?.status).toBe("Done");
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
      expect(result?.status).toBe("Cancelled");
    });

    it("Done + Cancelled mix excludes Cancelled and returns Done", () => {
      const result = deriveStatus([
        child("ISS-1", "Cancelled"),
        child("ISS-2", "Cancelled"),
        child("ISS-3", "Done"),
      ]);
      expect(result?.status).toBe("Done");
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
    return parseIssue(readFileSync(path, "utf-8"), { expectedPrefix: "ISS" }).status;
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

    const changes = recomputeParentStatuses(repoRoot, "ISS");
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

    const changes = recomputeParentStatuses(repoRoot, "ISS");
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

    const changes = recomputeParentStatuses(repoRoot, "ISS");
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

    const changes = recomputeParentStatuses(repoRoot, "ISS");
    expect(changes).toHaveLength(1);
    expect(loadStatus("ISS-1")).toBe("Done");
  });

  it("ignores YAMLs with empty children[]", () => {
    writeOpen(
      repoRoot,
      makeIssue({ id: "ISS-1", type: "Feature", status: "ToDo", children: [] }),
    );
    const changes = recomputeParentStatuses(repoRoot, "ISS");
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
        waiting_on: {
          reason: "Waits on something external",
          timestamp: "2026-05-01T00:00:00Z",
          by: ["ISS-99"],
        },
      }),
    );
    writeOpen(repoRoot, child("ISS-2", "In Progress"));

    const changes = recomputeParentStatuses(repoRoot, "ISS");
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

    const changes = recomputeParentStatuses(repoRoot, "ISS");
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

    const changes = recomputeParentStatuses(repoRoot, "ISS");
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

    const changes = recomputeParentStatuses(repoRoot, "ISS");
    expect(changes).toHaveLength(1);
    expect(loadStatus("ISS-1")).toBe("Done");
  });

  it("propagates Blocked up an Epic chain on the same call", () => {
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
    writeOpen(repoRoot, child("ISS-3", "Blocked"));

    const changes = recomputeParentStatuses(repoRoot, "ISS");
    expect(changes).toHaveLength(1);
    expect(loadStatus("ISS-1")).toBe("Blocked");
  });

  // ----- DX-147 — history-append on auto-derive -----

  function loadIssue(id: string, state: "open" | "closed" = "open"): Issue {
    const path = resolve(repoRoot, ".danxbot", "issues", state, `${id}.yml`);
    return parseIssue(readFileSync(path, "utf-8"), { expectedPrefix: "ISS" });
  }

  it("DX-147: derive flip appends exactly one worker:auto-derive status_change entry with rule note", () => {
    // Parent is In Progress; all children flip to Done; derivation
    // resolves to Done (rule 5). The parent's history must record one
    // status_change entry attributed to `worker:auto-derive` with a
    // `note` string describing the rule that fired.
    writeOpen(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        type: "Epic",
        status: "In Progress",
        children: ["ISS-2", "ISS-3"],
        history: [],
      }),
    );
    writeOpen(repoRoot, child("ISS-2", "Done"));
    writeOpen(repoRoot, child("ISS-3", "Done"));

    const changes = recomputeParentStatuses(repoRoot, "ISS");
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
    // The `note` MUST describe the rule that fired (per AC #1) — not
    // an empty string and not a generic "auto-derive" placeholder.
    expect(entry.note).toBeTruthy();
    expect(entry.note!.length).toBeGreaterThan(5);
    expect(entry.note).toMatch(/Done/);
    // ISO-8601 timestamp surface check (the cap/format details are
    // exercised in `appendHistory`'s own tests; we just want to know
    // we passed something parseable through).
    expect(Number.isFinite(Date.parse(entry.timestamp))).toBe(true);
  });

  it("DX-147: no flip means zero history entries appended (idempotent steady state)", () => {
    // Parent already In Progress; derived status is also In Progress —
    // recomputeParentStatuses must skip the write AND leave the YAML's
    // history empty (no fake state-delta entries for janitorial passes).
    writeOpen(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        type: "Epic",
        status: "In Progress",
        children: ["ISS-2"],
        history: [],
      }),
    );
    writeOpen(repoRoot, child("ISS-2", "In Progress"));

    const changes = recomputeParentStatuses(repoRoot, "ISS");
    expect(changes).toEqual([]);

    const reloaded = loadIssue("ISS-1");
    expect(reloaded.history).toEqual([]);
  });

  it("DX-147: derive flip preserves any prior history entries — append, not replace", () => {
    // Parent carries a prior dispatch-driven status_change in history.
    // The auto-derive flip must APPEND to that history, not overwrite
    // it — confirms `appendHistory`'s pure-array semantics survive the
    // recomputeParentStatuses spread.
    const prior = {
      timestamp: "2026-05-01T00:00:00.000Z",
      actor: "dispatch:abc",
      event: "status_change" as const,
      from: "ToDo" as IssueStatus,
      to: "In Progress" as IssueStatus,
    };
    writeOpen(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        type: "Epic",
        status: "In Progress",
        children: ["ISS-2"],
        history: [prior],
      }),
    );
    writeOpen(repoRoot, child("ISS-2", "Done"));

    const changes = recomputeParentStatuses(repoRoot, "ISS");
    expect(changes).toHaveLength(1);

    const reloaded = loadIssue("ISS-1");
    expect(reloaded.history).toHaveLength(2);
    expect(reloaded.history[0]).toMatchObject(prior);
    expect(reloaded.history[1].actor).toBe("worker:auto-derive");
    expect(reloaded.history[1].event).toBe("status_change");
  });

  // Per-rule note accuracy — one assertion per priority rule. A
  // regression that hardcodes the same note for every rule (or that
  // misroutes the rule strings) would slip past the single Done-flip
  // test.

  it("DX-147: rule 1 — Blocked flip note describes the Blocked rule", () => {
    writeOpen(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        type: "Epic",
        status: "In Progress",
        children: ["ISS-2"],
      }),
    );
    writeOpen(repoRoot, child("ISS-2", "Blocked"));

    recomputeParentStatuses(repoRoot, "ISS");
    const note = loadIssue("ISS-1").history[0].note ?? "";
    expect(note).toMatch(/Blocked/);
  });

  it("DX-147: rule 2 — In Progress flip note describes the In Progress rule", () => {
    // Parent at ToDo, mixed children with one In Progress → rule 2
    // fires.
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

    recomputeParentStatuses(repoRoot, "ISS");
    const note = loadIssue("ISS-1").history[0].note ?? "";
    expect(note).toMatch(/In Progress/);
  });

  it("DX-147: rule 4 — Review flip note describes the Review rule", () => {
    writeOpen(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        type: "Epic",
        status: "ToDo",
        children: ["ISS-2", "ISS-3"],
      }),
    );
    writeOpen(repoRoot, child("ISS-2", "Review"));
    writeOpen(repoRoot, child("ISS-3", "Review"));

    recomputeParentStatuses(repoRoot, "ISS");
    const note = loadIssue("ISS-1").history[0].note ?? "";
    expect(note).toMatch(/Review/);
  });

  it("DX-147: rule 6 — Cancelled flip note describes the Cancelled rule (every child Cancelled)", () => {
    writeOpen(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        type: "Epic",
        status: "In Progress",
        children: ["ISS-2", "ISS-3"],
      }),
    );
    writeOpen(repoRoot, child("ISS-2", "Cancelled"));
    writeOpen(repoRoot, child("ISS-3", "Cancelled"));

    recomputeParentStatuses(repoRoot, "ISS");
    const note = loadIssue("ISS-1").history[0].note ?? "";
    expect(note).toMatch(/Cancelled/);
  });
});
