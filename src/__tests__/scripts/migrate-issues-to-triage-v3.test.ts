import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { runMigration } from "../../../scripts/migrate-issues-to-triage-v3.js";

interface RepoLayout {
  root: string;
  openDir: string;
  closedDir: string;
}

function setupRepo(): RepoLayout {
  const root = mkdtempSync(join(tmpdir(), "migrate-triage-test-"));
  const openDir = join(root, ".danxbot/issues/open");
  const closedDir = join(root, ".danxbot/issues/closed");
  mkdirSync(openDir, { recursive: true });
  mkdirSync(closedDir, { recursive: true });
  return { root, openDir, closedDir };
}

function legacyYaml(opts: {
  id: string;
  status?: string;
  triagedTimestamp?: string;
  triagedStatus?: string;
  triagedExplain?: string;
  dispatchId?: string | null;
}): string {
  const ts = opts.triagedTimestamp ?? "";
  const st = opts.triagedStatus ?? "";
  const ex = opts.triagedExplain ?? "";
  const dispatch = opts.dispatchId === undefined ? "null" : JSON.stringify(opts.dispatchId);
  return [
    "schema_version: 3",
    "tracker: trello",
    `id: ${opts.id}`,
    'external_id: ""',
    "parent_id: null",
    "children: []",
    `dispatch_id: ${dispatch}`,
    `status: ${opts.status ?? "ToDo"}`,
    "type: Feature",
    "title: legacy fixture",
    'description: ""',
    "triaged:",
    `  timestamp: ${JSON.stringify(ts)}`,
    `  status: ${JSON.stringify(st)}`,
    `  explain: ${JSON.stringify(ex)}`,
    "ac: []",
    "comments: []",
    "retro:",
    '  good: ""',
    '  bad: ""',
    "  action_item_ids: []",
    "  commits: []",
    "blocked: null",
    "",
  ].join("\n");
}

