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
import type { Issue, WaitingOn } from "../issue-tracker/interface.js";
import {
  listBlockedTodoYamls,
  listDispatchableYamls,
  listInProgressYamls,
  listTriageDueYamls,
} from "./local-issues.js";

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
    triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
    ac: [{ check_item_id: "", title: "AC1", checked: false }],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    waiting_on: null,
    history: [],
    ...overrides,
  };
  // Auto-populate the self-block record when caller sets status="Blocked"
  // without an explicit `blocked` override. Keeps the v4 invariant
  // `status === "Blocked" ⟺ blocked !== null` without forcing every test
  // call site to repeat the {reason, timestamp} shape.
  if (merged.status === "Blocked" && merged.blocked === null) {
    merged.blocked = {
      reason: "test self-block",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
  }
  return merged;
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
        makeIssue({ id: "ISS-2", external_id: "b", status: "Blocked" }),
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
      const waiting_on: WaitingOn = {
        reason: "Waits for ISS-2",
        timestamp: "2026-01-01T00:00:00Z",
        by: ["ISS-2"],
      };
      writeAt(
        repoRoot,
        makeIssue({ id: "ISS-1", external_id: "a", waiting_on }),
        1000,
      );
      writeAt(repoRoot, makeIssue({ id: "ISS-2", external_id: "b" }), 1000);
      const result = listDispatchableYamls(repoRoot);
      expect(result.map((i) => i.id)).toEqual(["ISS-2"]);
    });

    it("excludes YAMLs that already carry a non-null dispatch (occupied)", () => {
      writeAt(
        repoRoot,
        makeIssue({
          id: "ISS-1",
          external_id: "a",
          dispatch: {
            id: "uuid-1",
            pid: 1,
            host: "h",
            kind: "work",
            started_at: "2026-01-01T00:00:00Z",
            ttl_seconds: 7200,
          },
        }),
        1000,
      );
      writeAt(repoRoot, makeIssue({ id: "ISS-2", external_id: "b" }), 1000);
      const result = listDispatchableYamls(repoRoot);
      expect(result.map((i) => i.id)).toEqual(["ISS-2"]);
    });

    it("excludes Epic-typed YAMLs (phase children dispatched directly)", () => {
      writeAt(
        repoRoot,
        makeIssue({ id: "ISS-1", external_id: "a", type: "Epic" }),
        1000,
      );
      writeAt(
        repoRoot,
        makeIssue({ id: "ISS-2", external_id: "b", type: "Feature" }),
        1000,
      );
      const result = listDispatchableYamls(repoRoot);
      expect(result.map((i) => i.id)).toEqual(["ISS-2"]);
    });

    it("sorts untriaged cards (triage.expires_at empty) before triaged cards regardless of mtime", () => {
      // Triaged with high ICE (mtime 1000) — would win FIFO
      writeAt(
        repoRoot,
        makeIssue({
          id: "ISS-1",
          external_id: "a",
          triage: {
            expires_at: "2026-09-01T00:00:00Z",
            reassess_hint: "",
            last_status: "Keep",
            last_explain: "",
            ice: { total: 100, i: 5, c: 5, e: 4 },
            history: [],
          },
        }),
        1000,
      );
      // Untriaged (mtime 5000) — should still win because untriaged has no
      // priority signal yet and the operator wants it flushed first.
      writeAt(repoRoot, makeIssue({ id: "ISS-2", external_id: "b" }), 5000);
      const result = listDispatchableYamls(repoRoot);
      expect(result.map((i) => i.id)).toEqual(["ISS-2", "ISS-1"]);
    });

    it("among triaged cards, sorts by triage.ice.total DESC", () => {
      writeAt(
        repoRoot,
        makeIssue({
          id: "ISS-1",
          external_id: "a",
          triage: {
            expires_at: "2026-09-01T00:00:00Z",
            reassess_hint: "",
            last_status: "Keep",
            last_explain: "",
            ice: { total: 20, i: 5, c: 2, e: 2 },
            history: [],
          },
        }),
        1000,
      );
      writeAt(
        repoRoot,
        makeIssue({
          id: "ISS-2",
          external_id: "b",
          triage: {
            expires_at: "2026-09-01T00:00:00Z",
            reassess_hint: "",
            last_status: "Keep",
            last_explain: "",
            ice: { total: 100, i: 5, c: 5, e: 4 },
            history: [],
          },
        }),
        2000,
      );
      writeAt(
        repoRoot,
        makeIssue({
          id: "ISS-3",
          external_id: "c",
          triage: {
            expires_at: "2026-09-01T00:00:00Z",
            reassess_hint: "",
            last_status: "Keep",
            last_explain: "",
            ice: { total: 60, i: 4, c: 3, e: 5 },
            history: [],
          },
        }),
        3000,
      );
      const result = listDispatchableYamls(repoRoot);
      expect(result.map((i) => i.id)).toEqual(["ISS-2", "ISS-3", "ISS-1"]);
    });

    it("falls back to FIFO mtime within the same priority tier (untriaged)", () => {
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

  });

  describe("listBlockedTodoYamls", () => {
    const waiting_on: WaitingOn = {
      reason: "Waits for ISS-2",
      timestamp: "2026-01-01T00:00:00Z",
      by: ["ISS-2"],
    };

    it("returns ToDo issues with non-null blocked, sorted FIFO", () => {
      writeAt(
        repoRoot,
        makeIssue({ id: "ISS-1", external_id: "a", waiting_on }),
        2000,
      );
      writeAt(
        repoRoot,
        makeIssue({ id: "ISS-2", external_id: "b", waiting_on }),
        1000,
      );
      const result = listBlockedTodoYamls(repoRoot);
      expect(result.map((i) => i.id)).toEqual(["ISS-2", "ISS-1"]);
    });

    it("excludes ToDo issues whose blocked is null", () => {
      writeAt(repoRoot, makeIssue({ id: "ISS-1", external_id: "a" }), 1000);
      expect(listBlockedTodoYamls(repoRoot)).toEqual([]);
    });

    it("excludes In Progress issues even with non-null waiting_on", () => {
      writeAt(
        repoRoot,
        makeIssue({
          id: "ISS-1",
          external_id: "a",
          status: "In Progress",
          waiting_on,
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

  describe("listTriageDueYamls", () => {
    const NOW = Date.parse("2026-05-07T12:00:00Z");

    function withTriage(overrides: Partial<Issue>, expiresAt: string): Issue {
      return makeIssue({
        ...overrides,
        triage: {
          expires_at: expiresAt,
          reassess_hint: "",
          last_status: expiresAt === "" ? "" : "Confirm-Block",
          last_explain: "",
          ice: { total: 0, i: 0, c: 0, e: 0 },
          history: [],
        },
      });
    }

    it("returns Review cards whose triage is due (expires_at empty or <= now)", () => {
      writeAt(
        repoRoot,
        withTriage(
          { id: "ISS-1", external_id: "a", status: "Review" },
          "2026-04-01T00:00:00Z", // past — due
        ),
        1000,
      );
      writeAt(
        repoRoot,
        withTriage(
          { id: "ISS-2", external_id: "b", status: "Review" },
          "2026-09-01T00:00:00Z", // future — not due
        ),
        2000,
      );
      const result = listTriageDueYamls(repoRoot, NOW);
      expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
    });

    it("returns Blocked cards whose triage is due", () => {
      writeAt(
        repoRoot,
        withTriage(
          { id: "ISS-1", external_id: "a", status: "Blocked" },
          "",
        ),
        1000,
      );
      const result = listTriageDueYamls(repoRoot, NOW);
      expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
    });

    it("returns Blocked cards (waiting_on != null) regardless of status", () => {
      const waiting_on: WaitingOn = {
        reason: "Waits for ISS-99",
        timestamp: "2026-04-01T00:00:00Z",
        by: ["ISS-99"],
      };
      writeAt(
        repoRoot,
        withTriage(
          { id: "ISS-1", external_id: "a", status: "ToDo", waiting_on },
          "",
        ),
        1000,
      );
      const result = listTriageDueYamls(repoRoot, NOW);
      expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
    });

    it("excludes ToDo cards (blocked == null) — they go through the work path", () => {
      writeAt(
        repoRoot,
        withTriage({ id: "ISS-1", external_id: "a", status: "ToDo" }, ""),
        1000,
      );
      const result = listTriageDueYamls(repoRoot, NOW);
      expect(result).toEqual([]);
    });

    it("excludes In Progress / Done / Cancelled / Needs Approval cards", () => {
      for (const status of [
        "In Progress",
        "Done",
        "Cancelled",
        "Needs Approval",
      ] as const) {
        const dir = resolve(repoRoot, ".danxbot", "issues", "open");
        rmSync(dir, { recursive: true, force: true });
        writeAt(
          repoRoot,
          withTriage(
            { id: "ISS-1", external_id: "a", status },
            "",
          ),
          1000,
        );
        expect(listTriageDueYamls(repoRoot, NOW)).toEqual([]);
      }
    });

    it("excludes cards with an active dispatch (dispatch != null)", () => {
      writeAt(
        repoRoot,
        makeIssue({
          id: "ISS-1",
          external_id: "a",
          status: "Review",
          dispatch: {
            id: "uuid-1",
            pid: 1,
            host: "h",
            kind: "triage",
            started_at: "2026-05-07T11:55:00Z",
            ttl_seconds: 600,
          },
        }),
        1000,
      );
      expect(listTriageDueYamls(repoRoot, NOW)).toEqual([]);
    });

    it("sorts never-triaged (expires_at === '') before stale-triaged", () => {
      writeAt(
        repoRoot,
        withTriage(
          { id: "ISS-1", external_id: "a", status: "Review" },
          "2026-04-01T00:00:00Z",
        ),
        1000,
      );
      writeAt(
        repoRoot,
        withTriage(
          { id: "ISS-2", external_id: "b", status: "Review" },
          "",
        ),
        5000,
      );
      const result = listTriageDueYamls(repoRoot, NOW);
      expect(result.map((i) => i.id)).toEqual(["ISS-2", "ISS-1"]);
    });

    it("sorts stale-triaged by expires_at ASC (oldest stale first)", () => {
      writeAt(
        repoRoot,
        withTriage(
          { id: "ISS-1", external_id: "a", status: "Review" },
          "2026-03-01T00:00:00Z",
        ),
        3000,
      );
      writeAt(
        repoRoot,
        withTriage(
          { id: "ISS-2", external_id: "b", status: "Review" },
          "2026-01-01T00:00:00Z",
        ),
        2000,
      );
      writeAt(
        repoRoot,
        withTriage(
          { id: "ISS-3", external_id: "c", status: "Review" },
          "2026-04-01T00:00:00Z",
        ),
        1000,
      );
      const result = listTriageDueYamls(repoRoot, NOW);
      expect(result.map((i) => i.id)).toEqual(["ISS-2", "ISS-1", "ISS-3"]);
    });

    it("FIFO mtime tiebreak when expires_at matches exactly", () => {
      writeAt(
        repoRoot,
        withTriage(
          { id: "ISS-2", external_id: "b", status: "Review" },
          "2026-04-01T00:00:00Z",
        ),
        2000,
      );
      writeAt(
        repoRoot,
        withTriage(
          { id: "ISS-1", external_id: "a", status: "Review" },
          "2026-04-01T00:00:00Z",
        ),
        1000,
      );
      const result = listTriageDueYamls(repoRoot, NOW);
      expect(result.map((i) => i.id)).toEqual(["ISS-1", "ISS-2"]);
    });

    it("treats a malformed expires_at (non-parseable) as due (fail-open — re-triage will fix the field)", () => {
      writeAt(
        repoRoot,
        withTriage(
          { id: "ISS-1", external_id: "a", status: "Review" },
          "not-a-real-date",
        ),
        1000,
      );
      const result = listTriageDueYamls(repoRoot, NOW);
      expect(result.map((i) => i.id)).toEqual(["ISS-1"]);
    });
  });
});
