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
import { parse as parseYaml } from "yaml";
import {
  TrelloListMapValidationError,
  _resetForTesting,
  classifyTrelloListMapping,
  emptyTrelloListMap,
  ensureTrelloListMapFile,
  readTrelloListMap,
  trelloListMapFilePath,
  validateTrelloListMap,
  writeTrelloListMap,
  type TrelloListMap,
} from "./trello-list-map.js";

function setupRepoDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "danxbot-trello-list-map-test-"));
  mkdirSync(resolve(dir, ".danxbot"), { recursive: true });
  return dir;
}

let cleanupDirs: string[] = [];

beforeEach(() => {
  _resetForTesting();
  cleanupDirs = [];
});

afterEach(() => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
});

function makeDir(): string {
  const d = setupRepoDir();
  cleanupDirs.push(d);
  return d;
}

describe("emptyTrelloListMap", () => {
  it("returns the canonical empty shape", () => {
    expect(emptyTrelloListMap()).toEqual({ list_id_to_trello_list_id: {} });
  });
});

describe("readTrelloListMap", () => {
  it("returns empty map when file is missing", () => {
    const dir = makeDir();
    expect(readTrelloListMap(dir)).toEqual({ list_id_to_trello_list_id: {} });
  });

  it("parses a valid file", () => {
    const dir = makeDir();
    writeFileSync(
      trelloListMapFilePath(dir),
      "list_id_to_trello_list_id:\n  dx-1: trello-a\n  dx-2: trello-b\n",
      "utf-8",
    );
    expect(readTrelloListMap(dir)).toEqual({
      list_id_to_trello_list_id: { "dx-1": "trello-a", "dx-2": "trello-b" },
    });
  });

  it("degrades to empty map on corrupt YAML (logs warn, never throws)", () => {
    const dir = makeDir();
    writeFileSync(trelloListMapFilePath(dir), "::: not yaml :::\n  - [", "utf-8");
    expect(readTrelloListMap(dir)).toEqual({ list_id_to_trello_list_id: {} });
  });

  it("degrades to empty map when list_id_to_trello_list_id is missing", () => {
    const dir = makeDir();
    writeFileSync(trelloListMapFilePath(dir), "other_field: 1\n", "utf-8");
    expect(readTrelloListMap(dir)).toEqual({ list_id_to_trello_list_id: {} });
  });

  it("degrades to empty map when inner is an array (defensive normalize branch)", () => {
    const dir = makeDir();
    writeFileSync(
      trelloListMapFilePath(dir),
      "list_id_to_trello_list_id:\n  - 1\n  - 2\n",
      "utf-8",
    );
    expect(readTrelloListMap(dir)).toEqual({ list_id_to_trello_list_id: {} });
  });

  it("filters out non-string keys/values during normalize (best-effort read)", () => {
    const dir = makeDir();
    writeFileSync(
      trelloListMapFilePath(dir),
      "list_id_to_trello_list_id:\n  dx-1: trello-a\n  dx-2: 42\n  dx-3: ''\n",
      "utf-8",
    );
    expect(readTrelloListMap(dir)).toEqual({
      list_id_to_trello_list_id: { "dx-1": "trello-a" },
    });
  });
});

describe("ensureTrelloListMapFile", () => {
  it("seeds the file with an empty map on first call", async () => {
    const dir = makeDir();
    const path = trelloListMapFilePath(dir);
    expect(existsSync(path)).toBe(false);
    await ensureTrelloListMapFile(dir);
    expect(existsSync(path)).toBe(true);
    const parsed = parseYaml(readFileSync(path, "utf-8"));
    expect(parsed).toEqual({ list_id_to_trello_list_id: {} });
  });

  it("is idempotent — second call leaves the existing file untouched", async () => {
    const dir = makeDir();
    await ensureTrelloListMapFile(dir);
    const path = trelloListMapFilePath(dir);
    writeFileSync(
      path,
      "list_id_to_trello_list_id:\n  dx-1: trello-a\n",
      "utf-8",
    );
    await ensureTrelloListMapFile(dir);
    const after = parseYaml(readFileSync(path, "utf-8"));
    expect(after).toEqual({ list_id_to_trello_list_id: { "dx-1": "trello-a" } });
  });
});

describe("writeTrelloListMap", () => {
  it("round-trips via read", async () => {
    const dir = makeDir();
    const map: TrelloListMap = {
      list_id_to_trello_list_id: { "dx-1": "trello-a", "dx-2": "trello-b" },
    };
    await writeTrelloListMap(dir, map, new Set(["dx-1", "dx-2"]));
    expect(readTrelloListMap(dir)).toEqual(map);
  });

  it("uses atomic temp+rename (no .tmp residue after write)", async () => {
    const dir = makeDir();
    await writeTrelloListMap(
      dir,
      { list_id_to_trello_list_id: { "dx-1": "trello-a" } },
      new Set(["dx-1"]),
    );
    const dotDir = resolve(dir, ".danxbot");
    const { readdirSync } = await import("node:fs");
    const tmpFiles = readdirSync(dotDir).filter((f) =>
      f.startsWith("trello-list-map.yaml.tmp."),
    );
    expect(tmpFiles).toEqual([]);
    expect(existsSync(trelloListMapFilePath(dir))).toBe(true);
  });

  it("serializes concurrent writes (in-process promise chain)", async () => {
    const dir = makeDir();
    const known = new Set(["dx-1", "dx-2"]);
    const a = writeTrelloListMap(
      dir,
      { list_id_to_trello_list_id: { "dx-1": "trello-a" } },
      known,
    );
    const b = writeTrelloListMap(
      dir,
      { list_id_to_trello_list_id: { "dx-1": "trello-a", "dx-2": "trello-b" } },
      known,
    );
    await Promise.all([a, b]);
    // Last writer wins; both writes completed without error.
    expect(readTrelloListMap(dir)).toEqual({
      list_id_to_trello_list_id: { "dx-1": "trello-a", "dx-2": "trello-b" },
    });
  });

  it("rejects unknown danxbot list ids", async () => {
    const dir = makeDir();
    await expect(
      writeTrelloListMap(
        dir,
        { list_id_to_trello_list_id: { "dx-ghost": "trello-a" } },
        new Set(["dx-1"]),
      ),
    ).rejects.toBeInstanceOf(TrelloListMapValidationError);
  });
});

