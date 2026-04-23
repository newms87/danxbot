import { describe, it, expect, beforeEach, vi } from "vitest";
import http from "http";
import { createMockReqWithBody, createMockRes } from "../__tests__/helpers/http-mocks.js";

function createMockReqWithRawBody(method: string, raw: string): http.IncomingMessage {
  const req = new http.IncomingMessage(null as never);
  req.method = method;
  process.nextTick(() => {
    req.emit("data", Buffer.from(raw));
    req.emit("end");
  });
  return req;
}

const mockResetAllData = vi.fn();
vi.mock("./reset-data.js", () => ({
  resetAllData: (...args: unknown[]) => mockResetAllData(...args),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { handleAdminReset } from "./admin-routes.js";

describe("handleAdminReset", () => {
  beforeEach(() => {
    mockResetAllData.mockReset();
  });

  it("returns 400 when confirm token is missing", async () => {
    const req = createMockReqWithBody("POST", {});
    const res = createMockRes();

    await handleAdminReset(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/confirm/i);
    expect(mockResetAllData).not.toHaveBeenCalled();
  });

  it("returns 400 when confirm token is wrong", async () => {
    const req = createMockReqWithBody("POST", { confirm: "yes" });
    const res = createMockRes();

    await handleAdminReset(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(mockResetAllData).not.toHaveBeenCalled();
  });

  it("returns 400 with 'Invalid JSON body' when the body is actually malformed JSON", async () => {
    const req = createMockReqWithRawBody("POST", "{not-json");
    const res = createMockRes();

    await handleAdminReset(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toBe("Invalid JSON body");
    expect(mockResetAllData).not.toHaveBeenCalled();
  });

  it("returns 400 when body is empty (confirm is undefined)", async () => {
    const req = createMockReqWithBody("POST");
    const res = createMockRes();

    await handleAdminReset(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(JSON.parse(res._getBody()).error).toMatch(/confirm/i);
    expect(mockResetAllData).not.toHaveBeenCalled();
  });

  it("calls resetAllData and returns 200 with the result on valid confirm", async () => {
    mockResetAllData.mockResolvedValueOnce({
      tablesCleared: ["dispatches", "threads", "health_check"],
      rowsDeleted: 42,
      perTable: { dispatches: 10, threads: 5, health_check: 2 },
    });
    const req = createMockReqWithBody("POST", { confirm: "RESET" });
    const res = createMockRes();

    await handleAdminReset(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(JSON.parse(res._getBody())).toEqual({
      tablesCleared: ["dispatches", "threads", "health_check"],
      rowsDeleted: 42,
      perTable: { dispatches: 10, threads: 5, health_check: 2 },
    });
    expect(mockResetAllData).toHaveBeenCalledOnce();
  });

  it("returns 500 when resetAllData throws", async () => {
    mockResetAllData.mockRejectedValueOnce(new Error("db down"));
    const req = createMockReqWithBody("POST", { confirm: "RESET" });
    const res = createMockRes();

    await handleAdminReset(req, res);

    expect(res._getStatusCode()).toBe(500);
    const body = JSON.parse(res._getBody());
    expect(body.error).toBe("Reset failed");
    expect(body.details).toBe("db down");
  });
});
