import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Mock auth-middleware before importing issue-import so requireUser
// bypasses for Bearer "user-<name>" tokens (mirrors the issue-write
// test pattern — both modules share the same auth band).
vi.mock("./auth-middleware.js", () => ({
  requireUser: async (req: { headers: { authorization?: string } }) => {
    const h = req.headers?.authorization;
    const t = h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
    if (!t || !t.startsWith("user-")) return { ok: false, status: 401 };
    return {
      ok: true,
      user: { userId: 1, username: t.slice("user-".length) },
    };
  },
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockEventBusPublish = vi.fn();
vi.mock("./event-bus.js", () => ({
  eventBus: {
    publish: (...args: unknown[]) => mockEventBusPublish(...args),
  },
}));

vi.mock("../poller/issues-db.js", () => ({
  dbListAllIssues: vi.fn(async () => []),
}));

import {
  applyIssueImport,
  buildIssueSubtreePayload,
  handleGetIssueSubtree,
  handleImportIssues,
} from "./issue-import.js";
import { IssuePatchError } from "./issue-write.js";
import { createEmptyIssue, serializeIssue } from "../issue-tracker/yaml.js";
import { issuePath, ensureIssuesDirs } from "../issue-tracker/paths.js";
import type {
  Issue,
  IssueCopyPayload,
} from "../issue-tracker/interface.js";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";
import { deps as buildDeps } from "./agents-test-fixtures.js";

let tmpRoot: string;
let repoLocalPath: string;
let altRepoLocalPath: string;

function writeRepoConfig(localPath: string, prefix: string): void {
  const configDir = resolve(localPath, ".danxbot/config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    resolve(configDir, "config.yml"),
    `issue_prefix: ${prefix}\n`,
  );
}

function writeIssueFixture(
  localPath: string,
  issue: Issue,
  state: "open" | "closed" = "open",
): string {
  ensureIssuesDirs(localPath);
  const p = issuePath(localPath, issue.id, state);
  writeFileSync(p, serializeIssue(issue));
  return p;
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const base = createEmptyIssue({
    id: "DX-1",
    title: "Root card",
    description: "Body",
    status: "ToDo",
    type: "Feature",
  });
  return { ...base, ...overrides };
}

function readYaml(localPath: string, id: string): string {
  return readFileSync(issuePath(localPath, id, "open"), "utf-8");
}

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "issue-import-test-"));
  repoLocalPath = resolve(tmpRoot, "danxbot");
  altRepoLocalPath = resolve(tmpRoot, "gpt-manager");
  mkdirSync(repoLocalPath, { recursive: true });
  mkdirSync(altRepoLocalPath, { recursive: true });
  writeRepoConfig(repoLocalPath, "DX");
  writeRepoConfig(altRepoLocalPath, "GPT");
  mockEventBusPublish.mockClear();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── buildIssueSubtreePayload ──────────────────────────────────────────

describe("buildIssueSubtreePayload — walk + strip", () => {
  it("returns a single-issue payload for a leaf card", () => {
    writeIssueFixture(repoLocalPath, makeIssue());
    const payload = buildIssueSubtreePayload(repoLocalPath, "DX-1", "DX");
    expect(payload.schema_version).toBe(11);
    expect(payload.issues).toHaveLength(1);
    expect(payload.issues[0].id).toBe("DX-1");
    expect(payload.issues[0].title).toBe("Root card");
  });

  it("walks children[] and returns root + every descendant", () => {
    writeIssueFixture(
      repoLocalPath,
      makeIssue({
        id: "DX-1",
        type: "Epic",
        children: ["DX-2", "DX-3"],
      }),
    );
    writeIssueFixture(
      repoLocalPath,
      makeIssue({
        id: "DX-2",
        title: "Phase 1",
        parent_id: "DX-1",
      }),
    );
    writeIssueFixture(
      repoLocalPath,
      makeIssue({
        id: "DX-3",
        title: "Phase 2",
        parent_id: "DX-1",
      }),
    );
    const payload = buildIssueSubtreePayload(repoLocalPath, "DX-1", "DX");
    expect(payload.issues.map((i) => i.id)).toEqual([
      "DX-1",
      "DX-2",
      "DX-3",
    ]);
  });

  it("walks deeply nested children (epic → phase → sub-card)", () => {
    writeIssueFixture(
      repoLocalPath,
      makeIssue({
        id: "DX-1",
        type: "Epic",
        children: ["DX-2"],
      }),
    );
    writeIssueFixture(
      repoLocalPath,
      makeIssue({
        id: "DX-2",
        parent_id: "DX-1",
        children: ["DX-3"],
      }),
    );
    writeIssueFixture(
      repoLocalPath,
      makeIssue({
        id: "DX-3",
        parent_id: "DX-2",
      }),
    );
    const payload = buildIssueSubtreePayload(repoLocalPath, "DX-1", "DX");
    expect(payload.issues.map((i) => i.id)).toEqual([
      "DX-1",
      "DX-2",
      "DX-3",
    ]);
  });

  it("strips repo-specific bits — external_id, tracker, dispatch, triage, history, assigned_agent, comment ids, ac check_item_ids", () => {
    writeIssueFixture(
      repoLocalPath,
      makeIssue({
        id: "DX-1",
        external_id: "trello-card-xyz",
        tracker: "trello",
        assigned_agent: "alice",
        ac: [
          { check_item_id: "trello-check-abc", title: "AC1", checked: true },
        ],
        comments: [
          {
            id: "trello-comment-1",
            author: "bob",
            timestamp: "2026-05-14T00:00:00Z",
            text: "old comment",
          },
        ],
      }),
    );
    const payload = buildIssueSubtreePayload(repoLocalPath, "DX-1", "DX");
    const issue = payload.issues[0];
    expect(issue.external_id).toBe("");
    expect(issue.tracker).toBe("memory");
    expect(issue.dispatch).toBeNull();
    expect(issue.assigned_agent).toBeNull();
    expect("position" in issue).toBe(false);
    expect(issue.history).toEqual([]);
    expect(issue.triage.history).toEqual([]);
    expect(issue.triage.last_status).toBe("");
    expect(issue.ac[0].check_item_id).toBe("");
    expect(issue.ac[0].checked).toBe(true);
    expect(issue.ac[0].title).toBe("AC1");
    expect(issue.comments[0].id).toBeUndefined();
    expect(issue.comments[0].text).toBe("old comment");
  });

  it("preserves blocked + status + waiting_on + requires_human + effort_level + retro verbatim", () => {
    writeIssueFixture(
      repoLocalPath,
      makeIssue({
        id: "DX-1",
        status: "Blocked",
        blocked: {
          reason: "Need a credential rotation",
          at: "2026-05-14T01:00:00Z",
        },
        waiting_on: null,
        requires_human: {
          reason: "Operator must do X",
          steps: ["step 1", "step 2"],
          set_by: "agent",
          set_at: "2026-05-14T02:00:00Z",
        },
        effort_level: "high",
        retro: {
          good: "shipped",
          bad: "took a while",
          action_item_ids: [],
          commits: ["abc123"],
        },
      }),
    );
    const payload = buildIssueSubtreePayload(repoLocalPath, "DX-1", "DX");
    const issue = payload.issues[0];
    expect(issue.status).toBe("Blocked");
    expect(issue.blocked).toEqual({
      reason: "Need a credential rotation",
      at: "2026-05-14T01:00:00Z",
    });
    expect(issue.requires_human?.reason).toBe("Operator must do X");
    expect(issue.requires_human?.steps).toEqual(["step 1", "step 2"]);
    expect(issue.effort_level).toBe("high");
    expect(issue.retro.commits).toEqual(["abc123"]);
  });

  it("404s when the root id is missing in open/", () => {
    expect(() =>
      buildIssueSubtreePayload(repoLocalPath, "DX-999", "DX"),
    ).toThrowError(IssuePatchError);
    try {
      buildIssueSubtreePayload(repoLocalPath, "DX-999", "DX");
    } catch (err) {
      const e = err as IssuePatchError;
      expect(e.status).toBe(404);
    }
  });

  it("handles cycle-shaped children[] without recursing forever", () => {
    // Pathological fixture: DX-1 lists DX-2 as a child; DX-2 lists
    // DX-1 back. The walker's `visited` set must collapse the cycle
    // to two emitted entries.
    writeIssueFixture(
      repoLocalPath,
      makeIssue({
        id: "DX-1",
        type: "Epic",
        children: ["DX-2"],
      }),
    );
    writeIssueFixture(
      repoLocalPath,
      makeIssue({
        id: "DX-2",
        parent_id: "DX-1",
        children: ["DX-1"],
      }),
    );
    const payload = buildIssueSubtreePayload(repoLocalPath, "DX-1", "DX");
    expect(payload.issues.map((i) => i.id).sort()).toEqual(["DX-1", "DX-2"]);
  });

  it("500s on malformed on-disk YAML, naming the offending id", () => {
    ensureIssuesDirs(repoLocalPath);
    const p = issuePath(repoLocalPath, "DX-1", "open");
    writeFileSync(p, "schema_version: 8\nthis is not valid yaml: : : :");
    try {
      buildIssueSubtreePayload(repoLocalPath, "DX-1", "DX");
      throw new Error("expected throw");
    } catch (err) {
      const e = err as IssuePatchError;
      expect(e.status).toBe(500);
      expect(e.body.error).toContain("DX-1");
      expect(e.body.error).toContain("malformed");
    }
  });

  it("treats a missing descendant as incoherent subtree (404)", () => {
    writeIssueFixture(
      repoLocalPath,
      makeIssue({
        id: "DX-1",
        type: "Epic",
        children: ["DX-2", "DX-3"],
      }),
    );
    writeIssueFixture(repoLocalPath, makeIssue({ id: "DX-2", parent_id: "DX-1" }));
    // DX-3 intentionally missing.
    try {
      buildIssueSubtreePayload(repoLocalPath, "DX-1", "DX");
      throw new Error("expected throw");
    } catch (err) {
      const e = err as IssuePatchError;
      expect(e.status).toBe(404);
      expect(e.body.error).toContain("Descendant");
      expect(e.body.error).toContain("DX-3");
    }
  });
});

// ── applyIssueImport — id allocation + rewrite ────────────────────────

describe("applyIssueImport — happy paths", () => {
  function payloadOf(issues: Issue[]): IssueCopyPayload {
    return { schema_version: 11, issues };
  }

  it("allocates a fresh id and writes the single-card YAML", async () => {
    // Pre-populate one card in the target so nextIssueId returns DX-2.
    writeIssueFixture(
      repoLocalPath,
      makeIssue({ id: "DX-1", title: "existing" }),
    );
    const payload = payloadOf([
      {
        ...makeIssue({ id: "DX-100", title: "imported" }),
        tracker: "memory",
        external_id: "",
        assigned_agent: null,
        history: [],
      },
    ]);
    const result = await applyIssueImport("danxbot", repoLocalPath, payload);
    expect(result.topId).toBe("DX-2");
    expect(result.issues).toHaveLength(1);
    expect(existsSync(issuePath(repoLocalPath, "DX-2", "open"))).toBe(true);
    const text = readYaml(repoLocalPath, "DX-2");
    expect(text).toContain("id: DX-2");
    expect(text).toContain("title: imported");
    expect(text).not.toContain("DX-100");
    expect(mockEventBusPublish).toHaveBeenCalledTimes(1);
  });

  it("rewrites parent_id and children[] when an epic with phases is imported", async () => {
    const epic = makeIssue({
      id: "DX-100",
      type: "Epic",
      title: "Epic",
      children: ["DX-200", "DX-201"],
    });
    const phase1 = makeIssue({
      id: "DX-200",
      type: "Feature",
      title: "Phase 1",
      parent_id: "DX-100",
    });
    const phase2 = makeIssue({
      id: "DX-201",
      type: "Feature",
      title: "Phase 2",
      parent_id: "DX-100",
    });
    const payload = payloadOf([epic, phase1, phase2]);

    const result = await applyIssueImport("danxbot", repoLocalPath, payload);
    expect(result.topId).toBe("DX-1");
    expect(result.issues.map((i) => i.id)).toEqual([
      "DX-1",
      "DX-2",
      "DX-3",
    ]);
    expect(result.issues[0].children).toEqual(["DX-2", "DX-3"]);
    expect(result.issues[1].parent_id).toBe("DX-1");
    expect(result.issues[2].parent_id).toBe("DX-1");
  });

  it("rewrites deeply nested parent_id chains (epic → phase → sub-card)", async () => {
    const root = makeIssue({
      id: "DX-100",
      type: "Epic",
      children: ["DX-200"],
    });
    const mid = makeIssue({
      id: "DX-200",
      type: "Feature",
      parent_id: "DX-100",
      children: ["DX-300"],
    });
    const leaf = makeIssue({
      id: "DX-300",
      type: "Bug",
      parent_id: "DX-200",
    });

    const result = await applyIssueImport(
      "danxbot",
      repoLocalPath,
      payloadOf([root, mid, leaf]),
    );
    expect(result.issues[0].children).toEqual(["DX-2"]);
    expect(result.issues[1].parent_id).toBe("DX-1");
    expect(result.issues[1].children).toEqual(["DX-3"]);
    expect(result.issues[2].parent_id).toBe("DX-2");
  });

  it("drops parent_id when the referenced parent is not in the payload", async () => {
    const child = makeIssue({
      id: "DX-200",
      parent_id: "DX-100", // parent NOT included in payload
    });
    const result = await applyIssueImport(
      "danxbot",
      repoLocalPath,
      payloadOf([child]),
    );
    expect(result.issues[0].parent_id).toBeNull();
  });

  it("drops children[] entries not in the payload", async () => {
    const epic = makeIssue({
      id: "DX-100",
      type: "Epic",
      // Only DX-200 is in the payload; DX-201 is dropped.
      children: ["DX-200", "DX-201"],
    });
    const phase = makeIssue({
      id: "DX-200",
      type: "Feature",
      parent_id: "DX-100",
    });
    const result = await applyIssueImport(
      "danxbot",
      repoLocalPath,
      payloadOf([epic, phase]),
    );
    expect(result.issues[0].children).toEqual(["DX-2"]);
  });

  it("rewrites against the target repo's prefix (cross-prefix paste DX → GPT)", async () => {
    const epic = makeIssue({
      id: "DX-100",
      type: "Epic",
      children: ["DX-200"],
    });
    const phase = makeIssue({
      id: "DX-200",
      parent_id: "DX-100",
    });
    const result = await applyIssueImport(
      "gpt-manager",
      altRepoLocalPath,
      payloadOf([epic, phase]),
    );
    expect(result.issues.map((i) => i.id)).toEqual(["GPT-1", "GPT-2"]);
    expect(result.issues[0].children).toEqual(["GPT-2"]);
    expect(result.issues[1].parent_id).toBe("GPT-1");
    expect(existsSync(issuePath(altRepoLocalPath, "GPT-1", "open"))).toBe(
      true,
    );
    expect(existsSync(issuePath(altRepoLocalPath, "GPT-2", "open"))).toBe(
      true,
    );
  });

  it("preserves status === Blocked AND blocked record (invariant holds across paste)", async () => {
    const src = makeIssue({
      id: "DX-100",
      status: "Blocked",
      blocked: {
        reason: "Original blocker text",
        at: "2026-05-14T00:00:00Z",
      },
    });
    const result = await applyIssueImport(
      "danxbot",
      repoLocalPath,
      payloadOf([src]),
    );
    expect(result.issues[0].status).toBe("Blocked");
    expect(result.issues[0].blocked).toEqual({
      reason: "Original blocker text",
      at: "2026-05-14T00:00:00Z",
    });
  });

  it("rewrites waiting_on.by[] when all entries are in the payload", async () => {
    const a = makeIssue({ id: "DX-100", title: "A" });
    const b = makeIssue({
      id: "DX-200",
      title: "B",
      waiting_on: {
        reason: "needs A",
        timestamp: "2026-05-14T00:00:00Z",
        by: ["DX-100"],
      },
    });
    const result = await applyIssueImport(
      "danxbot",
      repoLocalPath,
      payloadOf([a, b]),
    );
    expect(result.issues[1].waiting_on?.by).toEqual(["DX-1"]);
  });

  it("collapses waiting_on to null when every by[] entry is outside the payload", async () => {
    const src = makeIssue({
      id: "DX-100",
      waiting_on: {
        reason: "needs X",
        timestamp: "2026-05-14T00:00:00Z",
        by: ["DX-999"], // not in payload
      },
    });
    const result = await applyIssueImport(
      "danxbot",
      repoLocalPath,
      payloadOf([src]),
    );
    expect(result.issues[0].waiting_on).toBeNull();
  });

  it("drops conflict_on[] entries not in the payload", async () => {
    const a = makeIssue({ id: "DX-100", title: "A" });
    const b = makeIssue({
      id: "DX-200",
      title: "B",
      conflict_on: [
        { id: "DX-100", reason: "shared file" }, // in payload
        { id: "DX-999", reason: "orphan mutex" }, // dropped
      ],
    });
    const result = await applyIssueImport(
      "danxbot",
      repoLocalPath,
      payloadOf([a, b]),
    );
    expect(result.issues[1].conflict_on).toEqual([
      { id: "DX-1", reason: "shared file" },
    ]);
  });

  it("rewrites retro.action_item_ids that are in the payload + drops the rest", async () => {
    const a = makeIssue({ id: "DX-100", title: "Followup" });
    const b = makeIssue({
      id: "DX-200",
      title: "Main",
      retro: {
        good: "g",
        bad: "b",
        action_item_ids: ["DX-100", "DX-999"], // 999 dropped
        commits: [],
      },
    });
    const result = await applyIssueImport(
      "danxbot",
      repoLocalPath,
      payloadOf([a, b]),
    );
    expect(result.issues[1].retro.action_item_ids).toEqual(["DX-1"]);
  });

  it("resets dispatch / triage / external_id / assigned_agent / history on every pasted card", async () => {
    const src = {
      ...makeIssue({ id: "DX-100" }),
      // Force-write fields the strip path doesn't normally see in a
      // fresh fixture, so the rewriter has work to do.
      external_id: "trello-x",
      tracker: "trello",
      assigned_agent: "phil" as string | null,
    };
    const result = await applyIssueImport(
      "danxbot",
      repoLocalPath,
      payloadOf([src as Issue]),
    );
    const out = result.issues[0];
    expect(out.dispatch).toBeNull();
    expect(out.external_id).toBe("");
    expect(out.assigned_agent).toBeNull();
    expect(out.history).toEqual([]);
    expect(out.triage.history).toEqual([]);
    expect(out.triage.last_status).toBe("");
  });

  it("publishes one issue:updated SSE event per imported card", async () => {
    const epic = makeIssue({
      id: "DX-100",
      type: "Epic",
      children: ["DX-200", "DX-201"],
    });
    const phase1 = makeIssue({ id: "DX-200", parent_id: "DX-100" });
    const phase2 = makeIssue({ id: "DX-201", parent_id: "DX-100" });
    await applyIssueImport(
      "danxbot",
      repoLocalPath,
      payloadOf([epic, phase1, phase2]),
    );
    expect(mockEventBusPublish).toHaveBeenCalledTimes(3);
    const topics = mockEventBusPublish.mock.calls.map(
      (c) => (c[0] as { topic: string }).topic,
    );
    expect(topics).toEqual([
      "issue:updated",
      "issue:updated",
      "issue:updated",
    ]);
  });
});

describe("applyIssueImport — validation failures", () => {
  function payloadOf(issues: Issue[]): IssueCopyPayload {
    return { schema_version: 11, issues };
  }

  it("rejects a non-object body with 400", async () => {
    await expect(
      applyIssueImport("danxbot", repoLocalPath, "nope"),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "Body must be a JSON object" },
    });
  });

  it("rejects a missing schema_version with 400", async () => {
    await expect(
      applyIssueImport("danxbot", repoLocalPath, { issues: [] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a future schema_version with 400", async () => {
    await expect(
      applyIssueImport("danxbot", repoLocalPath, {
        schema_version: 109,
        issues: [],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a payload with duplicate source ids", async () => {
    const dup1 = makeIssue({ id: "DX-100", title: "first" });
    const dup2 = makeIssue({ id: "DX-100", title: "second" });
    await expect(
      applyIssueImport(
        "danxbot",
        repoLocalPath,
        payloadOf([dup1, dup2]),
      ),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: expect.stringContaining("duplicates an earlier entry") },
    });
  });

  it("rejects empty issues[] with 400", async () => {
    await expect(
      applyIssueImport("danxbot", repoLocalPath, payloadOf([])),
    ).rejects.toMatchObject({
      status: 400,
      body: { error: "issues must be a non-empty array" },
    });
  });

  it("rejects an issue whose id does not match <PREFIX>-N", async () => {
    await expect(
      applyIssueImport("danxbot", repoLocalPath, {
        schema_version: 11,
        issues: [{ id: "not-an-id" }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rolls back prior disk writes when a later write fails mid-loop", async () => {
    // Force a real write failure on the SECOND card. Allocation order
    // is DX-1, DX-2; the second card's atomic write goes through
    // `${target}.tmp` first. Pre-create a directory at `DX-2.yml.tmp`
    // so `writeFileSync` against that path throws EISDIR — a real
    // syscall fault, no mocking the fs surface (ESM blocks vi.spyOn
    // on `node:fs` exports).
    ensureIssuesDirs(repoLocalPath);
    mkdirSync(
      resolve(repoLocalPath, ".danxbot/issues/open/DX-2.yml.tmp"),
    );
    const a = makeIssue({ id: "DX-100", title: "first" });
    const b = makeIssue({ id: "DX-200", title: "second" });
    await expect(
      applyIssueImport("danxbot", repoLocalPath, payloadOf([a, b])),
    ).rejects.toMatchObject({ status: 500 });
    // First card's destination must be rolled back — the import is
    // observably atomic either-all-or-none. The leftover `.tmp`
    // directory is fine; only `<id>.yml` files matter for the
    // observable state.
    expect(existsSync(issuePath(repoLocalPath, "DX-1", "open"))).toBe(false);
    expect(existsSync(issuePath(repoLocalPath, "DX-2", "open"))).toBe(false);
  });

  it("is atomic — a mid-batch validation failure leaves zero YAMLs written", async () => {
    const ok = makeIssue({ id: "DX-100", title: "ok" });
    // Second issue carries an unrecognized `status` value — `parseIssue`
    // round-trip in phase 2 rejects with 400 BEFORE any disk write
    // begins. `priority` and other clampable numeric fields are
    // forgiving by design and not a useful failure trigger here.
    const broken = {
      ...makeIssue({ id: "DX-200", title: "broken" }),
      status: "Bogus" as unknown as Issue["status"],
    };
    await expect(
      applyIssueImport(
        "danxbot",
        repoLocalPath,
        payloadOf([ok, broken as Issue]),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const openDir = resolve(repoLocalPath, ".danxbot/issues/open");
    const entries = existsSync(openDir) ? readdirSync(openDir) : [];
    expect(entries).toEqual([]);
  });
});

// ── HTTP handler — handleImportIssues ────────────────────────────────

describe("handleImportIssues — HTTP route", () => {
  function payloadOf(issues: Issue[]): IssueCopyPayload {
    return { schema_version: 11, issues };
  }

  function depsForRepo() {
    return buildDeps({
      repos: [
        {
          name: "danxbot",
          url: "https://example.com/danxbot.git",
          localPath: repoLocalPath,
          hostPath: repoLocalPath,
          workerPort: 5562,
        },
      ],
    });
  }

  it("rejects requests without a Bearer token (401)", async () => {
    const req = createMockReqWithBody(
      "POST",
      payloadOf([makeIssue()]) as unknown as Record<string, unknown>,
    );
    const res = createMockRes();
    await handleImportIssues(req, res, "danxbot", depsForRepo());
    expect(res._getStatusCode()).toBe(401);
  });

  it("rejects requests with a non-user Bearer token (401)", async () => {
    const req = createMockReqWithBody(
      "POST",
      payloadOf([makeIssue()]) as unknown as Record<string, unknown>,
    );
    req.headers.authorization = "Bearer dispatch-token-xyz";
    const res = createMockRes();
    await handleImportIssues(req, res, "danxbot", depsForRepo());
    expect(res._getStatusCode()).toBe(401);
  });

  it("rejects requests missing ?repo= (400)", async () => {
    const req = createMockReqWithBody(
      "POST",
      payloadOf([makeIssue()]) as unknown as Record<string, unknown>,
    );
    req.headers.authorization = "Bearer user-alice";
    const res = createMockRes();
    await handleImportIssues(req, res, null, depsForRepo());
    expect(res._getStatusCode()).toBe(400);
  });

  it("rejects unknown repo (404)", async () => {
    const req = createMockReqWithBody(
      "POST",
      payloadOf([makeIssue()]) as unknown as Record<string, unknown>,
    );
    req.headers.authorization = "Bearer user-alice";
    const res = createMockRes();
    await handleImportIssues(req, res, "no-such-repo", depsForRepo());
    expect(res._getStatusCode()).toBe(404);
  });

  it("returns 200 with {topId, issues} on success", async () => {
    const payload = payloadOf([
      makeIssue({ id: "DX-100", title: "imported" }),
    ]);
    const req = createMockReqWithBody(
      "POST",
      payload as unknown as Record<string, unknown>,
    );
    req.headers.authorization = "Bearer user-alice";
    const res = createMockRes();
    await handleImportIssues(req, res, "danxbot", depsForRepo());
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody()) as {
      topId: string;
      issues: Issue[];
    };
    expect(body.topId).toBe("DX-1");
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].title).toBe("imported");
  });
});

// ── HTTP handler — handleGetIssueSubtree ─────────────────────────────

describe("handleGetIssueSubtree — HTTP route", () => {
  function depsForRepo() {
    return buildDeps({
      repos: [
        {
          name: "danxbot",
          url: "https://example.com/danxbot.git",
          localPath: repoLocalPath,
          hostPath: repoLocalPath,
          workerPort: 5562,
        },
      ],
    });
  }

  it("rejects requests without a Bearer token (401)", async () => {
    writeIssueFixture(repoLocalPath, makeIssue());
    const req = createMockReqWithBody("GET");
    const res = createMockRes();
    await handleGetIssueSubtree(req, res, "DX-1", "danxbot", depsForRepo());
    expect(res._getStatusCode()).toBe(401);
  });

  it("returns 200 with the payload on success", async () => {
    writeIssueFixture(repoLocalPath, makeIssue());
    const req = createMockReqWithBody("GET");
    req.headers.authorization = "Bearer user-alice";
    const res = createMockRes();
    await handleGetIssueSubtree(req, res, "DX-1", "danxbot", depsForRepo());
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody()) as IssueCopyPayload;
    expect(body.schema_version).toBe(11);
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].id).toBe("DX-1");
  });

  it("returns 404 when the root id is missing", async () => {
    const req = createMockReqWithBody("GET");
    req.headers.authorization = "Bearer user-alice";
    const res = createMockRes();
    await handleGetIssueSubtree(
      req,
      res,
      "DX-999",
      "danxbot",
      depsForRepo(),
    );
    expect(res._getStatusCode()).toBe(404);
  });

  it("returns 400 when ?repo= is omitted", async () => {
    const req = createMockReqWithBody("GET");
    req.headers.authorization = "Bearer user-alice";
    const res = createMockRes();
    await handleGetIssueSubtree(req, res, "DX-1", null, depsForRepo());
    expect(res._getStatusCode()).toBe(400);
  });

  it("returns 404 when the repo is not configured", async () => {
    const req = createMockReqWithBody("GET");
    req.headers.authorization = "Bearer user-alice";
    const res = createMockRes();
    await handleGetIssueSubtree(
      req,
      res,
      "DX-1",
      "no-such-repo",
      depsForRepo(),
    );
    expect(res._getStatusCode()).toBe(404);
  });
});
