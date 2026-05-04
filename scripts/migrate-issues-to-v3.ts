#!/usr/bin/env -S npx tsx
/**
 * Migrate every `<repo>/.danxbot/issues/{open,closed}/*.yml` from
 * schema_version 2 → 3.
 *
 * The only schema change v2 → v3 is the addition of the required
 * `children: string[]` field (reverse linkage from `parent_id` for the
 * epic ↔ phase relationship). Migration:
 *
 *   - Bumps `schema_version: 2` → `3`.
 *   - Inserts `children: []` immediately after `parent_id` if absent.
 *   - Issues already at v3 are skipped (idempotent re-run).
 *   - Issues at any other schema_version (1, 4+) abort the migration loud
 *     so the operator can investigate.
 *
 * Repos to migrate are passed as CLI args (paths to repo roots that
 * contain a `.danxbot/issues/` directory). Defaults to walking
 * `<danxbot-root>/repos/*` if none are supplied — matches dev convention.
 *
 * Usage:
 *   npx tsx scripts/migrate-issues-to-v3.ts                    # all dev repos
 *   npx tsx scripts/migrate-issues-to-v3.ts /path/to/repo ...  # specific
 *
 * The script reads + writes YAML in-place via the `yaml` package so
 * comment / formatting is preserved as well as the parser allows.
 * Children-bumped files round-trip cleanly through the new strict
 * `parseIssue` validator post-write.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { parseIssue, ISSUE_ID_REGEX } from "../src/issue-tracker/yaml.js";

interface MigrationResult {
  path: string;
  status: "migrated" | "skipped-already-v3" | "error";
  message?: string;
}

/**
 * Find the highest ISS-N already used in the repo (across both `open` and
 * `closed` subdirs) so v1-orphan migration can allocate non-colliding ids.
 * v1 files are filename = `<external_id>.yml` (no id field), so the
 * existing `nextIssueId` from the runtime cannot see them; this scanner
 * is intentionally local to the migration script.
 */
function findMaxIssN(repoRoot: string): number {
  const issuesDir = resolve(repoRoot, ".danxbot", "issues");
  let max = 0;
  for (const state of ["open", "closed"] as const) {
    const dir = resolve(issuesDir, state);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".yml")) continue;
      const stem = entry.slice(0, -".yml".length);
      const m = stem.match(/^ISS-(\d+)$/);
      if (m) {
        const n = Number.parseInt(m[1], 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
      // Also consider any `id: ISS-N` already inside a YAML body — covers
      // the unlikely case of a v1 file whose author hand-set id but
      // didn't rename the file.
      const path = resolve(dir, entry);
      try {
        const content = readFileSync(path, "utf-8");
        const idMatch = content.match(/^id:\s*(ISS-\d+)$/m);
        if (idMatch) {
          const m2 = idMatch[1].match(/^ISS-(\d+)$/);
          if (m2) {
            const n = Number.parseInt(m2[1], 10);
            if (Number.isFinite(n) && n > max) max = n;
          }
        }
      } catch {
        // Best-effort scan; ignore unreadable files (caller will report
        // them as errors during migration).
      }
    }
  }
  return max;
}

