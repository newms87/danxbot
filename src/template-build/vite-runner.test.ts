import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  runViteBuild,
  writeDefaultViteConfig,
  ViteBuildError,
} from "./vite-runner.js";

describe("vite-runner", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "vite-runner-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe("runViteBuild", () => {
    it("captures stdout, stderr, and duration on success", async () => {
      // /bin/sh script that pretends to be a vite binary: echoes one line
      // to stdout, one to stderr, succeeds.
      const fakeVite = join(workDir, "fake-vite.sh");
      await writeFile(
        fakeVite,
        `#!/bin/sh
echo "build succeeded for $*"
echo "warning: one warning" 1>&2
exit 0
`,
        { mode: 0o755 },
      );

      const result = await runViteBuild({
        cwd: workDir,
        viteBin: fakeVite,
      });

      expect(result.stdout).toContain("build succeeded");
      expect(result.stdout).toContain("build --outDir dist");
      expect(result.stderr).toContain("one warning");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("throws ViteBuildError carrying stderr + exitCode on non-zero exit", async () => {
      const fakeVite = join(workDir, "fake-vite-fail.sh");
      await writeFile(
        fakeVite,
        `#!/bin/sh
echo "compile error: missing module" 1>&2
exit 2
`,
        { mode: 0o755 },
      );

      try {
        await runViteBuild({ cwd: workDir, viteBin: fakeVite });
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ViteBuildError);
        const vbe = err as ViteBuildError;
        expect(vbe.exitCode).toBe(2);
        expect(vbe.stderr).toContain("compile error: missing module");
      }
    });

    it("throws ViteBuildError when the binary does not exist", async () => {
      await expect(
        runViteBuild({
          cwd: workDir,
          viteBin: join(workDir, "does-not-exist"),
        }),
      ).rejects.toBeInstanceOf(ViteBuildError);
    });
  });

  describe("writeDefaultViteConfig", () => {
    it("writes a vite.config.ts when none exists", async () => {
      const wrote = await writeDefaultViteConfig(workDir);
      expect(wrote).toBe(true);

      const body = (
        await readFile(join(workDir, "vite.config.ts"))
      ).toString();
      expect(body).toContain("defineConfig");
      expect(body).toContain('base: "./"');
      expect(body).toContain('"vue"');
      expect(body).toContain('"@thehammer/danx-ui"');
    });

    it("does NOT overwrite an existing vite.config.ts", async () => {
      const existing = "// existing user config\nexport default {};\n";
      await writeFile(join(workDir, "vite.config.ts"), existing);

      const wrote = await writeDefaultViteConfig(workDir);
      expect(wrote).toBe(false);

      const body = (
        await readFile(join(workDir, "vite.config.ts"))
      ).toString();
      expect(body).toBe(existing);
    });

    it("honors a custom externals list", async () => {
      await writeDefaultViteConfig(workDir, ["lodash", "pinia"]);
      const body = (
        await readFile(join(workDir, "vite.config.ts"))
      ).toString();
      expect(body).toContain('"lodash"');
      expect(body).toContain('"pinia"');
      expect(body).not.toContain('"vue"');
    });
  });
});
