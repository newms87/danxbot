import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
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
  const merged: Issue = {
    schema_version: 4,
    tracker: "memory",
    id: overrides.id ?? "ISS-1",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: "Title",
    description: "",
    triage: { expires_at: "", reassess_hint: "", last_status: "", last_explain: "", ice: { total: 0, i: 0, c: 0, e: 0 }, history: [] },
    ac: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: overrides.blocked ?? null,
    waiting_on: overrides.waiting_on ?? null,
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
        description: "Epic body markdown",
        status: "In Progress",
        children: ["ISS-2", "ISS-3"],
        ac: [
          { check_item_id: "a", title: "ac1", checked: true },
          { check_item_id: "b", title: "ac2", checked: false },
        ],
        comments: [
          { author: "x", timestamp: "t1", text: "hi" },
          { author: "y", timestamp: "t2", text: "yo" },
        ],
        waiting_on: {
          reason: "waiting",
          timestamp: "2026-01-01T00:00:00Z",
          by: ["ISS-2"],
        },
        blocked: null,
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
      description: "Epic body markdown",
      // Literal passthrough. No projection. The YAML's status +
      // waiting_on are wired verbatim — board column + Blocked-by pill
      // both follow the tracker exactly.
      status: "In Progress",
      parent_id: null,
      children: ["ISS-2", "ISS-3"],
      ac_total: 2,
      ac_done: 1,
      children_detail: [
        { id: "ISS-2", name: "<ISS-2: unknown>", type: "Feature", status: "ToDo", waiting_on: true, waiting_on_by_card: false, missing: true },
        { id: "ISS-3", name: "<ISS-3: unknown>", type: "Feature", status: "ToDo", waiting_on: true, waiting_on_by_card: false, missing: true },
      ],
      waiting_on: true,
      waiting_on_reason: "waiting",
      waiting_on_by: ["ISS-2"],
      comments_count: 2,
      has_retro: true,
      updated_at: 1_700_000_000_000,
    });
  });

  it("has empty children_detail for non-epic cards with no children", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-2",
        type: "Feature",
      }),
      1_000,
    );
    const items = await listIssues(repo);
    expect(items[0].children_detail).toEqual([]);
  });

  it("emits empty children_detail for epics with no children", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-1", type: "Epic" }),
      1_000,
    );
    const items = await listIssues(repo);
    expect(items[0].children_detail).toEqual([]);
  });

  it("children_detail carries child's raw Done status + blocked=false and uses child.title as name", async () => {
    const repo = setupRepo();
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
    writeIssue(
      repo,
      "closed",
      emptyIssue({
        id: "ISS-2",
        title: "Phase one shipped",
        status: "Done",
      }),
      1_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail).toEqual([
      { id: "ISS-2", name: "Phase one shipped", type: "Feature", status: "Done", waiting_on: false, waiting_on_by_card: false, missing: false },
    ]);
  });

  it("children_detail carries Cancelled raw (no projection in backend)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-1", type: "Epic", children: ["ISS-2"] }),
      2_000,
    );
    writeIssue(
      repo,
      "closed",
      emptyIssue({ id: "ISS-2", title: "phase 2", status: "Cancelled" }),
      1_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail[0].status).toBe("Cancelled");
    expect(epic.children_detail[0].waiting_on).toBe(false);
  });

  it("children_detail carries blocked=true when child has a blocked record (status untouched)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-1", type: "Epic", children: ["ISS-2"] }),
      2_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-2",
        title: "blocked phase",
        status: "ToDo",
        waiting_on: {
          reason: "waiting",
          timestamp: "2026-01-01T00:00:00Z",
          by: ["ISS-3"],
        },
        blocked: null,
      }),
      1_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail[0].status).toBe("ToDo");
    expect(epic.children_detail[0].waiting_on).toBe(true);
  });

  it("children_detail carries Blocked raw + blocked=false", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-1", type: "Epic", children: ["ISS-2"] }),
      2_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-2", title: "help me", status: "Blocked" }),
      1_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail[0].status).toBe("Blocked");
    expect(epic.children_detail[0].waiting_on).toBe(false);
  });

  // No projection — epic's status + waiting_on come from its own YAML
  // verbatim. Children's waiting state is rendered through the
  // children_detail[] glyph badges, not folded onto the epic. Tests
  // below assert literal passthrough.
  it("epic with no own waiting_on is NOT waiting regardless of child state (literal)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        status: "In Progress",
        children: ["ISS-2", "ISS-3"],
      }),
      3_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-2", status: "In Progress" }),
      2_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-3",
        status: "ToDo",
        waiting_on: {
          reason: "wait for ISS-2",
          timestamp: "2026-01-01T00:00:00Z",
          by: ["ISS-2"],
        },
        blocked: null,
      }),
      1_000,
    );
    const epic = (await listIssues(repo)).find((i) => i.id === "ISS-1")!;
    expect(epic.waiting_on).toBe(false);
    expect(epic.status).toBe("In Progress");
    expect(epic.waiting_on_by).toEqual([]);
  });

  it("epic status untouched by child waiting on external work (literal)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        status: "In Progress",
        children: ["ISS-2"],
      }),
      3_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-2",
        status: "ToDo",
        waiting_on: {
          reason: "waits cross-epic",
          timestamp: "2026-01-01T00:00:00Z",
          by: ["ISS-99"],
        },
        blocked: null,
      }),
      2_000,
    );
    const epic = (await listIssues(repo)).find((i) => i.id === "ISS-1")!;
    expect(epic.status).toBe("In Progress");
    expect(epic.waiting_on).toBe(false);
    expect(epic.waiting_on_by).toEqual([]);
    // Child's waiting state surfaces via children_detail, not the epic.
    expect(epic.children_detail[0].waiting_on).toBe(true);
  });

  it("epic status untouched by child status === Blocked (literal)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        status: "In Progress",
        children: ["ISS-2"],
      }),
      2_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-2", status: "Blocked" }),
      1_000,
    );
    const epic = (await listIssues(repo)).find((i) => i.id === "ISS-1")!;
    expect(epic.status).toBe("In Progress");
    expect(epic.waiting_on).toBe(false);
    expect(epic.children_detail[0].status).toBe("Blocked");
  });

  it("epic with non-null waiting_on surfaces literally on the wire", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        status: "ToDo",
        children: ["ISS-2"],
        waiting_on: {
          reason: "hard dep on external epic",
          timestamp: "2026-01-01T00:00:00Z",
          by: ["ISS-99"],
        },
      }),
      2_000,
    );
    writeIssue(repo, "open", emptyIssue({ id: "ISS-2" }), 1_000);
    const epic = (await listIssues(repo)).find((i) => i.id === "ISS-1")!;
    expect(epic.status).toBe("ToDo");
    expect(epic.waiting_on).toBe(true);
    expect(epic.waiting_on_reason).toBe("hard dep on external epic");
    expect(epic.waiting_on_by).toEqual(["ISS-99"]);
  });

  it("epic NOT waiting by missing children alone (literal)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        status: "In Progress",
        children: ["ISS-99", "ISS-100"],
      }),
      1_000,
    );
    const epic = (await listIssues(repo)).find((i) => i.id === "ISS-1")!;
    expect(epic.waiting_on).toBe(false);
    expect(epic.status).toBe("In Progress");
  });

  it("children_detail carries Needs Approval raw + blocked=false", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-1", type: "Epic", children: ["ISS-2"] }),
      2_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-2",
        title: "approve me",
        status: "Needs Approval",
      }),
      1_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail[0].status).toBe("Needs Approval");
    expect(epic.children_detail[0].waiting_on).toBe(false);
  });

  it("children_detail carries the child's raw type (Bug/Feature/Epic flows through)", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-1",
        type: "Epic",
        children: ["ISS-2", "ISS-3"],
      }),
      3_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-2", type: "Bug", title: "bug child" }),
      2_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-3", type: "Feature", title: "feat child" }),
      1_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail.map((c) => c.type)).toEqual(["Bug", "Feature"]);
  });

  it("missing children get missing=true + blocked=true so the SPA renders them as a distinct ⛔ row", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-1", type: "Epic", children: ["ISS-99"] }),
      2_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail[0]).toEqual({
      id: "ISS-99",
      name: "<ISS-99: unknown>",
      type: "Feature",
      status: "ToDo",
      waiting_on: true,
      waiting_on_by_card: false,
      missing: true,
    });
  });

  it("children_detail carries In Progress raw + blocked=false", async () => {
    const repo = setupRepo();
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-1", type: "Epic", children: ["ISS-2"] }),
      2_000,
    );
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-2",
        title: "active",
        status: "In Progress",
      }),
      1_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail[0].status).toBe("In Progress");
    expect(epic.children_detail[0].waiting_on).toBe(false);
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

  // Regression — operator opens an Epic's Phases tab and sees
  // "N children not in current view" because some Done phase children
  // fall past the recent-50 closed cap. Fix: closed cards referenced
  // by an open card's children[] / parent_id / blocked.by[] are pulled
  // into the slice on top of the recent-50.
  it("pulls closed cards referenced by an open card's children[] beyond the 50-cap", async () => {
    const repo = setupRepo();
    // 60 unrelated closed cards — fill the cap.
    for (let i = 1; i <= 60; i++) {
      writeIssue(
        repo,
        "closed",
        emptyIssue({ id: `ISS-${i}`, status: "Done" }),
        1_000_000 + i,
      );
    }
    // Three OLD closed phase children (older than every above).
    writeIssue(repo, "closed", emptyIssue({ id: "ISS-200", status: "Done" }), 500);
    writeIssue(repo, "closed", emptyIssue({ id: "ISS-201", status: "Done" }), 600);
    writeIssue(repo, "closed", emptyIssue({ id: "ISS-202", status: "Done" }), 700);
    // Open epic referencing them.
    writeIssue(
      repo,
      "open",
      emptyIssue({
        id: "ISS-300",
        type: "Epic",
        children: ["ISS-200", "ISS-201", "ISS-202"],
      }),
      2_000_000,
    );
    const items = await listIssues(repo);
    const ids = new Set(items.map((i) => i.id));
    // Recent-50 still applies AS A FLOOR (50 newest closed + 1 open).
    expect(items.length).toBe(50 + 1 + 3);
    // All three referenced closed cards present.
    expect(ids.has("ISS-200")).toBe(true);
    expect(ids.has("ISS-201")).toBe(true);
    expect(ids.has("ISS-202")).toBe(true);
    // Epic's children_detail shows zero missing.
    const epic = items.find((i) => i.id === "ISS-300")!;
    expect(epic.children_detail.every((c) => !c.missing)).toBe(true);
  });

  it("pulls closed cards referenced by parent_id beyond the 50-cap", async () => {
    const repo = setupRepo();
    for (let i = 1; i <= 60; i++) {
      writeIssue(
        repo,
        "closed",
        emptyIssue({ id: `ISS-${i}`, status: "Done" }),
        1_000_000 + i,
      );
    }
    // Old closed parent.
    writeIssue(
      repo,
      "closed",
      emptyIssue({ id: "ISS-200", type: "Epic", status: "Done" }),
      500,
    );
    // Open child referencing it.
    writeIssue(
      repo,
      "open",
      emptyIssue({ id: "ISS-300", parent_id: "ISS-200" }),
      2_000_000,
    );
    const ids = new Set((await listIssues(repo)).map((i) => i.id));
    expect(ids.has("ISS-200")).toBe(true);
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

  it("throws on malformed YAML — fail loud, no silent skip", async () => {
    const repo = setupRepo();
    writeFileSync(
      join(repo, ".danxbot/issues/open/ISS-99.yml"),
      "not: : valid: yaml: at: all: }",
      "utf-8",
    );
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1" }), 1_000);

    await expect(listIssues(repo)).rejects.toThrow();
  });

  it("throws on rogue filename in the issues dir — fail loud", async () => {
    const repo = setupRepo();
    writeFileSync(
      join(repo, ".danxbot/issues/open/garbage.yml"),
      "schema_version: 3\n",
      "utf-8",
    );
    await expect(listIssues(repo)).rejects.toThrow(/rogue filename/);
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
    const path = writeIssue(
      repo,
      "closed",
      emptyIssue({ id: "ISS-7", status: "Done" }),
      5_000,
    );
    const onDisk = readFileSync(path, "utf-8");
    const detail = await readIssueDetail(repo, "ISS-7");
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe("ISS-7");
    expect(detail!.status).toBe("Done");
    expect(detail!.raw_yaml).toBe(onDisk);
  });

  it("returns null when the id is unknown", async () => {
    const repo = setupRepo();
    const detail = await readIssueDetail(repo, "ISS-404");
    expect(detail).toBeNull();
  });

  it("includes raw_yaml field with the verbatim file text", async () => {
    const repo = setupRepo();
    const issue = emptyIssue({ id: "ISS-2", description: "hello" });
    const path = writeIssue(repo, "open", issue, 3_000);
    const onDisk = readFileSync(path, "utf-8");

    const detail = await readIssueDetail(repo, "ISS-2");
    expect(detail).not.toBeNull();
    expect(detail!.raw_yaml).toBe(onDisk);
  });

  it("throws on malformed YAML — fail loud, no silent null", async () => {
    const repo = setupRepo();
    writeFileSync(
      join(repo, ".danxbot/issues/open/ISS-99.yml"),
      "not: : valid: yaml",
      "utf-8",
    );
    await expect(readIssueDetail(repo, "ISS-99")).rejects.toThrow();
  });
});

