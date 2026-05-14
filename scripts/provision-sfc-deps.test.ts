/**
 * Smoke tests for the provision-sfc-deps CLI. The CLI is a thin
 * orchestrator over `runProvisionSfcDepsJob` + `runPruneSfcDepsJob`,
 * but its operator-visible contract is the exit-code matrix
 * (`0` clean, `1` per-version failures, `64` no source). We exercise
 * the `main` body by importing it after `process.exit` is stubbed
 * and the runners are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("provision-sfc-deps CLI exit-code matrix", () => {
  let exits: number[];
  let stderr: string[];
  let stdout: string[];
  let envBefore: NodeJS.ProcessEnv;

  beforeEach(() => {
    exits = [];
    stderr = [];
    stdout = [];
    envBefore = { ...process.env };
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exits.push(code ?? 0);
      throw new Error("__EXIT__");
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((c: any) => {
      stderr.push(typeof c === "string" ? c : c.toString());
      return true;
    }) as never);
    vi.spyOn(process.stdout, "write").mockImplementation(((c: any) => {
      stdout.push(typeof c === "string" ? c : c.toString());
      return true;
    }) as never);
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("SFC_DEPS_")) delete process.env[k];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = envBefore;
    vi.resetModules();
  });

  async function importMain() {
    vi.resetModules();
    const mod = await import("./provision-sfc-deps.js");
    return mod;
  }

  it("exits 64 when neither SFC_DEPS_LOCAL_MANIFEST_DIR nor SFC_DEPS_S3_BUCKET is set", async () => {
    // No mocks needed — falls into resolveManifestSourceFromEnv null
    // branch before invoking the runners.
    const mod = await importMain();
    await expect(mod._cliMainForTest()).rejects.toThrow("__EXIT__");
    expect(exits).toEqual([64]);
    expect(stderr.join("")).toContain("no manifest source configured");
  });

  it("exits 1 when runProvisionSfcDepsJob throws", async () => {
    process.env.SFC_DEPS_LOCAL_MANIFEST_DIR = "/tmp/__nope__";
    vi.doMock("../src/cron/jobs/provision-sfc-deps.js", () => ({
      runProvisionSfcDepsJob: async () => {
        throw new Error("provisioner exploded");
      },
    }));
    vi.doMock("../src/cron/jobs/prune-sfc-deps.js", () => ({
      runPruneSfcDepsJob: async () => {},
    }));
    const mod = await importMain();
    await expect(mod._cliMainForTest()).rejects.toThrow("__EXIT__");
    expect(exits).toEqual([1]);
    expect(stderr.join("")).toContain("provisioner threw");
  });

  it("exits 1 when runPruneSfcDepsJob throws", async () => {
    process.env.SFC_DEPS_LOCAL_MANIFEST_DIR = "/tmp/__nope__";
    vi.doMock("../src/cron/jobs/provision-sfc-deps.js", () => ({
      runProvisionSfcDepsJob: async () => {},
    }));
    vi.doMock("../src/cron/jobs/prune-sfc-deps.js", () => ({
      runPruneSfcDepsJob: async () => {
        throw new Error("prune exploded");
      },
    }));
    const mod = await importMain();
    await expect(mod._cliMainForTest()).rejects.toThrow("__EXIT__");
    expect(exits).toEqual([1]);
    expect(stderr.join("")).toContain("prune threw");
  });

  it("exits 1 when a runner emits a per-version error log line", async () => {
    process.env.SFC_DEPS_LOCAL_MANIFEST_DIR = "/tmp/__nope__";
    vi.doMock("../src/cron/jobs/provision-sfc-deps.js", () => ({
      runProvisionSfcDepsJob: async (opts: any) => {
        opts.log({ kind: "error", error: "bad manifest" });
      },
    }));
    vi.doMock("../src/cron/jobs/prune-sfc-deps.js", () => ({
      runPruneSfcDepsJob: async () => {},
    }));
    const mod = await importMain();
    await expect(mod._cliMainForTest()).rejects.toThrow("__EXIT__");
    expect(exits).toEqual([1]);
  });

  it("exits 0 when both runners complete cleanly", async () => {
    process.env.SFC_DEPS_LOCAL_MANIFEST_DIR = "/tmp/__nope__";
    vi.doMock("../src/cron/jobs/provision-sfc-deps.js", () => ({
      runProvisionSfcDepsJob: async () => {},
    }));
    vi.doMock("../src/cron/jobs/prune-sfc-deps.js", () => ({
      runPruneSfcDepsJob: async () => {},
    }));
    const mod = await importMain();
    await mod._cliMainForTest();
    expect(exits).toEqual([]);
  });
});