function migrateV1(
  filePath: string,
  map: Record<string, unknown>,
  allocateId: () => string,
): MigrationResult {
  // v1 contract: filename = `<external_id>.yml`, no `id` field, otherwise
  // structurally identical to v2 minus `children`. v1 → v3 jump:
  //   1. Allocate next ISS-N.
  //   2. Add `id` + `children: []`, bump `schema_version` to 3.
  //   3. Reorder keys to canonical layout (so the file matches what the
  //      strict serializer would emit on next save).
  //   4. Write to new path `<dir>/<id>.yml`.
  //   5. Remove the original file.
  const newId = allocateId();
  if (!ISSUE_ID_REGEX.test(newId)) {
    return {
      path: filePath,
      status: "error",
      message: `Allocated id ${JSON.stringify(newId)} does not match ISS-N`,
    };
  }
  const next: Record<string, unknown> = {
    schema_version: 3,
    tracker: map.tracker,
    id: newId,
    external_id: map.external_id,
    parent_id: map.parent_id ?? null,
    children: [],
    dispatch_id: map.dispatch_id ?? null,
    status: map.status,
    type: map.type,
    title: map.title,
    description: map.description ?? "",
    triaged: map.triaged ?? { timestamp: "", status: "", explain: "" },
    ac: map.ac ?? [],
    phases: map.phases ?? [],
    comments: map.comments ?? [],
    retro: map.retro ?? { good: "", bad: "", action_items: [], commits: [] },
  };

  const newYaml = stringify(next, { lineWidth: 0 });
  try {
    parseIssue(newYaml);
  } catch (err) {
    return {
      path: filePath,
      status: "error",
      message: `v1 → v3 post-migration validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const newPath = resolve(dirname(filePath), `${newId}.yml`);
  if (existsSync(newPath) && newPath !== filePath) {
    return {
      path: filePath,
      status: "error",
      message: `Target file already exists: ${newPath}`,
    };
  }
  writeFileSync(newPath, newYaml);
  if (newPath !== filePath) {
    // Remove the v1-named original. `renameSync` would clobber if the
    // names matched, but we've already verified no collision.
    renameSync(filePath, `${filePath}.migrated-to-v3`);
    // We keep the `.migrated-to-v3` suffix as a paper trail for the
    // operator; it's gitignored under `.danxbot/`.
  }
  return {
    path: filePath,
    status: "migrated",
    message: `v1 → v3, allocated ${newId}, file at ${basename(newPath)}`,
  };
}

function migrateOne(
  filePath: string,
  allocateId: () => string,
): MigrationResult {
  const raw = readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    return {
      path: filePath,
      status: "error",
      message: `YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return {
      path: filePath,
      status: "error",
      message: "Not a YAML mapping",
    };
  }

  const map = parsed as Record<string, unknown>;
  const version = map.schema_version;

  if (version === 3) {
    return { path: filePath, status: "skipped-already-v3" };
  }

  if (version === 1) {
    return migrateV1(filePath, map, allocateId);
  }

  if (version !== 2) {
    return {
      path: filePath,
      status: "error",
      message: `Unexpected schema_version: ${JSON.stringify(version)} (expected 1, 2, or 3)`,
    };
  }

  // Bump version + add children: []. Insertion order matters for the
  // canonical serializer, but `yaml.stringify` follows object insertion
  // order, so we rebuild the object with the desired key sequence.
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(map)) {
    if (key === "schema_version") {
      next[key] = 3;
      continue;
    }
    next[key] = value;
    if (key === "parent_id" && !("children" in map)) {
      next.children = [];
    }
  }
  // Guard: in the (impossible) case parent_id was missing from the
  // source map, append children at the end so the field is at least
  // present and the strict validator can complain about parent_id
  // separately rather than silently swallowing both.
  if (!("children" in next)) {
    next.children = [];
  }

  const newYaml = stringify(next, { lineWidth: 0 });

  // Round-trip through the strict validator to catch any other schema
  // drift before writing — better to fail loud here than to ship a
  // half-migrated YAML the worker rejects on next pickup.
  try {
    parseIssue(newYaml);
  } catch (err) {
    return {
      path: filePath,
      status: "error",
      message: `Post-migration validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  writeFileSync(filePath, newYaml);
  return { path: filePath, status: "migrated" };
}

function findIssueYamls(repoRoot: string): string[] {
  const issuesDir = resolve(repoRoot, ".danxbot", "issues");
  const out: string[] = [];
  for (const state of ["open", "closed"] as const) {
    const dir = resolve(issuesDir, state);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(".yml")) out.push(resolve(dir, entry));
    }
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);

  const repoRoots: string[] = [];
  if (args.length > 0) {
    repoRoots.push(...args);
  } else {
    // Default: walk `<danxbot>/repos/*` (the dev convention).
    const reposDir = resolve(import.meta.dirname, "..", "repos");
    if (existsSync(reposDir)) {
      for (const entry of readdirSync(reposDir)) {
        const p = resolve(reposDir, entry);
        if (existsSync(resolve(p, ".danxbot", "issues"))) {
          repoRoots.push(p);
        }
      }
    }
  }

  if (repoRoots.length === 0) {
    console.error("No connected repos found with .danxbot/issues/ dirs.");
    process.exit(1);
  }

  let migrated = 0;
  let skipped = 0;
  const errors: MigrationResult[] = [];

  for (const root of repoRoots) {
    const yamls = findIssueYamls(root);
    if (yamls.length === 0) {
      console.log(`[${root}] no issue YAMLs`);
      continue;
    }
    console.log(`[${root}] migrating ${yamls.length} YAMLs...`);
    let nextN = findMaxIssN(root) + 1;
    const allocateId = (): string => `ISS-${nextN++}`;
    for (const yaml of yamls) {
      const result = migrateOne(yaml, allocateId);
      if (result.status === "migrated") {
        migrated++;
        console.log(`  ✓ ${result.path}`);
      } else if (result.status === "skipped-already-v3") {
        skipped++;
      } else {
        errors.push(result);
        console.error(`  ✗ ${result.path}: ${result.message}`);
      }
    }
  }

  console.log();
  console.log(`Migrated: ${migrated}`);
  console.log(`Skipped (already v3): ${skipped}`);
  console.log(`Errors: ${errors.length}`);

  if (errors.length > 0) {
    process.exit(1);
  }
}

main();
