#!/usr/bin/env -S npx tsx
/**
 * Migrate every `<repo>/.danxbot/issues/{open,closed}/*.yml` from the
 * legacy schema (flat `triaged: {timestamp, status, explain}` block plus
 * `dispatch_id: string|null`) to the per-card-triage rework shape (Phase 1
 * of ISS-90 / ISS-91):
 *
 *   - `triaged: {...}` → `triage: { expires_at, reassess_hint,
 *     last_status, last_explain, ice, history }`. Old triage values land
 *     in `history[0]` (and mirror to `last_*`); `expires_at` is staggered
 *     across `now → now + interval*N` so re-triage drains gradually
 *     instead of stamped all-at-once. The stagger interval defaults to
 *     5 minutes (`STAGGER_MS_DEFAULT`); pass `--stagger-ms=<ms>` to
 *     override (used by tests).
 *   - `dispatch_id: <uuid>` → `dispatch: { id, pid, host, kind,
 *     started_at, ttl_seconds }`. `pid` / `host` / `started_at` /
 *     `ttl_seconds` default to 0 / "" / "" / 0 (Phase 2 fills in real
 *     values when it scans live PIDs). `dispatch_id: null` →
 *     `dispatch: null`.
 *
 * Idempotent: a YAML that already carries `triage` and `dispatch` is
 * skipped on re-run. The strict `parseIssue` validator the worker uses
 * is run on every migrated YAML before write so post-migration files
 * round-trip cleanly.
 *
 * Repos to migrate are passed as CLI args (paths to repo roots that
 * contain a `.danxbot/issues/` directory). Defaults to walking
 * `<danxbot-root>/repos/*` if none are supplied — matches dev convention.
 *
 * Usage:
 *   npx tsx scripts/migrate-issues-to-triage-v3.ts                    # all dev repos
 *   npx tsx scripts/migrate-issues-to-triage-v3.ts /path/to/repo ...  # specific
 *   npx tsx scripts/migrate-issues-to-triage-v3.ts --stagger-ms=0     # immediate (test)
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { parseIssue, ISSUE_ID_REGEX } from "../src/issue-tracker/yaml.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const STAGGER_MS_DEFAULT = 5 * 60 * 1000; // 5 minutes between re-triage slots

interface MigrationResult {
  path: string;
  status: "migrated" | "skipped-already-migrated" | "error";
  message?: string;
}

interface CliOptions {
  staggerMs: number;
  repoRoots: string[];
}

function parseCli(argv: string[]): CliOptions {
  let staggerMs = STAGGER_MS_DEFAULT;
  const repoRoots: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--stagger-ms=")) {
      const value = Number(arg.slice("--stagger-ms=".length));
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid --stagger-ms value: ${arg}`);
      }
      staggerMs = value;
    } else {
      repoRoots.push(arg);
    }
  }
  return { staggerMs, repoRoots };
}

function buildEmptyTriage(): Record<string, unknown> {
  return {
    expires_at: "",
    reassess_hint: "",
    last_status: "",
    last_explain: "",
    ice: { total: 0, i: 0, c: 0, e: 0 },
    history: [],
  };
}

/**
 * Translate a legacy `triaged: {timestamp, status, explain}` mapping
 * into the new `triage` block. The migrated card is treated as
 * "scheduled for re-triage" so `expires_at` stays empty until the
 * caller stamps a staggered slot via `applyStagger`.
 */
function migrateTriaged(
  legacyTriaged: unknown,
): Record<string, unknown> {
  if (legacyTriaged === null || legacyTriaged === undefined) {
    return buildEmptyTriage();
  }
  if (typeof legacyTriaged !== "object" || Array.isArray(legacyTriaged)) {
    return buildEmptyTriage();
  }
  const t = legacyTriaged as Record<string, unknown>;
  const ts = typeof t.timestamp === "string" ? t.timestamp : "";
  const st = typeof t.status === "string" ? t.status : "";
  const ex = typeof t.explain === "string" ? t.explain : "";
  const triage = buildEmptyTriage();
  if (ts || st || ex) {
    triage.last_status = st;
    triage.last_explain = ex;
    (triage.history as unknown[]).push({
      timestamp: ts,
      status: st,
      explain: ex,
      expires_at: "",
      ice: { total: 0, i: 0, c: 0, e: 0 },
    });
  }
  return triage;
}

