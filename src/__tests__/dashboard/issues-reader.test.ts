import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listIssues,
  readIssueDetail,
  __resetWarnedPathsForTests,
} from "../../dashboard/issues-reader.js";
import { serializeIssue } from "../../issue-tracker/yaml.js";
import type { Issue } from "../../issue-tracker/interface.js";

function emptyIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    schema_version: 3,
    tracker: "memory",
    id: overrides.id ?? "ISS-1",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch_id: null,
    status: "ToDo",
    type: "Feature",
    title: "Title",
    description: "",
    triaged: { timestamp: "", status: "", explain: "" },
    ac: [],
    phases: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    ...overrides,
  };
}

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "issues-reader-"));
  mkdirSync(join(repo, ".danxbot/issues/open"), { recursive: true });
  mkdirSync(join(repo, ".danxbot/issues/closed"), { recursive: true });
  return repo;
}

function writeIssue(
  repo: string,
  sub: "open" | "closed",
  issue: Issue,
  mtimeMs: number,
): string {
  const path = join(repo, ".danxbot/issues", sub, `${issue.id}.yml`);
  writeFileSync(path, serializeIssue(issue), "utf-8");
  const t = new Date(mtimeMs);
  utimesSync(path, t, t);
  return path;
}

beforeEach(() => {
  __resetWarnedPathsForTests();
});

