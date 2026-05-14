import { describe, it, expect, vi } from "vitest";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { handleClearBroken } from "./clear-broken-route.js";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import type {
  AgentRecord,
  AgentBrokenState,
  AgentStrikeEntry,
} from "../settings-file.js";

function repo() {
  return makeRepoContext({
    name: "danxbot",
    localPath: "/repos/danxbot",
    hostPath: "/repos/danxbot",
    issuePrefix: "DX",
  });
}

function strike(over?: Partial<AgentStrikeEntry>): AgentStrikeEntry {
  return {
    dispatch_id: "d-1",
    issue_id: "DX-1",
    terminal_status: "failed",
    timestamp: "2026-05-14T08:00:00Z",
    raw_error: "boom",
    ...over,
  };
}

function brokenAgent(over?: {
  broken?: Partial<AgentBrokenState> | null;
  strikes?: { count: number; history: AgentStrikeEntry[] };
}): AgentRecord {
  const explicitlyNull = over !== undefined && over.broken === null;
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
    broken: explicitlyNull
      ? null
      : {
          reason: "Agent dispatch failing — investigation pending",
          suggested_steps: [],
          set_at: "2026-05-14T10:00:00Z",
          evaluator_status: "completed",
          evaluator_dispatch_id: null,
          ...(over?.broken ?? {}),
        },
    strikes: over?.strikes ?? {
      count: 3,
      history: [strike({ dispatch_id: "d-1" }), strike({ dispatch_id: "d-2" }), strike({ dispatch_id: "d-3" })],
    },
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

describe("handleClearBroken (worker)", () => {
  it("400 on missing or non-string name", async () => {
    const m = stubMutate({ alice: brokenAgent() });
    for (const body of [{}, { name: "" }, { name: 42 }]) {
      const req = createMockReqWithBody("POST", body);
      const res = createMockRes();
      await handleClearBroken(req, res, repo(), { mutate: m.mutate });
      expect(res._getStatusCode()).toBe(400);
    }
    // State unchanged.
    expect(m.state.agents.alice.broken).not.toBeNull();
    expect(m.state.agents.alice.strikes.count).toBe(3);
  });

  it("404 when agent does not exist in the repo", async () => {
    const m = stubMutate({});
    const req = createMockReqWithBody("POST", { name: "alice" });
    const res = createMockRes();
    await handleClearBroken(req, res, repo(), { mutate: m.mutate });
    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody()).error).toMatch(/alice/);
  });

  it("400 when the agent is not in broken state", async () => {
    const m = stubMutate({ alice: brokenAgent({ broken: null }) });
    const req = createMockReqWithBody("POST", { name: "alice" });
    const res = createMockRes();
    await handleClearBroken(req, res, repo(), { mutate: m.mutate });
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/not.*broken/i);
    // Strikes left alone — only clear on actual broken transition.
    expect(m.state.agents.alice.strikes.count).toBe(3);
  });

  it("clears broken + zeroes strike count + preserves strike history for audit + bumps updated_at", async () => {
    const m = stubMutate({ alice: brokenAgent() });
    const originalUpdatedAt = m.state.agents.alice.updated_at;
    const req = createMockReqWithBody("POST", { name: "alice" });
    const res = createMockRes();
    await handleClearBroken(req, res, repo(), { mutate: m.mutate });

    expect(res._getStatusCode()).toBe(200);
    const body = JSON.parse(res._getBody());
    expect(body).toMatchObject({
      status: "cleared",
      repo: "danxbot",
      agent: "alice",
    });
    // Strike summary echoed back — the dashboard proxy forwards the
    // worker's response body verbatim so the SPA's success toast can
    // surface how many strikes were cleared.
    expect(body.cleared_strikes).toMatchObject({
      count: 3,
      history: expect.arrayContaining([
        expect.objectContaining({ dispatch_id: "d-1" }),
        expect.objectContaining({ dispatch_id: "d-2" }),
        expect.objectContaining({ dispatch_id: "d-3" }),
      ]),
    });

    const alice = m.state.agents.alice;
    expect(alice.broken).toBeNull();
    expect(alice.strikes.count).toBe(0);
    // History preserved on the record — STRIKES_HISTORY_CAP=3 window
    // doubles as the immediate-forensics audit log.
    expect(alice.strikes.history).toHaveLength(3);
    // Lifecycle stamp moves forward — a future refactor that drops the
    // bump would fail this assertion.
    expect(alice.updated_at).not.toBe(originalUpdatedAt);
  });

  it("500 when mutate throws", async () => {
    const failingMutate = vi
      .fn()
      .mockRejectedValue(new Error("disk full"));
    const req = createMockReqWithBody("POST", { name: "alice" });
    const res = createMockRes();
    await handleClearBroken(req, res, repo(), {
      mutate: failingMutate as never,
    });
    expect(res._getStatusCode()).toBe(500);
  });
});
