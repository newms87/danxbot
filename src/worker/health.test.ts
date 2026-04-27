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

const mockPreflightClaudeAuth = vi.fn().mockResolvedValue({ ok: true });
vi.mock("../agent/claude-auth-preflight.js", () => ({
  preflightClaudeAuth: (...args: unknown[]) => mockPreflightClaudeAuth(...args),
}));

const mockPreflightProjectsDir = vi.fn().mockResolvedValue({ ok: true });
vi.mock("../agent/projects-dir-preflight.js", () => ({
  preflightProjectsDir: (...args: unknown[]) => mockPreflightProjectsDir(...args),
}));

import { getHealthStatus } from "./health.js";

describe("getHealthStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFlag.mockReturnValue(null);
    mockPreflightClaudeAuth.mockResolvedValue({ ok: true });
    mockPreflightProjectsDir.mockResolvedValue({ ok: true });
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

  describe("claude_auth field (Trello 3l2d7i46)", () => {
    it("exposes claude_auth.ok=true when preflight passes", async () => {
      mockCheckDbConnection.mockResolvedValue(true);
      mockIsSlackConnected.mockReturnValue(true);
      mockGetTotalQueuedCount.mockReturnValue(0);
      mockGetQueueStats.mockReturnValue({});
      mockPreflightClaudeAuth.mockResolvedValue({ ok: true });

      const repo = makeRepoContext();
      const result = await getHealthStatus(repo);

      expect(result.claude_auth).toEqual({ ok: true });
      expect(result.status).toBe("ok");
    });

    it("returns 'degraded' with reason+summary when claude-auth preflight fails", async () => {
      // DB and Slack both healthy — proves auth-broken alone is enough to
      // demote the worker out of "ok" without conflating signals.
      mockCheckDbConnection.mockResolvedValue(true);
      mockIsSlackConnected.mockReturnValue(true);
      mockGetTotalQueuedCount.mockReturnValue(0);
      mockGetQueueStats.mockReturnValue({});
      mockPreflightClaudeAuth.mockResolvedValue({
        ok: false,
        reason: "expired",
        summary:
          "claude-auth OAuth token expired at 2026-01-01T00:00:00.000Z — host claude needs to refresh, or worker needs a redeploy",
      });

      const repo = makeRepoContext();
      const result = await getHealthStatus(repo);

      expect(result.status).toBe("degraded");
      expect(result.claude_auth.ok).toBe(false);
      expect(result.claude_auth.reason).toBe("expired");
      expect(result.claude_auth.summary).toMatch(/expired/);
    });

    it("returns 'degraded' when DB is down AND auth is broken — both signals surface, status not double-counted", async () => {
      mockCheckDbConnection.mockResolvedValue(false);
      mockIsSlackConnected.mockReturnValue(true);
      mockGetTotalQueuedCount.mockReturnValue(0);
      mockGetQueueStats.mockReturnValue({});
      mockPreflightClaudeAuth.mockResolvedValue({
        ok: false,
        reason: "missing",
        summary: "claude-auth file .credentials.json is missing",
      });

      const repo = makeRepoContext();
      const result = await getHealthStatus(repo);

      expect(result.status).toBe("degraded");
      expect(result.db_connected).toBe(false);
      expect(result.claude_auth.ok).toBe(false);
      expect(result.claude_auth.reason).toBe("missing");
    });

    it("returns 'degraded' when Slack is down AND auth is broken — independent signals", async () => {
      mockCheckDbConnection.mockResolvedValue(true);
      mockIsSlackConnected.mockReturnValue(false);
      mockGetTotalQueuedCount.mockReturnValue(0);
      mockGetQueueStats.mockReturnValue({});
      mockPreflightClaudeAuth.mockResolvedValue({
        ok: false,
        reason: "readonly",
        summary: "claude-auth file .claude.json is read-only",
      });

      const repo = makeRepoContext({
        slack: { enabled: true, botToken: "x", appToken: "x", channelId: "C" },
      });
      const result = await getHealthStatus(repo);

      expect(result.status).toBe("degraded");
      expect(result.slack_connected).toBe(false);
      expect(result.claude_auth.ok).toBe(false);
    });

    it("'halted' still wins over auth-broken — halt takes precedence", async () => {
      mockCheckDbConnection.mockResolvedValue(true);
      mockIsSlackConnected.mockReturnValue(true);
      mockGetTotalQueuedCount.mockReturnValue(0);
      mockGetQueueStats.mockReturnValue({});
      mockReadFlag.mockReturnValue({
        timestamp: "2026-04-21T00:00:00.000Z",
        source: "agent" as const,
        dispatchId: "d-1",
        reason: "MCP Trello unavailable",
      });
      mockPreflightClaudeAuth.mockResolvedValue({
        ok: false,
        reason: "readonly",
        summary:
          "claude-auth file .claude.json at /home/danxbot/.claude.json is read-only — see compose.yml CLAUDE_CREDS_DIR mount; PHevzRil",
      });

      const repo = makeRepoContext();
      const result = await getHealthStatus(repo);

      expect(result.status).toBe("halted");
      // Both signals are still surfaced even though only halt sets the
      // top-level status — the operator sees the full picture.
      expect(result.claude_auth.ok).toBe(false);
      expect(result.criticalFailure).not.toBeNull();
    });
  });

  describe("projects_dir field (Trello cjAyJpgr-followup)", () => {
    it("exposes projects_dir.ok=true when preflight passes", async () => {
      mockCheckDbConnection.mockResolvedValue(true);
      mockIsSlackConnected.mockReturnValue(true);
      mockGetTotalQueuedCount.mockReturnValue(0);
      mockGetQueueStats.mockReturnValue({});

      const repo = makeRepoContext();
      const result = await getHealthStatus(repo);

      expect(result.projects_dir).toEqual({ ok: true });
      expect(result.status).toBe("ok");
    });

    it("returns 'degraded' with reason+summary when projects-dir preflight fails — readonly (the verified bug class)", async () => {
      // The exact runtime shape we reproduced on 2026-04-26: dir exists
      // but is owned by root, container UID 1000 can't write, claude
      // silently fails to produce JSONL. /health surfaces this without
      // waiting for the next dispatch to time out.
      mockCheckDbConnection.mockResolvedValue(true);
      mockIsSlackConnected.mockReturnValue(true);
      mockGetTotalQueuedCount.mockReturnValue(0);
      mockGetQueueStats.mockReturnValue({});
      mockPreflightProjectsDir.mockResolvedValue({
        ok: false,
        reason: "readonly",
        summary:
          "Projects dir /home/danxbot/.claude/projects is not writable by the worker — chown the bind source on the host to UID 1000",
      });

      const repo = makeRepoContext();
      const result = await getHealthStatus(repo);

      expect(result.status).toBe("degraded");
      expect(result.projects_dir.ok).toBe(false);
      expect(result.projects_dir.reason).toBe("readonly");
      // Contract: the summary names the chown remediation. Drop or
      // rephrase only with a real reason — the dashboard renders this
      // verbatim on the Agents tab.
      expect(result.projects_dir.summary).toMatch(/chown/);
    });

    it("returns 'degraded' when only projects_dir is broken — independent of auth, db, slack", async () => {
      // Auth + db + slack all healthy. projects_dir alone demoting the
      // worker out of "ok" proves the field has its own seat in the
      // status calculation, not folded into auth.
      mockCheckDbConnection.mockResolvedValue(true);
      mockIsSlackConnected.mockReturnValue(true);
      mockGetTotalQueuedCount.mockReturnValue(0);
      mockGetQueueStats.mockReturnValue({});
      mockPreflightProjectsDir.mockResolvedValue({
        ok: false,
        reason: "missing",
        summary: "Projects dir does not exist",
      });

      const repo = makeRepoContext();
      const result = await getHealthStatus(repo);

      expect(result.status).toBe("degraded");
      expect(result.claude_auth.ok).toBe(true);
      expect(result.projects_dir.ok).toBe(false);
      expect(result.projects_dir.reason).toBe("missing");
    });

    it("surfaces both signals when auth AND projects_dir are broken — neither field hides the other", async () => {
      mockCheckDbConnection.mockResolvedValue(true);
      mockIsSlackConnected.mockReturnValue(true);
      mockGetTotalQueuedCount.mockReturnValue(0);
      mockGetQueueStats.mockReturnValue({});
      mockPreflightClaudeAuth.mockResolvedValue({
        ok: false,
        reason: "expired",
        summary: "claude-auth OAuth token expired",
      });
      mockPreflightProjectsDir.mockResolvedValue({
        ok: false,
        reason: "readonly",
        summary: "Projects dir is not writable",
      });

      const repo = makeRepoContext();
      const result = await getHealthStatus(repo);

      expect(result.status).toBe("degraded");
      expect(result.claude_auth.ok).toBe(false);
      expect(result.claude_auth.reason).toBe("expired");
      expect(result.projects_dir.ok).toBe(false);
      expect(result.projects_dir.reason).toBe("readonly");
    });

    it("'halted' still wins over projects-dir-broken — halt takes precedence", async () => {
      mockCheckDbConnection.mockResolvedValue(true);
      mockIsSlackConnected.mockReturnValue(true);
      mockGetTotalQueuedCount.mockReturnValue(0);
      mockGetQueueStats.mockReturnValue({});
      mockReadFlag.mockReturnValue({
        timestamp: "2026-04-21T00:00:00.000Z",
        source: "agent" as const,
        dispatchId: "d-1",
        reason: "MCP Trello unavailable",
      });
      mockPreflightProjectsDir.mockResolvedValue({
        ok: false,
        reason: "readonly",
        summary: "Projects dir is not writable",
      });

      const repo = makeRepoContext();
      const result = await getHealthStatus(repo);

      expect(result.status).toBe("halted");
      // Both signals still surfaced — operator sees the full picture.
      expect(result.projects_dir.ok).toBe(false);
      expect(result.criticalFailure).not.toBeNull();
    });
  });
});