describe("listIssues", () => {
  it("returns IssueListItem[] with every list-card field populated correctly", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        title: "Epic title",
        status: "In Progress",
        children: ["ISS-2", "ISS-3"],
        ac: [
          { check_item_id: "a", title: "ac1", checked: true },
          { check_item_id: "b", title: "ac2", checked: false },
        ],
        phases: [
          { check_item_id: "p1", title: "p1", status: "Complete", notes: "" },
          { check_item_id: "p2", title: "p2", status: "Pending", notes: "" },
          { check_item_id: "p3", title: "p3", status: "Blocked", notes: "" },
        ],
        comments: [
          { author: "x", timestamp: "t1", text: "hi" },
          { author: "y", timestamp: "t2", text: "yo" },
        ],
        blocked: {
          reason: "waiting",
          timestamp: "2026-01-01T00:00:00Z",
          by: ["ISS-2"],
        },
        retro: {
          good: "ok",
          bad: "",
          action_item_ids: [],
          commits: [],
        },
      }),
      1_700_000_000_000,
    );

    const items = await listIssues(repo);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: "ISS-1",
      type: "Epic",
      title: "Epic title",
      status: "In Progress",
      parent_id: null,
      children: ["ISS-2", "ISS-3"],
      ac_total: 2,
      ac_done: 1,
      phases_total: 3,
      phases_done: 1,
      blocked: true,
      comments_count: 2,
      has_retro: true,
      updated_at: 1_700_000_000_000,
    });
  });

  it("sorts by updated_at descending across open + closed", async () => {
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1" }), 1_000);
    writeIssue(repo, "open", emptyIssue({ id: "ISS-2" }), 3_000);
    writeIssue(
      repo,
      "closed",
      emptyIssue({ id: "ISS-3", status: "Done" }),
      2_000,
    );

    const items = await listIssues(repo);
    expect(items.map((i) => i.id)).toEqual(["ISS-2", "ISS-3", "ISS-1"]);
  });

  it("caps closed issues at 50 by default (recent)", async () => {
    const repo = setupRepo();
    for (let i = 1; i <= 60; i++) {
      writeIssue(
        repo,
        "closed",
        emptyIssue({ id: `ISS-${i}`, status: "Done" }),
        1_000_000 + i, // newer ids → newer mtime
      );
    }
    const items = await listIssues(repo);
    expect(items).toHaveLength(50);
    // Newest 50: ISS-11..ISS-60
    expect(items[0].id).toBe("ISS-60");
    expect(items[49].id).toBe("ISS-11");
  });

  it("returns every closed issue when include_closed=all", async () => {
    const repo = setupRepo();
    for (let i = 1; i <= 60; i++) {
      writeIssue(
        repo,
        "closed",
        emptyIssue({ id: `ISS-${i}`, status: "Done" }),
        1_000_000 + i,
      );
    }
    const items = await listIssues(repo, { includeClosed: "all" });
    expect(items).toHaveLength(60);
  });

  it("skips malformed YAML without throwing", async () => {
    const repo = setupRepo();
    writeFileSync(
      join(repo, ".danxbot/issues/open/ISS-99.yml"),
      "not: : valid: yaml: at: all: }",
      "utf-8",
    );
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1" }), 1_000);

    const items = await listIssues(repo);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("ISS-1");
  });

  it("ignores non-.yml files (e.g. .migrated-to-v3 marker)", async () => {
    const repo = setupRepo();
    writeFileSync(
      join(repo, ".danxbot/issues/open/.migrated-to-v3"),
      "marker",
      "utf-8",
    );
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1" }), 1_000);

    const items = await listIssues(repo);
    expect(items.map((i) => i.id)).toEqual(["ISS-1"]);
  });

  it("returns [] when neither open/ nor closed/ exists", async () => {
    const repo = mkdtempSync(join(tmpdir(), "issues-reader-empty-"));
    const items = await listIssues(repo);
    expect(items).toEqual([]);
  });

  it("preserves parent_id and children round-trip", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-2",
        parent_id: "ISS-1",
        children: [],
      }),
      1_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        children: ["ISS-2"],
      }),
      2_000,
    );

    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    const phase = items.find((i) => i.id === "ISS-2")!;
    expect(epic.children).toEqual(["ISS-2"]);
    expect(epic.parent_id).toBeNull();
    expect(phase.parent_id).toBe("ISS-1");
    expect(phase.children).toEqual([]);
  });

  it("has_retro is false when every retro field is empty", async () => {
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1" }), 1_000);
    const items = await listIssues(repo);
    expect(items[0].has_retro).toBe(false);
  });

  it.each([
    ["good", { good: "x", bad: "", action_item_ids: [], commits: [] }],
    ["bad", { good: "", bad: "y", action_item_ids: [], commits: [] }],
    [
      "action_item_ids",
      { good: "", bad: "", action_item_ids: ["ISS-9"], commits: [] },
    ],
    ["commits", { good: "", bad: "", action_item_ids: [], commits: ["abc"] }],
  ])(
    "has_retro is true when retro.%s is non-empty",
    async (_label, retro) => {
      const repo = setupRepo();
      writeIssue(repo, "open", emptyIssue({ id: "ISS-1", retro }), 1_000);
      const items = await listIssues(repo);
      expect(items[0].has_retro).toBe(true);
    },
  );

  it("warns exactly once per malformed YAML across multiple list calls", async () => {
    const repo = setupRepo();
    const malformed = join(repo, ".danxbot/issues/open/ISS-99.yml");
    writeFileSync(malformed, "not: : valid: yaml", "utf-8");
    // Logger writes warn via console.error.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await listIssues(repo);
      await listIssues(repo);
      const warnsForThisFile = errSpy.mock.calls.filter((args) =>
        args.some((a) => typeof a === "string" && a.includes(malformed)),
      );
      expect(warnsForThisFile).toHaveLength(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("readIssueDetail", () => {
  it("returns the full Issue with mtime injected", async () => {
    const repo = setupRepo();
    const issue = emptyIssue({
      id: "ISS-1",
      description: "body",
      ac: [{ check_item_id: "a", title: "ac1", checked: false }],
      comments: [{ author: "x", timestamp: "t", text: "hi" }],
    });
    writeIssue(repo, "open", issue, 1_700_000_000_000);

    const detail = await readIssueDetail(repo, "ISS-1");
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe("ISS-1");
    expect(detail!.description).toBe("body");
    expect(detail!.ac).toHaveLength(1);
    expect(detail!.comments).toHaveLength(1);
    expect(detail!.updated_at).toBe(1_700_000_000_000);
  });

  it("prefers open/<id>.yml over closed/<id>.yml when both exist", async () => {
    // Edge case: a card briefly exists in both subdirs during a status
    // transition. The reader must return the open/ copy (current state),
    // not the closed/ copy (stale snapshot).
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-5", status: "In Progress", title: "open-copy" }),
      2_000,
    );
    writeIssue(
      repo,
      "closed",
      emptyIssue({ id: "ISS-5", status: "Done", title: "closed-copy" }),
      9_999, // newer mtime — must NOT be preferred
    );
    const detail = await readIssueDetail(repo, "ISS-5");
    expect(detail!.title).toBe("open-copy");
    expect(detail!.status).toBe("In Progress");
  });

  it("looks in closed/ when not found in open/", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "closed",
      emptyIssue({ id: "ISS-7", status: "Done" }),
      5_000,
    );
    const detail = await readIssueDetail(repo, "ISS-7");
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe("ISS-7");
    expect(detail!.status).toBe("Done");
  });

  it("returns null when the id is unknown", async () => {
    const repo = setupRepo();
    const detail = await readIssueDetail(repo, "ISS-404");
    expect(detail).toBeNull();
  });

  it("returns null for a malformed YAML without throwing", async () => {
    const repo = setupRepo();
    writeFileSync(
      join(repo, ".danxbot/issues/open/ISS-99.yml"),
      "not: : valid: yaml",
      "utf-8",
    );
    const detail = await readIssueDetail(repo, "ISS-99");
    expect(detail).toBeNull();
  });
});
