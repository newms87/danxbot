import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYamlText } from "yaml";
import { KNOWN_SCHEMA_MAX } from "../../issue-tracker/schema-versions.js";

/**
 * DX-597 Phase 6 — schema-uniformity invariant.
 *
 * Walks every connected repo's `<repo>/.danxbot/issues/open/*.yml`
 * and every recent (mtime ≤ 48h) `closed/*.yml` and asserts
 * `schema_version === KNOWN_SCHEMA_MAX`. Closed YAMLs older than 48h
 * are slated for deletion by the next boot sweep; we deliberately
 * skip them so a not-yet-swept stale fixture cannot fail this gate.
 *
 * Discovery: enumerate symlinks under `<danxbot-root>/repos/` — the
 * deployment convention is one symlink per connected repo. In CI or
 * a fresh checkout where the `repos/` directory does not exist (no
 * connected repos linked in), the test no-ops with a passing
 * assertion. The point of the test is to lock the host's REAL YAML
 * state, not to fail when run in an isolated container.
 */

function findDanxbotRoot(): string | null {
  // Walk up from this test file looking for a `repos/` dir that
  // sits next to a `package.json` naming `danxbot`. Resolves both
  // the worktree path AND the canonical danxbot path.
  let cur = realpathSync(resolve(__dirname, "..", "..", ".."));
  for (let i = 0; i < 8; i++) {
    const pkgPath = resolve(cur, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
          name?: string;
        };
        if (pkg.name === "danxbot" && existsSync(resolve(cur, "repos"))) {
          return cur;
        }
      } catch {
        // ignore unreadable package.json
      }
    }
    const parent = resolve(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

interface ConnectedRepo {
  name: string;
  localPath: string;
}

function discoverConnectedRepos(): ConnectedRepo[] {
  const root = findDanxbotRoot();
  if (!root) return [];
  const reposDir = resolve(root, "repos");
  if (!existsSync(reposDir)) return [];
  const entries = readdirSync(reposDir);
  const out: ConnectedRepo[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const linkPath = resolve(reposDir, name);
    let resolved: string;
    try {
      resolved = realpathSync(linkPath);
    } catch {
      continue;
    }
    if (!existsSync(resolve(resolved, ".danxbot"))) continue;
    out.push({ name, localPath: resolved });
  }
  return out;
}

const CLOSED_MAX_AGE_MS = 48 * 60 * 60 * 1000;

interface YamlCheck {
  repo: string;
  path: string;
  actualVersion: unknown;
}

function walkRepoYamls(
  repo: ConnectedRepo,
  nowMs: number,
): { failures: YamlCheck[]; scanned: number } {
  const failures: YamlCheck[] = [];
  let scanned = 0;
  const openDir = resolve(repo.localPath, ".danxbot", "issues", "open");
  const closedDir = resolve(repo.localPath, ".danxbot", "issues", "closed");

  const scan = (dir: string, kind: "open" | "closed"): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".yml")) continue;
      const path = resolve(dir, name);
      if (kind === "closed") {
        const st = statSync(path);
        if (nowMs - st.mtimeMs > CLOSED_MAX_AGE_MS) continue;
      }
      scanned++;
      let parsed: unknown;
      try {
        parsed = parseYamlText(readFileSync(path, "utf-8"));
      } catch {
        failures.push({ repo: repo.name, path, actualVersion: "<unparseable>" });
        continue;
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        failures.push({ repo: repo.name, path, actualVersion: "<not-object>" });
        continue;
      }
      const version = (parsed as Record<string, unknown>).schema_version;
      if (version !== KNOWN_SCHEMA_MAX) {
        failures.push({ repo: repo.name, path, actualVersion: version });
      }
    }
  };

  scan(openDir, "open");
  scan(closedDir, "closed");
  return { failures, scanned };
}

describe("schema-uniformity invariant (DX-597)", () => {
  const repos = discoverConnectedRepos();
  const nowMs = Date.now();

  it("repos discovery is internally consistent (no-op when no repos symlinked)", () => {
    for (const r of repos) {
      expect(existsSync(resolve(r.localPath, ".danxbot"))).toBe(true);
    }
  });

  it(
    `every open YAML in every connected repo is at KNOWN_SCHEMA_MAX (repos.length=${repos.length})`,
    () => {
      const allFailures: YamlCheck[] = [];
      let totalScanned = 0;
      for (const repo of repos) {
        const { failures, scanned } = walkRepoYamls(repo, nowMs);
        allFailures.push(...failures);
        totalScanned += scanned;
      }
      if (allFailures.length > 0) {
        const msg = allFailures
          .map(
            (f) =>
              `  [${f.repo}] ${f.path} — schema_version=${JSON.stringify(f.actualVersion)} (expected ${KNOWN_SCHEMA_MAX})`,
          )
          .join("\n");
        throw new Error(
          `${allFailures.length} YAML(s) below KNOWN_SCHEMA_MAX=${KNOWN_SCHEMA_MAX} ` +
            `(scanned ${totalScanned} files across ${repos.length} repo(s)):\n${msg}`,
        );
      }
      // Vacuous-pass guard: if connected repos exist on this host, at
      // least one YAML MUST have been scanned. Discovery returning
      // repos with empty issues subtrees would silently green-light
      // a broken invariant.
      if (repos.length > 0) {
        expect(totalScanned).toBeGreaterThan(0);
      }
      expect(allFailures).toEqual([]);
    },
  );
});
