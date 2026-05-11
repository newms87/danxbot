/**
 * Unit tests for the danxbot MCP server.
 *
 * Tests the stdio JSON-RPC protocol handling and danxbot_complete tool.
 * Spawns the real server script as a child process to test the full protocol.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  probePgReachable,
  resolveTestPgHost,
} from "../helpers/test-pg.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../../..");
const tsxBin = resolve(projectRoot, "node_modules/.bin/tsx");
const serverScript = resolve(projectRoot, "src/mcp/danxbot-server.ts");

/** Simple HTTP capture server that records stop requests */
function createStopServer(): Promise<{
  url: string;
  requests: Array<{ status: string; summary: string }>;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const requests: Array<{ status: string; summary: string }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          requests.push(JSON.parse(body));
        } catch { /* ignore */ }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/api/stop/test-job`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Spawn the danxbot MCP server with the given stop URL */
function spawnServer(stopUrl: string): ChildProcess {
  return spawn(tsxBin, [serverScript], {
    env: { ...process.env, DANXBOT_STOP_URL: stopUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Send a JSON-RPC message and collect lines of output */
function sendMessage(
  proc: ChildProcess,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for response")), 5_000);

    let buffer = "";
    const onData = (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          // Only resolve on a response with a matching id
          if (parsed.id === message.id) {
            clearTimeout(timer);
            proc.stdout?.removeListener("data", onData);
            resolve(parsed);
          }
        } catch { /* not a JSON line yet */ }
      }
      buffer = lines[lines.length - 1];
    };

    proc.stdout?.on("data", onData);
    proc.stdin?.write(JSON.stringify(message) + "\n");
  });
}

describe("danxbot MCP server", () => {
  let stopServer: Awaited<ReturnType<typeof createStopServer>>;
  let proc: ChildProcess;

  beforeEach(async () => {
    stopServer = await createStopServer();
    proc = spawnServer(stopServer.url);
    // Give the server a moment to start
    await new Promise((r) => setTimeout(r, 500));
  });

  afterEach(async () => {
    proc.kill("SIGTERM");
    await stopServer.close();
  });

  it("responds to initialize with server capabilities", async () => {
    const response = await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities).toBeDefined();
    expect((result.capabilities as Record<string, unknown>).tools).toBeDefined();
    expect(result.serverInfo).toMatchObject({ name: "danxbot" });
  }, 10_000);

  it("lists danxbot_complete tool via tools/list", async () => {
    // Initialize first
    await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const response = await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    expect(response.error).toBeUndefined();
    const result = response.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("danxbot_complete");
    expect(result.tools[0].description).toBeTruthy();
    expect(result.tools[0].inputSchema).toBeDefined();
  }, 10_000);

  it("calls danxbot_complete and POSTs to stop URL", async () => {
    await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const response = await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "danxbot_complete",
        arguments: { status: "completed", summary: "All tasks finished." },
      },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("completed");

    // Verify the stop server received the POST
    await new Promise((r) => setTimeout(r, 200));
    expect(stopServer.requests).toHaveLength(1);
    expect(stopServer.requests[0].status).toBe("completed");
    expect(stopServer.requests[0].summary).toBe("All tasks finished.");
  }, 10_000);

  it("returns error for unknown tool", async () => {
    await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const response = await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "unknown_tool", arguments: {} },
    });

    expect(response.error).toBeDefined();
    expect((response.error as { message: string }).message).toContain("Unknown tool");
  }, 10_000);

  it("responds to ping with empty result", async () => {
    const response = await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 5,
      method: "ping",
      params: {},
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({});
  }, 10_000);

  it("returns method-not-found for truly unknown methods", async () => {
    const response = await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 6,
      method: "resources/list",
      params: {},
    });

    expect(response.error).toBeDefined();
    expect((response.error as { code: number }).code).toBe(-32601);
  }, 10_000);

  it("calls danxbot_complete with status failed and POSTs correctly", async () => {
    await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
    });

    const response = await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "danxbot_complete",
        arguments: { status: "failed", summary: "Encountered fatal error." },
      },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].text).toContain("failed");

    await new Promise((r) => setTimeout(r, 200));
    expect(stopServer.requests).toHaveLength(1);
    expect(stopServer.requests[0].status).toBe("failed");
    expect(stopServer.requests[0].summary).toBe("Encountered fatal error.");
  }, 10_000);
});

describe("danxbot MCP server — issue tools", () => {
  /**
   * Capture server that records every issue-create POST so tests can
   * assert the body the agent sent and respond with a custom status +
   * JSON. DX-157 retired the parallel save HTTP route; the watcher now
   * mirrors agent edits to the DB on every YAML write and the poller's
   * per-tick mirror handles the outbound tracker push.
   */
  function createIssueServer(): Promise<{
    createUrl: string;
    createRequests: Array<{ body: Record<string, unknown> }>;
    setNextCreateResponse: (status: number, body: unknown) => void;
    close: () => Promise<void>;
  }> {
    return new Promise((resolveOuter) => {
      const createRequests: Array<{ body: Record<string, unknown> }> = [];
      let nextCreate = {
        status: 200,
        body: { created: true, external_id: "mem-1" } as unknown,
      };
      const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          const body = raw ? JSON.parse(raw) : {};
          const path = req.url ?? "/";
          if (path.includes("/api/issue-create/")) {
            createRequests.push({ body });
            res.writeHead(nextCreate.status, {
              "Content-Type": "application/json",
            });
            res.end(JSON.stringify(nextCreate.body));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        const base = `http://127.0.0.1:${port}`;
        resolveOuter({
          createUrl: `${base}/api/issue-create/test-job`,
          createRequests,
          setNextCreateResponse: (status, body) => {
            nextCreate = { status, body };
          },
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    });
  }

  function spawnIssueServer(
    stopUrl: string,
    issueCreateUrl: string | undefined,
  ): ChildProcess {
    return spawn(tsxBin, [serverScript], {
      env: {
        ...process.env,
        DANXBOT_STOP_URL: stopUrl,
        DANXBOT_ISSUE_CREATE_URL: issueCreateUrl,
      } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  let stopServer: Awaited<ReturnType<typeof createStopServer>>;
  let issueServer: Awaited<ReturnType<typeof createIssueServer>>;
  let proc: ChildProcess;

  beforeEach(async () => {
    stopServer = await createStopServer();
    issueServer = await createIssueServer();
  });

  afterEach(async () => {
    proc?.kill("SIGTERM");
    await stopServer.close();
    await issueServer.close();
  });

  it("advertises danx_issue_create when its URL is set", async () => {
    proc = spawnIssueServer(stopServer.url, issueServer.createUrl);
    await new Promise((r) => setTimeout(r, 500));

    await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });

    const response = await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const result = response.result as {
      tools: Array<{ name: string }>;
    };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("danx_issue_create");
    // DX-157 retired the parallel save tool — agents `Edit` directly.
    // Confirm the legacy tool name is NOT advertised by checking the
    // pruned tool surface against a hardcoded allowlist.
    expect(names).toEqual(
      expect.arrayContaining(["danxbot_complete", "danx_issue_create"]),
    );
    expect(names).not.toContain("danxbot_slack_reply");
  }, 10_000);

  it("hides danx_issue_create when its URL is absent", async () => {
    proc = spawnIssueServer(stopServer.url, undefined);
    await new Promise((r) => setTimeout(r, 500));

    await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });

    const response = await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const result = response.result as {
      tools: Array<{ name: string }>;
    };
    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain("danx_issue_create");
  }, 10_000);

  it("calls danx_issue_create → POSTs to create URL → forwards worker JSON", async () => {
    proc = spawnIssueServer(stopServer.url, issueServer.createUrl);
    await new Promise((r) => setTimeout(r, 500));

    await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });

    issueServer.setNextCreateResponse(200, {
      created: true,
      external_id: "mem-42",
    });
    const response = await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "danx_issue_create",
        arguments: { filename: "draft" },
      },
    });
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(JSON.parse(result.content[0].text)).toEqual({
      created: true,
      external_id: "mem-42",
    });
    expect(issueServer.createRequests[0].body).toEqual({ filename: "draft" });
  }, 10_000);

  it("forwards a worker non-2xx as a JSON-RPC error", async () => {
    proc = spawnIssueServer(stopServer.url, issueServer.createUrl);
    await new Promise((r) => setTimeout(r, 500));

    await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });

    issueServer.setNextCreateResponse(500, { error: "boom" });
    const response = await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "danx_issue_create",
        arguments: { filename: "broken" },
      },
    });
    expect(response.error).toBeDefined();
    expect((response.error as { message: string }).message).toContain("500");
  }, 10_000);

  it("returns created:false body verbatim on 200 response (validation failure)", async () => {
    proc = spawnIssueServer(stopServer.url, issueServer.createUrl);
    await new Promise((r) => setTimeout(r, 500));

    await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });

    issueServer.setNextCreateResponse(200, {
      created: false,
      errors: ["missing required field: title"],
    });
    const response = await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "danx_issue_create",
        arguments: { filename: "broken" },
      },
    });
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(JSON.parse(result.content[0].text)).toEqual({
      created: false,
      errors: ["missing required field: title"],
    });
  }, 10_000);

  it("rejects danx_issue_create when called without DANXBOT_ISSUE_CREATE_URL", async () => {
    proc = spawnIssueServer(stopServer.url, undefined);
    await new Promise((r) => setTimeout(r, 500));

    await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    });

    // Tool is hidden from tools/list, but `tools/call` reaches the
    // dispatcher anyway — the dispatcher's fail-loud guard is the
    // safety net.
    const response = await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "danx_issue_create",
        arguments: { filename: "draft" },
      },
    });
    expect(response.error).toBeDefined();
    expect((response.error as { message: string }).message).toContain(
      "DANXBOT_ISSUE_CREATE_URL",
    );
  }, 10_000);
});

