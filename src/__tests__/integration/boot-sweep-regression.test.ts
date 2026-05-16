import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYamlText } from "yaml";
import { runBootMigrationSweep } from "../../worker/migrate-on-boot.js";
import { KNOWN_SCHEMA_MAX } from "../../issue-tracker/schema-versions.js";
import { flagPath, readFlag, writeFlag } from "../../critical-failure.js";

/**
 * Drift guard — pin the literal `source: "boot-migration-sweep"`
 * string in `src/index.ts`. This is the call site the emulator below
 * mirrors. If production diverges (different source key, removed
 * call, etc.), this assertion fires before the regression tests
 * silently green-light a stale contract.
 */
const SRC_INDEX_PATH = resolve(__dirname, "..", "..", "index.ts");
const SRC_INDEX_TEXT = readFileSync(SRC_INDEX_PATH, "utf-8");

/**
 * DX-597 Phase 6 — boot-sweep regression coverage.
 *
 * Locks the three boot-sweep regressions a future agent would
 * re-introduce if the legacy tolerance branches creep back:
 *
 *   1. A v9 YAML on disk MUST be migrated to KNOWN_SCHEMA_MAX
 *      post-boot.
 *   2. A v2 YAML (below the legacy-to-v10 bridge floor, no
 *      registered migration)
 *      MUST land in `result.failed[]` AND the boot path MUST write
 *      `<repo>/.danxbot/CRITICAL_FAILURE` with
 *      `source: "boot-migration-sweep"`. A v9 alongside still
 *      migrates cleanly — partial failure does not abort the sweep.
 *   3. `closed/*.yml` with mtime 49h ago MUST be deleted; a sibling
 *      at 47h MUST be migrated to KNOWN_SCHEMA_MAX. The boundary is
 *      strict-greater (`>`) on 48h.
 *
 * Distinct from `boot-migration-sweep.test.ts`: that suite owns the
 * unit-level surface of the sweep (atomic writes, env skip, multi-
 * repo aggregation). This suite owns the cross-module regression
 * coverage — the sweep's interaction with the critical-failure flag
 * writer + the version-floor that future-readable YAMLs must respect.
 */

function writeYaml(path: string, body: string, mtimeMs?: number): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf-8");
  if (mtimeMs !== undefined) {
    const sec = mtimeMs / 1000;
    utimesSync(path, sec, sec);
  }
}

const v9Yaml = (id: string): string =>
  [
    "schema_version: 9",
    "tracker: trello",
    `id: ${id}`,
    'external_id: ""',
    "parent_id: null",
    "children: []",
    "dispatch: null",
    "status: ToDo",
    "type: Feature",
    `title: ${id}`,
    "description: body",
    "priority: 3",
    "position: null",
    "triage:",
    "  expires_at: ''",
    "  reassess_hint: ''",
    "  last_status: ''",
    "  last_explain: ''",
    "  ice: {total: 0, i: 0, c: 0, e: 0}",
    "  history: []",
    "ac: []",
    "comments: []",
    "history: []",
    "retro: { good: '', bad: '', action_item_ids: [], commits: [] }",
    "assigned_agent: null",
    "waiting_on: null",
    "blocked: null",
    "requires_human: null",
    "conflict_on: []",
    "effort_level: medium",
    "db_updated_at: ''",
    "",
  ].join("\n");

// Pre-bridge legacy schemas (3-8) all migrate cleanly via the
// `legacy-to-v10` registry entry; v2 (and below) have no registered
// migration, so they are the canonical "boot sweep refuses to load"
// fixture. The historical name `v3Yaml` is preserved as an alias to
// keep the regression-test diff narrow.
const v2Yaml = (id: string): string =>
  [
    "schema_version: 2",
    "tracker: trello",
    `id: ${id}`,
    "status: ToDo",
    "type: Feature",
    `title: ${id} prehistoric`,
    "description: body",
    "",
  ].join("\n");

/**
 * Mirror the production boot path's flag-on-failure step (see
 * `src/index.ts:262`) without booting the full worker. The point of
 * this helper is to assert the contract from the sweep's caller's
 * perspective: when `failed[]` is non-empty, the worker writes the
 * flag with `source: "boot-migration-sweep"`.
 */
function bootSweepEmulator(repoLocalPath: string, failed: { path: string; error: string }[]): void {
  if (failed.length === 0) return;
  writeFlag(repoLocalPath, {
    source: "boot-migration-sweep",
    dispatchId: "boot",
    reason: `Boot migration sweep failed for ${failed.length} file(s) — every YAML must reach v${KNOWN_SCHEMA_MAX} before the worker can serve dispatches`,
    detail: JSON.stringify(failed, null, 2),
  });
}

