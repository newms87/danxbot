/**
 * SFC-deps provisioner (DX-540).
 *
 * Materializes `/srv/sfc-deps/<shell_version>/node_modules/` for every
 * manifest the `ManifestSource` returns. Idempotent — if the existing
 * snapshot's deps match the live manifest AND `node_modules/` is
 * present, the install is skipped. Errors are isolated per
 * `shell_version` so one bad manifest cannot block the rest.
 *
 * The default `runInstall` shells out to `npm install --omit=dev` in
 * the target dir; tests inject a fake. The S3 manifest source lives
 * in `./manifest-source.ts` for the same reason.
 */

import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  isValidShellVersion,
  isSharedDepsManifest,
  SNAPSHOT_FILENAME,
  type ManifestSource,
  type ProvisionLogLine,
  type ProvisionResult,
  type SharedDepsManifest,
} from "./types.js";

/**
 * Default wall-clock cap on `npm install`. Tuned to match DX-539's
 * vite-runner default — long enough for a cold cache against the
 * public npm registry, short enough that a stalled network surfaces
 * before the next cron tick.
 */
export const DEFAULT_NPM_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

export interface ProvisionOptions {
  source: ManifestSource;
  baseDir: string;
  /**
   * Materialize node_modules in `dir`. Default: spawns
   * `npm install --omit=dev` with the dir's `package.json`. Tests
   * inject a fake that creates `node_modules/` without network.
   */
  runInstall?: (dir: string) => Promise<void>;
  log?: (line: ProvisionLogLine) => void;
  /** Inject a clock for deterministic duration logging. */
  now?: () => number;
  /** Override the npm-install wall-clock cap. */
  installTimeoutMs?: number;
}

function defaultLog(line: ProvisionLogLine): void {
  process.stdout.write(`${JSON.stringify({ name: "sfc-deps-provisioner", ...line })}\n`);
}

function makeDefaultRunInstall(timeoutMs: number): (dir: string) => Promise<void> {
  return async (dir: string) => {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "npm",
        ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-progress"],
        {
          cwd: dir,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, npm_config_loglevel: "warn" },
        },
      );
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new Error(
              `npm install timed out after ${timeoutMs}ms in ${dir}: ${stderr.slice(-1000)}${stdout.slice(-500)}`,
            ),
          );
          return;
        }
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `npm install exited ${code} in ${dir}: ${stderr.slice(-1500)}${stdout.slice(-500)}`,
            ),
          );
      });
    });
  };
}

/**
 * Canonical-serialize a manifest for the snapshot file. Key order is
 * stable (alphabetical) so byte-identical inputs produce
 * byte-identical snapshots — the idempotence check is a simple
 * `JSON.parse(...).deps` deep-equal after canonicalization.
 */
function canonicalizeManifest(m: SharedDepsManifest): SharedDepsManifest {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(m.deps).sort()) sorted[k] = m.deps[k];
  return { shell_version: m.shell_version, deps: sorted };
}

function depsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function readExistingSnapshot(
  targetDir: string,
  log: (line: ProvisionLogLine) => void,
): Promise<SharedDepsManifest | null> {
  const snapPath = join(targetDir, SNAPSHOT_FILENAME);
  try {
    const text = await readFile(snapPath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (isSharedDepsManifest(parsed)) return parsed;
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Surface the non-ENOENT failure (EACCES, EISDIR, JSON parse, etc.)
    // so an operator catches the misconfig instead of seeing the
    // provisioner silently re-install on every tick. Returning null
    // keeps the call non-fatal — the provisioner will treat the
    // version as fresh and re-materialize.
    log({
      kind: "skipped-malformed",
      shell_version: "(unknown)",
      target_dir: targetDir,
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function writeManifestFiles(
  targetDir: string,
  manifest: SharedDepsManifest,
): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const canonical = canonicalizeManifest(manifest);
  const pkg = {
    name: `sfc-deps-${manifest.shell_version}`,
    private: true,
    dependencies: canonical.deps,
  };
  await writeFile(
    join(targetDir, "package.json"),
    JSON.stringify(pkg, null, 2),
    "utf8",
  );
  // Snapshot is written AFTER install succeeds — we do the
  // package.json write here so install has its input, then the
  // caller writes the snapshot once install succeeds. That way a
  // failed install leaves the dir without a snapshot, so the next
  // tick retries instead of falsely-skipping.
}

async function writeSnapshot(
  targetDir: string,
  manifest: SharedDepsManifest,
): Promise<void> {
  const canonical = canonicalizeManifest(manifest);
  const tmp = join(targetDir, `${SNAPSHOT_FILENAME}.tmp`);
  await writeFile(tmp, JSON.stringify(canonical), "utf8");
  await rename(tmp, join(targetDir, SNAPSHOT_FILENAME));
}

export async function provisionSfcDeps(
  opts: ProvisionOptions,
): Promise<ProvisionResult> {
  const log = opts.log ?? defaultLog;
  const runInstall =
    opts.runInstall ??
    makeDefaultRunInstall(opts.installTimeoutMs ?? DEFAULT_NPM_INSTALL_TIMEOUT_MS);
  const now = opts.now ?? Date.now;

  let entries;
  try {
    entries = await opts.source.list();
  } catch (err) {
    // Isolate listing failure — a transient S3 hiccup must not break
    // the whole cron tick. Per-version failures handled in the loop.
    const error = err instanceof Error ? err.message : String(err);
    log({
      kind: "error",
      shell_version: "(list)",
      target_dir: opts.baseDir,
      error: `manifest source list failed: ${error}`,
    });
    return {
      provisioned: [],
      skipped: [],
      failed: [{ shell_version: "(list)", error }],
    };
  }

  const provisioned: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ shell_version: string; error: string }> = [];

  for (const entry of entries) {
    const shellVersion = entry.shell_version;

    if (!isValidShellVersion(shellVersion)) {
      const error = `unsafe shell_version "${shellVersion}" — refusing to write under ${opts.baseDir}`;
      failed.push({ shell_version: shellVersion, error });
      log({
        kind: "error",
        shell_version: shellVersion,
        target_dir: opts.baseDir,
        error,
      });
      continue;
    }

    const targetDir = join(opts.baseDir, shellVersion);

    try {
      const manifest = await opts.source.fetch(entry);
      if (!isSharedDepsManifest(manifest) || manifest.shell_version !== shellVersion) {
        const error = `manifest body shape mismatch for ${shellVersion}`;
        failed.push({ shell_version: shellVersion, error });
        log({ kind: "error", shell_version: shellVersion, target_dir: targetDir, error });
        continue;
      }

      const existing = await readExistingSnapshot(targetDir, log);
      const nodeModulesPresent = await pathExists(
        join(targetDir, "node_modules"),
      );
      if (
        existing &&
        existing.shell_version === shellVersion &&
        depsEqual(existing.deps, manifest.deps) &&
        nodeModulesPresent
      ) {
        skipped.push(shellVersion);
        log({
          kind: "skipped-up-to-date",
          shell_version: shellVersion,
          target_dir: targetDir,
        });
        continue;
      }

      const start = now();
      await writeManifestFiles(targetDir, manifest);
      await runInstall(targetDir);
      await writeSnapshot(targetDir, manifest);
      provisioned.push(shellVersion);
      log({
        kind: "provisioned",
        shell_version: shellVersion,
        target_dir: targetDir,
        duration_ms: now() - start,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ shell_version: shellVersion, error });
      log({
        kind: "error",
        shell_version: shellVersion,
        target_dir: targetDir,
        error,
      });
    }
  }

  return { provisioned, skipped, failed };
}
