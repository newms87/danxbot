import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYamlText } from "yaml";
import {
  runBootMigrationSweep,
  type BootSweepRepo,
} from "../../worker/migrate-on-boot.js";
import { KNOWN_SCHEMA_MAX } from "../../issue-tracker/schema-versions.js";
import { parseIssue } from "../../issue-tracker/yaml.js";

/**
 * DX-593 — boot-time schema migration sweep integration test.
 *
 * Plants a mixed-version fixture (v9 + v10 open YAMLs, closed YAMLs split
 * across the 48h mtime boundary, a broken-YAML failure case) into a real
 * tmpdir repo, runs the sweep, asserts:
 *   - every open YAML is at KNOWN_SCHEMA_MAX after the sweep
 *   - closed YAMLs older than 48h are unlinked
 *   - closed YAMLs newer than 48h are migrated to KNOWN_SCHEMA_MAX
 *   - syntactically broken YAML lands in result.failed[] without throwing
 *   - the result counts (migrated / unchanged / deletedClosed / failed) match
 *   - DANXBOT_SKIP_BOOT_MIGRATION_SWEEP=1 short-circuits the sweep
 */

const V9_YAML = (id: string): string =>
  [
    "schema_version: 9",
    "tracker: trello",
    `id: ${id}`,
    'external_id: ""',
    "parent_id: null",
    "children: []",
    "dispatch: null",
    // status MUST be Blocked because the fixture carries a non-null
    // blocked record — the validator enforces the `blocked != null ⇔
    // status === Blocked` invariant.
    "status: Blocked",
    "type: Feature",
    `title: ${id} legacy`,
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
    "blocked:",
    "  reason: legacy reason",
    "  timestamp: '2026-05-10T00:00:00Z'",
    "requires_human: null",
    "conflict_on: []",
    "effort_level: medium",
    "db_updated_at: ''",
    "",
  ].join("\n");

const V10_YAML = (id: string): string =>
  [
    `schema_version: ${KNOWN_SCHEMA_MAX}`,
    "tracker: trello",
    `id: ${id}`,
    'external_id: ""',
    "parent_id: null",
    "children: []",
    "dispatch: null",
    "status: ToDo",
    "type: Feature",
    `title: ${id} canonical`,
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
    "archived_at: null",
    "ready_at: null",
    "completed_at: null",
    "cancelled_at: null",
    "list_name: null",
    "",
  ].join("\n");

function makeRepo(localPath: string): BootSweepRepo {
  return { localPath };
}

function writeYaml(path: string, body: string, mtimeMs?: number): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf-8");
  if (mtimeMs !== undefined) {
    const sec = mtimeMs / 1000;
    utimesSync(path, sec, sec);
  }
}