function migrateDispatchId(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    // Unknown shape — fail loud at validation time rather than silently
    // re-encoding. The migration is best-effort.
    return null;
  }
  if (value === "") return null;
  return {
    id: value,
    pid: 0,
    host: "",
    kind: "work",
    started_at: "",
    ttl_seconds: 0,
  };
}

/**
 * Rebuild the YAML mapping with canonical key order matching
 * `serializeIssue`. `yaml.stringify` honors insertion order, so a
 * deterministic field sequence here keeps the migrated file
 * byte-identical to what the worker would write on its next save.
 */
function rebuildCanonical(
  source: Record<string, unknown>,
  migratedTriage: Record<string, unknown>,
  migratedDispatch: unknown,
): Record<string, unknown> {
  return {
    schema_version: source.schema_version,
    tracker: source.tracker,
    id: source.id,
    external_id: source.external_id,
    parent_id: source.parent_id ?? null,
    children: source.children ?? [],
    dispatch: migratedDispatch,
    status: source.status,
    type: source.type,
    title: source.title,
    description: source.description ?? "",
    triage: migratedTriage,
    ac: source.ac ?? [],
    comments: source.comments ?? [],
    retro:
      source.retro ?? {
        good: "",
        bad: "",
        action_item_ids: [],
        commits: [],
      },
    blocked: source.blocked ?? null,
  };
}

