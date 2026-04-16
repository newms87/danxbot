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
