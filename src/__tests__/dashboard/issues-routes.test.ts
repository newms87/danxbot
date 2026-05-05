import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockRes } from "../helpers/http-mocks.js";
import type { RepoConfig } from "../../types.js";
import type { DispatchProxyDeps } from "../../dashboard/dispatch-proxy.js";

const mockListIssues = vi.fn();
const mockReadIssueDetail = vi.fn();

vi.mock("../../dashboard/issues-reader.js", () => ({
  listIssues: (...args: unknown[]) => mockListIssues(...args),
  readIssueDetail: (...args: unknown[]) => mockReadIssueDetail(...args),
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
} from "../../dashboard/issues-routes.js";

const REPOS: RepoConfig[] = [
  {
    name: "danxbot",
    url: "https://github.com/newms/danxbot.git",
    localPath: "/repos/danxbot",
    workerPort: 5562,
  },
  {
    name: "platform",
    url: "https://github.com/newms/platform.git",
    localPath: "/repos/platform",
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
      schema_version: 3,
      id: "ISS-1",
      title: "t",
      description: "body",
      ac: [],
      phases: [],
      comments: [],
      retro: { good: "", bad: "", action_item_ids: [], commits: [] },
      blocked: null,
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