describe("validateTrelloListMap", () => {
  const known = new Set(["dx-1", "dx-2"]);

  it("accepts an empty map", () => {
    expect(() => validateTrelloListMap(emptyTrelloListMap(), known)).not.toThrow();
  });

  it("rejects a null / non-object outer map", () => {
    expect(() =>
      validateTrelloListMap(null as unknown as TrelloListMap, known),
    ).toThrowError(TrelloListMapValidationError);
  });

  it("accepts a fully-known map", () => {
    expect(() =>
      validateTrelloListMap(
        { list_id_to_trello_list_id: { "dx-1": "trello-a", "dx-2": "trello-b" } },
        known,
      ),
    ).not.toThrow();
  });

  it("rejects unknown danxbot list ids with a per-entry diagnostic", () => {
    let caught: TrelloListMapValidationError | null = null;
    try {
      validateTrelloListMap(
        { list_id_to_trello_list_id: { "dx-ghost": "trello-a" } },
        known,
      );
    } catch (e) {
      caught = e as TrelloListMapValidationError;
    }
    expect(caught).toBeInstanceOf(TrelloListMapValidationError);
    expect(caught!.errors).toEqual([
      expect.stringContaining("unknown danxbot list id"),
    ]);
  });

  it("rejects empty-string values", () => {
    expect(() =>
      validateTrelloListMap(
        { list_id_to_trello_list_id: { "dx-1": "" } },
        known,
      ),
    ).toThrowError(TrelloListMapValidationError);
  });

  it("rejects non-string values", () => {
    expect(() =>
      validateTrelloListMap(
        { list_id_to_trello_list_id: { "dx-1": 42 as unknown as string } },
        known,
      ),
    ).toThrowError(TrelloListMapValidationError);
  });

  it("rejects a non-object inner map", () => {
    expect(() =>
      validateTrelloListMap(
        { list_id_to_trello_list_id: [] as unknown as Record<string, string> },
        known,
      ),
    ).toThrowError(TrelloListMapValidationError);
  });

  it("accumulates multiple errors in one throw", () => {
    let caught: TrelloListMapValidationError | null = null;
    try {
      validateTrelloListMap(
        {
          list_id_to_trello_list_id: {
            "dx-ghost": "trello-a",
            "dx-1": "",
          },
        },
        known,
      );
    } catch (e) {
      caught = e as TrelloListMapValidationError;
    }
    expect(caught).toBeInstanceOf(TrelloListMapValidationError);
    expect(caught!.errors).toHaveLength(2);
  });
});

describe("classifyTrelloListMapping", () => {
  const danxbotLists = [{ id: "dx-1" }, { id: "dx-2" }, { id: "dx-3" }];
  const trelloLists = [
    { id: "trello-a", name: "Backlog" },
    { id: "trello-b", name: "In Progress" },
  ];

  it("returns mapped when map points at a live trello list", () => {
    const result = classifyTrelloListMapping(danxbotLists, trelloLists, {
      list_id_to_trello_list_id: { "dx-1": "trello-a" },
    });
    expect(result["dx-1"]).toEqual({
      status: "mapped",
      trello_list_id: "trello-a",
      trello_list_name: "Backlog",
    });
  });

  it("returns unmapped when the danxbot list has no entry in the map", () => {
    const result = classifyTrelloListMapping(danxbotLists, trelloLists, {
      list_id_to_trello_list_id: { "dx-1": "trello-a" },
    });
    expect(result["dx-2"]).toEqual({ status: "unmapped" });
    expect(result["dx-3"]).toEqual({ status: "unmapped" });
  });

  it("returns orphaned when the mapped trello id is missing from the board", () => {
    const result = classifyTrelloListMapping(danxbotLists, trelloLists, {
      list_id_to_trello_list_id: { "dx-1": "trello-deleted" },
    });
    expect(result["dx-1"]).toEqual({
      status: "orphaned",
      trello_list_id: "trello-deleted",
    });
  });

  it("produces one entry per danxbot list, regardless of map shape", () => {
    const result = classifyTrelloListMapping(danxbotLists, trelloLists, {
      list_id_to_trello_list_id: {
        "dx-1": "trello-a",
        "dx-2": "trello-deleted",
      },
    });
    expect(Object.keys(result).sort()).toEqual(["dx-1", "dx-2", "dx-3"]);
    expect(result["dx-1"].status).toBe("mapped");
    expect(result["dx-2"].status).toBe("orphaned");
    expect(result["dx-3"].status).toBe("unmapped");
  });

  it("treats empty / non-string mapped values as unmapped", () => {
    const result = classifyTrelloListMapping(danxbotLists, trelloLists, {
      list_id_to_trello_list_id: { "dx-1": "" as string },
    });
    expect(result["dx-1"]).toEqual({ status: "unmapped" });
  });
});
