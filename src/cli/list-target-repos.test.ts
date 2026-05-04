import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "../..");
const SCRIPT_REL = "src/cli/list-target-repos.ts";

let tmp: string;

/**
 * Build a temp project root that:
 *   - Symlinks `src/`, `node_modules/`, `package.json`, and `tsconfig.json`
 *     back to the real project so `npx tsx` can resolve everything.
 *   - Owns a fresh `deploy/targets/` dir so each test writes its own fixture.
 *
 * Mirrors the test-fixture pattern in `src/__tests__/integration/launch-all-workers.test.ts`.
 */
function setupTmpProject(): void {
  tmp = mkdtempSync(resolve(tmpdir(), "list-target-repos-test-"));
  symlinkSync(resolve(PROJECT_ROOT, "src"), resolve(tmp, "src"));
  symlinkSync(resolve(PROJECT_ROOT, "node_modules"), resolve(tmp, "node_modules"));
  symlinkSync(resolve(PROJECT_ROOT, "package.json"), resolve(tmp, "package.json"));
  symlinkSync(resolve(PROJECT_ROOT, "tsconfig.json"), resolve(tmp, "tsconfig.json"));
  mkdirSync(resolve(tmp, "deploy/targets"), { recursive: true });
}

function writeTarget(name: string, body: string): void {
  writeFileSync(resolve(tmp, "deploy/targets", `${name}.yml`), body, "utf-8");
}

function runScript(targetName?: string): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (targetName) env["DANXBOT_TARGET"] = targetName;
  else delete env["DANXBOT_TARGET"];
  const r = spawnSync("npx", ["tsx", SCRIPT_REL], {
    cwd: tmp,
    env,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? 1,
  };
}

beforeEach(() => {
  setupTmpProject();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("list-target-repos.ts", () => {
  // The Makefile's `for name in $(TARGET_REPO_NAMES)` shell loop depends on
  // whitespace-separated tokens — i.e. exactly one repo name per line. Any
  // change to the output format (commas, JSON, multi-token lines) silently
  // breaks `make launch-infra`, `make launch-all-workers`, `make stop-all-workers`,
  // and `make validate-repos`. Pin the format here so a future refactor to
  // e.g. `names.join(",")` fails this test loudly instead of failing the
  // Makefile cryptically.
  it("emits one repo name per line in target order", () => {
    writeTarget(
      "local",
      [
        "name: local",
        "mode: local",
        "repos:",
        "  - name: alpha",
        "    url: https://example.com/a.git",
        "    worker_port: 5561",
        "  - name: bravo",
        "    url: https://example.com/b.git",
        "    worker_port: 5562",
        "  - name: charlie",
        "    url: https://example.com/c.git",
        "    worker_port: 5563",
        "",
      ].join("\n"),
    );

    const { stdout, status, stderr } = runScript("local");

    expect(status, `stderr:\n${stderr}`).toBe(0);
    expect(stdout).toBe("alpha\nbravo\ncharlie\n");
  });

  it("emits empty stdout (and exits 0) when the target has no repos", () => {
    writeTarget("local", "name: local\nmode: local\nrepos: []\n");

    const { stdout, status } = runScript("local");

    expect(status).toBe(0);
    expect(stdout).toBe("");
  });

  it("loads the target named by DANXBOT_TARGET (not always 'local')", () => {
    writeTarget("local", "name: local\nmode: local\nrepos: []\n");
    writeTarget(
      "gpt",
      [
        "name: gpt",
        "repos:",
        "  - name: only-gpt-repo",
        "    url: https://example.com/g.git",
        "    worker_port: 5562",
        "",
      ].join("\n"),
    );

    const { stdout, status } = runScript("gpt");

    expect(status).toBe(0);
    expect(stdout).toBe("only-gpt-repo\n");
  });

  it("exits non-zero when the target file is missing (operator typo / wrong DANXBOT_TARGET)", () => {
    // No target file at all — loadTarget throws, the script propagates.
    const { status, stderr } = runScript("nonexistent");

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/deploy\/targets\/nonexistent\.yml/);
  });
});
