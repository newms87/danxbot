import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { handleReRunEvaluator } from "./re-run-evaluator-route.js";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import type { AgentRecord, AgentBrokenState } from "../settings-file.js";

function repo() {
  return makeRepoContext({
    name: "danxbot",
    localPath: "/repos/danxbot",
    hostPath: "/repos/danxbot",
    issuePrefix: "DX",
  });
}

function brokenAgent(over?: Partial<AgentBrokenState>): AgentRecord {
  return {
    type: "agent",
    bio: "test",
    capabilities: ["issue-worker"],
    schedule: {
      tz: "UTC",
      always_on: true,
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
      sun: [],
    },
    enabled: true,
    broken: {
      reason: "Agent dispatch failing — investigation pending",
      suggested_steps: [],
      set_at: "2026-05-14T10:00:00Z",
      evaluator_status: "failed",
      evaluator_dispatch_id: "old-dispatch",
      ...over,
    },
    strikes: { count: 3, history: [] },
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-14T10:00:00Z",
  } as AgentRecord;
}

function stubMutate(initial: Record<string, AgentRecord>) {
  const state = { agents: initial };
  const mutate = vi.fn(
    async (
      _localPath: string,
      mutator: (
        current: Record<string, AgentRecord>,
      ) => Record<string, AgentRecord>,
      _writtenBy: string,
    ) => {
      state.agents = mutator({ ...state.agents });
      return { agents: state.agents } as never;
    },
  );
  return { state, mutate };
}

describe("handleReRunEvaluator (worker)", () => {
  let emit: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    emit = vi.fn();
  });

  it("400 on missing or non-string name", async () => {
    const m = stubMutate({ alice: brokenAgent() });
    for (const body of [{}, { name: "" }, { name: 42 }]) {
      const req = createMockReqWithBody("POST", body);
      const res = createMockRes();
      await handleReRunEvaluator(req, res, repo(), {
        mutate: m.mutate,
        emit: emit as never,
      });
      expect(res._getStatusCode()).toBe(400);
    }
    expect(emit).not.toHaveBeenCalled();
  });

  it("404 when agent does not exist in the repo", async () => {
    const m = stubMutate({});
    const req = createMockReqWithBody("POST", { name: "alice" });
    const res = createMockRes();
    await handleReRunEvaluator(req, res, repo(), {
      mutate: m.mutate,
      emit: emit as never,
    });
    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody()).error).toMatch(/alice/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("400 when the agent is not in broken state", async () => {
    const m = stubMutate({
      alice: { ...brokenAgent(), broken: null } as AgentRecord,
    });
    const req = createMockReqWithBody("POST", { name: "alice" });
    const res = createMockRes();
    await handleReRunEvaluator(req, res, repo(), {
      mutate: m.mutate,
      emit: emit as never,
    });
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/broken state/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("400 when the evaluator is already running (anti-double-click guard)", async () => {
    const m = stubMutate({
      alice: brokenAgent({
        evaluator_status: "running",
        evaluator_dispatch_id: "in-flight",
      }),
    });
    const req = createMockReqWithBody("POST", { name: "alice" });
    const res = createMockRes();
    await handleReRunEvaluator(req, res, repo(), {
      mutate: m.mutate,
      emit: emit as never,
    });
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/already.*running/i);
    expect(emit).not.toHaveBeenCalled();
    // State left untouched.
    expect(m.state.agents.alice.broken?.evaluator_status).toBe("running");
    expect(m.state.agents.alice.broken?.evaluator_dispatch_id).toBe(
      "in-flight",
    );
  });

  it("resets evaluator_status to pending + clears dispatch_id + emits broken-transition", async () => {
    const m = stubMutate({ alice: brokenAgent() });
    const req = createMockReqWithBody("POST", { name: "alice" });
    const res = createMockRes();
    await handleReRunEvaluator(req, res, repo(), {
      mutate: m.mutate,
      emit: emit as never,
    });
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({
      status: "queued",
      repo: "danxbot",
      agent: "alice",
    });
    const broken = m.state.agents.alice.broken!;
    expect(broken.evaluator_status).toBe("pending");
    expect(broken.evaluator_dispatch_id).toBeNull();
    // The default reason from Phase 2 stays — re-run does NOT clear it.
    expect(broken.reason).toBe(
      "Agent dispatch failing — investigation pending",
    );
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("broken-transition", {
      repoName: "danxbot",
      agentName: "alice",
    });
  });

  it("re-runs a completed evaluator (the typical operator path)", async () => {
    const m = stubMutate({
      alice: brokenAgent({
        evaluator_status: "completed",
        evaluator_dispatch_id: "previous",
        reason: "## Root cause\nold summary",
      }),
    });
    const req = createMockReqWithBody("POST", { name: "alice" });
    const res = createMockRes();
    await handleReRunEvaluator(req, res, repo(), {
      mutate: m.mutate,
      emit: emit as never,
    });
    expect(res._getStatusCode()).toBe(200);
    expect(m.state.agents.alice.broken?.evaluator_status).toBe("pending");
    // Reason is preserved verbatim — the next evaluator overwrites it.
    expect(m.state.agents.alice.broken?.reason).toBe(
      "## Root cause\nold summary",
    );
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("500 + no emit when mutate throws", async () => {
    const failingMutate = vi
      .fn()
      .mockRejectedValue(new Error("disk full"));
    const req = createMockReqWithBody("POST", { name: "alice" });
    const res = createMockRes();
    await handleReRunEvaluator(req, res, repo(), {
      mutate: failingMutate as never,
      emit: emit as never,
    });
    expect(res._getStatusCode()).toBe(500);
    expect(emit).not.toHaveBeenCalled();
  });
});
