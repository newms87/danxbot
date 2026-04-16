import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const CLI_PATH = join(__dirname, "capture-server-cli.ts");

describe("capture-server-cli", () => {
  let proc: ChildProcess | null = null;
  let outputFile: string | null = null;

  afterEach(async () => {
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        proc!.on("exit", () => resolve());
        setTimeout(resolve, 3000);
      });
    }
    proc = null;
    if (outputFile && existsSync(outputFile)) {
      unlinkSync(outputFile);
      outputFile = null;
    }
  });

  function startCli(args: string[] = []): Promise<{ port: number; process: ChildProcess }> {
    return new Promise((resolve, reject) => {
      const tsxBin = join(__dirname, "../../../..", "node_modules", ".bin", "tsx");
      proc = spawn(tsxBin, [CLI_PATH, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      let stdout = "";
      proc.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const lines = stdout.split("\n").filter(Boolean);
        if (lines.length > 0) {
          const port = parseInt(lines[0], 10);
          if (!isNaN(port) && port > 0) {
            resolve({ port, process: proc! });
          }
        }
      });

      proc.on("error", reject);
      proc.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`CLI exited with code ${code}`));
        }
      });

      setTimeout(() => reject(new Error("CLI did not print port within 10s")), 10000);
    });
  }

  it("starts on a random port and prints it to stdout", async () => {
    const { port } = await startCli();

    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it("captures requests and writes to output file on shutdown", async () => {
    outputFile = `/tmp/danxbot-cli-test-${Date.now()}.json`;
    const { port } = await startCli(["--output", outputFile]);

    // Send a PUT request
    const putResponse = await fetch(`http://127.0.0.1:${port}/status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "running" }),
    });
    expect(putResponse.ok).toBe(true);

    // Send a POST request
    const postResponse = await fetch(`http://127.0.0.1:${port}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ type: "test" }] }),
    });
    expect(postResponse.ok).toBe(true);

    // Kill the process and wait for output file
    proc!.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      proc!.on("exit", () => resolve());
      setTimeout(resolve, 3000);
    });
    proc = null;

    // Wait for the output file to appear (written by SIGTERM handler)
    const maxWait = 20;
    let waited = 0;
    while (!existsSync(outputFile) && waited < maxWait) {
      await new Promise((r) => setTimeout(r, 100));
      waited++;
    }

    // Verify output file
    expect(existsSync(outputFile)).toBe(true);
    const captured = JSON.parse(readFileSync(outputFile, "utf8"));
    expect(captured).toHaveLength(2);

    expect(captured[0].method).toBe("PUT");
    expect(captured[0].path).toBe("/status");
    expect(JSON.parse(captured[0].body)).toEqual({ status: "running" });

    expect(captured[1].method).toBe("POST");
    expect(captured[1].path).toBe("/events");
  });

  it("responds 200 to all requests", async () => {
    const { port } = await startCli();

    const response = await fetch(`http://127.0.0.1:${port}/anything`, {
      method: "GET",
    });
    expect(response.ok).toBe(true);

    const body = await response.json();
    expect(body).toEqual({ ok: true });
  });

  it("listens on an explicit port when --port is provided", async () => {
    // Use a high ephemeral port unlikely to conflict
    const explicitPort = 19876;
    const { port } = await startCli(["--port", String(explicitPort)]);

    expect(port).toBe(explicitPort);

    const response = await fetch(`http://127.0.0.1:${explicitPort}/test`);
    expect(response.ok).toBe(true);
  });

  it("writes empty array to output file when no requests are captured", async () => {
    outputFile = `/tmp/danxbot-cli-test-empty-${Date.now()}.json`;
    await startCli(["--output", outputFile]);

    // Kill immediately without sending any requests
    proc!.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      proc!.on("exit", () => resolve());
      setTimeout(resolve, 3000);
    });
    proc = null;

    const maxWait = 20;
    let waited = 0;
    while (!existsSync(outputFile) && waited < maxWait) {
      await new Promise((r) => setTimeout(r, 100));
      waited++;
    }

    expect(existsSync(outputFile)).toBe(true);
    const captured = JSON.parse(readFileSync(outputFile, "utf8"));
    expect(captured).toEqual([]);
  });

  it("writes output file on SIGINT as well as SIGTERM", async () => {
    outputFile = `/tmp/danxbot-cli-test-sigint-${Date.now()}.json`;
    const { port } = await startCli(["--output", outputFile]);

    // Send a request so we can verify it's captured
    await fetch(`http://127.0.0.1:${port}/ping`);

    proc!.kill("SIGINT");
    await new Promise<void>((resolve) => {
      proc!.on("exit", () => resolve());
      setTimeout(resolve, 3000);
    });
    proc = null;

    const maxWait = 20;
    let waited = 0;
    while (!existsSync(outputFile) && waited < maxWait) {
      await new Promise((r) => setTimeout(r, 100));
      waited++;
    }

    expect(existsSync(outputFile)).toBe(true);
    const captured = JSON.parse(readFileSync(outputFile, "utf8"));
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/ping");
  });

  it("records monotonically increasing timestamps", async () => {
    outputFile = `/tmp/danxbot-cli-test-ts-${Date.now()}.json`;
    const { port } = await startCli(["--output", outputFile]);

    await fetch(`http://127.0.0.1:${port}/first`);
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    await fetch(`http://127.0.0.1:${port}/second`);

    proc!.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      proc!.on("exit", () => resolve());
      setTimeout(resolve, 3000);
    });
    proc = null;

    const maxWait = 20;
    let waited = 0;
    while (!existsSync(outputFile) && waited < maxWait) {
      await new Promise((r) => setTimeout(r, 100));
      waited++;
    }

    const captured = JSON.parse(readFileSync(outputFile, "utf8"));
    expect(captured).toHaveLength(2);
    expect(captured[0].timestamp).toBeLessThanOrEqual(captured[1].timestamp);
    expect(captured[0].timestamp).toBeGreaterThan(0);
  });
});
