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
  return {
    schema_version: 3,
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
      description: "Epic body markdown",
      // Both children are missing → projected as blocked, which the
      // epic inherits → status pulled to Needs Help and blocked_by /
      // reason derived from the blocked children. The fixture's own
      // YAML `blocked` (waiting on ISS-2) is masked by the inherited
      // computation since it was a self-block (epic blocked by its
      // own child).
      status: "Needs Help",
      parent_id: null,
      children: ["ISS-2", "ISS-3"],
      ac_total: 2,
      ac_done: 1,
      children_detail: [
        { id: "ISS-2", name: "<ISS-2: unknown>", type: "Feature", status: "ToDo", blocked: true, blocked_by_card: false, missing: true },
        { id: "ISS-3", name: "<ISS-3: unknown>", type: "Feature", status: "ToDo", blocked: true, blocked_by_card: false, missing: true },
      ],
      blocked: true,
      blocked_reason: "Waiting on 2 blocked children: ISS-2, ISS-3.",
      blocked_by: ["ISS-2", "ISS-3"],
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
      { id: "ISS-2", name: "Phase one shipped", type: "Feature", status: "Done", blocked: false, blocked_by_card: false, missing: false },
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
    expect(epic.children_detail[0].blocked).toBe(false);
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
        blocked: {
          reason: "waiting",
          timestamp: "2026-01-01T00:00:00Z",
          by: ["ISS-3"],
        },
      }),
      1_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail[0].status).toBe("ToDo");
    expect(epic.children_detail[0].blocked).toBe(true);
  });

  it("children_detail carries Needs Help raw + blocked=false", async () => {
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
      emptyIssue({ id: "ISS-2", title: "help me", status: "Needs Help" }),
      1_000,
    );
    const items = await listIssues(repo);
    const epic = items.find((i) => i.id === "ISS-1")!;
    expect(epic.children_detail[0].status).toBe("Needs Help");
    expect(epic.children_detail[0].blocked).toBe(false);
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
    expect(epic.children_detail[0].blocked).toBe(false);
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
      blocked: true,
      blocked_by_card: false,
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
    expect(epic.children_detail[0].blocked).toBe(false);
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

// ---------- Per-repo prefix awareness (Phase 2 of ISS-99) ----------
//
// The dashboard reader resolves the issue prefix from each repo's
// `<repoCwd>/.danxbot/config/config.yml` `issue_prefix` field and threads it
// into `parseIssue` via `expectedPrefix`. A repo with `issue_prefix: DX`
// parses `DX-N.yml` cards; a repo without `config.yml` keeps the legacy
// `"ISS"` default so pre-migration repos continue to render. This block
// pins both halves so a future refactor can't silently regress to a
// hardcoded default.

function setupRepoWithPrefix(prefix: string): string {
  const repo = setupRepo();
  mkdirSync(join(repo, ".danxbot/config"), { recursive: true });
  writeFileSync(
    join(repo, ".danxbot/config/config.yml"),
    `issue_prefix: ${prefix}\n`,
    "utf-8",
  );
  return repo;
}

describe("listIssues / readIssueDetail per-repo issue_prefix", () => {
  beforeEach(() => {
    __resetWarnedPathsForTests();
  });

  it("listIssues parses DX-N cards in a repo configured with issue_prefix: DX", async () => {
    const repo = setupRepoWithPrefix("DX");
    writeIssue(repo, "open", emptyIssue({ id: "DX-1", title: "first" }), 1_000);
    writeIssue(repo, "open", emptyIssue({ id: "DX-2", title: "second" }), 2_000);
    const items = await listIssues(repo);
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(["DX-1", "DX-2"]);
  });

  it("listIssues parses SG-N cards in a repo configured with issue_prefix: SG", async () => {
    const repo = setupRepoWithPrefix("SG");
    writeIssue(repo, "open", emptyIssue({ id: "SG-7" }), 1_000);
    const items = await listIssues(repo);
    expect(items.map((i) => i.id)).toEqual(["SG-7"]);
  });

  it("listIssues skips ISS-N YAMLs with a warning when the repo prefix is DX", async () => {
    const repo = setupRepoWithPrefix("DX");
    writeIssue(repo, "open", emptyIssue({ id: "DX-1", title: "ok" }), 2_000);
    // Cross-prefix YAML: still loaded by `setupRepoWithPrefix` writer but
    // contains `id: ISS-1` — must be rejected by the validator under the
    // DX repo so a stale cross-repo file never silently surfaces on the DX
    // dashboard.
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1", title: "stale" }), 1_000);
    const items = await listIssues(repo);
    expect(items.map((i) => i.id)).toEqual(["DX-1"]);
  });

  it("readIssueDetail loads DX-N when the repo prefix is DX", async () => {
    const repo = setupRepoWithPrefix("DX");
    writeIssue(repo, "open", emptyIssue({ id: "DX-42", description: "body" }), 1_000);
    const detail = await readIssueDetail(repo, "DX-42");
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe("DX-42");
    expect(detail!.description).toBe("body");
  });

  it("readIssueDetail returns null for a cross-prefix id under a DX repo", async () => {
    const repo = setupRepoWithPrefix("DX");
    // The file is on disk but its `id` field is `ISS-1` — the DX
    // validator rejects it, and `readIssueDetail` swallows the parse
    // error per its existing contract.
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1" }), 1_000);
    const detail = await readIssueDetail(repo, "ISS-1");
    expect(detail).toBeNull();
  });

  it("falls back to the legacy ISS prefix when config.yml is absent", async () => {
    // No config.yml — `loadIssuePrefix` returns DEFAULT_ISSUE_PREFIX with a
    // warn-once log. Existing ISS-N repos continue to render.
    const repo = setupRepo();
    writeIssue(repo, "open", emptyIssue({ id: "ISS-9", title: "legacy" }), 1_000);
    const items = await listIssues(repo);
    expect(items.map((i) => i.id)).toEqual(["ISS-9"]);
  });

  it("falls back to ISS when config.yml has no issue_prefix field", async () => {
    const repo = setupRepo();
    mkdirSync(join(repo, ".danxbot/config"), { recursive: true });
    writeFileSync(
      join(repo, ".danxbot/config/config.yml"),
      "name: my-repo\n",
      "utf-8",
    );
    writeIssue(repo, "open", emptyIssue({ id: "ISS-3" }), 1_000);
    const items = await listIssues(repo);
    expect(items.map((i) => i.id)).toEqual(["ISS-3"]);
  });

  it("propagates a malformed issue_prefix as a thrown error", async () => {
    // `loadIssuePrefix` throws on a shape mismatch. The reader does NOT
    // swallow this — fail-loud is the contract for config-shape bugs.
    const repo = setupRepoWithPrefix("badShape!");
    await expect(listIssues(repo)).rejects.toThrow(/Invalid issue_prefix/);
  });

  it("preserves mtime-desc ordering of valid survivors when a cross-prefix YAML is skipped", async () => {
    // Validates that the prefix-skip path doesn't disturb the existing
    // mtime sort. Three valid DX-N files at different mtimes plus one
    // stale ISS-N (rejected by the validator). Surviving items must
    // come back ordered by mtime descending — same contract every other
    // listIssues call obeys.
    const repo = setupRepoWithPrefix("DX");
    writeIssue(repo, "open", emptyIssue({ id: "DX-1" }), 1_000);
    writeIssue(repo, "open", emptyIssue({ id: "DX-2" }), 3_000);
    writeIssue(repo, "open", emptyIssue({ id: "DX-3" }), 2_000);
    writeIssue(repo, "open", emptyIssue({ id: "ISS-1" }), 4_000);
    const items = await listIssues(repo);
    expect(items.map((i) => i.id)).toEqual(["DX-2", "DX-3", "DX-1"]);
  });
});