describe("danxbot MCP server — DX-242 DB fallback (real pg)", () => {
  /**
   * The DB-success branch lights up when the worker is unreachable
   * AND the postgres pool credentials reach the spawned MCP via
   * `DANXBOT_DB_*` env. We seed a `dispatches` row, spawn the server
   * with an unreachable stop URL + real DB creds, call
   * `danxbot_complete`, and assert the row transitions terminal in
   * the database — proving the env injection path AND the SQL UPDATE.
   *
   * Skip gate (DX-254): the single beforeAll below probes BOTH env
   * AND TCP reachability. `pgEnv` is set only when both succeed,
   * matching the consolidated gate in
   * `danxbot-stop-fallback.test.ts`. The prior split-gate (sync
   * env-read at module load + async probe in beforeAll) decided
   * skip in two places — the consolidated gate ties every
   * `ctx.skip()` below back to one decision point.
   *
   * Pairs with the `tryDirectDbWrite` unit suite in
   * `danxbot-stop-fallback.test.ts`, which exercises the SQL
   * directly. This test exercises the env-plumbing + chain ordering.
   *
   * Host portability — see `resolveTestPgHost` (DX-256).
   */
  let pgEnv: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  } | undefined;

  beforeAll(async () => {
    const host = process.env.DANXBOT_DB_HOST;
    const portRaw = process.env.DANXBOT_DB_PORT;
    const user = process.env.DANXBOT_DB_USER;
    const password = process.env.DANXBOT_DB_PASSWORD;
    const database = process.env.DANXBOT_DB_NAME;
    if (!host || !user || !password || !database) return; // env absent
    const port = portRaw ? parseInt(portRaw, 10) : 5432;
    if (!Number.isFinite(port)) return; // malformed port
    const candidate = {
      host: resolveTestPgHost(host),
      port,
      user,
      password,
      database,
    };
    if (await probePgReachable(candidate)) {
      pgEnv = candidate; // env present AND pg reachable
    }
  });

  it(
    "critical_failure status writes the row as 'failed' (CompleteStatus → DispatchStatus collapse)",
    async (ctx) => {
      if (!pgEnv) {
        ctx.skip();
        return;
      }
      const { Pool } = await import("pg");
      const { randomUUID } = await import("node:crypto");
      const pool = new Pool({
        host: pgEnv.host,
        port: pgEnv.port,
        user: pgEnv.user,
        password: pgEnv.password,
        database: pgEnv.database,
        max: 2,
      });
      const dispatchId = `test-mcp-fb-${randomUUID()}`;
      try {
        await pool.query(
          `INSERT INTO dispatches
            (id, repo_name, "trigger", trigger_metadata,
             "status", started_at, runtime_mode)
           VALUES ($1, 'test-repo', 'api', '{}'::jsonb,
                   'running', $2, 'host')`,
          [dispatchId, Date.now()],
        );

        const proc = spawn(tsxBin, [serverScript], {
          env: {
            ...process.env,
            DANXBOT_STOP_URL: `http://127.0.0.1:1/api/stop/${dispatchId}`,
            DANXBOT_DISPATCH_ID: dispatchId,
            DANXBOT_DB_HOST: pgEnv.host,
            DANXBOT_DB_PORT: String(pgEnv.port),
            DANXBOT_DB_USER: pgEnv.user,
            DANXBOT_DB_PASSWORD: pgEnv.password,
            DANXBOT_DB_NAME: pgEnv.database,
          } as NodeJS.ProcessEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });

        try {
          await new Promise((r) => setTimeout(r, 500));
          await sendMessage(proc, {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "test", version: "1.0" },
            },
          });
          const response = await sendMessage(proc, {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "danxbot_complete",
              arguments: {
                status: "critical_failure",
                summary: "MCP not loaded — env-level blocker",
              },
            },
          });
          expect(response.error).toBeUndefined();
          const result = response.result as {
            content: Array<{ type: string; text: string }>;
          };
          // Success message indicates DB fallback fired.
          expect(result.content[0].text).toContain("DB fallback");
        } finally {
          proc.kill("SIGTERM");
          // Give pg a beat to flush its connection close.
          await new Promise((r) => setTimeout(r, 200));
        }

        // Row finalized in DB. critical_failure collapses to `failed`
        // per the agent-facing → DB-status map.
        const { rows } = await pool.query<{
          status: string;
          summary: string;
        }>(
          `SELECT "status", summary FROM dispatches WHERE id = $1`,
          [dispatchId],
        );
        expect(rows[0].status).toBe("failed");
        expect(rows[0].summary).toBe("MCP not loaded — env-level blocker");
      } finally {
        await pool.query("DELETE FROM dispatches WHERE id = $1", [dispatchId]);
        await pool.end();
      }
    },
    20_000,
  );
});