function migrateOne(
  filePath: string,
): MigrationResult & { needsStagger: boolean } {
  const raw = readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    return {
      path: filePath,
      status: "error",
      needsStagger: false,
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
      needsStagger: false,
      message: "Not a YAML mapping",
    };
  }
  const map = parsed as Record<string, unknown>;
  // Older schemas (v1 / v2) get inlined into this single migration so a
  // never-migrated archive can leap straight to the post-rework shape.
  // v1 has no `id` field; we allocate one from the filename. v2 omits
  // `children`; we add `[]`. Both predate the `triage`/`dispatch`
  // rework so they share the legacy-field treatment below.
  if (map.schema_version === 1) {
    const v1 = migrateV1(filePath, map);
    if (v1.status === "error") {
      return {
        path: filePath,
        status: "error",
        needsStagger: false,
        message: v1.message,
      };
    }
    // After v1 promotion we proceed to triage migration on the new file.
    return migrateOne(v1.newPath ?? filePath);
  }
  if (map.schema_version === 2) {
    map.schema_version = 3;
    if (!("children" in map)) map.children = [];
    // fall through into the v3-legacy migration branch
  } else if (map.schema_version !== 3) {
    return {
      path: filePath,
      status: "error",
      needsStagger: false,
      message: `Unexpected schema_version: ${JSON.stringify(map.schema_version)} (expected 1, 2, or 3)`,
    };
  }
  const hasTriage = "triage" in map;
  const hasDispatch = "dispatch" in map;
  const hasLegacyTriaged = "triaged" in map;
  const hasLegacyDispatchId = "dispatch_id" in map;

  // Already migrated — no-op.
  if (hasTriage && hasDispatch && !hasLegacyTriaged && !hasLegacyDispatchId) {
    return { path: filePath, status: "skipped-already-migrated", needsStagger: false };
  }

  const migratedTriage = hasTriage
    ? (map.triage as Record<string, unknown>)
    : migrateTriaged(map.triaged);
  const migratedDispatch = hasDispatch
    ? map.dispatch
    : migrateDispatchId(map.dispatch_id);
  const next = rebuildCanonical(map, migratedTriage, migratedDispatch);

  // Determine whether this card needs a staggered re-triage slot. Only
  // **open** cards with a legacy `triaged.timestamp` (i.e., they were
  // triaged before the rework and are sitting in a non-terminal status)
  // qualify. Closed cards never re-triage; freshly-migrated open cards
  // already carry empty `triage` so re-triage on next poll is fine. The
  // caller assigns the staggered timestamp; this function reports the
  // need.
  const needsStagger =
    hasLegacyTriaged &&
    typeof (map.triaged as Record<string, unknown> | null)?.timestamp === "string" &&
    String((map.triaged as Record<string, unknown>).timestamp ?? "").length > 0;

  // Round-trip through the strict validator before writing. This is the
  // SAME validator the worker uses on every save, so a successful
  // migration here guarantees the worker accepts the file on next poll.
  let yamlText: string;
  try {
    yamlText = stringify(next, { lineWidth: 0 });
    parseIssue(yamlText);
  } catch (err) {
    return {
      path: filePath,
      status: "error",
      needsStagger: false,
      message: `Post-migration validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  writeFileSync(filePath, yamlText);
  return { path: filePath, status: "migrated", needsStagger };
}

/**
 * After every YAML in `open/` has been written with empty `expires_at`,
 * walk the slot list and stamp staggered re-triage timestamps. We do
 * this in a SECOND pass so the stagger order is deterministic (sort by
 * filename) instead of dependent on `readdir`'s natural order.
 */
function applyStagger(
  openYamls: string[],
  staggerMs: number,
  now = new Date(),
): MigrationResult[] {
  const results: MigrationResult[] = [];
  if (staggerMs === 0 || openYamls.length === 0) return results;
  const sorted = [...openYamls].sort();
  for (let i = 0; i < sorted.length; i++) {
    const filePath = sorted[i];
    const raw = readFileSync(filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const map = parsed as Record<string, unknown>;
    const triage = map.triage as Record<string, unknown> | undefined;
    if (!triage) continue;
    if (typeof triage.expires_at === "string" && triage.expires_at.length > 0) {
      // Already stamped — leave alone.
      continue;
    }
    triage.expires_at = new Date(now.getTime() + i * staggerMs).toISOString();
    let yamlText: string;
    try {
      yamlText = stringify(map, { lineWidth: 0 });
      parseIssue(yamlText);
    } catch (err) {
      results.push({
        path: filePath,
        status: "error",
        message: `Stagger validation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    writeFileSync(filePath, yamlText);
  }
  return results;
}

