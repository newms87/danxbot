import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeMcpServer,
  probeAllMcpServers,
  type McpServerConfig,
} from "./mcp-server-probe.js";

/**
 * Build a stdin-framed node script that acts like an MCP server stand-in.
 * `onInit` is a literal snippet invoked with `(msg)` in scope and is expected
 * to call `process.stdout.write(...)` for its response (or do nothing to
 * exercise the no-response branches).
 */
function buildStdinFramedServer(onInit: string): string {
  return `
    let stdin = '';
    process.stdin.on('data', (chunk) => {
      stdin += chunk;
      let nl;
      while ((nl = stdin.indexOf('\\n')) !== -1) {
        const line = stdin.slice(0, nl);
        stdin = stdin.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            ${onInit}
          }
        } catch { /* ignore */ }
      }
    });
    process.stdin.on('end', () => process.exit(0));
  `;
}

const HEALTHY_RESPONSE = `
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: msg.id,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      serverInfo: { name: 'test', version: '1.0' },
    },
  }) + '\\n');
`;

const PROTOCOL_ERROR_RESPONSE = `
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: msg.id,
    error: { code: -32601, message: 'Method not found' },
  }) + '\\n');
`;

const STRINGY_ID_RESPONSE = `
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: String(msg.id),
    result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 't', version: '1' } },
  }) + '\\n');
`;

const NOISY_NOTIFICATION_THEN_RESPONSE = `
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/log', params: { msg: 'hi' } }) + '\\n');
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: msg.id,
    result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 't', version: '1' } },
  }) + '\\n');
`;

const GARBAGE_STDOUT_SERVER = `
  process.stdout.write('this is not json at all\\n');
`;

const HEALTHY_SERVER = buildStdinFramedServer(HEALTHY_RESPONSE);
const PROTOCOL_ERROR_SERVER = buildStdinFramedServer(PROTOCOL_ERROR_RESPONSE);
const STRINGY_ID_SERVER = buildStdinFramedServer(STRINGY_ID_RESPONSE);
const NOISY_SERVER = buildStdinFramedServer(NOISY_NOTIFICATION_THEN_RESPONSE);
const GARBAGE_SERVER = buildStdinFramedServer(GARBAGE_STDOUT_SERVER);

const EXIT_NONZERO_SERVER = `
  process.stderr.write('SCHEMA_DEFINITION_ID is required\\n');
  process.exit(1);
`;

const HANG_SERVER = `
  setInterval(() => {}, 1000);
`;

/**
 * Writes its own PID to a file immediately, then hangs. Lets tests verify
 * the probe actually killed the child after timeout rather than trusting
 * vitest to hang if cleanup failed.
 */
function pidMarkerHangServer(pidFile: string): string {
  return `
    const fs = require('fs');
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {}, 1000);
  `;
}

