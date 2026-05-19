/**
 * DX-700 — shared connected-repo discovery helper.
 *
 * Walks up from a starting directory to find the danxbot root (the
 * dir whose `package.json` names `danxbot` AND has a `repos/` subdir),
 * then enumerates every symlink (or directory) under `repos/` that
 * contains a `.danxbot/` subtree. Used by both:
 *
 *   - `scripts/migrate-all-issues.ts` (operator-runnable boot-sweep)
 *   - `src/__tests__/integration/schema-uniformity.test.ts` (CI gate
 *     that asserts every YAML in every connected repo is canonical)
 *
 * Returns an empty list when no danxbot root is reachable from the
 * starting directory — callers can use `repos.length === 0` to no-op
 * cleanly in CI or fresh checkouts without connected repos.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface ConnectedRepo {
  name: string;
  localPath: string;
}

/**
 * Find the danxbot root by walking up from `startDir`. Returns the
 * absolute path of the root or `null` when not found within 8 levels.
 *
 * "danxbot root" = a directory that contains both a `package.json`
 * naming `danxbot` AND a `repos/` subdirectory. The double gate
 * prevents accidentally locating a sibling repo whose package.json
 * happens to be named differently.
 */
export function findDanxbotRoot(startDir: string): string | null {
  let cur = realpathSync(startDir);
  for (let i = 0; i < 8; i++) {
    const pkgPath = resolve(cur, "package.json");
    if (existsSync(pkgPath) && existsSync(resolve(cur, "repos"))) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
          name?: string;
        };
        if (pkg.name === "danxbot") return cur;
      } catch {
        // unreadable package.json — keep walking
      }
    }
    const parent = resolve(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/**
 * Enumerate connected repos under `<root>/repos/`. Each entry must
 * resolve (via `realpathSync`) to a directory containing a
 * `.danxbot/` subtree — that is the bind-mount contract every
 * connected repo follows. Entries without `.danxbot/` are silently
 * skipped (a stale symlink, or a non-repo directory).
 */
export function discoverConnectedRepos(startDir: string): ConnectedRepo[] {
  const root = findDanxbotRoot(startDir);
  if (!root) return [];
  const reposDir = resolve(root, "repos");
  if (!existsSync(reposDir)) return [];
  const out: ConnectedRepo[] = [];
  for (const name of readdirSync(reposDir)) {
    if (name.startsWith(".")) continue;
    const linkPath = resolve(reposDir, name);
    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(linkPath);
    } catch {
      continue;
    }
    if (!existsSync(resolve(resolvedPath, ".danxbot"))) continue;
    out.push({ name, localPath: resolvedPath });
  }
  return out;
}