describe("danxbot MCP server — DX-242 fallback chain", () => {
  /**
   * Spawn the MCP server with an unreachable stop URL, point its
   * filesystem-queue path at a tmpdir, and assert that
   * `danxbot_complete` still succeeds — the queue file is the
   * fallback path that absorbs the worker outage. Mirrors the
   * production scenario where the worker process dies before the
   * agent gets a chance to call `danxbot_complete`.
   *
   * No DB creds are configured, so the chain is HTTP → fs queue (the
   * DB step is gated on `readFallbackDbConfig` returning a config).
   * That keeps the unit test free of postgres without losing
   * coverage of the queue write itself — DB-fallback coverage lives
   * in the dedicated stop-fallback unit suite.
   */
  let workArea: string;

  beforeEach(() => {
    workArea = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "danxbot-fallback-"),
    );
  });

  afterEach(() => {
    require("node:fs").rmSync(workArea, { recursive: true, force: true });
  });

  it("queues to filesystem when the stop URL is unreachable", async () => {
    const dispatchId = "test-dispatch-fallback";
    // Loopback port 1 is reserved + nothing listens — connection
    // refused immediately, exactly the failure mode worker-down
    // exhibits.
    const proc = spawn(tsxBin, [serverScript], {
      env: {
        ...process.env,
        DANXBOT_STOP_URL: `http://127.0.0.1:1/api/stop/${dispatchId}`,
        DANXBOT_DISPATCH_ID: dispatchId,
        DANX_REPO_ROOT: workArea,
        // Deliberately no DANXBOT_DB_* vars — DB fallback skipped.
        DANXBOT_DB_HOST: undefined,
        DANXBOT_DB_USER: undefined,
        DANXBOT_DB_PASSWORD: undefined,
      } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      await new Promise((r) => setTimeout(r, 500));

      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      });

      const response = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "danxbot_complete",
          arguments: {
            status: "completed",
            summary: "Dispatched while worker was down.",
          },
        },
      });

      // No JSON-RPC error — fallback chain absorbed the worker
      // outage.
      expect(response.error).toBeUndefined();
      const result = response.result as {
        content: Array<{ type: string; text: string }>;
      };
      expect(result.content[0].text).toContain("queued for boot replay");

      // Queue file landed on disk with the agent-facing status (NOT
      // the collapsed DB status — the boot replay needs the original
      // value to re-route critical_failure correctly).
      const queueFile = require("node:path").join(
        workArea,
        ".danxbot",
        "dispatch-stops",
        `${dispatchId}.json`,
      );
      expect(require("node:fs").existsSync(queueFile)).toBe(true);
      const body = JSON.parse(
        require("node:fs").readFileSync(queueFile, "utf-8"),
      );
      expect(body).toMatchObject({
        dispatchId,
        status: "completed",
        summary: "Dispatched while worker was down.",
      });
      expect(typeof body.timestamp).toBe("string");
    } finally {
      proc.kill("SIGTERM");
    }
  }, 15_000);

  it("fails loud when no fallback paths are configured (worker down + no fallback context)", async () => {
    const proc = spawn(tsxBin, [serverScript], {
      env: {
        ...process.env,
        DANXBOT_STOP_URL: "http://127.0.0.1:1/api/stop/no-fallback",
        // No DISPATCH_ID, no REPO_ROOT, no DB creds.
        DANXBOT_DISPATCH_ID: undefined,
        DANX_REPO_ROOT: undefined,
        DANXBOT_DB_HOST: undefined,
        DANXBOT_DB_USER: undefined,
        DANXBOT_DB_PASSWORD: undefined,
      } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      await new Promise((r) => setTimeout(r, 500));

      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0" },
        },
      });

      const response = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "danxbot_complete",
          arguments: { status: "completed", summary: "ok" },
        },
      });

      // No fallback context => fail loud rather than silently
      // succeed against a worker that ate the signal.
      expect(response.error).toBeDefined();
      expect((response.error as { message: string }).message).toContain(
        "Stop API unreachable",
      );
    } finally {
      proc.kill("SIGTERM");
    }
  }, 15_000);
});

