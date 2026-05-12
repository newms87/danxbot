import { describe, expect, it, vi } from "vitest";
import {
  coerceVerdict,
  extractJsonVerdict,
  runConflictCheck,
} from "./conflict-check.js";
import type { AgentJob } from "../agent/agent-types.js";
import type { Issue } from "../issue-tracker/interface.js";
import type { RepoContext } from "../types.js";

function issue(
  id: string,
  overrides: Partial<Issue> = {},
): Issue {
  return {
    schema_version: 7,
    tracker: "memory",
    id,
    external_id: "",
    parent_id: null,
    children: [],
    dispatch: null,
    status: "ToDo",
    type: "Feature",
    title: id,
    description: "",
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
    assigned_agent: null,
    waiting_on: null,
    blocked: null,
    requires_human: null,
    conflict_on: [],
    history: [],
    ...overrides,
  };
}

function fakeRepo(): RepoContext {
  return {
    name: "danxbot",
    localPath: "/tmp/fake-repo",
    issuePrefix: "DX",
    workerPort: 5562,
  } as unknown as RepoContext;
}

function fakeJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: "job-conflict",
    status: "completed",
    summary: "{}",
    startedAt: new Date(),
    ...overrides,
  } as AgentJob;
}

describe("extractJsonVerdict", () => {
  it("parses bare JSON", () => {
    expect(
      extractJsonVerdict('{"kind":"ok","reason":"all good"}'),
    ).toEqual({ kind: "ok", reason: "all good" });
  });
  it("parses fenced ```json``` blocks", () => {
    const summary =
      'Conclusion:\n```json\n{"kind":"conflict","reason":"overlap","partners":[{"id":"DX-1","reason":"x"}]}\n```\n';
    expect(extractJsonVerdict(summary)).toEqual({
      kind: "conflict",
      reason: "overlap",
      partners: [{ id: "DX-1", reason: "x" }],
    });
  });
  it("returns null for empty / non-string input", () => {
    expect(extractJsonVerdict(null)).toBeNull();
    expect(extractJsonVerdict("")).toBeNull();
  });
  it("returns null for un-parseable JSON", () => {
    expect(extractJsonVerdict("not json at all")).toBeNull();
  });
  it("survives prose-prepended JSON", () => {
    expect(
      extractJsonVerdict(
        'After reviewing both YAMLs I see only dashboard files. {"kind":"ok","reason":"disjoint"}',
      ),
    ).toEqual({ kind: "ok", reason: "disjoint" });
  });
});

