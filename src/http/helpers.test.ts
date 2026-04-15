import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "./helpers.js";

function createMockResponse() {
  const res = {
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
  return res;
}

function createMockRequest(body: string = ""): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  process.nextTick(() => {
    if (body) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

describe("json", () => {
  it("sends JSON with correct content type and status", () => {
    const res = createMockResponse();

    json(res, 200, { hello: "world" });

    expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
    expect(res.end).toHaveBeenCalledWith('{"hello":"world"}');
  });

  it("sends error responses with non-200 status", () => {
    const res = createMockResponse();

    json(res, 404, { error: "Not found" });

    expect(res.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "application/json" });
  });
});

describe("parseBody", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses valid JSON body", async () => {
    const req = createMockRequest('{"task":"hello"}');

    const result = await parseBody(req);

    expect(result).toEqual({ task: "hello" });
  });

  it("returns empty object for empty body", async () => {
    const req = createMockRequest("");

    const result = await parseBody(req);

    expect(result).toEqual({});
  });

  it("rejects on invalid JSON", async () => {
    const req = createMockRequest("not json");

    await expect(parseBody(req)).rejects.toThrow("Invalid JSON body");
  });

  it("rejects on request error", async () => {
    const req = new EventEmitter() as IncomingMessage;
    process.nextTick(() => req.emit("error", new Error("connection reset")));

    await expect(parseBody(req)).rejects.toThrow("connection reset");
  });
});
