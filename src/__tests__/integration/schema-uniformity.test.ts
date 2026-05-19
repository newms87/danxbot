import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYamlText } from "yaml";
import { KNOWN_SCHEMA_MAX } from "../../issue-tracker/schema-versions.js";
import {
  discoverConnectedRepos,
  type ConnectedRepo,
} from "../../repo-discovery.js";

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

const CLOSED_MAX_AGE_MS = 48 * 60 * 60 * 1000;

interface YamlCheck {
  repo: string;
  path: string;
  actualVersion: unknown;
}

interface BlockedCheck {
  repo: string;
  path: string;
  field: string;
}

function walkRepoYamls(
  repo: ConnectedRepo,
  nowMs: number,
): {
  failures: YamlCheck[];
  blockedFailures: BlockedCheck[];
  scanned: number;
} {
  const failures: YamlCheck[] = [];
  const blockedFailures: BlockedCheck[] = [];
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
      const obj = parsed as Record<string, unknown>;
      const version = obj.schema_version;
      if (version !== KNOWN_SCHEMA_MAX) {
        failures.push({ repo: repo.name, path, actualVersion: version });
      }
      // DX-700: raw `"Blocked"` on either top-level `status` or any
      // `history[].from/to` is a stale-v11 drift that the v12 validator
      // rejects. The boot sweep's heal pass (DX-700) MUST have already
      // canonicalized these — any survivor is a real drift bug.
      if (obj.status === "Blocked") {
        blockedFailures.push({ repo: repo.name, path, field: "status" });
      }
      if (Array.isArray(obj.history)) {
        for (let i = 0; i < obj.history.length; i++) {
          const entry = obj.history[i];
          if (typeof entry !== "object" || entry === null) continue;
          const e = entry as Record<string, unknown>;
          if (e.from === "Blocked") {
            blockedFailures.push({
              repo: repo.name,
              path,
              field: `history[${i}].from`,
            });
          }
          if (e.to === "Blocked") {
            blockedFailures.push({
              repo: repo.name,
              path,
              field: `history[${i}].to`,
            });
          }
        }
      }
    }
  };

  scan(openDir, "open");
  scan(closedDir, "closed");
  return { failures, blockedFailures, scanned };
}

describe("schema-uniformity invariant (DX-597)", () => {
  const repos = discoverConnectedRepos(resolve(__dirname, "..", "..", ".."));
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

  it(
    `no YAML carries raw "Blocked" on status or history[].from/to (DX-700, repos.length=${repos.length})`,
    () => {
      const allBlocked: BlockedCheck[] = [];
      for (const repo of repos) {
        const { blockedFailures } = walkRepoYamls(repo, nowMs);
        allBlocked.push(...blockedFailures);
      }
      if (allBlocked.length > 0) {
        const msg = allBlocked
          .map((f) => `  [${f.repo}] ${f.path} — ${f.field} === "Blocked"`)
          .join("\n");
        throw new Error(
          `${allBlocked.length} stale "Blocked" reference(s) survived the boot-sweep heal pass; ` +
            `v12 dropped "Blocked" from the IssueStatus enum so the validator rejects these on read:\n${msg}`,
        );
      }
      expect(allBlocked).toEqual([]);
    },
  );
});