/**
 * Find the highest ISS-N already used in the repo across both `open`
 * and `closed`. v1 archive files are named `<external_id>.yml` and
 * never carry an `id` field, so the runtime `nextIssueId` cannot see
 * them. This local scanner walks every YAML's filename + body so a
 * v1 file allocated on first migration cannot collide with an
 * existing ISS-N.
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
        // Best-effort scan; ignore unreadable files.
      }
    }
  }
  return max;
}

let allocatorState: { repoRoot: string; nextN: number } | null = null;
function allocateId(repoRoot: string): string {
  if (allocatorState === null || allocatorState.repoRoot !== repoRoot) {
    allocatorState = { repoRoot, nextN: findMaxIssN(repoRoot) + 1 };
  }
  return `ISS-${allocatorState.nextN++}`;
}

interface V1MigrationResult {
  status: "migrated" | "error";
  newPath?: string;
  message?: string;
}

function migrateV1(
  filePath: string,
  map: Record<string, unknown>,
): V1MigrationResult {
  const repoRoot = resolve(filePath, "..", "..", "..", ".."); // .yml → state → issues → .danxbot → repo
  const id = allocateId(repoRoot);
  if (!ISSUE_ID_REGEX.test(id)) {
    return {
      status: "error",
      message: `Allocated id ${JSON.stringify(id)} does not match ISS-N`,
    };
  }
  const next: Record<string, unknown> = {
    schema_version: 3,
    tracker: map.tracker,
    id,
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
    comments: map.comments ?? [],
    retro:
      map.retro ?? { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
  };
  const newYaml = stringify(next, { lineWidth: 0 });
  const newPath = resolve(dirname(filePath), `${id}.yml`);
  if (existsSync(newPath) && newPath !== filePath) {
    return {
      status: "error",
      message: `Target file already exists: ${newPath}`,
    };
  }
  writeFileSync(newPath, newYaml);
  if (newPath !== filePath) {
    // Keep a paper trail — same suffix the legacy v1→v3 migration used.
    renameSync(filePath, `${filePath}.migrated-to-v3`);
  }
  return { status: "migrated", newPath };
}

function findIssueYamls(repoRoot: string): {
  open: string[];
  closed: string[];
} {
  const issuesDir = resolve(repoRoot, ".danxbot", "issues");
  const out: { open: string[]; closed: string[] } = { open: [], closed: [] };
  for (const state of ["open", "closed"] as const) {
    const dir = resolve(issuesDir, state);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".yml")) continue;
      out[state].push(resolve(dir, entry));
    }
  }
  return out;
}

export function runMigration(opts: CliOptions): {
  migrated: number;
  skipped: number;
  errors: MigrationResult[];
} {
  const { staggerMs, repoRoots } = opts;
  let migrated = 0;
  let skipped = 0;
  const errors: MigrationResult[] = [];

  for (const root of repoRoots) {
    const yamls = findIssueYamls(root);
    const all = [...yamls.open, ...yamls.closed];
    if (all.length === 0) {
      console.log(`[${root}] no issue YAMLs`);
      continue;
    }
    console.log(`[${root}] migrating ${all.length} YAMLs...`);
    const openSet = new Set(yamls.open);
    const stagedFiles: string[] = [];
    for (const yaml of all) {
      const result = migrateOne(yaml);
      if (result.status === "migrated") {
        migrated++;
        // Only OPEN cards re-triage; closed cards are terminal and
        // never spawn another triage agent. Filter at stagger-collect
        // time so the second pass touches open files only.
        if (result.needsStagger && openSet.has(result.path)) {
          stagedFiles.push(result.path);
        }
        console.log(`  ✓ ${result.path}`);
      } else if (result.status === "skipped-already-migrated") {
        skipped++;
      } else {
        errors.push(result);
        console.error(`  ✗ ${result.path}: ${result.message}`);
      }
    }
    const staggerErrors = applyStagger(stagedFiles, staggerMs);
    errors.push(...staggerErrors);
    for (const e of staggerErrors) {
      console.error(`  ✗ ${e.path}: ${e.message}`);
    }
  }
  return { migrated, skipped, errors };
}

function main(): void {
  const argv = process.argv.slice(2);
  const opts = parseCli(argv);
  if (opts.repoRoots.length === 0) {
    const reposDir = resolve(SCRIPT_DIR, "..", "repos");
    if (existsSync(reposDir)) {
      for (const entry of readdirSync(reposDir)) {
        const p = resolve(reposDir, entry);
        if (existsSync(resolve(p, ".danxbot", "issues"))) {
          opts.repoRoots.push(p);
        }
      }
    }
  }
  if (opts.repoRoots.length === 0) {
    console.error("No connected repos found with .danxbot/issues/ dirs.");
    process.exit(1);
  }
  const { migrated, skipped, errors } = runMigration(opts);
  console.log();
  console.log(`Migrated: ${migrated}`);
  console.log(`Skipped (already migrated): ${skipped}`);
  console.log(`Errors: ${errors.length}`);
  if (errors.length > 0) process.exit(1);
}

// Run main when invoked as a script (direct `npx tsx` or via shebang).
// Vitest imports this module via `import { runMigration }` so the env
// flag `VITEST` is set during test runs — guard against that to avoid
// triggering a CLI walk during the test import.
if (!process.env.VITEST) {
  main();
}
