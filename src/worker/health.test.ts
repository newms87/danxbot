import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";

// --- Mocks ---

const mockIsSlackConnected = vi.fn();
const mockGetQueueStats = vi.fn();
const mockGetTotalQueuedCount = vi.fn();

vi.mock("../slack/listener.js", () => ({
  isSlackConnected: (...args: unknown[]) => mockIsSlackConnected(...args),
  getQueueStats: (...args: unknown[]) => mockGetQueueStats(...args),
  getTotalQueuedCount: (...args: unknown[]) => mockGetTotalQueuedCount(...args),
}));

const mockCheckDbConnection = vi.fn();
vi.mock("../db/health.js", () => ({
  checkDbConnection: (...args: unknown[]) => mockCheckDbConnection(...args),
}));

const mockReadFlag = vi.fn().mockReturnValue(null);
vi.mock("../critical-failure.js", () => ({
  readFlag: (...args: unknown[]) => mockReadFlag(...args),
}));

import { getHealthStatus } from "./health.js";

describe("getHealthStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFlag.mockReturnValue(null);
  });

  it("returns 'ok' when DB and Slack are connected", async () => {
    mockCheckDbConnection.mockResolvedValue(true);
    mockIsSlackConnected.mockReturnValue(true);
    mockGetTotalQueuedCount.mockReturnValue(0);
    mockGetQueueStats.mockReturnValue({});

    const repo = makeRepoContext({ slack: { enabled: true, botToken: "x", appToken: "x", channelId: "C" } });
    const result = await getHealthStatus(repo);

    expect(result.status).toBe("ok");
    expect(result.repo).toBe("test-repo");
    expect(result.db_connected).toBe(true);
    expect(result.slack_connected).toBe(true);
    expect(result.slack_expected).toBe(true);
  });

  it("returns 'degraded' when DB is down", async () => {
    mockCheckDbConnection.mockResolvedValue(false);
    mockIsSlackConnected.mockReturnValue(true);
    mockGetTotalQueuedCount.mockReturnValue(0);
    mockGetQueueStats.mockReturnValue({});

    const repo = makeRepoContext();
    const result = await getHealthStatus(repo);

    expect(result.status).toBe("degraded");
    expect(result.db_connected).toBe(false);
  });

  it("returns 'degraded' when Slack expected but not connected", async () => {
    mockCheckDbConnection.mockResolvedValue(true);
    mockIsSlackConnected.mockReturnValue(false);
    mockGetTotalQueuedCount.mockReturnValue(0);
    mockGetQueueStats.mockReturnValue({});

    const repo = makeRepoContext({ slack: { enabled: true, botToken: "x", appToken: "x", channelId: "C" } });
    const result = await getHealthStatus(repo);

    expect(result.status).toBe("degraded");
    expect(result.slack_connected).toBe(false);
    expect(result.slack_expected).toBe(true);
  });

  it("returns 'ok' when Slack not expected and not connected", async () => {
    mockCheckDbConnection.mockResolvedValue(true);
    mockIsSlackConnected.mockReturnValue(false);
    mockGetTotalQueuedCount.mockReturnValue(0);
    mockGetQueueStats.mockReturnValue({});

    const repo = makeRepoContext({ slack: { enabled: false, botToken: "", appToken: "", channelId: "" } });
    const result = await getHealthStatus(repo);

    expect(result.status).toBe("ok");
    expect(result.slack_connected).toBe(false);
    expect(result.slack_expected).toBe(false);
  });

  it("includes memory, uptime, and queue stats", async () => {
    mockCheckDbConnection.mockResolvedValue(true);
    mockIsSlackConnected.mockReturnValue(true);
    mockGetTotalQueuedCount.mockReturnValue(3);
    mockGetQueueStats.mockReturnValue({ "t1": 2, "t2": 1 });

    const repo = makeRepoContext();
    const result = await getHealthStatus(repo);

    expect(result.uptime_seconds).toBeTypeOf("number");
    expect(result.memory_usage_mb).toBeTypeOf("number");
    expect(result.queued_messages).toBe(3);
    expect(result.queue_by_thread).toEqual({ "t1": 2, "t2": 1 });
  });

  it("returns 'halted' when the critical-failure flag is set, regardless of DB/Slack health", async () => {
    // Halt takes precedence over degraded/ok — operator must investigate.
    // Everything else is intentionally healthy to prove halt wins.
    mockCheckDbConnection.mockResolvedValue(true);
    mockIsSlackConnected.mockReturnValue(true);
    mockGetTotalQueuedCount.mockReturnValue(0);
    mockGetQueueStats.mockReturnValue({});
    const flag = {
      timestamp: "2026-04-21T00:00:00.000Z",
      source: "agent" as const,
      dispatchId: "d-1",
      reason: "MCP Trello unavailable",
    };
    mockReadFlag.mockReturnValue(flag);

    const repo = makeRepoContext();
    const result = await getHealthStatus(repo);

    expect(result.status).toBe("halted");
    expect(result.criticalFailure).toEqual(flag);
  });

  it("returns 'halted' even when DB is down — halted wins over degraded", async () => {
    mockCheckDbConnection.mockResolvedValue(false);
    mockIsSlackConnected.mockReturnValue(false);
    mockGetTotalQueuedCount.mockReturnValue(0);
    mockGetQueueStats.mockReturnValue({});
    mockReadFlag.mockReturnValue({
      timestamp: "2026-04-21T00:00:00.000Z",
      source: "post-dispatch-check",
      dispatchId: "d-2",
      reason: "Card still in ToDo",
    });

    const repo = makeRepoContext();
    const result = await getHealthStatus(repo);

    expect(result.status).toBe("halted");
  });

  it("exposes criticalFailure:null when no flag is present", async () => {
    mockCheckDbConnection.mockResolvedValue(true);
    mockIsSlackConnected.mockReturnValue(true);
    mockGetTotalQueuedCount.mockReturnValue(0);
    mockGetQueueStats.mockReturnValue({});

    const repo = makeRepoContext();
    const result = await getHealthStatus(repo);

    expect(result.criticalFailure).toBeNull();
  });
});
