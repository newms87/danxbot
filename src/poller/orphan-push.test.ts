import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryTracker } from "../issue-tracker/memory.js";
import { parseIssue, serializeIssue } from "../issue-tracker/yaml.js";
import { ensureIssuesDirs, issuePath } from "./yaml-lifecycle.js";
import { pushOrphans } from "./orphan-push.js";
import type { Issue, IssueTracker } from "../issue-tracker/interface.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    schema_version: 3,
    tracker: "memory",
    id: "ISS-1",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch_id: null,
    status: "ToDo",
    type: "Feature",
    title: "Test",
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

function writeOrphan(repoRoot: string, issue: Issue): void {
  ensureIssuesDirs(repoRoot);
  writeFileSync(issuePath(repoRoot, issue.id, "open"), serializeIssue(issue));
}

function readYaml(repoRoot: string, id: string): Issue {
  return parseIssue(readFileSync(issuePath(repoRoot, id, "open"), "utf-8"));
}

describe("pushOrphans", () => {
  let repoRoot: string;
  let tracker: MemoryTracker;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-orphan-push-"));
    tracker = new MemoryTracker();
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("pushes a single orphan and stamps external_id back into the YAML", async () => {
    writeOrphan(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        title: "Solo orphan",
        ac: [
          { check_item_id: "", title: "ac one", checked: false },
        ],
      }),
    );

    const result = await pushOrphans(repoRoot, tracker);

    expect(result.pushed).toBe(1);
    expect(result.errors).toEqual([]);
    const stamped = readYaml(repoRoot, "ISS-1");
    expect(stamped.external_id).not.toBe("");
    expect(stamped.ac[0].check_item_id).not.toBe("");
  });

  it("is a no-op when there are no orphans", async () => {
    writeOrphan(
      repoRoot,
      makeIssue({ id: "ISS-1", external_id: "mem-xyz" }),
    );
    const result = await pushOrphans(repoRoot, tracker);
    expect(result.pushed).toBe(0);
    expect(result.errors).toEqual([]);
    // YAML untouched.
    expect(readYaml(repoRoot, "ISS-1").external_id).toBe("mem-xyz");
  });

  it("ignores closed/ orphans (never resurrects retired YAMLs as new tracker cards)", async () => {
    ensureIssuesDirs(repoRoot);
    const closedIssue = makeIssue({
      id: "ISS-9",
      status: "Done",
      title: "Already closed",
    });
    writeFileSync(
      resolve(repoRoot, ".danxbot/issues/closed/ISS-9.yml"),
      serializeIssue(closedIssue),
    );

    const result = await pushOrphans(repoRoot, tracker);
    expect(result.pushed).toBe(0);
  });

  it("pushes parent before child so child.parent_id resolves to a real external_id", async () => {
    writeOrphan(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        title: "Child",
        parent_id: "ISS-2",
      }),
    );
    writeOrphan(
      repoRoot,
      makeIssue({ id: "ISS-2", title: "Parent" }),
    );

    const result = await pushOrphans(repoRoot, tracker);
    expect(result.pushed).toBe(2);

    // Verify ordering by tracker call log: parent (ISS-2) MUST be createCard'd
    // before child (ISS-1).
    const createCalls = tracker
      .getRequestLog()
      .filter((e) => e.method === "createCard")
      .map((e) => (e.details as { input: { id: string } }).input.id);
    expect(createCalls).toEqual(["ISS-2", "ISS-1"]);

    // Child YAML retains its `parent_id` reference (the INTERNAL id stays
    // canonical — `external_id` is purely a tracker-side detail).
    expect(readYaml(repoRoot, "ISS-1").parent_id).toBe("ISS-2");
  });

  it("continues on per-card createCard failure and reports errors", async () => {
    writeOrphan(repoRoot, makeIssue({ id: "ISS-1", title: "First" }));
    writeOrphan(repoRoot, makeIssue({ id: "ISS-2", title: "Second" }));

    // Force the FIRST createCard call to reject. MemoryTracker's
    // `failNextWrite` consumes one rejection on the next mutating call.
    tracker.failNextWrite(new Error("simulated tracker outage"));

    const result = await pushOrphans(repoRoot, tracker);

    expect(result.pushed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].id).toMatch(/^ISS-/);
    expect(result.errors[0].message).toContain("simulated tracker outage");

    const stamped = [readYaml(repoRoot, "ISS-1"), readYaml(repoRoot, "ISS-2")];
    const pushed = stamped.filter((i) => i.external_id !== "");
    expect(pushed).toHaveLength(1);
  });

  it("subsequent invocation is a no-op (idempotent)", async () => {
    writeOrphan(repoRoot, makeIssue({ id: "ISS-1", title: "Once" }));
    const first = await pushOrphans(repoRoot, tracker);
    expect(first.pushed).toBe(1);

    const second = await pushOrphans(repoRoot, tracker);
    expect(second.pushed).toBe(0);
  });

  it("stamps phases[i].check_item_id back into the YAML alongside ac items", async () => {
    writeOrphan(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        phases: [
          { check_item_id: "", title: "P1", status: "Pending", notes: "" },
          { check_item_id: "", title: "P2", status: "Pending", notes: "" },
        ],
      }),
    );

    const result = await pushOrphans(repoRoot, tracker);
    expect(result.pushed).toBe(1);
    const stamped = readYaml(repoRoot, "ISS-1");
    expect(stamped.phases[0].check_item_id).not.toBe("");
    expect(stamped.phases[1].check_item_id).not.toBe("");
    expect(stamped.phases[0].check_item_id).not.toBe(
      stamped.phases[1].check_item_id,
    );
  });

  it("emits an orphan whose parent_id points at a non-orphan immediately", async () => {
    // Parent already has external_id set → not in the orphan set; child
    // should not wait for it.
    writeOrphan(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        external_id: "mem-parent",
      }),
    );
    writeOrphan(
      repoRoot,
      makeIssue({
        id: "ISS-2",
        parent_id: "ISS-1",
        title: "Child",
      }),
    );
    const result = await pushOrphans(repoRoot, tracker);
    expect(result.pushed).toBe(1);
    expect(readYaml(repoRoot, "ISS-2").external_id).not.toBe("");
  });

  it("emits an orphan whose parent_id points at a non-existent ISS-N immediately", async () => {
    writeOrphan(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        parent_id: "ISS-99",
        title: "Stale parent ref",
      }),
    );
    const result = await pushOrphans(repoRoot, tracker);
    expect(result.pushed).toBe(1);
  });

  it("throws on a parent_id cycle among orphans", async () => {
    writeOrphan(
      repoRoot,
      makeIssue({ id: "ISS-1", parent_id: "ISS-2", title: "A" }),
    );
    writeOrphan(
      repoRoot,
      makeIssue({ id: "ISS-2", parent_id: "ISS-1", title: "B" }),
    );
    await expect(pushOrphans(repoRoot, tracker)).rejects.toThrow(/cycle/i);
  });

  it("returns {pushed:0,errors:[]} when open/ does not exist", async () => {
    const result = await pushOrphans(repoRoot, tracker);
    expect(result).toEqual({ pushed: 0, errors: [] });
  });

  it("skips non-.yml and non-ISS-N filenames in open/", async () => {
    ensureIssuesDirs(repoRoot);
    writeFileSync(resolve(repoRoot, ".danxbot/issues/open/README.md"), "# x");
    writeFileSync(
      resolve(repoRoot, ".danxbot/issues/open/draft.yml"),
      "stem-not-iss-n",
    );
    writeOrphan(repoRoot, makeIssue({ id: "ISS-1", title: "Real" }));

    const result = await pushOrphans(repoRoot, tracker);
    expect(result.pushed).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("records a malformed YAML in errors[] and continues scanning", async () => {
    ensureIssuesDirs(repoRoot);
    writeFileSync(
      resolve(repoRoot, ".danxbot/issues/open/ISS-7.yml"),
      ":::: not valid yaml ::::\n  -[",
    );
    writeOrphan(repoRoot, makeIssue({ id: "ISS-1", title: "Healthy" }));

    const result = await pushOrphans(repoRoot, tracker);
    expect(result.pushed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].id).toBe("ISS-7");
  });

  it("records an error when tracker.createCard returns mismatched ac/phases length", async () => {
    // Build a stub tracker that returns one ac stamp for a 2-ac issue.
    // `Object.create(tracker)` preserves MemoryTracker methods + lets us
    // override `createCard` only — keeps the IssueTracker interface
    // satisfied without a hand-rolled stub.
    const stubTracker: IssueTracker = Object.create(tracker);
    stubTracker.createCard = async () => ({
      external_id: "stub-1",
      ac: [{ check_item_id: "ci-1" }],
      phases: [],
    });
    writeOrphan(
      repoRoot,
      makeIssue({
        id: "ISS-1",
        ac: [
          { check_item_id: "", title: "a", checked: false },
          { check_item_id: "", title: "b", checked: false },
        ],
      }),
    );
    const result = await pushOrphans(repoRoot, stubTracker);
    expect(result.pushed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/ac items|expected/i);
    // YAML untouched.
    expect(readYaml(repoRoot, "ISS-1").external_id).toBe("");
  });
});