describe("runBootMigrationSweep (DX-593)", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(resolve(tmpdir(), "boot-migration-sweep-"));
  });

  afterEach(() => {
    // Clear all YAMLs between cases — each test re-plants its own fixture.
    const openDir = resolve(dir, ".danxbot", "issues", "open");
    const closedDir = resolve(dir, ".danxbot", "issues", "closed");
    rmSync(openDir, { recursive: true, force: true });
    rmSync(closedDir, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("forwards v9 open YAMLs to KNOWN_SCHEMA_MAX, leaves v10 untouched, deletes closed-old, migrates closed-new", async () => {
    const openDir = resolve(dir, ".danxbot", "issues", "open");
    const closedDir = resolve(dir, ".danxbot", "issues", "closed");

    const nowMs = Date.UTC(2026, 4, 16, 12, 0, 0); // fixed clock
    const oldMtime = nowMs - 49 * 60 * 60 * 1000; // 49h old
    const freshMtime = nowMs - 1 * 60 * 60 * 1000; // 1h old

    writeYaml(resolve(openDir, "DX-1.yml"), V9_YAML("DX-1"));
    writeYaml(resolve(openDir, "DX-2.yml"), V9_YAML("DX-2"));
    writeYaml(resolve(openDir, "DX-3.yml"), V10_YAML("DX-3"));

    writeYaml(resolve(closedDir, "DX-4.yml"), V9_YAML("DX-4"), oldMtime);
    writeYaml(resolve(closedDir, "DX-5.yml"), V9_YAML("DX-5"), freshMtime);
    writeYaml(resolve(closedDir, "DX-6.yml"), V10_YAML("DX-6"), oldMtime);

    const result = await runBootMigrationSweep([makeRepo(dir)], { nowMs });

    // Counts: 2 open v9 migrated + 1 closed-new v9 migrated = 3; 1 open v10
    // unchanged = 1; 2 closed-old deleted (one v9 + one v10) = 2; 0 failed.
    expect(result.failed).toEqual([]);
    expect(result.migrated).toBe(3);
    expect(result.unchanged).toBe(1);
    expect(result.deletedClosed).toBe(2);

    // Every surviving YAML parses at KNOWN_SCHEMA_MAX through the STRICT
    // validator (parseIssue + validateIssue) — not just raw schema_version.
    // AC1's contract is "every YAML on disk that should still exist parses
    // as exactly KNOWN_SCHEMA_MAX"; without the strict round-trip, a future
    // bug in `migrations/v9-to-v10.ts` (e.g. malformed `blocked` object,
    // missing one of the five new nullable fields) would slip past.
    for (const p of [
      resolve(openDir, "DX-1.yml"),
      resolve(openDir, "DX-2.yml"),
      resolve(openDir, "DX-3.yml"),
      resolve(closedDir, "DX-5.yml"),
    ]) {
      const text = readFileSync(p, "utf-8");
      const parsedRaw = parseYamlText(text) as Record<string, unknown>;
      expect(parsedRaw.schema_version).toBe(KNOWN_SCHEMA_MAX);
      const issue = parseIssue(text, { expectedPrefix: "DX" });
      expect(issue.schema_version).toBe(KNOWN_SCHEMA_MAX);
    }

    // The migrated v9 fixture's `blocked.timestamp` MUST have been renamed
    // to `blocked.at` (DX-592 invariant). Locks the rename surface end-to-
    // end: a future bug in v9-to-v10 that left `.timestamp` in place would
    // pass raw `schema_version` checks but fail this one.
    const dx1 = parseIssue(readFileSync(resolve(openDir, "DX-1.yml"), "utf-8"), {
      expectedPrefix: "DX",
    });
    expect(dx1.blocked).toEqual({
      reason: "legacy reason",
      at: "2026-05-10T00:00:00Z",
    });

    // Closed-old files are gone (both v9 and v10 — the >48h gate doesn't
    // care about version).
    expect(existsSync(resolve(closedDir, "DX-4.yml"))).toBe(false);
    expect(existsSync(resolve(closedDir, "DX-6.yml"))).toBe(false);
  });

  it("48h boundary: closed YAML at EXACTLY 48h is migrated, not deleted (strict-greater gate)", async () => {
    // The closed-mtime gate is `nowMs - mtimeMs > CLOSED_MAX_AGE_MS`. A
    // file at exactly 48h is kept + migrated. Locks the strict-greater
    // boundary so a refactor to `>=` is caught.
    const closedDir = resolve(dir, ".danxbot", "issues", "closed");
    const nowMs = Date.UTC(2026, 4, 16, 12, 0, 0);
    const exactly48h = nowMs - 48 * 60 * 60 * 1000;
    writeYaml(resolve(closedDir, "DX-edge.yml"), V9_YAML("DX-edge"), exactly48h);

    const result = await runBootMigrationSweep([makeRepo(dir)], { nowMs });
    expect(result.failed).toEqual([]);
    expect(result.deletedClosed).toBe(0);
    expect(result.migrated).toBe(1);
    expect(existsSync(resolve(closedDir, "DX-edge.yml"))).toBe(true);
    const parsed = parseYamlText(
      readFileSync(resolve(closedDir, "DX-edge.yml"), "utf-8"),
    ) as Record<string, unknown>;
    expect(parsed.schema_version).toBe(KNOWN_SCHEMA_MAX);
  });

  it("aggregates counts across multiple repos", async () => {
    // Two independent tmp repos each carrying a v9 fixture. The sweep MUST
    // visit both and sum the counts into one BootSweepResult — a regression
    // where the second repo overwrote the first's counts would be
    // undetectable with single-repo cases only.
    const repoA = mkdtempSync(resolve(tmpdir(), "boot-migration-sweep-A-"));
    const repoB = mkdtempSync(resolve(tmpdir(), "boot-migration-sweep-B-"));
    try {
      writeYaml(
        resolve(repoA, ".danxbot", "issues", "open", "DX-1.yml"),
        V9_YAML("DX-1"),
      );
      writeYaml(
        resolve(repoB, ".danxbot", "issues", "open", "DX-2.yml"),
        V9_YAML("DX-2"),
      );
      writeYaml(
        resolve(repoB, ".danxbot", "issues", "open", "DX-3.yml"),
        V10_YAML("DX-3"),
      );

      const result = await runBootMigrationSweep(
        [makeRepo(repoA), makeRepo(repoB)],
        { nowMs: Date.now() },
      );
      expect(result.failed).toEqual([]);
      expect(result.migrated).toBe(2);
      expect(result.unchanged).toBe(1);
      expect(result.deletedClosed).toBe(0);
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });

  it("rolls back atomic-write on write failure: tmp removed, original untouched, failure recorded", async () => {
    // Force `writeFile` to fail with EACCES by stripping write permission
    // on the parent directory. The sweep's `readdir` (read+execute) still
    // works; `writeFile` of the tmp fails; the catch branch's
    // `unlink(tmp)` is a no-op (file never created). Asserts:
    //   (a) the file lands in failed[],
    //   (b) the original v9 content is still on disk,
    //   (c) no .tmp residue.
    const openDir = resolve(dir, ".danxbot", "issues", "open");
    const path = resolve(openDir, "DX-1.yml");
    writeYaml(path, V9_YAML("DX-1"));
    const originalText = readFileSync(path, "utf-8");

    chmodSync(openDir, 0o500); // r-x for owner — readdir works, writeFile fails
    try {
      const result = await runBootMigrationSweep([makeRepo(dir)], {
        nowMs: Date.now(),
      });
      expect(result.failed.length).toBe(1);
      expect(result.failed[0]!.path).toBe(path);
      // EACCES message shape varies; assert non-empty and matches a
      // permission-class error.
      expect(result.failed[0]!.error).toMatch(/EACCES|permission/i);
      expect(result.migrated).toBe(0);
    } finally {
      // Always restore writability so afterEach can clean up.
      chmodSync(openDir, 0o700);
    }

    // Original untouched.
    expect(readFileSync(path, "utf-8")).toBe(originalText);
    // No tmp residue.
    const list = readdirSync(openDir);
    expect(list.filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("collects per-file failures into result.failed[] without throwing — broken YAML does NOT abort the sweep", async () => {
    const openDir = resolve(dir, ".danxbot", "issues", "open");

    writeYaml(resolve(openDir, "DX-1.yml"), V9_YAML("DX-1"));
    writeYaml(resolve(openDir, "DX-broken.yml"), "this: is: not: valid yaml: [\n");
    writeYaml(resolve(openDir, "DX-no-version.yml"), "id: DX-7\nschema_version: oops\n");

    const nowMs = Date.now();
    const result = await runBootMigrationSweep([makeRepo(dir)], { nowMs });

    // The good v9 file still migrates; the two broken files land in failed[].
    expect(result.migrated).toBe(1);
    expect(result.failed.length).toBe(2);
    const failedPaths = result.failed.map((f) => f.path).sort();
    expect(failedPaths).toEqual(
      [
        resolve(openDir, "DX-broken.yml"),
        resolve(openDir, "DX-no-version.yml"),
      ].sort(),
    );
    for (const f of result.failed) {
      expect(typeof f.error).toBe("string");
      expect(f.error.length).toBeGreaterThan(0);
    }
  });

  it("returns empty result when DANXBOT_SKIP_BOOT_MIGRATION_SWEEP=1 (operator escape hatch)", async () => {
    const openDir = resolve(dir, ".danxbot", "issues", "open");
    const v9Path = resolve(openDir, "DX-1.yml");
    writeYaml(v9Path, V9_YAML("DX-1"));

    const result = await runBootMigrationSweep([makeRepo(dir)], {
      nowMs: Date.now(),
      envSkip: "1",
    });

    expect(result).toEqual({
      migrated: 0,
      healed: 0,
      unchanged: 0,
      deletedClosed: 0,
      failed: [],
    });

    // File is untouched — still v9 on disk.
    const parsed = parseYamlText(readFileSync(v9Path, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(parsed.schema_version).toBe(9);
  });

  it("tolerates missing open / closed directories without throwing", async () => {
    // Fresh repo with NO .danxbot/issues/ tree at all.
    const freshRepo = mkdtempSync(resolve(tmpdir(), "boot-migration-sweep-empty-"));
    try {
      const result = await runBootMigrationSweep([makeRepo(freshRepo)], {
        nowMs: Date.now(),
      });
      expect(result).toEqual({
        migrated: 0,
        healed: 0,
        unchanged: 0,
        deletedClosed: 0,
        failed: [],
      });
    } finally {
      rmSync(freshRepo, { recursive: true, force: true });
    }
  });

  it("ignores non-.yml files in the issues directories", async () => {
    const openDir = resolve(dir, ".danxbot", "issues", "open");
    writeYaml(resolve(openDir, "DX-1.yml"), V9_YAML("DX-1"));
    writeYaml(resolve(openDir, "README.md"), "# placeholder\n");
    writeYaml(resolve(openDir, ".gitkeep"), "");

    const result = await runBootMigrationSweep([makeRepo(dir)], {
      nowMs: Date.now(),
    });

    expect(result.failed).toEqual([]);
    expect(result.migrated).toBe(1);
    expect(result.unchanged).toBe(0);
    // README + .gitkeep still on disk untouched.
    expect(existsSync(resolve(openDir, "README.md"))).toBe(true);
    expect(existsSync(resolve(openDir, ".gitkeep"))).toBe(true);
  });

  it("heals an at-MAX YAML missing a required-with-default field (priority)", async () => {
    // Repro of DX-576-class drift: a writer regression emitted a v10
    // YAML without `priority`. Boot sweep MUST detect, fill the
    // canonical default, write back atomically, count the file under
    // result.healed (not result.unchanged), and produce a YAML that
    // round-trips through strict parseIssue.
    const openDir = resolve(dir, ".danxbot", "issues", "open");
    const path = resolve(openDir, "DX-1.yml");
    const malformed = V10_YAML("DX-1").replace(/\npriority: 3\n/, "\n");
    writeYaml(path, malformed);

    const result = await runBootMigrationSweep([makeRepo(dir)], {
      nowMs: Date.now(),
    });

    expect(result.failed).toEqual([]);
    expect(result.healed).toBe(1);
    expect(result.unchanged).toBe(0);
    expect(result.migrated).toBe(0);

    const after = readFileSync(path, "utf-8");
    const parsed = parseYamlText(after) as Record<string, unknown>;
    expect(parsed.priority).toBe(3);
    expect(parsed.schema_version).toBe(KNOWN_SCHEMA_MAX);

    // Round-trips through the strict reader after the heal.
    const issue = parseIssue(after, { expectedPrefix: "DX" });
    expect(issue.priority).toBe(3);
  });

  it("counts an at-MAX YAML with every required field as unchanged", async () => {
    const openDir = resolve(dir, ".danxbot", "issues", "open");
    writeYaml(resolve(openDir, "DX-1.yml"), V10_YAML("DX-1"));

    const result = await runBootMigrationSweep([makeRepo(dir)], {
      nowMs: Date.now(),
    });

    expect(result.unchanged).toBe(1);
    expect(result.healed).toBe(0);
    expect(result.migrated).toBe(0);
  });

  it("writes atomically — no .tmp residue after a successful migration", async () => {
    const openDir = resolve(dir, ".danxbot", "issues", "open");
    writeYaml(resolve(openDir, "DX-1.yml"), V9_YAML("DX-1"));

    await runBootMigrationSweep([makeRepo(dir)], { nowMs: Date.now() });

    const entries = readFileSync(resolve(openDir, "DX-1.yml"), "utf-8");
    expect(entries.length).toBeGreaterThan(0);
    // No residual tmp file
    const fs = await import("node:fs/promises");
    const list = await fs.readdir(openDir);
    expect(list.filter((n) => n.includes(".tmp"))).toEqual([]);
  });
});
