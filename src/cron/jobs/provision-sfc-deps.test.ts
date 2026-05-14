import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  provisionSfcDepsJob,
  runProvisionSfcDepsJob,
} from "./provision-sfc-deps.js";

describe("provisionSfcDepsJob", () => {
  it("registers with name + 1h interval", () => {
    expect(provisionSfcDepsJob.name).toBe("provision-sfc-deps");
    expect(provisionSfcDepsJob.intervalSec).toBe(3600);
  });
});

describe("runProvisionSfcDepsJob", () => {
  let baseDir: string;
  let manifestDir: string;
  let logs: object[];

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "sfc-cron-"));
    manifestDir = await mkdtemp(join(tmpdir(), "sfc-cron-manifest-"));
    logs = [];
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    await rm(manifestDir, { recursive: true, force: true });
  });

  it("no-op + log when neither env var is set", async () => {
    await runProvisionSfcDepsJob({
      env: {},
      baseDir,
      log: (l) => logs.push(l),
    });
    expect(logs.some((l: any) => l.kind === "skipped-no-source")).toBe(true);
  });

  it("invokes the provisioner against the local manifest source when SFC_DEPS_LOCAL_MANIFEST_DIR is set", async () => {
    await mkdir(join(manifestDir, "1.0.0"), { recursive: true });
    await writeFile(
      join(manifestDir, "1.0.0", "shared_deps_lock.json"),
      JSON.stringify({ shell_version: "1.0.0", deps: { vue: "3.5.13" } }),
    );

    await runProvisionSfcDepsJob({
      env: { SFC_DEPS_LOCAL_MANIFEST_DIR: manifestDir },
      baseDir,
      runInstall: async (dir) => {
        await mkdir(join(dir, "node_modules"), { recursive: true });
      },
      log: (l) => logs.push(l),
    });

    const tick = logs.find((l: any) => l.kind === "tick-complete");
    expect(tick).toBeDefined();
    expect((tick as any).source_kind).toBe("local");
    expect((tick as any).provisioned).toBe(1);

    const pkg = JSON.parse(
      await readFile(join(baseDir, "1.0.0", "package.json"), "utf8"),
    );
    expect(pkg.dependencies).toEqual({ vue: "3.5.13" });
    // snapshot written after install succeeds
    const snap = JSON.parse(
      await readFile(join(baseDir, "1.0.0", "shared_deps_lock.json"), "utf8"),
    );
    expect(snap).toEqual({ shell_version: "1.0.0", deps: { vue: "3.5.13" } });
  });
});