describe("boot-sweep regression coverage (DX-597)", () => {
  let dir = "";

  it("drift guard: src/index.ts still writes the CRITICAL_FAILURE flag with source='boot-migration-sweep' on sweep.failed", () => {
    expect(SRC_INDEX_TEXT).toMatch(/runBootMigrationSweep\(/);
    expect(SRC_INDEX_TEXT).toMatch(/source:\s*"boot-migration-sweep"/);
    expect(SRC_INDEX_TEXT).toMatch(/sweep\.failed\.length\s*>\s*0/);
  });

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "boot-sweep-regression-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("regression #1: a v9 YAML on disk is migrated to KNOWN_SCHEMA_MAX post-boot", async () => {
    const path = resolve(dir, ".danxbot", "issues", "open", "DX-1.yml");
    writeYaml(path, v9Yaml("DX-1"));

    const result = await runBootMigrationSweep([{ localPath: dir }], {
      nowMs: Date.now(),
    });

    expect(result.failed).toEqual([]);
    expect(result.migrated).toBe(1);
    const parsed = parseYamlText(readFileSync(path, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(parsed.schema_version).toBe(KNOWN_SCHEMA_MAX);
  });

  it("regression #2: v3 + v9 mix — v9 migrates, v3 lands in failed[], CRITICAL_FAILURE written", async () => {
    const v9Path = resolve(dir, ".danxbot", "issues", "open", "DX-2.yml");
    const v3Path = resolve(dir, ".danxbot", "issues", "open", "DX-3.yml");
    writeYaml(v9Path, v9Yaml("DX-2"));
    writeYaml(v3Path, v2Yaml("DX-3"));

    // Pre-flag absent.
    expect(existsSync(flagPath(dir))).toBe(false);

    const result = await runBootMigrationSweep([{ localPath: dir }], {
      nowMs: Date.now(),
    });

    // v9 migrated cleanly even though v3 alongside failed.
    expect(result.migrated).toBe(1);
    const v9Parsed = parseYamlText(readFileSync(v9Path, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(v9Parsed.schema_version).toBe(KNOWN_SCHEMA_MAX);

    // v3 surfaced in failed[] with the offending path.
    expect(result.failed.length).toBe(1);
    expect(result.failed[0]!.path).toBe(v3Path);
    // Tight match: v3 fails with the registry's "no migration
    // registered for schema_version 3" message. A regex broad enough
    // to pass on any error string would hide actual regressions.
    expect(result.failed[0]!.error).toMatch(/no migration registered for schema_version 2/i);

    // Boot-side caller (mirrored from src/index.ts) writes the flag.
    bootSweepEmulator(dir, result.failed);
    expect(existsSync(flagPath(dir))).toBe(true);
    const flag = readFlag(dir);
    expect(flag).not.toBeNull();
    expect(flag!.source).toBe("boot-migration-sweep");
    expect(flag!.reason).toMatch(/Boot migration sweep failed for 1 file/);
    expect(flag!.detail).toContain(v3Path);
  });

  it("regression #3: closed mtime gate — 49h-old deleted, 47h-old migrated to v10", async () => {
    const closedDir = resolve(dir, ".danxbot", "issues", "closed");
    const nowMs = Date.UTC(2026, 4, 16, 12, 0, 0);
    const old49h = nowMs - 49 * 60 * 60 * 1000;
    const fresh47h = nowMs - 47 * 60 * 60 * 1000;
    const oldPath = resolve(closedDir, "DX-old.yml");
    const freshPath = resolve(closedDir, "DX-fresh.yml");
    writeYaml(oldPath, v9Yaml("DX-old"), old49h);
    writeYaml(freshPath, v9Yaml("DX-fresh"), fresh47h);

    const result = await runBootMigrationSweep([{ localPath: dir }], { nowMs });

    expect(result.failed).toEqual([]);
    expect(result.deletedClosed).toBe(1);
    expect(result.migrated).toBe(1);

    // 49h-old gone.
    expect(existsSync(oldPath)).toBe(false);
    // 47h-old kept + migrated.
    expect(existsSync(freshPath)).toBe(true);
    const parsed = parseYamlText(readFileSync(freshPath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(parsed.schema_version).toBe(KNOWN_SCHEMA_MAX);
  });
});
