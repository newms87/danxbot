import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";
import {
  createMockReqWithBody,
  createMockRes,
} from "../__tests__/helpers/http-mocks.js";

const mockClearFlag = vi.fn();
vi.mock("../critical-failure.js", () => ({
  clearFlag: (...args: unknown[]) => mockClearFlag(...args),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { handleClearCriticalFailure } from "./critical-failure-route.js";

const REPO = makeRepoContext();

describe("handleClearCriticalFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 {cleared: true} when clearFlag deletes an existing flag", async () => {
    mockClearFlag.mockReturnValue(true);
    const req = createMockReqWithBody("DELETE", {});
    const res = createMockRes();

    await handleClearCriticalFailure(req, res, REPO);

    expect(mockClearFlag).toHaveBeenCalledWith(REPO.localPath);
    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({ cleared: true });
  });

  it("returns 200 {cleared: false} when the flag was already absent (idempotent)", async () => {
    mockClearFlag.mockReturnValue(false);
    const req = createMockReqWithBody("DELETE", {});
    const res = createMockRes();

    await handleClearCriticalFailure(req, res, REPO);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({ cleared: false });
  });

  it("returns 500 when clearFlag throws (filesystem error, etc.)", async () => {
    mockClearFlag.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    const req = createMockReqWithBody("DELETE", {});
    const res = createMockRes();

    await handleClearCriticalFailure(req, res, REPO);

    expect(res._getStatusCode()).toBe(500);
    expect(JSON.parse(res._getBody()).error).toMatch(/EACCES/);
  });
});
