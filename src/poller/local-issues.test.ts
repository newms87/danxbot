import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serializeIssue } from "../issue-tracker/yaml.js";
import type { Issue, IssueBlocked } from "../issue-tracker/interface.js";
import {
  listBlockedTodoYamls,
  listDispatchableYamls,
  listInProgressYamls,
} from "./local-issues.js";

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
    triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
    ac: [{ check_item_id: "", title: "AC1", checked: false }],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    ...overrides,
  };
}

function writeAt(
  repoRoot: string,
  issue: Issue,
  mtimeSeconds: number,
): string {
  const dir = resolve(repoRoot, ".danxbot", "issues", "open");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${issue.id}.yml`);
  writeFileSync(path, serializeIssue(issue));
  utimesSync(path, mtimeSeconds, mtimeSeconds);
  return path;
}

describe("local-issues", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-local-issues-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  describe("listDispatchableYamls", () => {
    it("returns ToDo + blocked=null issues", () => {
      writeAt(repoRoot, makeIssue({ id: "ISS-1", external_id: "a" }), 1000);
      const result = listDispatchableYamls(repoRoot);
      expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
    });

    it("excludes status !== ToDo", () => {
      writeAt(
        repoRoot,
        makeIssue({ id: "ISS-1", external_id: "a", status: "In Progress" }),
        1000,
      );
      writeAt(
        repoRoot,
        makeIssue({ id: "ISS-2", external_id: "b", status: "Needs Help" }),
        1000,
      );
      writeAt(
        repoRoot,
        makeIssue({ id: "ISS-3", external_id: "c", status: "ToDo" }),
        1000,
      );
      const result = listDispatchableYamls(repoRoot);
      expect(result.map((i) => i.id)).toEqual(["ISS-3"]);
    });

    it("excludes blocked YAMLs", () => {
      const blocked: IssueBlocked = {
        reason: "Waits for ISS-2",
        timestamp: "2026-01-01T00:00:00Z",
        by: ["ISS-2"],
      };
      writeAt(
        repoRoot,
        makeIssue({ id: "ISS-1", external_id: "a", blocked }),
        1000,
      );
      writeAt(repoRoot, makeIssue({ id: "ISS-2", external_id: "b" }), 1000);
      const result = listDispatchableYamls(repoRoot);
      expect(result.map((i) => i.id)).toEqual(["ISS-2"]);
    });

    it("excludes YAMLs whose external_id is in excludeExternalIds", () => {
      writeAt(repoRoot, makeIssue({ id: "ISS-1", external_id: "ai" }), 1000);
      writeAt(repoRoot, makeIssue({ id: "ISS-2", external_id: "todo" }), 1000);
      const result = listDispatchableYamls(repoRoot, {
        excludeExternalIds: new Set(["ai"]),
      });
      expect(result.map((i) => i.id)).toEqual(["ISS-2"]);
    });

    it("keeps orphan YAMLs (external_id === '') even when exclude set is non-empty", () => {
      writeAt(repoRoot, makeIssue({ id: "ISS-1", external_id: "" }), 1000);
      const result = listDispatchableYamls(repoRoot, {
        excludeExternalIds: new Set(["ai"]),
      });
      expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
    });

    it("sorts by mtime ascending (oldest first), tiebreak by id ascending", () => {
      writeAt(repoRoot, makeIssue({ id: "ISS-3", external_id: "c" }), 3000);
      writeAt(repoRoot, makeIssue({ id: "ISS-1", external_id: "a" }), 1000);
      writeAt(repoRoot, makeIssue({ id: "ISS-2", external_id: "b" }), 2000);
      writeAt(repoRoot, makeIssue({ id: "ISS-10", external_id: "d" }), 1000);
      const result = listDispatchableYamls(repoRoot);
      expect(result.map((i) => i.id)).toEqual([
        "ISS-1",
        "ISS-10",
        "ISS-2",
        "ISS-3",
      ]);
    });

    it("returns [] when issues dir is missing", () => {
      expect(listDispatchableYamls(repoRoot)).toEqual([]);
    });

    it("ignores non-yml + non-ISS-N files", () => {
      const dir = resolve(repoRoot, ".danxbot", "issues", "open");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "README.md"), "x");
      writeFileSync(join(dir, "scratch.yml"), "");
      writeAt(repoRoot, makeIssue({ id: "ISS-1", external_id: "a" }), 1000);
      const result = listDispatchableYamls(repoRoot);
      expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
    });

    it("skips malformed YAML (logs error) and continues with remaining valid YAMLs", () => {
      const dir = resolve(repoRoot, ".danxbot", "issues", "open");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "ISS-9.yml"), "schema_version: !!! invalid yaml");
      writeAt(repoRoot, makeIssue({ id: "ISS-1", external_id: "a" }), 1000);
      const result = listDispatchableYamls(repoRoot);
      expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
    });

    it("ignores YAMLs in the closed/ dir even when status would otherwise match", () => {
      const closedDir = resolve(repoRoot, ".danxbot", "issues", "closed");
      mkdirSync(closedDir, { recursive: true });
      writeFileSync(
        join(closedDir, "ISS-9.yml"),
        serializeIssue(makeIssue({ id: "ISS-9", external_id: "z" })),
      );
      writeAt(repoRoot, makeIssue({ id: "ISS-1", external_id: "a" }), 1000);
      const result = listDispatchableYamls(repoRoot);
      expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
    });

    it("treats an empty excludeExternalIds Set the same as omitting the option", () => {
      writeAt(repoRoot, makeIssue({ id: "ISS-1", external_id: "a" }), 1000);
      const result = listDispatchableYamls(repoRoot, {
        excludeExternalIds: new Set(),
      });
      expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
    });
  });

  describe("listBlockedTodoYamls", () => {
    const blocked: IssueBlocked = {
      reason: "Waits for ISS-2",
      timestamp: "2026-01-01T00:00:00Z",
      by: ["ISS-2"],
    };

    it("returns ToDo issues with non-null blocked, sorted FIFO", () => {
      writeAt(
        repoRoot,
        makeIssue({ id: "ISS-1", external_id: "a", blocked }),
        2000,
      );
      writeAt(
        repoRoot,
        makeIssue({ id: "ISS-2", external_id: "b", blocked }),
        1000,
      );
      const result = listBlockedTodoYamls(repoRoot);
      expect(result.map((i) => i.id)).toEqual(["ISS-2", "ISS-1"]);
    });

    it("excludes ToDo issues whose blocked is null", () => {
      writeAt(repoRoot, makeIssue({ id: "ISS-1", external_id: "a" }), 1000);
      expect(listBlockedTodoYamls(repoRoot)).toEqual([]);
    });

    it("excludes In Progress issues even with non-null blocked", () => {
      writeAt(
        repoRoot,
        makeIssue({
          id: "ISS-1",
          external_id: "a",
          status: "In Progress",
          blocked,
        }),
        1000,
      );
      expect(listBlockedTodoYamls(repoRoot)).toEqual([]);
    });
  });

  describe("listInProgressYamls", () => {
    it("returns only In Progress issues", () => {
      writeAt(
        repoRoot,
        makeIssue({ id: "ISS-1", external_id: "a", status: "ToDo" }),
        1000,
      );
      writeAt(
        repoRoot,
        makeIssue({
          id: "ISS-2",
          external_id: "b",
          status: "In Progress",
          dispatch: { id: "uuid-1", pid: 0, host: "", kind: "work", started_at: "", ttl_seconds: 0 },
        }),
        2000,
      );
      writeAt(
        repoRoot,
        makeIssue({
          id: "ISS-3",
          external_id: "c",
          status: "In Progress",
          dispatch: { id: "uuid-2", pid: 0, host: "", kind: "work", started_at: "", ttl_seconds: 0 },
        }),
        1500,
      );
      const result = listInProgressYamls(repoRoot);
      expect(result.map((i) => i.id)).toEqual(["ISS-3", "ISS-2"]);
    });
  });
});
