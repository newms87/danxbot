/**
 * Integration test for `/api/triage` (DX-515 phase 1).
 *
 * Drives the worker route end-to-end:
 *
 *   POST /api/triage (worker, real HTTP)
 *     → handleTriage validates body
 *     → dispatch() invoked with workspace=issue-worker,
 *       task=<base + optional ## Operator notes>,
 *       issueId=<issue_id>, dispatchKind="triage"
 *
 * Scope: WORKER ROUTE ONLY. The dashboard proxy → worker leg is covered
 * by `src/dashboard/dispatch-proxy.test.ts > handleTriageProxy`; the
 * task-shaping contract is unit-tested in
 * `src/worker/dispatch.test.ts > buildTriageTaskBody`. This file pins
 * the real HTTP path: route registration in `src/worker/server.ts`,
 * JSON body round-trip, and the captured `dispatch()` call's input.
 *
 * Per the DX-515 AC, this test covers the four cases:
 *   (a) base — no `instructions` → task body is the bare triage line
 *   (b) with-notes — task body appends the `## Operator notes` block
 *       verbatim
 *   (c) missing api_token — 401 belongs to the proxy auth band; this
 *       file documents the boundary (worker accepts requests without
 *       api_token — see comment on the test)
 *   (d) instructions > 2000 chars → 400 with the exceeds-limit message
 *
 * The "prompt.md captured under logs/<jobId>/" AC clause is satisfied
 * transitively: `dispatch()` writes prompt.md from `input.task` via
 * `spawnAgent` → `logPromptToDisk(...)`. Asserting the captured
 * `input.task` is the same observation without paying the real-spawn
 * cost.
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

  it("(a) base — POST /api/triage without instructions spawns dispatch with the bare triage line", async () => {
    mockDispatch.mockClear();
    const res = await postJson(workerPort, "/api/triage", {
      repo: "test-repo",
      issue_id: "DX-515",
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
    expect(input.task).toBe(
      "Triage card DX-515 using the danx-triage-card skill.",
    );
    // The task body — and therefore prompt.md, which `dispatch()` →
    // `spawnAgent` → `logPromptToDisk` writes verbatim — does NOT
    // carry the operator-notes header when `instructions` is omitted.
    expect(input.task).not.toMatch(/Operator notes/);
    expect(input.issueId).toBe("DX-515");
    expect(input.apiToken).toBe("secret");
    expect(input.overlay).toEqual({});
    expect(input.dispatchKind).toBe("triage");
    expect(input.apiDispatchMeta.trigger).toBe("api");
    expect(input.apiDispatchMeta.metadata.endpoint).toBe("/api/triage");
  });

  it("(b) with-notes — POST /api/triage with instructions appends the `## Operator notes` block", async () => {
    mockDispatch.mockClear();
    const notes = "re-score considering DX-269 — this may be obsolete";
    const res = await postJson(workerPort, "/api/triage", {
      repo: "test-repo",
      issue_id: "DX-515",
      instructions: notes,
    });

    expect(res.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const input = mockDispatch.mock.calls[0][0] as {
      task: string;
      dispatchKind?: string;
    };
    expect(input.task).toBe(
      `Triage card DX-515 using the danx-triage-card skill.\n\n## Operator notes\n\n${notes}`,
    );
    expect(input.dispatchKind).toBe("triage");
  });

  it("(c) the worker route does not 401 on missing api_token — that auth gate lives on the dashboard proxy", async () => {
    // The DX-515 AC pair "missing api_token → 401" is enforced by the
    // dashboard proxy's `Authorization: Bearer <DANXBOT_DISPATCH_TOKEN>`
    // gate (`handleTriageProxy` → `checkAuth`); workers bind only on
    // `danxbot-net` and never see external callers. This case-level
    // assertion documents the boundary: a worker-direct call without
    // `api_token` still succeeds. The proxy-side 401 contract is pinned
    // in `src/dashboard/dispatch-proxy.test.ts > handleTriageProxy`.
    mockDispatch.mockClear();
    const res = await postJson(workerPort, "/api/triage", {
      repo: "test-repo",
      issue_id: "DX-515",
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
      issue_id: "DX-515",
      instructions: oversized,
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(
      /instructions exceeds 2000-character limit/,
    );
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
