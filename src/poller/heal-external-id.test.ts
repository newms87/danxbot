import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { healExternalIds, HEAL_COMMENT_HEADER } from "./heal-external-id.js";
import { pushTrelloDiff } from "../issue/reconcile/trello.js";
import { MemoryTracker } from "../issue-tracker/__test__-memory.js";
import { TrelloTracker } from "../issue-tracker/trello.js";
import { parseIssue, serializeIssue } from "../issue-tracker/yaml.js";
import type {
  Issue,
  IssueStatus,
  IssueTracker,
} from "../issue-tracker/interface.js";
import type { TrelloConfig } from "../types.js";

function buildIssue(
  overrides: Partial<Issue> & { id: string },
): Issue {
  const merged: Issue = {
    schema_version: 7,
    tracker: "trello",
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo" as IssueStatus,
    type: "Feature",
    title: `Title for ${overrides.id}`,
    description: "Body",
    priority: 3.0,
    position: null,
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
    blocked: null,
    requires_human: null,
    assigned_agent: null,
    waiting_on: null,
    conflict_on: [],
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

const TRELLO_CONFIG: TrelloConfig = {
  apiKey: "k",
  apiToken: "t",
  boardId: "board",
  reviewListId: "list-review",
  todoListId: "list-todo",
  inProgressListId: "list-ip",
  needsHelpListId: "list-nh",
  doneListId: "list-done",
  cancelledListId: "list-cancelled",
  actionItemsListId: "list-ai",
  bugLabelId: "lbl-bug",
  featureLabelId: "lbl-feature",
  epicLabelId: "lbl-epic",
  needsHelpLabelId: "lbl-nh",
  blockedLabelId: "lbl-blocked",
  requiresHumanLabelId: "lbl-rh",
  triagedLabelId: "lbl-triaged",
};

const TRELLO_VALID_ID = "69fd1486208523401e60afcb";

describe("healExternalIds (DX-150 — per-tick external_id format heal)", () => {
  let repoRoot: string;
  let openDir: string;
  let closedDir: string;
  let trello: TrelloTracker;
  let memory: MemoryTracker;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-heal-extid-"));
    openDir = resolve(repoRoot, ".danxbot/issues/open");
    closedDir = resolve(repoRoot, ".danxbot/issues/closed");
    mkdirSync(openDir, { recursive: true });
    mkdirSync(closedDir, { recursive: true });
    trello = new TrelloTracker(TRELLO_CONFIG);
    memory = new MemoryTracker();
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function readYaml(state: "open" | "closed", id: string): Issue {
    const dir = state === "open" ? openDir : closedDir;
    return parseIssue(readFileSync(resolve(dir, `${id}.yml`), "utf-8"), {
      expectedPrefix: "DX",
    });
  }

  it("(1) blanks an open YAML carrying a foreign mem-N id under TrelloTracker, appends an audit comment, and reports the heal", () => {
    const issue = buildIssue({ id: "DX-1", external_id: "mem-2" });
    writeFileSync(resolve(openDir, "DX-1.yml"), serializeIssue(issue));

    const result = healExternalIds(repoRoot, trello, "DX");

    expect(result.healed).toEqual([
      { id: "DX-1", oldExternalId: "mem-2" },
    ]);
    expect(result.errors).toEqual([]);

    const reloaded = readYaml("open", "DX-1");
    expect(reloaded.external_id).toBe("");

    // Exactly one comment appended; no `id` field (worker assigns on push).
    expect(reloaded.comments).toHaveLength(1);
    const comment = reloaded.comments[0];
    expect(comment.id).toBeUndefined();
    expect(comment.author).toBe("danxbot");
    expect(comment.text).toContain(HEAL_COMMENT_HEADER);
    // Old id surfaced verbatim so a human reading the audit can correlate
    // back to whatever foreign tracker emitted it.
    expect(comment.text).toContain("mem-2");
    // Timestamp is ISO 8601-ish — at minimum a non-empty string.
    expect(comment.timestamp.length).toBeGreaterThan(0);
  });

  it("(2) is idempotent against a valid Trello id (24-hex) — no change, no comment, empty result", () => {
    const issue = buildIssue({ id: "DX-2", external_id: TRELLO_VALID_ID });
    writeFileSync(resolve(openDir, "DX-2.yml"), serializeIssue(issue));
    const before = readFileSync(resolve(openDir, "DX-2.yml"), "utf-8");

    const result = healExternalIds(repoRoot, trello, "DX");

    expect(result.healed).toEqual([]);
    expect(result.errors).toEqual([]);
    // File is byte-identical.
    expect(readFileSync(resolve(openDir, "DX-2.yml"), "utf-8")).toBe(before);
  });

  it("(3) leaves a memory-tracker mem-N id alone under MemoryTracker (foreign-format check is per-tracker)", () => {
    const issue = buildIssue({ id: "DX-3", external_id: "mem-2" });
    writeFileSync(resolve(openDir, "DX-3.yml"), serializeIssue(issue));
    const before = readFileSync(resolve(openDir, "DX-3.yml"), "utf-8");

    const result = healExternalIds(repoRoot, memory, "DX");

    expect(result.healed).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(readFileSync(resolve(openDir, "DX-3.yml"), "utf-8")).toBe(before);
  });

  it("(4) skips orphans (external_id === '') without calling the tracker", () => {
    const issue = buildIssue({ id: "DX-4", external_id: "" });
    writeFileSync(resolve(openDir, "DX-4.yml"), serializeIssue(issue));

    // Spy via a Proxy: throw if isValidExternalId is called with the empty
    // string — the heal pass MUST short-circuit before reaching the tracker.
    const callLog: string[] = [];
    const spy: IssueTracker = new Proxy(trello, {
      get(target, prop, receiver) {
        if (prop === "isValidExternalId") {
          return (id: string) => {
            callLog.push(id);
            return target.isValidExternalId(id);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const result = healExternalIds(repoRoot, spy, "DX");

    expect(result.healed).toEqual([]);
    expect(result.errors).toEqual([]);
    // The empty external_id never reached the validator.
    expect(callLog).not.toContain("");
  });

  it("(5) heals only the invalid entry in a mixed dir (3 valid + 1 invalid)", () => {
    const valid1 = buildIssue({ id: "DX-10", external_id: TRELLO_VALID_ID });
    const valid2 = buildIssue({
      id: "DX-11",
      external_id: "00000000000000000000abcd",
    });
    const orphan = buildIssue({ id: "DX-12", external_id: "" });
    const bad = buildIssue({ id: "DX-13", external_id: "mem-7" });
    for (const issue of [valid1, valid2, orphan, bad]) {
      writeFileSync(
        resolve(openDir, `${issue.id}.yml`),
        serializeIssue(issue),
      );
    }

    const result = healExternalIds(repoRoot, trello, "DX");

    expect(result.healed).toEqual([
      { id: "DX-13", oldExternalId: "mem-7" },
    ]);
    expect(result.errors).toEqual([]);
    // The three untouched files keep their external_id verbatim.
    expect(readYaml("open", "DX-10").external_id).toBe(TRELLO_VALID_ID);
    expect(readYaml("open", "DX-11").external_id).toBe(
      "00000000000000000000abcd",
    );
    expect(readYaml("open", "DX-12").external_id).toBe("");
    // The healed file blanked + audit comment appended.
    const healed = readYaml("open", "DX-13");
    expect(healed.external_id).toBe("");
    expect(healed.comments).toHaveLength(1);
    expect(healed.comments[0].text).toContain("mem-7");
  });

  it("(6) scans both open/ AND closed/ directories", () => {
    const openBad = buildIssue({ id: "DX-20", external_id: "mem-2" });
    const closedBad = buildIssue({
      id: "DX-21",
      external_id: "mem-1",
      status: "Done",
    });
    writeFileSync(resolve(openDir, "DX-20.yml"), serializeIssue(openBad));
    writeFileSync(resolve(closedDir, "DX-21.yml"), serializeIssue(closedBad));

    const result = healExternalIds(repoRoot, trello, "DX");

    expect(result.healed).toEqual(
      expect.arrayContaining([
        { id: "DX-20", oldExternalId: "mem-2" },
        { id: "DX-21", oldExternalId: "mem-1" },
      ]),
    );
    expect(result.healed).toHaveLength(2);
    expect(result.errors).toEqual([]);

    // open/ heal: file stays in open/, blanked + audited.
    expect(existsSync(resolve(openDir, "DX-20.yml"))).toBe(true);
    expect(readYaml("open", "DX-20").external_id).toBe("");
    // closed/ heal: file stays in closed/, blanked + audited. Heal does NOT
    // resurrect the file to open/ — terminal-status semantics are preserved.
    expect(existsSync(resolve(closedDir, "DX-21.yml"))).toBe(true);
    expect(existsSync(resolve(openDir, "DX-21.yml"))).toBe(false);
    expect(readYaml("closed", "DX-21").external_id).toBe("");
  });

  it("(7) records unparseable YAMLs in errors[] without aborting the pass — healthy siblings still heal", () => {
    writeFileSync(
      resolve(openDir, "DX-66.yml"),
      "this: is: not: valid: yaml\n  - completely broken\n",
    );
    const healthy = buildIssue({ id: "DX-67", external_id: "mem-9" });
    writeFileSync(resolve(openDir, "DX-67.yml"), serializeIssue(healthy));

    const result = healExternalIds(repoRoot, trello, "DX");

    expect(result.healed).toEqual([
      { id: "DX-67", oldExternalId: "mem-9" },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe(resolve(openDir, "DX-66.yml"));
    expect(result.errors[0].message.length).toBeGreaterThan(0);
    // Malformed file untouched on disk.
    expect(existsSync(resolve(openDir, "DX-66.yml"))).toBe(true);
    // Healthy sibling blanked.
    expect(readYaml("open", "DX-67").external_id).toBe("");
  });

  it("(8) hands off to the orphan-create branch: a healed YAML gets a fresh tracker-minted id via reconcile step 7", async () => {
    // Seed an open YAML with the bad mem-N id, heal it (blanks +
    // audits), then run pushTrelloDiff (the Phase 3 replacement for
    // orphan-push) against a MemoryTracker — the blanked YAML gets
    // minted a fresh `mem-1` via syncIssue's external_id === "" branch.
    // This is the integration AC for the heal → reconcile-push → fresh
    // card chain that motivates this whole pass: the bad data is
    // unrecoverable by sync (would 400 on the foreign tracker), so the
    // only path back to "card exists on the active tracker" is to
    // re-mint via the orphan-create branch reconcile step 7 calls.
    const issue = buildIssue({ id: "DX-30", external_id: "mem-2" });
    writeFileSync(resolve(openDir, "DX-30.yml"), serializeIssue(issue));

    const heal = healExternalIds(repoRoot, memory, "DX");
    // mem-2 IS valid for MemoryTracker — assert via Trello to actually
    // simulate the cross-tracker heal scenario.
    expect(heal.healed).toEqual([]);

    // Now switch to Trello (the realistic post-swap state) — heal.
    const trelloHeal = healExternalIds(repoRoot, trello, "DX");
    expect(trelloHeal.healed).toEqual([
      { id: "DX-30", oldExternalId: "mem-2" },
    ]);
    expect(readYaml("open", "DX-30").external_id).toBe("");

    // Reconcile step 7 picks up the blanked YAML and mints a fresh id
    // via the (still-MemoryTracker for test ergonomics) tracker. In
    // production this would be TrelloTracker minting a 24-hex id; the
    // contract is identical.
    const blanked = readYaml("open", "DX-30");
    const pushResult = await pushTrelloDiff({
      issue: blanked,
      repoName: "test-heal-orphan",
      repoLocalPath: repoRoot,
      issuePrefix: "DX",
      tracker: memory,
    });

    expect(pushResult.errors).toEqual([]);
    expect(pushResult.pushed).toBe(true);
    const reloaded = readYaml("open", "DX-30");
    expect(reloaded.external_id).not.toBe("");
    expect(reloaded.external_id).not.toBe("mem-2");
    // Audit comment from the heal is preserved through the push.
    expect(reloaded.comments.some((c) => c.text.includes(HEAL_COMMENT_HEADER))).toBe(
      true,
    );
  });

  it("returns empty result when neither open/ nor closed/ exists (fresh repo)", () => {
    rmSync(openDir, { recursive: true, force: true });
    rmSync(closedDir, { recursive: true, force: true });
    const result = healExternalIds(repoRoot, trello, "DX");
    expect(result).toEqual({ healed: [], errors: [] });
  });

  it("ignores files outside the <PREFIX>-N regex (drafts, dotfiles, non-yml)", () => {
    writeFileSync(resolve(openDir, "draft-card.yml"), "{}");
    writeFileSync(resolve(openDir, ".swp"), "");
    writeFileSync(resolve(openDir, "README.md"), "ignore me");

    const result = healExternalIds(repoRoot, trello, "DX");

    expect(result).toEqual({ healed: [], errors: [] });
    expect(existsSync(resolve(openDir, "draft-card.yml"))).toBe(true);
  });

  it("scans open/ when closed/ does not exist (partial-tree fresh-repo state)", () => {
    rmSync(closedDir, { recursive: true, force: true });
    const issue = buildIssue({ id: "DX-40", external_id: "mem-2" });
    writeFileSync(resolve(openDir, "DX-40.yml"), serializeIssue(issue));

    const result = healExternalIds(repoRoot, trello, "DX");

    expect(result.healed).toEqual([
      { id: "DX-40", oldExternalId: "mem-2" },
    ]);
    expect(result.errors).toEqual([]);
    expect(readYaml("open", "DX-40").external_id).toBe("");
  });

  it("scans closed/ when open/ does not exist (heal still fires for closed-only repos)", () => {
    rmSync(openDir, { recursive: true, force: true });
    const issue = buildIssue({
      id: "DX-41",
      external_id: "mem-1",
      status: "Done",
    });
    writeFileSync(resolve(closedDir, "DX-41.yml"), serializeIssue(issue));

    const result = healExternalIds(repoRoot, trello, "DX");

    expect(result.healed).toEqual([
      { id: "DX-41", oldExternalId: "mem-1" },
    ]);
    expect(result.errors).toEqual([]);
    expect(readYaml("closed", "DX-41").external_id).toBe("");
  });

  it("preserves every non-{external_id, comments} top-level field byte-for-byte (data-loss guard)", () => {
    // Reload-and-compare guard against a copy-paste bug that drops a
    // top-level field from the heal spread (`{...issue, external_id: "",
    // comments: [...]}`). Seed every field with a non-default value so
    // a regression that resets `triage` / `blocked` / `history` / `dispatch`
    // / `parent_id` / `children` / `retro` / `ac` to defaults trips the
    // assertion. Field-by-field equality (not deep-object) so the
    // failure message names which field drifted.
    const richIssue = buildIssue({
      id: "DX-50",
      external_id: "mem-2",
      type: "Bug",
      status: "ToDo",
      title: "Custom title",
      description: "Custom description",
      priority: 3.0,
      parent_id: "DX-49",
      children: ["DX-51", "DX-52"],
      ac: [
        { check_item_id: "chk-1", title: "ac one", checked: true },
        { check_item_id: "chk-2", title: "ac two", checked: false },
      ],
      comments: [
        {
          id: "cmt-pre",
          author: "human",
          timestamp: "2026-05-01T00:00:00.000Z",
          text: "pre-existing comment",
        },
      ],
      retro: {
        good: "shipped on time",
        bad: "missed lint",
        action_item_ids: ["DX-99"],
        commits: ["abc123"],
      },
      waiting_on: {
        reason: "Waiting on DX-49",
        timestamp: "2026-05-02T00:00:00.000Z",
        by: ["DX-49"],
      },
      history: [
        {
          timestamp: "2026-05-03T00:00:00.000Z",
          actor: "dispatch:abc",
          event: "created",
          to: "ToDo",
        },
      ],
      triage: {
        expires_at: "2026-05-10T00:00:00.000Z",
        reassess_hint: "wait for X",
        last_status: "Keep",
        last_explain: "still on track",
        ice: { total: 60, i: 4, c: 5, e: 3 },
        history: [
          {
            timestamp: "2026-05-03T00:00:00.000Z",
            status: "Keep",
            explain: "still on track",
            expires_at: "2026-05-10T00:00:00.000Z",
            ice: { total: 60, i: 4, c: 5, e: 3 },
          },
        ],
      },
    });
    writeFileSync(resolve(openDir, "DX-50.yml"), serializeIssue(richIssue));

    const result = healExternalIds(repoRoot, trello, "DX");
    expect(result.healed).toEqual([
      { id: "DX-50", oldExternalId: "mem-2" },
    ]);

    const reloaded = readYaml("open", "DX-50");
    // Modified-by-design: external_id blanked, audit comment appended.
    expect(reloaded.external_id).toBe("");
    expect(reloaded.comments).toHaveLength(2); // pre-existing + heal
    expect(reloaded.comments[0]).toEqual(richIssue.comments[0]);
    expect(reloaded.comments[1].text).toContain("mem-2");

    // Every other field MUST round-trip byte-identical.
    expect(reloaded.parent_id).toBe(richIssue.parent_id);
    expect(reloaded.children).toEqual(richIssue.children);
    expect(reloaded.status).toBe(richIssue.status);
    expect(reloaded.type).toBe(richIssue.type);
    expect(reloaded.title).toBe(richIssue.title);
    expect(reloaded.description).toBe(richIssue.description);
    expect(reloaded.ac).toEqual(richIssue.ac);
    expect(reloaded.retro).toEqual(richIssue.retro);
    expect(reloaded.blocked).toEqual(richIssue.blocked);
    expect(reloaded.history).toEqual(richIssue.history);
    expect(reloaded.triage).toEqual(richIssue.triage);
    expect(reloaded.dispatch).toBeNull();
  });

  it("honors the `now` injection for the audit comment timestamp", () => {
    // The `now` parameter exists for testability (and for future
    // dashboard-driven manual triggers that want to backstamp). A
    // refactor that drops the parameter or hardcodes Date.now() trips
    // this exact-match assertion.
    const issue = buildIssue({ id: "DX-60", external_id: "mem-2" });
    writeFileSync(resolve(openDir, "DX-60.yml"), serializeIssue(issue));

    const FROZEN = "2026-05-08T12:00:00.000Z";
    const result = healExternalIds(repoRoot, trello, "DX", () => FROZEN);

    expect(result.healed).toHaveLength(1);
    const reloaded = readYaml("open", "DX-60");
    expect(reloaded.comments[0].timestamp).toBe(FROZEN);
  });

  it("propagates tracker.isValidExternalId throws to the caller (fail-loud per JSDoc contract)", () => {
    // JSDoc on `IssueTracker.isValidExternalId` forbids network calls
    // and any nontrivial work — implementers MUST be pure and synchronous.
    // If a buggy implementation throws anyway, the heal pass aborts the
    // entire tick rather than swallowing the error into `errors[]`. Pin
    // this fail-loud behavior so a future "let's be defensive" refactor
    // doesn't silently mask a tracker contract violation.
    const issue = buildIssue({ id: "DX-70", external_id: "anything" });
    writeFileSync(resolve(openDir, "DX-70.yml"), serializeIssue(issue));

    const buggyTracker: IssueTracker = new Proxy(trello, {
      get(target, prop, receiver) {
        if (prop === "isValidExternalId") {
          return () => {
            throw new Error("buggy tracker");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    expect(() => healExternalIds(repoRoot, buggyTracker, "DX")).toThrow(
      /buggy tracker/,
    );
  });

  it("records writeFileSync failures in errors[] without aborting (read-only file in a healable batch)", () => {
    // Heal MUST keep going past a single write failure (e.g. operator
    // chmod'd a YAML for inspection). One bad file in `open/` does not
    // block the entire tick. Tested with real `chmodSync` so the
    // permission-denied path runs end-to-end. Skipped on Windows where
    // `chmod` semantics differ.
    if (process.platform === "win32") return;

    const readonly = buildIssue({ id: "DX-80", external_id: "mem-2" });
    const writable = buildIssue({ id: "DX-81", external_id: "mem-3" });
    const readonlyPath = resolve(openDir, "DX-80.yml");
    const writablePath = resolve(openDir, "DX-81.yml");
    writeFileSync(readonlyPath, serializeIssue(readonly));
    writeFileSync(writablePath, serializeIssue(writable));
    chmodSync(readonlyPath, 0o444);

    try {
      const result = healExternalIds(repoRoot, trello, "DX");

      // Healthy sibling healed; errors[] carries the read-only file.
      expect(result.healed).toEqual([
        { id: "DX-81", oldExternalId: "mem-3" },
      ]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toBe(readonlyPath);
      expect(result.errors[0].message.length).toBeGreaterThan(0);

      // Read-only file untouched on disk.
      const reloadedReadonly = readYaml("open", "DX-80");
      expect(reloadedReadonly.external_id).toBe("mem-2");
      expect(reloadedReadonly.comments).toHaveLength(0);
    } finally {
      // Restore so afterEach's rmSync doesn't EACCES.
      chmodSync(readonlyPath, 0o644);
    }
  });
});