describe("danxbot MCP server — startup error", () => {
  it("exits with code 1 when DANXBOT_STOP_URL is not set", async () => {
    const proc = spawn(tsxBin, [serverScript], {
      env: { ...process.env, DANXBOT_STOP_URL: undefined },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      proc.on("close", (code) => resolve(code));
      setTimeout(() => { proc.kill("SIGTERM"); resolve(null); }, 5_000);
    });

    expect(exitCode).toBe(1);
  }, 10_000);
});

describe("danxbot MCP server — stop API failure", () => {
  it("returns JSON-RPC error when stop API responds non-2xx", async () => {
    // Create a server that always responds 500
    const errorServer = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(500);
        res.end("Internal Server Error");
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}/api/stop/test-job`,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    });

    const proc = spawn(tsxBin, [serverScript], {
      env: { ...process.env, DANXBOT_STOP_URL: errorServer.url },
      stdio: ["pipe", "pipe", "pipe"],
    });

    await new Promise((r) => setTimeout(r, 500));

    try {
      await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
      });

      const response = await sendMessage(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "danxbot_complete",
          arguments: { status: "completed", summary: "Done." },
        },
      });

      expect(response.error).toBeDefined();
      expect((response.error as { message: string }).message).toContain("500");
    } finally {
      proc.kill("SIGTERM");
      await errorServer.close();
    }
  }, 15_000);
});
