/**
 * Sibling unit tests in `src/terminal.test.ts` cover the WRITTEN script
 * (string shape, ordering, `bash -n` syntax). They cannot catch a runtime
 * regression where the script is well-formed bash but fails when actually
 * executed (wrong variable name, `set -u` interaction, an `echo $$` typo
 * the regex misses). This file fills that gap.
 *
 * The `exec script -q -f -c "claude ..."` final line is regex-replaced with
 * `exec tail -f /dev/null` so no util-linux `script` and no real claude is
 * launched — isolating the PID-emit seam from every downstream cascade.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { buildDispatchScript } from "../../terminal.js";

describe("buildDispatchScript (integration)", () => {
  let dir: string;
  let child: ChildProcess | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "host-dispatch-script-it-"));
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            child!.kill("SIGKILL");
          } catch {
            // FALLTHROUGH
          }
          resolve();
        }, 1000);
        child!.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    child = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function buildAndStub(pidFilePath: string): string {
    const scriptPath = buildDispatchScript(dir, {
      flags: ["--dangerously-skip-permissions", "--verbose"],
      firstMessage: "<!-- danxbot-dispatch:it-test --> @/tmp/p/prompt.md",
      jobId: "it-test",
      terminalLogPath: join(dir, "terminal.log"),
      apiToken: "tok",
      pidFilePath,
    });

    const original = readFileSync(scriptPath, "utf-8");
    const stubbed = original.replace(
      /^exec script -q -f.*$/m,
      "exec tail -f /dev/null",
    );
    if (stubbed === original) {
      throw new Error(
        "Stub substitution did not fire — the `exec script -q -f` line shape changed. Update the test regex.",
      );
    }
    writeFileSync(scriptPath, stubbed, "utf-8");
    return scriptPath;
  }

  async function waitForFile(path: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (!existsSync(path)) {
      if (Date.now() - start >= timeoutMs) {
        throw new Error(
          `waitForFile timed out after ${timeoutMs}ms — ${path} never appeared`,
        );
      }
      await sleep(20);
    }
  }

  it("writes its own PID to pidFilePath when the generated script runs under bash", async () => {
    const pidFile = join(dir, "claude.pid");
    const scriptPath = buildAndStub(pidFile);

    child = spawn("bash", [scriptPath], { stdio: "ignore" });
    expect(child.pid).toBeGreaterThan(0);

    await waitForFile(pidFile, 2000);

    const contents = readFileSync(pidFile, "utf-8").trim();
    expect(contents).toMatch(/^\d+$/);
    const pid = Number(contents);

    // PID stability under exec is the load-bearing detail in terminal.ts:154-167:
    // bash writes $$ → exec replaces bash with tail (or `script` in prod) without
    // changing the PID, so the PID file points at whatever wraps claude's pty.
    expect(pid).toBe(child.pid);
    expect(() => process.kill(pid, 0)).not.toThrow();
  });
});
