import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockRes } from "../helpers/http-mocks.js";
import type { RepoConfig } from "../../types.js";
import type { DispatchProxyDeps } from "../../dashboard/dispatch-proxy.js";

const mockListIssues = vi.fn();
const mockReadIssueDetail = vi.fn();
const mockReadIssueHistory = vi.fn();

vi.mock("../../dashboard/issues-reader.js", () => ({
  listIssues: (...args: unknown[]) => mockListIssues(...args),
  readIssueDetail: (...args: unknown[]) => mockReadIssueDetail(...args),
  readIssueHistory: (...args: unknown[]) => mockReadIssueHistory(...args),
}));

vi.mock("../../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  handleListIssues,
  handleGetIssue,
  handleGetIssueHistory,
} from "../../dashboard/issues-routes.js";

const REPOS: RepoConfig[] = [
  {
    name: "danxbot",
    url: "https://github.com/newms/danxbot.git",
    localPath: "/repos/danxbot",
    hostPath: "/repos/danxbot",
    workerPort: 5562,
  },
  {
    name: "platform",
    url: "https://github.com/newms/platform.git",
    localPath: "/repos/platform",
    hostPath: "/repos/platform",
    workerPort: 5563,
  },
];

function deps(): DispatchProxyDeps {
  return {
    token: "test-token",
    repos: REPOS,
    resolveHost: () => "127.0.0.1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleListIssues", () => {
  it("400s when repo query param is missing", async () => {
    const res = createMockRes();
    await handleListIssues(
      res,
      { repo: null, includeClosed: null },
      deps(),
    );
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toContain("repo");
    expect(mockListIssues).not.toHaveBeenCalled();
  });

  it("400s when repo is unknown", async () => {
    const res = createMockRes();
    await handleListIssues(
      res,
      { repo: "nope", includeClosed: null },
      deps(),
    );
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toContain("nope");
    expect(mockListIssues).not.toHaveBeenCalled();
  });

  it("returns the items from listIssues with includeClosed=recent by default", async () => {
    mockListIssues.mockResolvedValue([
      { id: "ISS-1", title: "x" },
    ]);
    const res = createMockRes();
    await handleListIssues(
      res,
      { repo: "danxbot", includeClosed: null },
      deps(),
    );
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual([{ id: "ISS-1", title: "x" }]);
    expect(mockListIssues).toHaveBeenCalledWith("/repos/danxbot", {
      includeClosed: "recent",
    });
  });

  it("forwards include_closed=all", async () => {
    mockListIssues.mockResolvedValue([]);
    const res = createMockRes();
    await handleListIssues(
      res,
      { repo: "danxbot", includeClosed: "all" },
      deps(),
    );
    expect(mockListIssues).toHaveBeenCalledWith("/repos/danxbot", {
      includeClosed: "all",
    });
  });

  it("falls back to recent for any non-'all' include_closed value", async () => {
    mockListIssues.mockResolvedValue([]);
    const res = createMockRes();
    await handleListIssues(
      res,
      { repo: "danxbot", includeClosed: "garbage" },
      deps(),
    );
    expect(mockListIssues).toHaveBeenCalledWith("/repos/danxbot", {
      includeClosed: "recent",
    });
  });

  it("500s when listIssues throws", async () => {
    mockListIssues.mockRejectedValue(new Error("disk gone"));
    const res = createMockRes();
    await handleListIssues(
      res,
      { repo: "danxbot", includeClosed: null },
      deps(),
    );
    expect(res._getStatusCode()).toBe(500);
  });
});

describe("handleGetIssue", () => {
  it("400s when repo query param is missing", async () => {
    const res = createMockRes();
    await handleGetIssue(res, "ISS-1", { repo: null }, deps());
    expect(res._getStatusCode()).toBe(400);
    expect(mockReadIssueDetail).not.toHaveBeenCalled();
  });

  it("400s when repo is unknown", async () => {
    const res = createMockRes();
    await handleGetIssue(res, "ISS-1", { repo: "nope" }, deps());
    expect(res._getStatusCode()).toBe(400);
    expect(mockReadIssueDetail).not.toHaveBeenCalled();
  });

  it("404s when readIssueDetail returns null", async () => {
    mockReadIssueDetail.mockResolvedValue(null);
    const res = createMockRes();
    await handleGetIssue(res, "ISS-99", { repo: "danxbot" }, deps());
    expect(res._getStatusCode()).toBe(404);
    expect(JSON.parse(res._getBody()).error).toContain("ISS-99");
  });

  it("returns the full detail body verbatim", async () => {
    const detail = {
      schema_version: 10,
      id: "ISS-1",
      title: "t",
      description: "body",
      ac: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: null,
      requires_human: null,
      updated_at: 1_700_000_000_000,
    };
    mockReadIssueDetail.mockResolvedValue(detail);
    const res = createMockRes();
    await handleGetIssue(res, "ISS-1", { repo: "danxbot" }, deps());
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual(detail);
    expect(mockReadIssueDetail).toHaveBeenCalledWith("/repos/danxbot", "ISS-1");
  });

  it("500s when readIssueDetail throws", async () => {
    mockReadIssueDetail.mockRejectedValue(new Error("boom"));
    const res = createMockRes();
    await handleGetIssue(res, "ISS-1", { repo: "danxbot" }, deps());
    expect(res._getStatusCode()).toBe(500);
  });
});

describe("handleGetIssueHistory", () => {
  it("400s when repo query param is missing", async () => {
    const res = createMockRes();
    await handleGetIssueHistory(
      res,
      "ISS-1",
      { repo: null, limit: null },
      deps(),
    );
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toContain("repo");
    expect(mockReadIssueHistory).not.toHaveBeenCalled();
  });

  it("400s when repo is unknown", async () => {
    const res = createMockRes();
    await handleGetIssueHistory(
      res,
      "ISS-1",
      { repo: "nope", limit: null },
      deps(),
    );
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toContain("nope");
    expect(mockReadIssueHistory).not.toHaveBeenCalled();
  });

  it("returns the entries wrapped in {entries: [...]}", async () => {
    const entries = [
      {
        changed_at: "2026-05-08T10:00:00.000Z",
        source: "watcher",
        prev_hash: null,
        next_hash: "h1",
        patch: [{ op: "add", path: "/", value: { id: "ISS-1" } }],
      },
    ];
    mockReadIssueHistory.mockResolvedValue(entries);
    const res = createMockRes();
    await handleGetIssueHistory(
      res,
      "ISS-1",
      { repo: "danxbot", limit: null },
      deps(),
    );
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({ entries });
    expect(mockReadIssueHistory).toHaveBeenCalledWith(
      "/repos/danxbot",
      "ISS-1",
      { limit: 200 },
    );
  });

  it("returns 200 with empty entries for unknown ids (timeline render = empty state)", async () => {
    mockReadIssueHistory.mockResolvedValue([]);
    const res = createMockRes();
    await handleGetIssueHistory(
      res,
      "ISS-99999",
      { repo: "danxbot", limit: null },
      deps(),
    );
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({ entries: [] });
  });

  it("forwards a positive limit", async () => {
    mockReadIssueHistory.mockResolvedValue([]);
    const res = createMockRes();
    await handleGetIssueHistory(
      res,
      "ISS-1",
      { repo: "danxbot", limit: "50" },
      deps(),
    );
    expect(res._getStatusCode()).toBe(200);
    expect(mockReadIssueHistory).toHaveBeenCalledWith(
      "/repos/danxbot",
      "ISS-1",
      { limit: 50 },
    );
  });

  it("clamps an over-large limit to the cap (1000)", async () => {
    mockReadIssueHistory.mockResolvedValue([]);
    const res = createMockRes();
    await handleGetIssueHistory(
      res,
      "ISS-1",
      { repo: "danxbot", limit: "5000" },
      deps(),
    );
    expect(res._getStatusCode()).toBe(200);
    expect(mockReadIssueHistory).toHaveBeenCalledWith(
      "/repos/danxbot",
      "ISS-1",
      { limit: 1000 },
    );
  });

  it.each([
    ["zero", "0"],
    ["non-numeric", "abc"],
    ["negative", "-5"],
    ["empty string", ""],
    ["partial-numeric (parseInt slop)", "12abc"],
    ["fractional", "1.5"],
    ["leading whitespace", " 50"],
  ])("400s on a malformed limit (%s)", async (_label, limit) => {
    const res = createMockRes();
    await handleGetIssueHistory(
      res,
      "ISS-1",
      { repo: "danxbot", limit },
      deps(),
    );
    expect(res._getStatusCode()).toBe(400);
    expect(mockReadIssueHistory).not.toHaveBeenCalled();
  });

  it("accepts limit=1 (lower bound)", async () => {
    mockReadIssueHistory.mockResolvedValue([]);
    const res = createMockRes();
    await handleGetIssueHistory(
      res,
      "ISS-1",
      { repo: "danxbot", limit: "1" },
      deps(),
    );
    expect(res._getStatusCode()).toBe(200);
    expect(mockReadIssueHistory).toHaveBeenCalledWith(
      "/repos/danxbot",
      "ISS-1",
      { limit: 1 },
    );
  });

  it("accepts limit=1000 (exact cap, no clamp)", async () => {
    mockReadIssueHistory.mockResolvedValue([]);
    const res = createMockRes();
    await handleGetIssueHistory(
      res,
      "ISS-1",
      { repo: "danxbot", limit: "1000" },
      deps(),
    );
    expect(res._getStatusCode()).toBe(200);
    expect(mockReadIssueHistory).toHaveBeenCalledWith(
      "/repos/danxbot",
      "ISS-1",
      { limit: 1000 },
    );
  });

  it("500s when readIssueHistory throws", async () => {
    mockReadIssueHistory.mockRejectedValue(new Error("boom"));
    const res = createMockRes();
    await handleGetIssueHistory(
      res,
      "ISS-1",
      { repo: "danxbot", limit: null },
      deps(),
    );
    expect(res._getStatusCode()).toBe(500);
  });
});
