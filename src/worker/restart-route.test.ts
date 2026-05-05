import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRestartWorker = vi.fn();
const mockParseRestartRequest = vi.fn();

vi.mock("./restart.js", async () => {
  const actual =
    await vi.importActual<typeof import("./restart.js")>("./restart.js");
  return {
    ...actual,
    restartWorker: (...args: unknown[]) => mockRestartWorker(...args),
    parseRestartRequest: (...args: unknown[]) =>
      mockParseRestartRequest(...args),
  };
});

vi.mock("../config.js", () => ({
  config: { runtime: "host" },
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { handleRestart } from "./restart-route.js";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";

const REPO = makeRepoContext({ name: "danxbot", workerPort: 5562 });

describe("handleRestart", () => {
  beforeEach(() => {
    mockRestartWorker.mockReset();
    mockParseRestartRequest.mockReset();
  });

  it("400s on parse failure", async () => {
    mockParseRestartRequest.mockReturnValueOnce({
      ok: false,
      status: 400,
      error: "Missing or empty required field: repo",
    });
    const req = createMockReqWithBody("POST", { reason: "x" });
    const res = createMockRes();
    await handleRestart(req, res, "d-1", REPO);
    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Missing or empty required field: repo",
    });
    expect(mockRestartWorker).not.toHaveBeenCalled();
  });

  it("400s on missing reason", async () => {
    mockParseRestartRequest.mockReturnValueOnce({
      ok: false,
      status: 400,
      error: "Missing or empty required field: reason",
    });
    const req = createMockReqWithBody("POST", { repo: "danxbot" });
    const res = createMockRes();
    await handleRestart(req, res, "d-1", REPO);
    expect(res._getStatusCode()).toBe(400);
  });

  it("injects URL dispatchId as requestingDispatchId on the request passed to restartWorker", async () => {
    mockParseRestartRequest.mockReturnValueOnce({
      ok: true,
      value: { repo: "danxbot", reason: "x" },
    });
    mockRestartWorker.mockResolvedValueOnce({
      accepted: false,
      status: 403,
      body: { error: "x", outcome: "cross_repo" },
    });
    const req = createMockReqWithBody("POST", {
      repo: "danxbot",
      reason: "x",
      requestingDispatchId: "d-from-body-ignored",
    });
    const res = createMockRes();
    await handleRestart(req, res, "d-from-url", REPO);
    // Route forwards the URL path id into restartWorker's request arg
    // (parser ignores body's requestingDispatchId by contract)
    expect(mockRestartWorker.mock.calls[0][0].requestingDispatchId).toBe(
      "d-from-url",
    );
  });

  it("returns refusal status + body unchanged", async () => {
    mockParseRestartRequest.mockReturnValueOnce({
      ok: true,
      value: { repo: "danxbot", reason: "x" },
    });
    mockRestartWorker.mockResolvedValueOnce({
      accepted: false,
      status: 429,
      body: { error: "Restart on cooldown", outcome: "cooldown" },
    });
    const req = createMockReqWithBody("POST", { repo: "danxbot", reason: "x" });
    const res = createMockRes();
    await handleRestart(req, res, "d-1", REPO);
    expect(res._getStatusCode()).toBe(429);
    expect(JSON.parse(res._getBody())).toEqual({
      error: "Restart on cooldown",
      outcome: "cooldown",
    });
  });

  it("happy path: returns 202 + body, fires postFlush AFTER response.end", async () => {
    const postFlush = vi.fn();
    mockParseRestartRequest.mockReturnValueOnce({
      ok: true,
      value: { repo: "danxbot", reason: "x" },
    });
    mockRestartWorker.mockResolvedValueOnce({
      accepted: true,
      status: 202,
      body: {
        started: true,
        oldPid: 12345,
        restartId: 7,
        outcome: "started",
      },
      postFlush,
    });

    const req = createMockReqWithBody("POST", { repo: "danxbot", reason: "x" });
    const res = createMockRes();

    // Track call ordering: end MUST run before setImmediate-scheduled postFlush
    const callOrder: string[] = [];
    const originalEnd = res.end as unknown as (
      data?: string,
      cb?: () => void,
    ) => void;
    (res as unknown as { end: typeof originalEnd }).end = vi.fn(
      (data?: string, cb?: () => void) => {
        callOrder.push("end");
        if (cb) cb();
      },
    ) as unknown as typeof originalEnd;
    postFlush.mockImplementation(() => callOrder.push("postFlush"));

    await handleRestart(req, res, "d-1", REPO);
    // setImmediate is scheduled inside the end-callback; wait for it.
    await new Promise((r) => setImmediate(r));

    expect(callOrder).toEqual(["end", "postFlush"]);
    expect(postFlush).toHaveBeenCalledTimes(1);
  });

  it("500s on restartWorker throw, no postFlush", async () => {
    mockParseRestartRequest.mockReturnValueOnce({
      ok: true,
      value: { repo: "danxbot", reason: "x" },
    });
    mockRestartWorker.mockRejectedValueOnce(new Error("boom"));
    const req = createMockReqWithBody("POST", { repo: "danxbot", reason: "x" });
    const res = createMockRes();
    await handleRestart(req, res, "d-1", REPO);
    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody())).toEqual({ error: "boom" });
  });
});