describe("coerceVerdict", () => {
  it("returns null for non-objects", () => {
    expect(coerceVerdict(null)).toBeNull();
    expect(coerceVerdict("foo")).toBeNull();
    expect(coerceVerdict(42)).toBeNull();
  });
  it("returns null when kind is unknown", () => {
    expect(coerceVerdict({ kind: "bogus", reason: "x" })).toBeNull();
  });
  it("parses ok verdict", () => {
    expect(coerceVerdict({ kind: "ok", reason: "x" })).toEqual({
      kind: "ok",
      reason: "x",
    });
  });
  it("defaults missing reason to empty string", () => {
    expect(coerceVerdict({ kind: "ok" })).toEqual({ kind: "ok", reason: "" });
  });
  it("parses conflict verdict with partners", () => {
    expect(
      coerceVerdict({
        kind: "conflict",
        reason: "shared module",
        partners: [
          { id: "DX-1", reason: "fn rename" },
          { id: "DX-2", reason: "signature change" },
        ],
      }),
    ).toEqual({
      kind: "conflict",
      reason: "shared module",
      partners: [
        { id: "DX-1", reason: "fn rename" },
        { id: "DX-2", reason: "signature change" },
      ],
    });
  });
  it("dedupes conflict partners by id", () => {
    const r = coerceVerdict({
      kind: "conflict",
      reason: "x",
      partners: [
        { id: "DX-1", reason: "first" },
        { id: "DX-1", reason: "dup — ignored" },
      ],
    });
    expect(r).toEqual({
      kind: "conflict",
      reason: "x",
      partners: [{ id: "DX-1", reason: "first" }],
    });
  });
  it("strips invalid conflict partners (missing id, missing reason)", () => {
    expect(
      coerceVerdict({
        kind: "conflict",
        reason: "x",
        partners: [
          { id: "DX-1", reason: "ok" },
          { reason: "no id" },
          { id: "DX-2" }, // no reason
          { id: "", reason: "empty id" },
          null,
        ],
      }),
    ).toEqual({
      kind: "conflict",
      reason: "x",
      partners: [{ id: "DX-1", reason: "ok" }],
    });
  });
  it("returns null for conflict verdict with empty partners", () => {
    expect(
      coerceVerdict({ kind: "conflict", reason: "x", partners: [] }),
    ).toBeNull();
  });
  it("parses wait_for verdict with all required fields", () => {
    expect(
      coerceVerdict({
        kind: "wait_for",
        reason: "DX-1 defines the interface",
        wait_for: ["DX-1"],
        consumed_artifact: "AgentLock interface",
        cycle_audit: { walked: ["DX-1"] },
      }),
    ).toEqual({
      kind: "wait_for",
      reason: "DX-1 defines the interface",
      wait_for: ["DX-1"],
      consumed_artifact: "AgentLock interface",
      cycle_audit: { walked: ["DX-1"] },
    });
  });
  it("demotes wait_for to null when consumed_artifact is empty / missing", () => {
    expect(
      coerceVerdict({
        kind: "wait_for",
        reason: "x",
        wait_for: ["DX-1"],
        cycle_audit: { walked: [] },
      }),
    ).toBeNull();
    expect(
      coerceVerdict({
        kind: "wait_for",
        reason: "x",
        wait_for: ["DX-1"],
        consumed_artifact: "   ",
        cycle_audit: { walked: [] },
      }),
    ).toBeNull();
  });
  it("returns null for wait_for verdict with empty wait_for", () => {
    expect(
      coerceVerdict({
        kind: "wait_for",
        reason: "x",
        wait_for: [],
        consumed_artifact: "y",
        cycle_audit: { walked: [] },
      }),
    ).toBeNull();
  });
  it("accepts cycle_audit shape as bare array (legacy-friendly)", () => {
    expect(
      coerceVerdict({
        kind: "wait_for",
        reason: "x",
        wait_for: ["DX-1"],
        consumed_artifact: "X",
        cycle_audit: ["DX-1", "DX-2"],
      }),
    ).toEqual({
      kind: "wait_for",
      reason: "x",
      wait_for: ["DX-1"],
      consumed_artifact: "X",
      cycle_audit: { walked: ["DX-1", "DX-2"] },
    });
  });
});

