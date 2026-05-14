/**
 * Unit tests for the SFC-deps provisioner.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { provisionSfcDeps } from "./provisioner.js";
import type {
  ManifestSource,
  SharedDepsManifest,
  ProvisionLogLine,
} from "./types.js";

function fakeSource(
  manifests: Record<string, SharedDepsManifest>,
): ManifestSource {
  return {
    list: async () =>
      Object.keys(manifests).map((shell_version) => ({
        shell_version,
        locator: `mem://${shell_version}`,
      })),
    fetch: async (entry) => {
      const m = manifests[entry.shell_version];
      if (!m) throw new Error(`fakeSource missing ${entry.shell_version}`);
      return m;
    },
  };
}

describe("provisionSfcDeps", () => {
  let baseDir: string;
  let logs: ProvisionLogLine[];

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "sfc-deps-test-"));
    logs = [];
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("provisions a fresh shell_version: writes package.json, invokes install, writes snapshot", async () => {
    const installed: Array<{ dir: string; pkg: unknown }> = [];
    const source = fakeSource({
      "1.0.0": { shell_version: "1.0.0", deps: { vue: "3.5.13" } },
    });

    const result = await provisionSfcDeps({
      source,
      baseDir,
      runInstall: async (dir) => {
        const pkgPath = join(dir, "package.json");
        const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
        installed.push({ dir, pkg });
        await mkdir(join(dir, "node_modules"), { recursive: true });
      },
      log: (line) => logs.push(line),
    });

    expect(result.provisioned).toEqual(["1.0.0"]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);

    expect(installed).toHaveLength(1);
    expect(installed[0].dir).toBe(join(baseDir, "1.0.0"));
    expect(installed[0].pkg).toEqual({
      name: "sfc-deps-1.0.0",
      private: true,
      dependencies: { vue: "3.5.13" },
    });

    const snapshot = JSON.parse(
      await readFile(join(baseDir, "1.0.0", "shared_deps_lock.json"), "utf8"),
    );
    expect(snapshot).toEqual({
      shell_version: "1.0.0",
      deps: { vue: "3.5.13" },
    });

    expect(logs.some((l) => l.kind === "provisioned")).toBe(true);
  });

  it("idempotent: skips when existing snapshot matches", async () => {
    const target = join(baseDir, "1.0.0");
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "shared_deps_lock.json"),
      JSON.stringify({ shell_version: "1.0.0", deps: { vue: "3.5.13" } }),
    );
    await mkdir(join(target, "node_modules"), { recursive: true });

    let installCalls = 0;
    const source = fakeSource({
      "1.0.0": { shell_version: "1.0.0", deps: { vue: "3.5.13" } },
    });

    const result = await provisionSfcDeps({
      source,
      baseDir,
      runInstall: async () => {
        installCalls++;
      },
      log: (line) => logs.push(line),
    });

    expect(result.skipped).toEqual(["1.0.0"]);
    expect(result.provisioned).toEqual([]);
    expect(installCalls).toBe(0);
    expect(logs.some((l) => l.kind === "skipped-up-to-date")).toBe(true);
  });

  it("re-provisions when deps differ from snapshot", async () => {
    const target = join(baseDir, "1.0.0");
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "shared_deps_lock.json"),
      JSON.stringify({ shell_version: "1.0.0", deps: { vue: "3.5.12" } }),
    );

    let installCalls = 0;
    const source = fakeSource({
      "1.0.0": { shell_version: "1.0.0", deps: { vue: "3.5.13" } },
    });

    await provisionSfcDeps({
      source,
      baseDir,
      runInstall: async (dir) => {
        installCalls++;
        await mkdir(join(dir, "node_modules"), { recursive: true });
      },
      log: (line) => logs.push(line),
    });

    expect(installCalls).toBe(1);
    const snapshot = JSON.parse(
      await readFile(join(target, "shared_deps_lock.json"), "utf8"),
    );
    expect(snapshot.deps).toEqual({ vue: "3.5.13" });
  });

  it("rejects unsafe shell_version chars and records the failure", async () => {
    const source = fakeSource({
      "../escape": { shell_version: "../escape", deps: {} },
    });

    let installCalls = 0;
    const result = await provisionSfcDeps({
      source,
      baseDir,
      runInstall: async () => {
        installCalls++;
      },
      log: (line) => logs.push(line),
    });

    expect(installCalls).toBe(0);
    expect(result.provisioned).toEqual([]);
    expect(result.failed).toEqual([
      {
        shell_version: "../escape",
        error: expect.stringContaining("unsafe shell_version"),
      },
    ]);
    expect(logs.some((l) => l.kind === "error")).toBe(true);

    const escapeExists = await stat(join(baseDir, "..", "escape")).catch(
      () => null,
    );
    expect(escapeExists).toBeNull();
  });

  it("isolates per-version failures: one install throws, others still run", async () => {
    const source = fakeSource({
      "1.0.0": { shell_version: "1.0.0", deps: { vue: "3.5.13" } },
      "2.0.0": { shell_version: "2.0.0", deps: { vue: "3.6.0" } },
    });

    const result = await provisionSfcDeps({
      source,
      baseDir,
      runInstall: async (dir) => {
        if (dir.endsWith("1.0.0")) throw new Error("simulated install fail");
        await mkdir(join(dir, "node_modules"), { recursive: true });
      },
      log: (line) => logs.push(line),
    });

    expect(result.provisioned).toEqual(["2.0.0"]);
    expect(result.failed).toEqual([
      { shell_version: "1.0.0", error: "simulated install fail" },
    ]);
  });

  it("snapshot keeps deps key order stable so byte-identical manifests skip", async () => {
    const target = join(baseDir, "1.0.0");
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "shared_deps_lock.json"),
      JSON.stringify({
        shell_version: "1.0.0",
        deps: { vue: "3.5.13", "@thehammer/danx-ui": "0.7.2" },
      }),
    );
    await mkdir(join(target, "node_modules"), { recursive: true });

    let installCalls = 0;
    const source = fakeSource({
      "1.0.0": {
        shell_version: "1.0.0",
        deps: { "@thehammer/danx-ui": "0.7.2", vue: "3.5.13" },
      },
    });

    const result = await provisionSfcDeps({
      source,
      baseDir,
      runInstall: async () => {
        installCalls++;
      },
      log: (line) => logs.push(line),
    });

    expect(installCalls).toBe(0);
    expect(result.skipped).toEqual(["1.0.0"]);
  });

  it("re-provisions when node_modules is absent even if snapshot matches", async () => {
    const target = join(baseDir, "1.0.0");
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "shared_deps_lock.json"),
      JSON.stringify({ shell_version: "1.0.0", deps: { vue: "3.5.13" } }),
    );

    let installCalls = 0;
    const source = fakeSource({
      "1.0.0": { shell_version: "1.0.0", deps: { vue: "3.5.13" } },
    });

    await provisionSfcDeps({
      source,
      baseDir,
      runInstall: async (dir) => {
        installCalls++;
        await mkdir(join(dir, "node_modules"), { recursive: true });
      },
      log: (line) => logs.push(line),
    });

    expect(installCalls).toBe(1);
  });

  it("isolates source.list() failure as a tick-level error (not a throw)", async () => {
    const source: ManifestSource = {
      list: async () => {
        throw new Error("S3 list failed");
      },
      fetch: async () => {
        throw new Error("unreachable");
      },
    };

    const result = await provisionSfcDeps({
      source,
      baseDir,
      runInstall: async () => {},
      log: (line) => logs.push(line),
    });
    expect(result.provisioned).toEqual([]);
    expect(result.failed).toEqual([
      { shell_version: "(list)", error: "S3 list failed" },
    ]);
    expect(logs.some((l) => l.kind === "error")).toBe(true);
  });

  it("records failure when manifest body shape mismatches the entry", async () => {
    const source: ManifestSource = {
      list: async () => [{ shell_version: "1.0.0", locator: "mem://1.0.0" }],
      // body declares a different shell_version
      fetch: async () =>
        ({ shell_version: "9.9.9", deps: { vue: "3.5.13" } }) as any,
    };
    const result = await provisionSfcDeps({
      source,
      baseDir,
      runInstall: async () => {},
      log: (l) => logs.push(l),
    });
    expect(result.failed).toEqual([
      {
        shell_version: "1.0.0",
        error: expect.stringContaining("manifest body shape mismatch"),
      },
    ]);
  });

  it("records failure + does not write snapshot when shape is missing deps", async () => {
    const source: ManifestSource = {
      list: async () => [{ shell_version: "1.0.0", locator: "mem://1.0.0" }],
      fetch: async () => ({ shell_version: "1.0.0" }) as any,
    };
    const result = await provisionSfcDeps({
      source,
      baseDir,
      runInstall: async () => {},
      log: (l) => logs.push(l),
    });
    expect(result.failed[0].error).toMatch(/shape mismatch/);
    const snapExists = await stat(
      join(baseDir, "1.0.0", "shared_deps_lock.json"),
    ).catch(() => null);
    expect(snapExists).toBeNull();
  });

  it("install failure leaves the dir WITHOUT a snapshot so the next tick retries", async () => {
    const source = fakeSource({
      "1.0.0": { shell_version: "1.0.0", deps: { vue: "3.5.13" } },
    });

    await provisionSfcDeps({
      source,
      baseDir,
      runInstall: async () => {
        throw new Error("install boom");
      },
      log: (l) => logs.push(l),
    });

    // package.json was written (input to install) but the snapshot was NOT
    // — re-provisioning is the next-tick contract.
    const pkgExists = await stat(join(baseDir, "1.0.0", "package.json"))
      .then(() => true)
      .catch(() => false);
    expect(pkgExists).toBe(true);
    const snapExists = await stat(
      join(baseDir, "1.0.0", "shared_deps_lock.json"),
    )
      .then(() => true)
      .catch(() => false);
    expect(snapExists).toBe(false);
  });

  it("re-provisions when existing snapshot is malformed (logs the anomaly)", async () => {
    const target = join(baseDir, "1.0.0");
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "shared_deps_lock.json"),
      "{ this is not json",
    );
    await mkdir(join(target, "node_modules"), { recursive: true });

    let installCalls = 0;
    const source = fakeSource({
      "1.0.0": { shell_version: "1.0.0", deps: { vue: "3.5.13" } },
    });
    await provisionSfcDeps({
      source,
      baseDir,
      runInstall: async (dir) => {
        installCalls++;
        await mkdir(join(dir, "node_modules"), { recursive: true });
      },
      log: (l) => logs.push(l),
    });
    expect(installCalls).toBe(1);
    expect(logs.some((l) => l.kind === "skipped-malformed")).toBe(true);
  });

  it("returns provisioned list and emits start log when log is provided", async () => {
    const source = fakeSource({
      "1.0.0": { shell_version: "1.0.0", deps: { vue: "3.5.13" } },
    });
    await provisionSfcDeps({
      source,
      baseDir,
      runInstall: async (dir) => {
        await mkdir(join(dir, "node_modules"), { recursive: true });
      },
      log: (line) => logs.push(line),
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "provisioned",
          shell_version: "1.0.0",
        }),
      ]),
    );
  });
});
