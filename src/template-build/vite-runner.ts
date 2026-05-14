/**
 * Vite build invocation for the template-build pipeline (DX-539).
 *
 * `runViteBuild` exec's a vite binary (resolved from the symlinked shared
 * deps dir at `<scratch>/node_modules/.bin/vite`) in the scratch directory.
 * It captures stdout + stderr separately, times the run, and throws a
 * `ViteBuildError` on non-zero exit so the handler can return the
 * `vite_build_failed` error branch with the captured stderr.
 *
 * `writeDefaultViteConfig` writes a minimal `vite.config.ts` into the
 * scratch dir when the source tarball did not ship one. The defaults
 * mirror what the gpt-manager build orchestrator (SG-150) expects: relative
 * asset base, App.vue entry, the shared-deps manifest list marked as
 * Rollup external so the bundle does NOT inline `vue` / `@thehammer/danx-ui`.
 */

import { spawn } from "child_process";
import { writeFile, access } from "fs/promises";
import { join } from "path";

export class ViteBuildError extends Error {
  constructor(
    message: string,
    public stdout: string,
    public stderr: string,
    public exitCode: number | null,
  ) {
    super(message);
    this.name = "ViteBuildError";
  }
}

export interface ViteBuildResult {
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunViteBuildOptions {
  cwd: string;
  viteBin: string;
  outDir?: string;
  /** Hard kill after this many ms. Default 10 minutes. */
  timeoutMs?: number;
  /** Override only used by tests — swaps in a stub for the real vite. */
  spawnImpl?: typeof spawn;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export async function runViteBuild(
  opts: RunViteBuildOptions,
): Promise<ViteBuildResult> {
  const { cwd, viteBin, outDir = "dist" } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = opts.spawnImpl ?? spawn;

  const started = Date.now();
  const child = spawnFn(viteBin, ["build", "--outDir", outDir], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise<ViteBuildResult>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new ViteBuildError(
          `Failed to spawn vite: ${err.message}`,
          stdout,
          stderr,
          null,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      if (timedOut) {
        reject(
          new ViteBuildError(
            `vite build timed out after ${timeoutMs}ms`,
            stdout,
            stderr,
            code,
          ),
        );
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr, durationMs });
      } else {
        reject(
          new ViteBuildError(
            `vite build exited with code ${code}`,
            stdout,
            stderr,
            code,
          ),
        );
      }
    });
  });
}

/**
 * Generate a default `vite.config.ts` if the source tarball did not include
 * one. The shared deps manifest names which packages are externalized so
 * the per-template bundle stays small and the host-provisioned
 * `/srv/sfc-deps/<v>/node_modules/` carries the real implementations at
 * runtime.
 */
export async function writeDefaultViteConfig(
  cwd: string,
  externals: string[] = ["vue", "@thehammer/danx-ui"],
): Promise<boolean> {
  const path = join(cwd, "vite.config.ts");
  try {
    await access(path);
    return false;
  } catch {
    /* file missing — write defaults below */
  }

  const externalList = JSON.stringify(externals);
  const body = `import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  base: "./",
  plugins: [vue()],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: "App.vue",
      external: ${externalList},
    },
  },
});
`;

  await writeFile(path, body, "utf-8");
  return true;
}
