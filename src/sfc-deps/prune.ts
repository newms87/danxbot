/**
 * Stale-dir prune for /srv/sfc-deps/.
 *
 * A dir is considered prunable when BOTH:
 *   - its `shell_version` (= dirname) is NOT in `activeShellVersions`
 *     (the set the live manifest source returned this tick), AND
 *   - its directory mtime is older than `staleAfterMs` (default 30d).
 *
 * Active versions are always kept regardless of age — that protects
 * the long-running production version from disappearing during a
 * brief manifest-publish hiccup. Fresh inactive versions are kept
 * too — covers the case where a manifest was just unpublished but
 * an in-flight build still references the deps dir.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  isValidShellVersion,
  type PruneLogLine,
  type PruneResult,
} from "./types.js";

export interface PruneOptions {
  baseDir: string;
  activeShellVersions: ReadonlySet<string>;
  staleAfterMs: number;
  now?: () => number;
  /** Override the rm primitive — defaults to `fs.rm(recursive)`. */
  rmDir?: (dir: string) => Promise<void>;
  log?: (line: PruneLogLine) => void;
}

function defaultLog(line: PruneLogLine): void {
  process.stdout.write(`${JSON.stringify({ name: "sfc-deps-prune", ...line })}\n`);
}

async function defaultRmDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

async function tryReaddir(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function pruneStaleSfcDeps(
  opts: PruneOptions,
): Promise<PruneResult> {
  const log = opts.log ?? defaultLog;
  const rmDir = opts.rmDir ?? defaultRmDir;
  const now = (opts.now ?? Date.now)();

  const entries = await tryReaddir(opts.baseDir);
  if (entries === null) {
    return { pruned: [], kept: [], failed: [] };
  }

  const pruned: string[] = [];
  const kept: string[] = [];
  const failed: Array<{ shell_version: string; error: string }> = [];

  for (const name of entries) {
    if (!isValidShellVersion(name)) continue;
    const target = join(opts.baseDir, name);
    let st;
    try {
      st = await stat(target);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    if (opts.activeShellVersions.has(name)) {
      kept.push(name);
      log({ kind: "skipped-active", shell_version: name, target_dir: target });
      continue;
    }

    const ageMs = now - st.mtimeMs;
    if (ageMs <= opts.staleAfterMs) {
      kept.push(name);
      log({
        kind: "skipped-fresh",
        shell_version: name,
        target_dir: target,
        reason: `age ${Math.round(ageMs / 86_400_000)}d <= staleAfterMs`,
      });
      continue;
    }

    try {
      await rmDir(target);
      pruned.push(name);
      log({ kind: "pruned", shell_version: name, target_dir: target });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ shell_version: name, error });
      log({ kind: "error", shell_version: name, target_dir: target, error });
    }
  }

  return { pruned, kept, failed };
}
