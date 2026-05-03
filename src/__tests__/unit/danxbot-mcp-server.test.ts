/**
 * Unit tests for the danxbot MCP server.
 *
 * Tests the stdio JSON-RPC protocol handling and danxbot_complete tool.
 * Spawns the real server script as a child process to test the full protocol.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

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
   * Capture server that records every issue-save / issue-create POST so
   * tests can assert the body the agent sent and respond with a custom
   * status + JSON. Keyed by URL path so a single server can route both
   * tools.
   */
  function createIssueServer(): Promise<{
    saveUrl: string;
    createUrl: string;
    saveRequests: Array<{ body: Record<string, unknown> }>;
    createRequests: Array<{ body: Record<string, unknown> }>;
    setNextSaveResponse: (status: number, body: unknown) => void;
    setNextCreateResponse: (status: number, body: unknown) => void;
    close: () => Promise<void>;
  }> {
    return new Promise((resolveOuter) => {
      const saveRequests: Array<{ body: Record<string, unknown> }> = [];
      const createRequests: Array<{ body: Record<string, unknown> }> = [];
      let nextSave = { status: 200, body: { saved: true } as unknown };
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
          if (path.includes("/api/issue-save/")) {
            saveRequests.push({ body });
            res.writeHead(nextSave.status, {
              "Content-Type": "application/json",
            });
            res.end(JSON.stringify(nextSave.body));
            return;
          }
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
          saveUrl: `${base}/api/issue-save/test-job`,
          createUrl: `${base}/api/issue-create/test-job`,
          saveRequests,
          createRequests,
          setNextSaveResponse: (status, body) => {
            nextSave = { status, body };
          },
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
    issueSaveUrl: string | undefined,
    issueCreateUrl: string | undefined,
  ): ChildProcess {
    return spawn(tsxBin, [serverScript], {
      env: {
        ...process.env,
        DANXBOT_STOP_URL: stopUrl,
        DANXBOT_ISSUE_SAVE_URL: issueSaveUrl,
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

  it("advertises danx_issue_save + danx_issue_create when both URLs are set", async () => {
    proc = spawnIssueServer(
      stopServer.url,
      issueServer.saveUrl,
      issueServer.createUrl,
    );
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
    expect(names).toContain("danx_issue_save");
    expect(names).toContain("danx_issue_create");
  }, 10_000);

  it("hides danx_issue_create when only DANXBOT_ISSUE_SAVE_URL is set (AND-semantics on filter)", async () => {
    // Pins the filter contract: each tool's URL is its OWN gate.
    // A regression to OR-semantics ("any issue URL set → expose both")
    // would let a partially-configured dispatch advertise a tool whose
    // env var is undefined and the agent would crash on first call.
    proc = spawnIssueServer(stopServer.url, issueServer.saveUrl, undefined);
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
    expect(names).toContain("danx_issue_save");
    expect(names).not.toContain("danx_issue_create");
  }, 10_000);

  it("hides danx_issue_* tools when URLs are absent", async () => {
    proc = spawnIssueServer(stopServer.url, undefined, undefined);
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
    expect(names).not.toContain("danx_issue_save");
    expect(names).not.toContain("danx_issue_create");
  }, 10_000);

  it("calls danx_issue_save → POSTs to save URL → returns worker JSON verbatim", async () => {
    proc = spawnIssueServer(
      stopServer.url,
      issueServer.saveUrl,
      issueServer.createUrl,
    );
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

    issueServer.setNextSaveResponse(200, { saved: true });
    const response = await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "danx_issue_save",
        arguments: { external_id: "card-1" },
      },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(JSON.parse(result.content[0].text)).toEqual({ saved: true });
    expect(issueServer.saveRequests).toHaveLength(1);
    expect(issueServer.saveRequests[0].body).toEqual({ external_id: "card-1" });
  }, 10_000);

  it("calls danx_issue_create → POSTs to create URL → forwards worker JSON", async () => {
    proc = spawnIssueServer(
      stopServer.url,
      issueServer.saveUrl,
      issueServer.createUrl,
    );
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
    proc = spawnIssueServer(
      stopServer.url,
      issueServer.saveUrl,
      issueServer.createUrl,
    );
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

    issueServer.setNextSaveResponse(500, { error: "boom" });
    const response = await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "danx_issue_save",
        arguments: { external_id: "card" },
      },
    });
    expect(response.error).toBeDefined();
    expect((response.error as { message: string }).message).toContain("500");
  }, 10_000);

  it("returns saved:false body verbatim on 200 response (validation failure)", async () => {
    proc = spawnIssueServer(
      stopServer.url,
      issueServer.saveUrl,
      issueServer.createUrl,
    );
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

    issueServer.setNextSaveResponse(200, {
      saved: false,
      errors: ["missing required field: title"],
    });
    const response = await sendMessage(proc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "danx_issue_save",
        arguments: { external_id: "broken" },
      },
    });
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(JSON.parse(result.content[0].text)).toEqual({
      saved: false,
      errors: ["missing required field: title"],
    });
  }, 10_000);

  it("rejects danx_issue_save when called without DANXBOT_ISSUE_SAVE_URL", async () => {
    proc = spawnIssueServer(stopServer.url, undefined, undefined);
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
        name: "danx_issue_save",
        arguments: { external_id: "x" },
      },
    });
    expect(response.error).toBeDefined();
    expect((response.error as { message: string }).message).toContain(
      "DANXBOT_ISSUE_SAVE_URL",
    );
  }, 10_000);
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
