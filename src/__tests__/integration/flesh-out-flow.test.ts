/**
 * Integration test for `/api/flesh-out` (DX-348 Phase 1 / DX-349).
 *
 * Drives the full surface end-to-end:
 *
 *   POST /api/flesh-out (worker, real HTTP)
 *     → handleFleshOut validates body
 *     → dispatch() invoked with workspace=issue-worker,
 *       task="/danx-flesh-out <issue_id>", issueId=<issue_id>
 *
 * Scope: WORKER ROUTE ONLY. The dashboard proxy → worker leg is covered
 * by `src/dashboard/dispatch-proxy.test.ts > handleFleshOutProxy` (real
 * loopback `FakeWorker` + `handleFleshOutProxy`). This file exercises
 * the worker server alone.
 *
 * What this catches that the unit tests do not:
 *   - Real HTTP request bodies are JSON-decoded and reach the handler
 *     intact (no header / encoding regression).
 *   - The worker server's route table actually matches
 *     `POST /api/flesh-out` (route-registration regression in
 *     `src/worker/server.ts`).
 *   - The strict-allowlist 404 fires for non-POST methods.
 *
 * Cost: free. Mocks `dispatch()` to a stub that returns a synthetic
 * dispatchId; no Claude API spend, no spawn, no JSONL.
 *
 * Wired into `make test-system-flesh-out` via
 * `src/__tests__/system/run-flesh-out-system-test.sh`.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { makeRepoContext } from "../helpers/fixtures.js";

// Mock dispatch() before importing the worker server — the handler
// imports it transitively. Returning a deterministic dispatchId keeps
// the assertions terse.
const mockDispatch = vi.fn().mockResolvedValue({
  dispatchId: "test-flesh-out-integration",
  job: {},
});
vi.mock("../../dispatch/core.js", async () => {
  const actual = await vi.importActual<typeof import("../../dispatch/core.js")>(
    "../../dispatch/core.js",
  );
  return {
    ...actual,
    dispatch: (...args: unknown[]) => mockDispatch(...args),
  };
});

// `isFeatureEnabled` reads `settings.json` on disk; we don't want
// that I/O in a free test, and the route's 503 branch is already
// covered by the unit suite. Force-enable here so the happy paths
// hit the dispatch call.
vi.mock("../../settings-file.js", () => ({
  isFeatureEnabled: () => true,
}));

vi.mock("../../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// `seedCooldownFromDb` reaches the worker_restarts table; not relevant
// to the flesh-out path. Stub so the server boot doesn't try.
vi.mock("../../worker/restart.js", () => ({
  seedCooldownFromDb: vi.fn().mockResolvedValue(undefined),
}));

import { startWorkerServer } from "../../worker/server.js";

let workerPort: number;
let workerStop: () => Promise<void>;

async function startWorker(): Promise<{ port: number; stop: () => Promise<void> }> {
  // Pass workerPort=0 so the OS picks a free ephemeral port — avoids
  // collisions when multiple integration tests run in parallel.
  const repo = makeRepoContext({ workerPort: 0 });
  const server = await startWorkerServer(repo);
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function postJson(
  port: number,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

describe("flesh-out integration — real worker HTTP", () => {
  beforeAll(async () => {
    const w = await startWorker();
    workerPort = w.port;
    workerStop = w.stop;
  });

  afterAll(async () => {
    await workerStop();
  });

  it("POST /api/flesh-out with valid body spawns dispatch with the right task / workspace / issueId", async () => {
    mockDispatch.mockClear();
    const res = await postJson(workerPort, "/api/flesh-out", {
      repo: "test-repo",
      issue_id: "DX-349",
      api_token: "secret",
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      job_id: "test-flesh-out-integration",
      status: "launched",
    });

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const input = mockDispatch.mock.calls[0][0] as {
      workspace: string;
      task: string;
      issueId?: string;
      apiToken?: string;
      overlay: Record<string, string>;
      apiDispatchMeta: { trigger: string; metadata: { endpoint: string } };
    };
    expect(input.workspace).toBe("issue-worker");
    expect(input.task).toBe("/danx-flesh-out DX-349");
    expect(input.issueId).toBe("DX-349");
    expect(input.apiToken).toBe("secret");
    expect(input.overlay).toEqual({});
    expect(input.apiDispatchMeta.trigger).toBe("api");
    expect(input.apiDispatchMeta.metadata.endpoint).toBe("/api/flesh-out");
  });

  it("POST /api/flesh-out with malformed issue_id returns 400 (real-HTTP)", async () => {
    mockDispatch.mockClear();
    const res = await postJson(workerPort, "/api/flesh-out", {
      repo: "test-repo",
      issue_id: "not-a-card-id",
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(
      /Invalid issue_id "not-a-card-id"/,
    );
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("POST /api/flesh-out without issue_id returns 400 (real-HTTP)", async () => {
    mockDispatch.mockClear();
    const res = await postJson(workerPort, "/api/flesh-out", {
      repo: "test-repo",
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Missing or blank required field: issue_id",
    });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("GET /api/flesh-out returns 404 (the route is POST-only)", async () => {
    mockDispatch.mockClear();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: workerPort, path: "/api/flesh-out", method: "GET" },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(404);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