describe("runConflictCheck", () => {
  it("happy path: agent returns kind:ok", async () => {
    const dispatchMock = vi.fn().mockImplementation(async (input) => {
      const job = fakeJob({
        status: "completed",
        summary: '{"kind":"ok","reason":"no overlap"}',
      });
      input.onComplete?.(job);
      return { dispatchId: "did", job };
    });
    const result = await runConflictCheck(
      {
        repo: fakeRepo(),
        candidate: issue("DX-100"),
        inProgress: [issue("DX-141")],
      },
      { dispatch: dispatchMock, dispatchId: "did" },
    );
    expect(result.kind).toBe("ok");
    expect(dispatchMock).toHaveBeenCalledOnce();
  });

  it("agent returns kind:conflict with partners", async () => {
    const dispatchMock = vi.fn().mockImplementation(async (input) => {
      const job = fakeJob({
        status: "completed",
        summary:
          '{"kind":"conflict","reason":"both rewrite launcher.ts","partners":[{"id":"DX-141","reason":"shared fn"}]}',
      });
      input.onComplete?.(job);
      return { dispatchId: "did", job };
    });
    const result = await runConflictCheck(
      {
        repo: fakeRepo(),
        candidate: issue("DX-100"),
        inProgress: [issue("DX-141")],
      },
      { dispatch: dispatchMock, dispatchId: "did" },
    );
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.partners).toEqual([{ id: "DX-141", reason: "shared fn" }]);
    }
  });

  it("malformed summary → transient conflict (empty partners, no stamp)", async () => {
    const dispatchMock = vi.fn().mockImplementation(async (input) => {
      const job = fakeJob({ status: "completed", summary: "garbage" });
      input.onComplete?.(job);
      return { dispatchId: "did", job };
    });
    const result = await runConflictCheck(
      {
        repo: fakeRepo(),
        candidate: issue("DX-100"),
        inProgress: [issue("DX-141")],
      },
      { dispatch: dispatchMock, dispatchId: "did" },
    );
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.partners).toEqual([]);
      expect(result.reason).toMatch(/malformed/i);
    }
  });

  it("non-completed status (e.g. timeout) → transient conflict (empty partners)", async () => {
    const dispatchMock = vi.fn().mockImplementation(async (input) => {
      const job = fakeJob({
        status: "timeout",
        summary: "Agent timed out after 300s",
      });
      input.onComplete?.(job);
      return { dispatchId: "did", job };
    });
    const result = await runConflictCheck(
      {
        repo: fakeRepo(),
        candidate: issue("DX-100"),
        inProgress: [issue("DX-141")],
      },
      { dispatch: dispatchMock, dispatchId: "did" },
    );
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.partners).toEqual([]);
      expect(result.reason).toMatch(/did not complete cleanly/i);
    }
  });

  it("dispatch throws → transient conflict (empty partners)", async () => {
    const dispatchMock = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await runConflictCheck(
      {
        repo: fakeRepo(),
        candidate: issue("DX-100"),
        inProgress: [issue("DX-141")],
      },
      { dispatch: dispatchMock, dispatchId: "did" },
    );
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.partners).toEqual([]);
      expect(result.reason).toMatch(/failed to spawn/i);
    }
  });

  it("zero in-progress → short-circuits to ok without spawning", async () => {
    const dispatchMock = vi.fn();
    const result = await runConflictCheck(
      {
        repo: fakeRepo(),
        candidate: issue("DX-100"),
        inProgress: [],
      },
      { dispatch: dispatchMock, dispatchId: "did" },
    );
    expect(result.kind).toBe("ok");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("awaits the async onComplete callback (DX-200 review fix)", async () => {
    const dispatchMock = vi.fn().mockImplementation(async (input) => {
      const runningJob = fakeJob({ status: "running", summary: "" });
      setTimeout(() => {
        input.onComplete?.(
          fakeJob({
            status: "completed",
            summary: '{"kind":"ok","reason":"async ok"}',
          }),
        );
      }, 5);
      return { dispatchId: "did", job: runningJob };
    });
    const result = await runConflictCheck(
      {
        repo: fakeRepo(),
        candidate: issue("DX-100"),
        inProgress: [issue("DX-141")],
      },
      { dispatch: dispatchMock, dispatchId: "did" },
    );
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.reason).toBe("async ok");
    }
  });

  it("never-completing dispatch → grace-window timeout returns transient conflict", async () => {
    const dispatchMock = vi.fn().mockImplementation(async () => ({
      dispatchId: "did",
      job: fakeJob({ status: "running", summary: "" }),
    }));
    vi.useFakeTimers();
    try {
      const promise = runConflictCheck(
        {
          repo: fakeRepo(),
          candidate: issue("DX-100"),
          inProgress: [issue("DX-141")],
        },
        { dispatch: dispatchMock, dispatchId: "did" },
      );
      // CONFLICT_CHECK_TIMEOUT_MS (300_000) + 5_000 grace.
      await vi.advanceTimersByTimeAsync(305_001);
      const result = await promise;
      expect(result.kind).toBe("conflict");
      if (result.kind === "conflict") {
        expect(result.partners).toEqual([]);
        expect(result.reason).toMatch(/grace window/i);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("stages the candidate + every in-progress YAML under the dispatch's keyed tmpdir", async () => {
    let capturedStaged: { path: string; content: string }[] = [];
    const dispatchMock = vi.fn().mockImplementation(async (input) => {
      capturedStaged = input.stagedFiles ?? [];
      const job = fakeJob({
        status: "completed",
        summary: '{"kind":"ok","reason":"x"}',
      });
      input.onComplete?.(job);
      return { dispatchId: "did", job };
    });
    await runConflictCheck(
      {
        repo: fakeRepo(),
        candidate: issue("DX-100", { description: "candidate body" }),
        inProgress: [issue("DX-141"), issue("DX-142")],
      },
      { dispatch: dispatchMock, dispatchId: "did" },
    );
    expect(capturedStaged).toHaveLength(3);
    expect(capturedStaged[0].path).toContain("candidate.yml");
    expect(capturedStaged[0].path).toContain(
      "/tmp/conflict-check/${DANXBOT_DISPATCH_ID}/",
    );
    expect(capturedStaged[1].path).toContain("in-progress-0.yml");
    expect(capturedStaged[2].path).toContain("in-progress-1.yml");
    expect(capturedStaged[0].content).toContain("DX-100");
    expect(capturedStaged[0].content).toContain("candidate body");
    expect(capturedStaged[1].content).toContain("DX-141");
  });
});
