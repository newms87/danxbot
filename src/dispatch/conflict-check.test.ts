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
    schema_version: 6,
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
    expect(extractJsonVerdict('{"ok":true,"reason":"all good"}')).toEqual({
      ok: true,
      reason: "all good",
    });
  });
  it("parses fenced ```json``` blocks", () => {
    const summary = "Conclusion:\n```json\n{\"ok\":false,\"reason\":\"overlap\",\"blocked_by\":[\"DX-1\"]}\n```\n";
    expect(extractJsonVerdict(summary)).toEqual({
      ok: false,
      reason: "overlap",
      blocked_by: ["DX-1"],
    });
  });
  it("returns null for empty / non-string input", () => {
    expect(extractJsonVerdict(null)).toBeNull();
    expect(extractJsonVerdict("")).toBeNull();
  });
  it("returns null for un-parseable JSON", () => {
    expect(extractJsonVerdict("not json at all")).toBeNull();
  });
});

describe("coerceVerdict", () => {
  it("returns null for non-objects", () => {
    expect(coerceVerdict(null)).toBeNull();
    expect(coerceVerdict("foo")).toBeNull();
    expect(coerceVerdict(42)).toBeNull();
  });
  it("returns null when ok is missing", () => {
    expect(coerceVerdict({ reason: "x" })).toBeNull();
  });
  it("strips invalid blocked_by entries", () => {
    expect(
      coerceVerdict({
        ok: false,
        reason: "x",
        blocked_by: ["DX-1", null, "", "DX-2"],
      }),
    ).toEqual({ ok: false, reason: "x", blocked_by: ["DX-1", "DX-2"] });
  });
  it("ignores blocked_by when ok=true", () => {
    expect(
      coerceVerdict({ ok: true, reason: "x", blocked_by: ["DX-1"] }),
    ).toEqual({ ok: true, reason: "x" });
  });
  it("defaults missing reason to empty string", () => {
    expect(coerceVerdict({ ok: true })).toEqual({ ok: true, reason: "" });
  });
});

describe("runConflictCheck", () => {
  it("happy path: triage agent returns {ok: true} via summary", async () => {
    const dispatchMock = vi.fn().mockImplementation(async (input) => {
      const job = fakeJob({
        status: "completed",
        summary: '{"ok":true,"reason":"no overlap"}',
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
    expect(result.ok).toBe(true);
    expect(dispatchMock).toHaveBeenCalledOnce();
  });

  it("triage agent returns {ok: false, blocked_by: [...]} via summary", async () => {
    const dispatchMock = vi.fn().mockImplementation(async (input) => {
      const job = fakeJob({
        status: "completed",
        summary:
          '{"ok":false,"reason":"both touch launcher.ts","blocked_by":["DX-141"]}',
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
    expect(result.ok).toBe(false);
    expect(result.blocked_by).toEqual(["DX-141"]);
  });

  it("malformed summary → conservative ok=false", async () => {
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
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/malformed/i);
  });

  it("non-completed status (e.g. timeout) → conservative ok=false", async () => {
    const dispatchMock = vi.fn().mockImplementation(async (input) => {
      const job = fakeJob({
        status: "timeout",
        summary: "Agent timed out after 90s",
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
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/did not complete cleanly/i);
    expect(result.reason).toMatch(/timeout/i);
  });

  it("dispatch throws → conservative ok=false (no agent ran)", async () => {
    const dispatchMock = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await runConflictCheck(
      {
        repo: fakeRepo(),
        candidate: issue("DX-100"),
        inProgress: [issue("DX-141")],
      },
      { dispatch: dispatchMock, dispatchId: "did" },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/failed to spawn/i);
  });

  it("zero in-progress → short-circuits to ok=true without spawning", async () => {
    const dispatchMock = vi.fn();
    const result = await runConflictCheck(
      {
        repo: fakeRepo(),
        candidate: issue("DX-100"),
        inProgress: [],
      },
      { dispatch: dispatchMock, dispatchId: "did" },
    );
    expect(result.ok).toBe(true);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("awaits the async onComplete callback rather than reading dispatch's resolved 'running' job (DX-200 review fix)", async () => {
    // Production `dispatch()` resolves immediately with status="running"
    // and fires onComplete later when the agent exits. The helper
    // MUST wait for the onComplete payload, not race the dispatch's
    // resolution. Simulate this by deferring the onComplete call.
    const dispatchMock = vi.fn().mockImplementation(async (input) => {
      const runningJob = fakeJob({
        status: "running",
        summary: "",
      });
      // Fire onComplete a few microtasks later — same shape as the
      // real launcher.
      setTimeout(() => {
        input.onComplete?.(
          fakeJob({
            status: "completed",
            summary: '{"ok":true,"reason":"async ok"}',
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
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("async ok");
  });

  it("extractJsonVerdict survives prose-prepended JSON (agent reasoning + JSON)", async () => {
    const dispatchMock = vi.fn().mockImplementation(async (input) => {
      const job = fakeJob({
        status: "completed",
        summary:
          'After reviewing both YAMLs I see the candidate touches dashboard files only. {"ok":true,"reason":"disjoint"}',
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
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("disjoint");
  });

  it("never-completing dispatch → grace-window timeout returns conservative ok=false", async () => {
    // Stub dispatch to NEVER fire onComplete. The 90s+5s grace window
    // is too long for a unit test, so we don't actually wait — instead
    // we patch the helper's timeout. Compose with shorter grace via
    // a wrapper test: rely on the timeoutPromise path. We simulate the
    // grace expiry by resolving the test fast — using vi.useFakeTimers.
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
      // Advance past the grace window (90_000 + 5_000 = 95_000ms).
      await vi.advanceTimersByTimeAsync(95_001);
      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/grace window/i);
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
        summary: '{"ok":true,"reason":"x"}',
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
