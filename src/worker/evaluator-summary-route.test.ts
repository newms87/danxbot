import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { handleEvaluatorSummary } from "./evaluator-summary-route.js";
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

/** Build a stub `mutateAgents` against an in-memory agents map. */
function makeStubMutate(initial: Record<string, AgentRecord>) {
  const state = { agents: initial };
  const mutate = vi.fn(
    async (
      _localPath: string,
      mutator: (
        current: Record<string, AgentRecord>,
      ) => Record<string, AgentRecord>,
      _writtenBy: string,
    ) => {
      // Pass a shallow copy so the mutator can mutate freely — mirrors
      // `mutateAgents` semantics.
      state.agents = mutator({ ...state.agents });
      return { agents: state.agents } as never;
    },
  );
  return { state, mutate };
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
      evaluator_status: "running",
      evaluator_dispatch_id: "dispatch-eval-1",
      ...over,
    },
    strikes: { count: 3, history: [] },
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-14T10:00:00Z",
  } as AgentRecord;
}

describe("handleEvaluatorSummary", () => {
  let mutate: ReturnType<typeof makeStubMutate>;
  beforeEach(() => {
    mutate = makeStubMutate({
      alice: brokenAgent(),
    });
  });

  it("400 on malformed body", async () => {
    const req = createMockReqWithBody("POST", undefined);
    // Force a JSON parse failure by writing non-JSON content. The helper
    // serializes via JSON.stringify so an actual parse failure needs a
    // raw read — instead, pass an empty body which `parseBody` accepts
    // as `{}`, then verify the parser rejects missing reason.
    const res = createMockRes();
    await handleEvaluatorSummary(req, res, "dispatch-eval-1", repo(), {
      mutate: mutate.mutate,
    });
    expect(res._getStatusCode()).toBe(400);
    expect(mutate.mutate).not.toHaveBeenCalled();
  });

  it("400 when reason is missing", async () => {
    const req = createMockReqWithBody("POST", {});
    const res = createMockRes();
    await handleEvaluatorSummary(req, res, "dispatch-eval-1", repo(), {
      mutate: mutate.mutate,
    });
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/reason/i);
  });

  it("400 when reason is empty string", async () => {
    const req = createMockReqWithBody("POST", { reason: "   " });
    const res = createMockRes();
    await handleEvaluatorSummary(req, res, "dispatch-eval-1", repo(), {
      mutate: mutate.mutate,
    });
    expect(res._getStatusCode()).toBe(400);
  });

  it("400 when suggested_steps is not an array", async () => {
    const req = createMockReqWithBody("POST", {
      reason: "ok",
      suggested_steps: "not an array",
    });
    const res = createMockRes();
    await handleEvaluatorSummary(req, res, "dispatch-eval-1", repo(), {
      mutate: mutate.mutate,
    });
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/suggested_steps/);
  });

  it("400 when suggested_steps contains a non-string entry", async () => {
    const req = createMockReqWithBody("POST", {
      reason: "ok",
      suggested_steps: ["a", 42],
    });
    const res = createMockRes();
    await handleEvaluatorSummary(req, res, "dispatch-eval-1", repo(), {
      mutate: mutate.mutate,
    });
    expect(res._getStatusCode()).toBe(400);
  });

  it("404 when no agent carries the dispatch id (stale re-run)", async () => {
    // Agents map has no agent with evaluator_dispatch_id="other-id".
    const req = createMockReqWithBody("POST", { reason: "summary text" });
    const res = createMockRes();
    await handleEvaluatorSummary(req, res, "other-id", repo(), {
      mutate: mutate.mutate,
    });
    expect(res._getStatusCode()).toBe(404);
    // Mutator runs (loop-no-write) but produces no targetAgent → 404.
    expect(mutate.mutate).toHaveBeenCalledTimes(1);
    // The agent's broken state should remain unchanged.
    expect(mutate.state.agents.alice.broken?.evaluator_status).toBe("running");
  });

  it("writes reason + suggested_steps + flips evaluator_status to completed on happy path", async () => {
    const req = createMockReqWithBody("POST", {
      reason: "## Root cause\nBranch sync broken",
      suggested_steps: ["Check git auth", "Review failing test"],
    });
    const res = createMockRes();
    await handleEvaluatorSummary(req, res, "dispatch-eval-1", repo(), {
      mutate: mutate.mutate,
    });
    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body).toEqual({
      status: "applied",
      agent: "alice",
      repo: "danxbot",
    });
    const broken = mutate.state.agents.alice.broken!;
    expect(broken.reason).toBe("## Root cause\nBranch sync broken");
    expect(broken.suggested_steps).toEqual([
      "Check git auth",
      "Review failing test",
    ]);
    expect(broken.evaluator_status).toBe("completed");
    // The original strike-3 set_at MUST be preserved — the banner UI
    // displays "broken at" from this field, and the evaluator finished
    // later, not when the agent became broken.
    expect(broken.set_at).toBe("2026-05-14T10:00:00Z");
    // The evaluator_dispatch_id is preserved (audit + re-run can read it).
    expect(broken.evaluator_dispatch_id).toBe("dispatch-eval-1");
  });

  it("defaults suggested_steps to [] when omitted", async () => {
    const req = createMockReqWithBody("POST", { reason: "x" });
    const res = createMockRes();
    await handleEvaluatorSummary(req, res, "dispatch-eval-1", repo(), {
      mutate: mutate.mutate,
    });
    expect(res._getStatusCode()).toBe(200);
    expect(mutate.state.agents.alice.broken?.suggested_steps).toEqual([]);
  });

  it("500 when the mutator throws", async () => {
    const failingMutate = vi
      .fn()
      .mockRejectedValue(new Error("settings file locked"));
    const req = createMockReqWithBody("POST", { reason: "x" });
    const res = createMockRes();
    await handleEvaluatorSummary(req, res, "dispatch-eval-1", repo(), {
      mutate: failingMutate as unknown as typeof mutate.mutate,
    });
    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/settings/i);
  });

  it("targets only the agent whose evaluator_dispatch_id matches (multi-agent map)", async () => {
    mutate = makeStubMutate({
      alice: brokenAgent({ evaluator_dispatch_id: "dispatch-eval-1" }),
      bob: brokenAgent({
        evaluator_dispatch_id: "dispatch-eval-2",
        reason: "Bob's existing reason",
      }),
    });
    const req = createMockReqWithBody("POST", {
      reason: "Alice's summary",
    });
    const res = createMockRes();
    await handleEvaluatorSummary(req, res, "dispatch-eval-1", repo(), {
      mutate: mutate.mutate,
    });
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody()).agent).toBe("alice");
    expect(mutate.state.agents.alice.broken?.reason).toBe("Alice's summary");
    // Bob untouched.
    expect(mutate.state.agents.bob.broken?.reason).toBe(
      "Bob's existing reason",
    );
    expect(mutate.state.agents.bob.broken?.evaluator_status).toBe("running");
  });
});
