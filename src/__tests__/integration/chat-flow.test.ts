/**
 * Integration test for `/api/chat` (DX-348 Phase 3 / DX-351).
 *
 * Drives the full worker surface end-to-end:
 *
 *   POST /api/chat (worker, real HTTP)
 *     → handleChat validates body
 *     → reads <repoRoot>/.danxbot/chat-sessions/<issue_id>.json
 *     → decides FRESH (no record) vs RESUME (record + session resolves)
 *     → dispatch() invoked with workspace=issue-chat
 *     → after spawn, writes the chat-sessions record with the new dispatch id
 *
 * Scope: WORKER ROUTE ONLY. The dashboard proxy → worker leg is covered
 * by `src/dashboard/dispatch-proxy.test.ts > handleChatProxy` (real
 * loopback `FakeWorker` + `handleChatProxy`). This file exercises the
 * worker server alone, including the FRESH path's task-shape contract
 * (`/danx-chat <issue_id>\n\n<text>`) and the chat-sessions disk
 * round-trip across calls.
 *
 * Cost: free. Mocks `dispatch()` to a stub that returns a synthetic
 * dispatchId; no Claude API spend, no spawn, no JSONL.
 *
 * Wired into `make test-system-chat` via
 * `src/__tests__/system/run-chat-system-test.sh`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { makeRepoContext } from "../helpers/fixtures.js";

// Mock dispatch() before importing the worker server — the handler
// imports it transitively. Returning a deterministic dispatchId keeps
// the assertions terse.
const mockDispatch = vi.fn();
vi.mock("../../dispatch/core.js", async () => {
  const actual = await vi.importActual<typeof import("../../dispatch/core.js")>(
    "../../dispatch/core.js",
  );
  return {
    ...actual,
    dispatch: (...args: unknown[]) => mockDispatch(...args),
  };
});

// `resolveParentSessionId` walks the real `<repo>/.danxbot/workspaces/`
// dir on disk to find the parent JSONL — wiring a real session file is
// expensive for a free integration test. Mock the resolver so the
// RESUME path can be driven deterministically by the test's pre-written
// chat-sessions record alone.
const mockResolveParentSessionId = vi.fn();
vi.mock("../../agent/resolve-parent-session.js", () => ({
  resolveParentSessionId: (...args: unknown[]) =>
    mockResolveParentSessionId(...args),
}));

// `isFeatureEnabled` reads `settings.json` on disk; we don't want that
// I/O in a free test, and the route's 503 branch is already covered by
// the unit suite. Force-enable here so the happy paths hit the dispatch
// call.
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

vi.mock("../../worker/restart.js", () => ({
  seedCooldownFromDb: vi.fn().mockResolvedValue(undefined),
}));

import { startWorkerServer } from "../../worker/server.js";

let workerPort: number;
let workerStop: () => Promise<void>;
let repoLocalPath: string;

async function startWorker(): Promise<{
  port: number;
  stop: () => Promise<void>;
  repoLocalPath: string;
}> {
  // Per-test repo dir so chat-sessions writes have somewhere to land.
  // The handler's `writeChatSession` auto-creates the chat-sessions dir,
  // so we only need the repo root.
  const dir = mkdtempSync(resolve(tmpdir(), "chat-flow-integration-"));
  const repo = makeRepoContext({ workerPort: 0, localPath: dir });
  const server = await startWorkerServer(repo);
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    repoLocalPath: dir,
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

describe("chat integration — real worker HTTP", () => {
  beforeAll(async () => {
    const w = await startWorker();
    workerPort = w.port;
    workerStop = w.stop;
    repoLocalPath = w.repoLocalPath;
  });

  afterAll(async () => {
    await workerStop();
  });

  beforeEach(() => {
    mockDispatch.mockReset();
    mockDispatch.mockResolvedValue({
      dispatchId: "integration-chat-1",
      job: {},
    });
    mockResolveParentSessionId.mockReset();
    mockResolveParentSessionId.mockResolvedValue({ kind: "not-found" });
  });

  it("POST /api/chat FRESH path: dispatches with /danx-chat task + persists chat-sessions record", async () => {
    const res = await postJson(workerPort, "/api/chat", {
      repo: "test-repo",
      issue_id: "DX-351",
      text: "please flip status to ToDo",
      api_token: "secret",
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      job_id: "integration-chat-1",
      parent_job_id: null,
      status: "launched",
    });

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const input = mockDispatch.mock.calls[0][0] as {
      workspace: string;
      task: string;
      issueId?: string;
      apiToken?: string;
      resumeSessionId?: string;
      parentJobId?: string;
      apiDispatchMeta: {
        trigger: string;
        metadata: { endpoint: string; workspace: string };
      };
    };
    expect(input.workspace).toBe("issue-chat");
    expect(input.task).toBe(
      "/danx-chat DX-351\n\nplease flip status to ToDo",
    );
    expect(input.issueId).toBe("DX-351");
    expect(input.apiToken).toBe("secret");
    expect(input.resumeSessionId).toBeUndefined();
    expect(input.parentJobId).toBeUndefined();
    expect(input.apiDispatchMeta.metadata.endpoint).toBe("/api/chat");
    expect(input.apiDispatchMeta.metadata.workspace).toBe("issue-chat");

    // Chat-sessions record persisted at the canonical path.
    const recordPath = resolve(
      repoLocalPath,
      ".danxbot",
      "chat-sessions",
      "DX-351.json",
    );
    const record = JSON.parse(readFileSync(recordPath, "utf-8"));
    expect(record.dispatch_id).toBe("integration-chat-1");
    expect(typeof record.updated_at).toBe("string");
  });

  it("POST /api/chat RESUME path: prior chat-sessions record + resolvable session → text-only task + parent_job_id set + new leaf persisted", async () => {
    // Pre-seed the chat-sessions record on disk as if a prior turn had
    // landed.
    const sessionsDir = resolve(
      repoLocalPath,
      ".danxbot",
      "chat-sessions",
    );
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      resolve(sessionsDir, "DX-352.json"),
      JSON.stringify({
        dispatch_id: "prior-leaf-job",
        updated_at: "2026-05-14T07:00:00.000Z",
      }),
      "utf-8",
    );
    mockResolveParentSessionId.mockResolvedValueOnce({
      kind: "found",
      sessionId: "session-uuid-from-prior-leaf",
    });
    mockDispatch.mockResolvedValueOnce({
      dispatchId: "resumed-turn-2",
      job: {},
    });

    const res = await postJson(workerPort, "/api/chat", {
      repo: "test-repo",
      issue_id: "DX-352",
      text: "and also bump priority",
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      job_id: "resumed-turn-2",
      parent_job_id: "prior-leaf-job",
      status: "launched",
    });

    const input = mockDispatch.mock.calls[0][0] as {
      task: string;
      resumeSessionId?: string;
      parentJobId?: string;
    };
    // No `/danx-chat` prefix on resume — claude --resume restores the
    // skill body from the prior session.
    expect(input.task).toBe("and also bump priority");
    expect(input.resumeSessionId).toBe("session-uuid-from-prior-leaf");
    expect(input.parentJobId).toBe("prior-leaf-job");

    // The chat-sessions record is advanced to the new leaf.
    const updated = JSON.parse(
      readFileSync(resolve(sessionsDir, "DX-352.json"), "utf-8"),
    );
    expect(updated.dispatch_id).toBe("resumed-turn-2");
  });

  it("POST /api/chat with malformed issue_id returns 400", async () => {
    const res = await postJson(workerPort, "/api/chat", {
      repo: "test-repo",
      issue_id: "not-a-card-id",
      text: "hi",
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(
      /Invalid issue_id "not-a-card-id"/,
    );
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("POST /api/chat with missing text returns 400", async () => {
    const res = await postJson(workerPort, "/api/chat", {
      repo: "test-repo",
      issue_id: "DX-351",
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Missing or blank required field: text",
    });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("POST /api/chat with missing issue_id returns 400", async () => {
    const res = await postJson(workerPort, "/api/chat", {
      repo: "test-repo",
      text: "hi",
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Missing or blank required field: issue_id",
    });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("GET /api/chat returns 404 (POST-only)", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: workerPort,
          path: "/api/chat",
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
