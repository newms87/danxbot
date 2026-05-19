/**
 * Pins the DX-658 / Phase 2 lists.yaml one-shot migration that strips
 * the legacy `type: "blocked"` list from existing repos. AC #6 of
 * DX-658.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { migrateListsFileForDx658 } from "./lists-file-migrate-blocked.js";
import { _resetForTesting, listsFilePath } from "./lists-file.js";

function setupRepoDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "danxbot-lists-mig-test-"));
  mkdirSync(resolve(dir, ".danxbot"), { recursive: true });
  return dir;
}

const cleanupDirs: string[] = [];

beforeEach(() => {
  _resetForTesting();
});

afterEach(() => {
  for (const d of cleanupDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function track(d: string): string {
  cleanupDirs.push(d);
  return d;
}

const PRE_DX658_FILE = {
  lists: [
    {
      id: "id-archived",
      name: "Backlog",
      type: "archived",
      order: 0,
      is_default_for_type: true,
      color: "#64748b",
    },
    {
      id: "id-review",
      name: "Review",
      type: "review",
      order: 1,
      is_default_for_type: true,
      color: "#3b82f6",
    },
    {
      id: "id-ready",
      name: "To Do",
      type: "ready",
      order: 2,
      is_default_for_type: true,
      color: "#22d3ee",
    },
    {
      id: "id-blocked",
      name: "Blocked",
      type: "blocked",
      order: 3,
      is_default_for_type: true,
      color: "#ef4444",
    },
    {
      id: "id-in_progress",
      name: "In Progress",
      type: "in_progress",
      order: 4,
      is_default_for_type: true,
      color: "#f59e0b",
    },
    {
      id: "id-completed",
      name: "Done",
      type: "completed",
      order: 5,
      is_default_for_type: true,
      color: "#22c55e",
    },
    {
      id: "id-cancelled",
      name: "Cancelled",
      type: "cancelled",
      order: 6,
      is_default_for_type: true,
      color: "#71717a",
    },
  ],
  tombstone_ids: [],
};

describe("migrateListsFileForDx658", () => {
  it("removes the blocked list and tombstones its id on a pre-DX-658 file", async () => {
    const dir = track(setupRepoDir());
    const path = listsFilePath(dir);
    writeFileSync(path, stringifyYaml(PRE_DX658_FILE, { lineWidth: 0 }));

    const result = await migrateListsFileForDx658(dir);

    expect(result.migrated).toBe(true);
    expect(result.removedIds).toEqual(["id-blocked"]);

    const saved = parseYaml(readFileSync(path, "utf-8"));
    expect(saved.lists.map((l: { type: string }) => l.type)).toEqual([
      "archived",
      "review",
      "ready",
      "in_progress",
      "completed",
      "cancelled",
    ]);
    expect(saved.tombstone_ids).toContain("id-blocked");
  });

  it("is a no-op when the file already has no blocked list (idempotent)", async () => {
    const dir = track(setupRepoDir());
    const path = listsFilePath(dir);
    const post = {
      ...PRE_DX658_FILE,
      lists: PRE_DX658_FILE.lists.filter((l) => l.type !== "blocked"),
      tombstone_ids: ["id-blocked"],
    };
    writeFileSync(path, stringifyYaml(post, { lineWidth: 0 }));
    const before = readFileSync(path, "utf-8");

    const result = await migrateListsFileForDx658(dir);

    expect(result.migrated).toBe(false);
    expect(result.removedIds).toEqual([]);
    // File is untouched (byte-stable when there is nothing to do).
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("returns migrated=false when the file does not exist (fresh repo path)", async () => {
    const dir = track(setupRepoDir());
    expect(existsSync(listsFilePath(dir))).toBe(false);

    const result = await migrateListsFileForDx658(dir);

    expect(result.migrated).toBe(false);
    expect(result.removedIds).toEqual([]);
  });

  it("re-running after a successful migration is a no-op (idempotent)", async () => {
    const dir = track(setupRepoDir());
    const path = listsFilePath(dir);
    writeFileSync(path, stringifyYaml(PRE_DX658_FILE, { lineWidth: 0 }));

    const first = await migrateListsFileForDx658(dir);
    expect(first.migrated).toBe(true);

    const second = await migrateListsFileForDx658(dir);
    expect(second.migrated).toBe(false);
    expect(second.removedIds).toEqual([]);

    const saved = parseYaml(readFileSync(path, "utf-8"));
    expect(
      saved.lists.some((l: { type: string }) => l.type === "blocked"),
    ).toBe(false);
    expect(saved.tombstone_ids).toContain("id-blocked");
  });

  it("backfills missing `color` on a pre-DX-601 file so the strict write-side validator does not reject the migrated shape", async () => {
    const dir = track(setupRepoDir());
    const path = listsFilePath(dir);
    // Pre-DX-601 shape: no `color` field on any entry. One of them is
    // the legacy `type: "blocked"` list the migration must remove.
    const preColorFile = {
      lists: [
        {
          id: "id-archived",
          name: "Backlog",
          type: "archived",
          order: 0,
          is_default_for_type: true,
        },
        {
          id: "id-review",
          name: "Review",
          type: "review",
          order: 1,
          is_default_for_type: true,
        },
        {
          id: "id-ready",
          name: "To Do",
          type: "ready",
          order: 2,
          is_default_for_type: true,
        },
        {
          id: "id-blocked",
          name: "Blocked",
          type: "blocked",
          order: 3,
          is_default_for_type: true,
        },
        {
          id: "id-in_progress",
          name: "In Progress",
          type: "in_progress",
          order: 4,
          is_default_for_type: true,
        },
        {
          id: "id-completed",
          name: "Done",
          type: "completed",
          order: 5,
          is_default_for_type: true,
        },
        {
          id: "id-cancelled",
          name: "Cancelled",
          type: "cancelled",
          order: 6,
          is_default_for_type: true,
        },
      ],
      tombstone_ids: [],
    };
    writeFileSync(path, stringifyYaml(preColorFile, { lineWidth: 0 }));

    const result = await migrateListsFileForDx658(dir);

    expect(result.migrated).toBe(true);
    expect(result.removedIds).toEqual(["id-blocked"]);

    const saved = parseYaml(readFileSync(path, "utf-8"));
    // Blocked stripped; remaining 6 entries each carry a hex color
    // backfilled from the type → seed mapping (no NEUTRAL fallback for
    // these — every type is in LIST_TYPES_SET).
    expect(saved.lists).toHaveLength(6);
    for (const l of saved.lists as Array<{ type: string; color: string }>) {
      expect(l.color).toMatch(/^#[0-9a-fA-F]{3,6}$/);
    }
    expect(saved.tombstone_ids).toContain("id-blocked");
  });

  it("preserves any pre-existing tombstone_ids entries", async () => {
    const dir = track(setupRepoDir());
    const path = listsFilePath(dir);
    const seeded = {
      ...PRE_DX658_FILE,
      tombstone_ids: ["prior-tombstoned-id"],
    };
    writeFileSync(path, stringifyYaml(seeded, { lineWidth: 0 }));

    const result = await migrateListsFileForDx658(dir);

    expect(result.migrated).toBe(true);
    const saved = parseYaml(readFileSync(path, "utf-8"));
    expect(saved.tombstone_ids).toEqual(["prior-tombstoned-id", "id-blocked"]);
  });
});
