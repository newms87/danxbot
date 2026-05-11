import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../dispatch/ttl-timer.js", () => ({
  rearmTtlTimer: vi.fn(),
}));

import { rearmTtlTimer } from "../dispatch/ttl-timer.js";
import {
  HEARTBEAT_INTERVAL_MS,
  startHeartbeat,
  stopHeartbeat,
} from "./agent-status.js";
import type { AgentJob } from "./agent-types.js";

function makeJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: "job-x",
    status: "running",
    summary: "",
    startedAt: new Date(),
    statusUrl: "http://localhost/status",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    recoverCount: 0,
    ...overrides,
  } as AgentJob;
}

describe("startHeartbeat — TTL re-arm hook (DX-289 / Phase 4b.2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default fetch stub so putStatus does not fire real HTTP — tests
    // for the HTTP side live elsewhere; we only assert the re-arm.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(rearmTtlTimer).mockReset();
  });

  it("re-arms the TTL timer on every heartbeat tick when ttlMs + dispatchId are set", () => {
    const job = makeJob({ dispatchId: "dispatch-1", ttlMs: 7_200_000 });
    startHeartbeat(job, "token");

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(rearmTtlTimer).toHaveBeenCalledTimes(1);
    expect(rearmTtlTimer).toHaveBeenCalledWith("dispatch-1", 7_200_000);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(rearmTtlTimer).toHaveBeenCalledTimes(2);

    stopHeartbeat(job);
  });

  it("does NOT call rearmTtlTimer when ttlMs is unset (non-poller dispatch)", () => {
    const job = makeJob({ dispatchId: "dispatch-1" });
    startHeartbeat(job, "token");

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(rearmTtlTimer).not.toHaveBeenCalled();

    stopHeartbeat(job);
  });

  it("does NOT call rearmTtlTimer when dispatchId is unset (defensive guard)", () => {
    const job = makeJob({ ttlMs: 7_200_000 });
    startHeartbeat(job, "token");

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(rearmTtlTimer).not.toHaveBeenCalled();

    stopHeartbeat(job);
  });

  it("stops re-arming once job.status transitions out of 'running'", () => {
    const job = makeJob({ dispatchId: "dispatch-1", ttlMs: 7_200_000 });
    startHeartbeat(job, "token");

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(rearmTtlTimer).toHaveBeenCalledTimes(1);

    job.status = "completed";

    // Next tick observes the terminal status and bails before rearm.
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(rearmTtlTimer).toHaveBeenCalledTimes(1);
  });

  it("no-op when statusUrl is unset (heartbeat does not start)", () => {
    const job = makeJob({
      dispatchId: "dispatch-1",
      ttlMs: 7_200_000,
      statusUrl: undefined,
    });
    startHeartbeat(job, "token");

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(rearmTtlTimer).not.toHaveBeenCalled();
    expect(job.heartbeatInterval).toBeUndefined();
  });
});
