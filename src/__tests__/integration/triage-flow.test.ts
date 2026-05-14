/**
 * Integration test for `/api/triage` — orchestrator route.
 *
 * Drives the worker route end-to-end:
 *
 *   POST /api/triage (worker, real HTTP)
 *     → handleTriage validates body (rejects legacy issue_id)
 *     → dispatch() invoked with workspace=issue-worker,
 *       task=`/danx-triage-orchestrator` (+ optional `## Operator notes`),
 *       dispatchKind="triage", no issueId
 *
 * Scope: WORKER ROUTE ONLY. The dashboard proxy → worker leg is covered
 * by `src/dashboard/dispatch-proxy.test.ts > handleTriageProxy`; the
 * task-shaping contract is unit-tested in
 * `src/worker/dispatch.test.ts > buildTriageTaskBody`.
 *
 * Cases:
 *   (a) base — no `instructions` → task body is `/danx-triage-orchestrator`
 *   (b) with-notes — task body appends the `## Operator notes` block
 *   (c) missing api_token — worker accepts (auth lives on the proxy)
 *   (d) instructions > 2000 chars → 400
 *   (e) stray issue_id → 400 (zero back-compat)
 *
 * Cost: free. Mocks `dispatch()` to a stub.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import { makeRepoContext } from "../helpers/fixtures.js";

const mockDispatch = vi.fn().mockResolvedValue({
  dispatchId: "test-triage-integration",
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

// Force-enable dispatchApi — same rationale as flesh-out-flow.test.ts.
// The 503 branch is covered by the unit suite.
vi.mock("../../settings-file.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../settings-file.js")>(
      "../../settings-file.js",
    );
  return {
    ...actual,
    isFeatureEnabled: () => true,
  };
});

vi.mock("../../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// `seedCooldownFromDb` reaches the worker_restarts table — not relevant
// to the triage path. Stub so the worker server boot doesn't try.
vi.mock("../../worker/restart.js", () => ({
  seedCooldownFromDb: vi.fn().mockResolvedValue(undefined),
}));

import { startWorkerServer } from "../../worker/server.js";

let workerPort: number;
let workerStop: () => Promise<void>;

async function startWorker(): Promise<{
  port: number;
  stop: () => Promise<void>;
}> {
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

describe("triage integration — real worker HTTP", () => {
  beforeAll(async () => {
    const w = await startWorker();
    workerPort = w.port;
    workerStop = w.stop;
  });

  afterAll(async () => {
    await workerStop();
  });

  it("(a) base — POST /api/triage without instructions spawns the orchestrator dispatch", async () => {
    mockDispatch.mockClear();
    const res = await postJson(workerPort, "/api/triage", {
      repo: "test-repo",
      api_token: "secret",
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      job_id: "test-triage-integration",
      status: "launched",
    });

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const input = mockDispatch.mock.calls[0][0] as {
      workspace: string;
      task: string;
      issueId?: string;
      apiToken?: string;
      overlay: Record<string, string>;
      dispatchKind?: string;
      apiDispatchMeta: { trigger: string; metadata: { endpoint: string } };
    };
    expect(input.workspace).toBe("issue-worker");
    expect(input.task).toBe("/danx-triage-orchestrator");
    expect(input.task).not.toMatch(/Operator notes/);
    expect(input.issueId).toBeUndefined();
    expect(input.apiToken).toBe("secret");
    expect(input.overlay).toEqual({});
    expect(input.dispatchKind).toBe("triage");
    expect(input.apiDispatchMeta.trigger).toBe("api");
    expect(input.apiDispatchMeta.metadata.endpoint).toBe("/api/triage");
  });

  it("(b) with-notes — POST /api/triage with instructions appends the `## Operator notes` block", async () => {
    mockDispatch.mockClear();
    const notes = "only Blocked cards older than 2 weeks";
    const res = await postJson(workerPort, "/api/triage", {
      repo: "test-repo",
      instructions: notes,
    });

    expect(res.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const input = mockDispatch.mock.calls[0][0] as {
      task: string;
      dispatchKind?: string;
    };
    expect(input.task).toBe(
      `/danx-triage-orchestrator\n\n## Operator notes\n\n${notes}`,
    );
    expect(input.dispatchKind).toBe("triage");
  });

  it("(c) the worker route does not 401 on missing api_token — that auth gate lives on the dashboard proxy", async () => {
    mockDispatch.mockClear();
    const res = await postJson(workerPort, "/api/triage", {
      repo: "test-repo",
    });
    expect(res.status).toBe(200);
    const input = mockDispatch.mock.calls[0][0] as { apiToken?: string };
    expect(input.apiToken).toBeUndefined();
  });

  it("(d) over-long — POST /api/triage with instructions > 2000 chars returns 400", async () => {
    mockDispatch.mockClear();
    const oversized = "x".repeat(2001);
    const res = await postJson(workerPort, "/api/triage", {
      repo: "test-repo",
      instructions: oversized,
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(
      /instructions exceeds 2000-character limit/,
    );
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("(e) legacy issue_id — POST /api/triage with stray issue_id returns 400 (zero back-compat)", async () => {
    mockDispatch.mockClear();
    const res = await postJson(workerPort, "/api/triage", {
      repo: "test-repo",
      issue_id: "DX-515",
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/issue_id is not accepted/);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("GET /api/triage returns 404 (route is POST-only)", async () => {
    mockDispatch.mockClear();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: workerPort,
          path: "/api/triage",
          method: "GET",
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(404);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
