import http from "http";
import { vi } from "vitest";

export interface MockResponse extends http.ServerResponse {
  _getStatusCode: () => number;
  _getHeaders: () => Record<string, string | number>;
  _getBody: () => string;
}

/** Create a mock ServerResponse that captures status code, headers, and body. */
export function createMockRes(): MockResponse {
  const headers: Record<string, string | number> = {};
  let statusCode = 200;
  let body = "";

  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    }),
    writeHead: vi.fn((code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          headers[k.toLowerCase()] = v;
        }
      }
    }),
    end: vi.fn((data?: string) => {
      if (data) body = data;
    }),
    write: vi.fn(),
    getHeader: vi.fn((name: string) => headers[name.toLowerCase()]),
    _getStatusCode: () => statusCode,
    _getHeaders: () => headers,
    _getBody: () => body,
  };

  return res as unknown as MockResponse;
}

/** Create a mock IncomingMessage with method and URL set. */
export function createMockReq(method: string, url: string): http.IncomingMessage {
  const req = new http.IncomingMessage(null as never);
  req.method = method;
  req.url = url;
  return req;
}

/** Create a mock IncomingMessage that streams a JSON body. */
export function createMockReqWithBody(method: string, body?: Record<string, unknown>): http.IncomingMessage {
  const req = new http.IncomingMessage(null as never);
  req.method = method;

  if (body) {
    const json = JSON.stringify(body);
    process.nextTick(() => {
      req.emit("data", Buffer.from(json));
      req.emit("end");
    });
  } else {
    process.nextTick(() => {
      req.emit("end");
    });
  }

  return req;
}

/** Create a paired mock request and response. */
export function createMockReqRes(method: string, url: string): { req: http.IncomingMessage; res: MockResponse } {
  return { req: createMockReq(method, url), res: createMockRes() };
}