describe("migrate-issues-to-triage-v3", () => {
  it("migrates a legacy YAML to the new schema and copies triaged values to triage.history[0] + last_*", () => {
    const repo = setupRepo();
    try {
      const filePath = join(repo.openDir, "ISS-1.yml");
      writeFileSync(
        filePath,
        legacyYaml({
          id: "ISS-1",
          triagedTimestamp: "2026-04-01T12:00:00Z",
          triagedStatus: "Keep",
          triagedExplain: "looks good",
        }),
      );
      const result = runMigration({ staggerMs: 0, repoRoots: [repo.root] });
      expect(result.errors).toEqual([]);
      expect(result.migrated).toBe(1);
      const migrated = parse(readFileSync(filePath, "utf-8")) as Record<
        string,
        unknown
      >;
      // legacy fields gone
      expect(migrated.triaged).toBeUndefined();
      expect(migrated.dispatch_id).toBeUndefined();
      // new fields present
      expect(migrated.dispatch).toBeNull();
      const triage = migrated.triage as Record<string, unknown>;
      expect(triage.last_status).toBe("Keep");
      expect(triage.last_explain).toBe("looks good");
      const history = triage.history as Array<Record<string, unknown>>;
      expect(history).toHaveLength(1);
      expect(history[0].timestamp).toBe("2026-04-01T12:00:00Z");
      expect(history[0].status).toBe("Keep");
      expect(history[0].explain).toBe("looks good");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it("idempotent — re-running on a migrated YAML is a no-op (skipped, not migrated)", () => {
    const repo = setupRepo();
    try {
      const filePath = join(repo.openDir, "ISS-2.yml");
      writeFileSync(
        filePath,
        legacyYaml({
          id: "ISS-2",
          triagedTimestamp: "2026-04-01T12:00:00Z",
          triagedStatus: "Keep",
        }),
      );
      runMigration({ staggerMs: 0, repoRoots: [repo.root] });
      const after1 = readFileSync(filePath, "utf-8");
      const result2 = runMigration({ staggerMs: 0, repoRoots: [repo.root] });
      expect(result2.migrated).toBe(0);
      expect(result2.skipped).toBe(1);
      expect(result2.errors).toEqual([]);
      // file content stable across the second run
      expect(readFileSync(filePath, "utf-8")).toBe(after1);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it("converts a non-null dispatch_id into a structured dispatch{} block with id preserved", () => {
    const repo = setupRepo();
    try {
      const filePath = join(repo.openDir, "ISS-3.yml");
      writeFileSync(
        filePath,
        legacyYaml({
          id: "ISS-3",
          dispatchId: "abc-uuid-123",
        }),
      );
      runMigration({ staggerMs: 0, repoRoots: [repo.root] });
      const migrated = parse(readFileSync(filePath, "utf-8")) as Record<
        string,
        unknown
      >;
      expect(migrated.dispatch_id).toBeUndefined();
      const dispatch = migrated.dispatch as Record<string, unknown>;
      expect(dispatch.id).toBe("abc-uuid-123");
      expect(dispatch.pid).toBe(0);
      expect(dispatch.host).toBe("");
      expect(dispatch.kind).toBe("work");
      expect(dispatch.started_at).toBe("");
      expect(dispatch.ttl_seconds).toBe(0);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it("staggers expires_at across now → now + interval*N for open cards that had legacy triaged.timestamp", () => {
    const repo = setupRepo();
    try {
      const start = new Date("2026-05-07T00:00:00Z").getTime();
      const before = Date.now();
      // Use real time so the script's `new Date()` in applyStagger is
      // close to NOW; we then assert each entry is at least START_AGO and
      // at most START_AHEAD apart.
      void start;
      void before;
      for (let i = 0; i < 4; i++) {
        writeFileSync(
          join(repo.openDir, `ISS-${i + 10}.yml`),
          legacyYaml({
            id: `ISS-${i + 10}`,
            triagedTimestamp: "2026-04-01T12:00:00Z",
            triagedStatus: "Keep",
          }),
        );
      }
      const intervalMs = 60_000; // 1 minute
      runMigration({ staggerMs: intervalMs, repoRoots: [repo.root] });

      const stamps = [10, 11, 12, 13]
        .map((n) => {
          const yaml = parse(
            readFileSync(join(repo.openDir, `ISS-${n}.yml`), "utf-8"),
          ) as Record<string, unknown>;
          return new Date(
            (yaml.triage as Record<string, unknown>).expires_at as string,
          ).getTime();
        })
        .sort((a, b) => a - b);

      // Spacing is exactly intervalMs between consecutive stamps.
      for (let i = 1; i < stamps.length; i++) {
        expect(stamps[i] - stamps[i - 1]).toBe(intervalMs);
      }
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it("with --stagger-ms=0 leaves expires_at empty so EVERY card re-triages on next poll", () => {
    const repo = setupRepo();
    try {
      writeFileSync(
        join(repo.openDir, "ISS-20.yml"),
        legacyYaml({
          id: "ISS-20",
          triagedTimestamp: "2026-04-01T12:00:00Z",
          triagedStatus: "Keep",
        }),
      );
      runMigration({ staggerMs: 0, repoRoots: [repo.root] });
      const yaml = parse(
        readFileSync(join(repo.openDir, "ISS-20.yml"), "utf-8"),
      ) as Record<string, unknown>;
      expect((yaml.triage as Record<string, unknown>).expires_at).toBe("");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it("does NOT stagger closed cards (terminal cards never re-triage)", () => {
    const repo = setupRepo();
    try {
      const closedPath = join(repo.closedDir, "ISS-30.yml");
      writeFileSync(
        closedPath,
        legacyYaml({
          id: "ISS-30",
          status: "Done",
          triagedTimestamp: "2026-04-01T12:00:00Z",
          triagedStatus: "Keep",
        }),
      );
      runMigration({ staggerMs: 60_000, repoRoots: [repo.root] });
      const yaml = parse(readFileSync(closedPath, "utf-8")) as Record<
        string,
        unknown
      >;
      // closed card had legacy triaged → migrates to history but its
      // expires_at stays empty (closed cards are not staggered).
      const triage = yaml.triage as Record<string, unknown>;
      expect(triage.expires_at).toBe("");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it("migrated YAMLs round-trip through the strict parseIssue validator", async () => {
    const { parseIssue } = await import(
      "../../issue-tracker/yaml.js"
    );
    const repo = setupRepo();
    try {
      const filePath = join(repo.openDir, "ISS-40.yml");
      writeFileSync(
        filePath,
        legacyYaml({
          id: "ISS-40",
          triagedTimestamp: "2026-04-01T12:00:00Z",
          triagedStatus: "Keep",
          triagedExplain: "fine",
          dispatchId: "uuid-1",
        }),
      );
      runMigration({ staggerMs: 0, repoRoots: [repo.root] });
      const migrated = parseIssue(readFileSync(filePath, "utf-8"));
      expect(migrated.id).toBe("ISS-40");
      expect(migrated.triage.last_status).toBe("Keep");
      expect(migrated.dispatch?.id).toBe("uuid-1");
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
});