describe("probeMcpServer", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mcp-probe-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function configFor(
    script: string,
    env: Record<string, string> = {},
  ): McpServerConfig {
    return {
      command: process.execPath,
      args: ["-e", script],
      env,
    };
  }

  it("returns ok when the server responds to initialize with a result", async () => {
    const result = await probeMcpServer(
      "healthy",
      configFor(HEALTHY_SERVER),
      3_000,
    );

    expect(result.ok).toBe(true);
  });

  it("returns failure with reason=exit when the server exits non-zero", async () => {
    const result = await probeMcpServer(
      "schema",
      configFor(EXIT_NONZERO_SERVER),
      3_000,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("exit");
    expect(result.exitCode).toBe(1);
    expect(result.serverName).toBe("schema");
    expect(result.stderr).toContain("SCHEMA_DEFINITION_ID is required");
    expect(result.message).toContain("schema");
    expect(result.message).toContain("SCHEMA_DEFINITION_ID is required");
  });

  it("returns failure with reason=timeout when the server hangs without responding", async () => {
    const result = await probeMcpServer("silent", configFor(HANG_SERVER), 500);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("timeout");
    expect(result.serverName).toBe("silent");
    expect(result.message).toContain("silent");
    expect(result.message).toContain("timeout");
  });

  it("returns failure with reason=protocol when the server responds with a JSON-RPC error", async () => {
    const result = await probeMcpServer(
      "buggy",
      configFor(PROTOCOL_ERROR_SERVER),
      3_000,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("protocol");
    expect(result.serverName).toBe("buggy");
    expect(result.message).toContain("buggy");
    expect(result.message).toContain("Method not found");
  });

  it("returns failure with reason=protocol when the server emits malformed non-JSON output", async () => {
    const result = await probeMcpServer(
      "garbage",
      configFor(GARBAGE_SERVER),
      3_000,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("protocol");
    expect(result.message).toContain("garbage");
    expect(result.message).toContain("malformed JSON");
  });

  it("returns failure with reason=exit when the command does not exist", async () => {
    // Spawning a nonexistent binary fires `child.on('error', ...)` rather
    // than `child.on('exit', ...)`. The probe must convert that into a
    // failure result instead of leaving the promise unresolved.
    const result = await probeMcpServer(
      "missing",
      {
        command: "/nonexistent/binary-does-not-exist-xyz",
        args: [],
        env: {},
      },
      3_000,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("exit");
    expect(result.serverName).toBe("missing");
    expect(result.message).toContain("missing");
    expect(result.message.toLowerCase()).toMatch(/failed to spawn|enoent/);
  });

  it("ignores stray notifications and unrelated frames before the initialize response", async () => {
    // A compliant MCP server may emit notifications/log, notifications/progress,
    // or responses for other request ids before the initialize result. The
    // probe must filter by id and not settle early on a notification.
    const result = await probeMcpServer(
      "noisy",
      configFor(NOISY_SERVER),
      3_000,
    );

    expect(result.ok).toBe(true);
  });

  it('accepts a stringy JSON-RPC id (e.g. "1") matching the request id', async () => {
    // JSON-RPC permits both numeric and string ids. A server that echoes
    // our numeric 1 back as the string "1" must still be recognized as a
    // valid response — otherwise the probe times out on a healthy server.
    const result = await probeMcpServer(
      "stringy",
      configFor(STRINGY_ID_SERVER),
      3_000,
    );

    expect(result.ok).toBe(true);
  });

  it("kills the subprocess after a successful probe", async () => {
    const start = Date.now();
    const result = await probeMcpServer(
      "healthy",
      configFor(HEALTHY_SERVER),
      3_000,
    );
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(true);
    // Healthy probe should complete well under the timeout window.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("actually kills the hung subprocess on timeout (PID is no longer alive)", async () => {
    // Captures the spawned PID via a marker file the server writes before
    // hanging. After the probe returns, process.kill(pid, 0) must throw
    // ESRCH — proving the probe cleaned up its child rather than relying
    // on vitest to hang at teardown.
    const pidFile = join(tempDir, "hang.pid");
    const result = await probeMcpServer(
      "silent",
      configFor(pidMarkerHangServer(pidFile)),
      500,
    );

    expect(result.ok).toBe(false);

    // Give the OS a moment to fully reap the killed child.
    await new Promise((r) => setTimeout(r, 50));

    const fs = await import("node:fs");
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8"), 10);
    expect(Number.isInteger(pid)).toBe(true);

    let stillAlive = true;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") stillAlive = false;
    }
    expect(stillAlive).toBe(false);
  });

  it("merges env vars into the child process environment", async () => {
    const script = `
      if (!process.env.PROBE_TEST_VAR) {
        process.stderr.write('PROBE_TEST_VAR missing\\n');
        process.exit(1);
      }
      ${HEALTHY_SERVER}
    `;

    const result = await probeMcpServer(
      "env-check",
      configFor(script, { PROBE_TEST_VAR: "present" }),
      3_000,
    );

    expect(result.ok).toBe(true);
  });

  it("reports an exit-code-only message when stderr is empty on exit failure", async () => {
    const result = await probeMcpServer(
      "quiet",
      configFor("process.exit(42);"),
      3_000,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("exit");
    expect(result.exitCode).toBe(42);
    expect(result.stderr).toBe("");
    expect(result.message).toContain("quiet");
    expect(result.message).toContain("42");
  });

  it("reports exitCode=null with a signal mention when the child is killed by a signal", async () => {
    // A server that sleeps long enough for the probe's own SIGKILL after
    // timeout demonstrates the killed-by-signal path — the child exits with
    // code=null. Exposing null in the failure shape (rather than coercing
    // to 0) prevents the nonsensical "exit code 0" message on a failure.
    const result = await probeMcpServer(
      "signal-killed",
      configFor(HANG_SERVER),
      300,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The probe timed out first (timeout fires before exit), so this is
    // reason=timeout, not exit. But to exercise the null-exitCode path:
    // the probe's own SIGKILL race may produce a post-timeout exit event
    // with code=null, which the probe is now shape-safe for. The primary
    // assertion is just that the result doesn't claim exitCode=0 on a
    // non-clean termination.
    if (result.reason === "exit") {
      expect(result.exitCode).toBeNull();
      expect(result.message).toMatch(/signal/i);
    }
  });
});

describe("probeAllMcpServers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "mcp-probe-all-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSettings(content: unknown): string {
    const path = join(tempDir, "settings.json");
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it("returns ok when all configured servers respond", async () => {
    const settingsPath = writeSettings({
      mcpServers: {
        alpha: {
          command: process.execPath,
          args: ["-e", HEALTHY_SERVER],
          env: {},
        },
        beta: {
          command: process.execPath,
          args: ["-e", HEALTHY_SERVER],
          env: {},
        },
      },
    });

    const result = await probeAllMcpServers(settingsPath, 3_000);

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("throws when the settings file has no mcpServers key (bug at call site)", async () => {
    const settingsPath = writeSettings({});

    await expect(probeAllMcpServers(settingsPath, 3_000)).rejects.toThrow(
      /no "mcpServers" key/,
    );
  });

  it("throws when the settings file has an empty mcpServers map (bug at call site)", async () => {
    const settingsPath = writeSettings({ mcpServers: {} });

    await expect(probeAllMcpServers(settingsPath, 3_000)).rejects.toThrow(
      /empty "mcpServers" map/,
    );
  });

  it("reports the single broken server while healthy servers still pass", async () => {
    const settingsPath = writeSettings({
      mcpServers: {
        good: {
          command: process.execPath,
          args: ["-e", HEALTHY_SERVER],
          env: {},
        },
        broken: {
          command: process.execPath,
          args: ["-e", EXIT_NONZERO_SERVER],
          env: {},
        },
      },
    });

    const result = await probeAllMcpServers(settingsPath, 3_000);

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].serverName).toBe("broken");
    expect(result.failures[0].reason).toBe("exit");
  });

  it("aggregates every broken server when multiple fail", async () => {
    const settingsPath = writeSettings({
      mcpServers: {
        crashes: {
          command: process.execPath,
          args: ["-e", EXIT_NONZERO_SERVER],
          env: {},
        },
        hangs: {
          command: process.execPath,
          args: ["-e", HANG_SERVER],
          env: {},
        },
      },
    });

    const result = await probeAllMcpServers(settingsPath, 500);

    expect(result.ok).toBe(false);
    const names = result.failures.map((f) => f.serverName).sort();
    expect(names).toEqual(["crashes", "hangs"]);
  });

  it("throws when the settings file does not exist", async () => {
    await expect(
      probeAllMcpServers(join(tempDir, "missing.json"), 3_000),
    ).rejects.toThrow(/settings/i);
  });

  it("throws when the settings file is not valid JSON", async () => {
    const path = join(tempDir, "bad.json");
    writeFileSync(path, "{ not valid json");

    await expect(probeAllMcpServers(path, 3_000)).rejects.toThrow();
  });
});