// ---------- Prefix-agnostic reader ----------
//
// The dashboard reader derives `expectedPrefix` per file from each
// YAML's filename stem (`<2-4 caps>-<digits>.yml`). It does NOT read
// `<repoCwd>/.danxbot/config/config.yml#issue_prefix` — a single
// repo-wide cached prefix bricks the dashboard during a prefix
// migration (cached `ISS` worker faces freshly-renamed `DX-*.yml`
// files → every file fails validation as "malformed" → empty list).

describe("listIssues / readIssueDetail prefix-agnostic", () => {
  beforeEach(() => {
    __resetWarnedPathsForTests();
  });

  it("loads DX-N cards (no config.yml needed)", async () => {
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "DX-1", title: "first" }), 1_000);
    writeIssue(repo, "open", emptyIssue({ id: "DX-2", title: "second" }), 2_000);
    const items = await listIssues(repo);
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(["DX-1", "DX-2"]);
  });

  it("loads SG-N cards (no config.yml needed)", async () => {
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "SG-7" }), 1_000);
    const items = await listIssues(repo);
    expect(items.map((i) => i.id)).toEqual(["SG-7"]);
  });

  it("co-existing prefixes both load — no monoculture skip", async () => {
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "DX-1", title: "dx" }), 2_000);
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1", title: "iss" }), 1_000);
    const items = await listIssues(repo);
    expect(items.map((i) => i.id).sort()).toEqual(["DX-1", "ISS-1"]);
  });

  it("readIssueDetail loads any prefix by id", async () => {
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "DX-42", description: "body" }), 1_000);
    const detail = await readIssueDetail(repo, "DX-42");
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe("DX-42");
    expect(detail!.description).toBe("body");
  });

  it("preserves mtime-desc ordering across mixed prefixes", async () => {
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "DX-1" }), 1_000);
    writeIssue(repo, "open", emptyIssue({ id: "DX-2" }), 3_000);
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1" }), 4_000);
    writeIssue(repo, "open", emptyIssue({ id: "DX-3" }), 2_000);
    const items = await listIssues(repo);
    expect(items.map((i) => i.id)).toEqual(["ISS-1", "DX-2", "DX-3", "DX-1"]);
  });
});
