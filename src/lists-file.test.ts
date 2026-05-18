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
  LIST_TYPES,
  ListsValidationError,
  _resetForTesting,
  applyCreateList,
  applyDeleteList,
  applySwapOrder,
  applyUpdateList,
  defaultLists,
  ensureListsFile,
  getDefaultListForType,
  httpStatusForListsValidationCode,
  listsFilePath,
  readLists,
  validateLists,
  writeLists,
  type ListsFile,
} from "./lists-file.js";

function setupRepoDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "danxbot-lists-test-"));
  mkdirSync(resolve(dir, ".danxbot"), { recursive: true });
  return dir;
}

function deterministicUuid(seed: string): () => string {
  let n = 0;
  return () => `${seed}-${n++}`;
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

describe("defaultLists", () => {
  it("seeds 6 lists, one per type, all default", () => {
    const file = defaultLists({ uuid: deterministicUuid("s") });
    expect(file.lists).toHaveLength(6);
    const types = file.lists.map((l) => l.type).sort();
    expect(types).toEqual([...LIST_TYPES].sort());
    expect(file.lists.every((l) => l.is_default_for_type)).toBe(true);
    expect(file.tombstone_ids).toEqual([]);
  });

  it("validates clean against validateLists", () => {
    expect(() => validateLists(defaultLists())).not.toThrow();
  });

  it("seeds the canonical color per type (DX-601)", () => {
    const file = defaultLists({ uuid: deterministicUuid("color") });
    const byType = Object.fromEntries(
      file.lists.map((l) => [l.type, { name: l.name, color: l.color }]),
    );
    expect(byType.archived).toEqual({ name: "Backlog", color: "#64748b" });
    expect(byType.review).toEqual({ name: "Review", color: "#3b82f6" });
    expect(byType.ready).toEqual({ name: "To Do", color: "#22d3ee" });
    expect(byType.in_progress).toEqual({ name: "In Progress", color: "#f59e0b" });
    expect(byType.completed).toEqual({ name: "Done", color: "#22c55e" });
    expect(byType.cancelled).toEqual({ name: "Cancelled", color: "#71717a" });
  });
});

describe("validateLists", () => {
  it("rejects missing type", () => {
    const file = defaultLists();
    file.lists = file.lists.filter((l) => l.type !== "review");
    expect(() => validateLists(file)).toThrowError(/type "review".*≥1 list/);
  });

  it("rejects two defaults for same type", () => {
    const file = defaultLists({ uuid: deterministicUuid("v") });
    file.lists.push({
      id: "extra-id",
      name: "Extra Review",
      type: "review",
      order: 99,
      is_default_for_type: true,
      color: "#3b82f6",
    });
    expect(() => validateLists(file)).toThrowError(/Type "review" has 2 defaults/);
  });

  it("rejects zero defaults for a type", () => {
    const file = defaultLists();
    const idx = file.lists.findIndex((l) => l.type === "review");
    file.lists[idx] = { ...file.lists[idx], is_default_for_type: false };
    expect(() => validateLists(file)).toThrowError(/no list with is_default_for_type=true/);
  });

  it("rejects duplicate ids", () => {
    const file = defaultLists();
    file.lists[1] = { ...file.lists[1], id: file.lists[0].id };
    expect(() => validateLists(file)).toThrowError(/duplicates an earlier entry/);
  });

  it("rejects tombstone reuse", () => {
    const file = defaultLists();
    file.tombstone_ids = [file.lists[0].id];
    expect(() => validateLists(file)).toThrowError(/previously deleted — ids never reused/);
  });

  it("rejects invalid color (DX-601)", () => {
    const file = defaultLists();
    file.lists[0] = { ...file.lists[0], color: "not-a-color" };
    expect(() => validateLists(file)).toThrowError(/color must be a hex color/);
  });

  it("rejects empty color string (DX-601)", () => {
    const file = defaultLists();
    file.lists[0] = { ...file.lists[0], color: "" };
    expect(() => validateLists(file)).toThrowError(
      /color must be a hex color|missing required field/,
    );
  });

  it("accepts 3-digit and 6-digit hex with mixed case (DX-601)", () => {
    const file = defaultLists();
    file.lists[0] = { ...file.lists[0], color: "#aBc" };
    file.lists[1] = { ...file.lists[1], color: "#AaBbCc" };
    expect(() => validateLists(file)).not.toThrow();
  });

  it("rejects non-string color (DX-601)", () => {
    const file = defaultLists();
    file.lists[0] = { ...file.lists[0], color: 123 as unknown as string };
    expect(() => validateLists(file)).toThrowError(
      /missing required field|color must be a hex/,
    );
  });

  it("rejects 4-digit and 5-digit hex AND missing # (DX-601)", () => {
    const cases = ["#abcd", "#12345", "abcdef", "#xyz"];
    for (const bad of cases) {
      const file = defaultLists();
      file.lists[0] = { ...file.lists[0], color: bad };
      expect(() => validateLists(file)).toThrowError();
    }
  });

  it("rejects negative order on validateLists (AC #5, DX-601)", () => {
    const file = defaultLists();
    file.lists[0] = { ...file.lists[0], order: -1 };
    expect(() => validateLists(file)).toThrowError(/order must be ≥ 0/);
  });

  it("gathers multiple errors", () => {
    const file: ListsFile = { lists: [], tombstone_ids: [] };
    expect.assertions(2);
    try {
      validateLists(file);
    } catch (err) {
      expect(err).toBeInstanceOf(ListsValidationError);
      expect((err as ListsValidationError).errors.length).toBeGreaterThanOrEqual(LIST_TYPES.length);
    }
  });
});

describe("file round-trip", () => {
  it("readLists returns seed when file missing", () => {
    const dir = makeDir();
    const file = readLists(dir);
    expect(file.lists).toHaveLength(6);
  });

  it("writeLists then readLists yields identical content", async () => {
    const dir = makeDir();
    const seed = defaultLists({ uuid: deterministicUuid("rt") });
    await writeLists(dir, seed);
    const back = readLists(dir);
    expect(back).toEqual(seed);
  });

  it("writeLists rejects an invalid file under the lock", async () => {
    const dir = makeDir();
    const bad = defaultLists();
    bad.lists = bad.lists.filter((l) => l.type !== "review");
    await expect(writeLists(dir, bad)).rejects.toBeInstanceOf(ListsValidationError);
    // File on disk must NOT have been touched.
    expect(existsSync(listsFilePath(dir))).toBe(false);
  });

  it("write is atomic — no .tmp residue on success", async () => {
    const dir = makeDir();
    await writeLists(dir, defaultLists());
    const danxbotDir = resolve(dir, ".danxbot");
    const entries = readFileSync(listsFilePath(dir), "utf-8");
    expect(entries).toContain("lists:");
    // No leftover .tmp files
    const fs = require("node:fs") as typeof import("node:fs");
    const ls = fs.readdirSync(danxbotDir);
    expect(ls.filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("readLists degrades to seed on parse failure", () => {
    const dir = makeDir();
    writeFileSync(listsFilePath(dir), "{not valid yaml: [: : :", "utf-8");
    const file = readLists(dir);
    expect(file.lists).toHaveLength(6);
  });

  it("readLists backfills missing color from the type's seed color (DX-601 migration)", () => {
    // Simulate a pre-DX-601 lists.yaml on disk: shape matches except
    // every entry lacks `color`. Read must NOT throw (preserves
    // existing-repo dispatch flow) and must return entries with the
    // canonical seed color per type.
    const dir = makeDir();
    const legacy = `lists:
  - id: a
    name: Review
    type: review
    order: 1
    is_default_for_type: true
  - id: b
    name: To Do
    type: ready
    order: 2
    is_default_for_type: true
tombstone_ids: []
`;
    writeFileSync(listsFilePath(dir), legacy, "utf-8");
    const file = readLists(dir);
    expect(file.lists.find((l) => l.type === "review")?.color).toBe("#3b82f6");
    expect(file.lists.find((l) => l.type === "ready")?.color).toBe("#22d3ee");
  });
});

describe("ensureListsFile", () => {
  it("seeds when missing", async () => {
    const dir = makeDir();
    await ensureListsFile(dir, { uuid: deterministicUuid("e") });
    expect(existsSync(listsFilePath(dir))).toBe(true);
    const parsed = parseYaml(readFileSync(listsFilePath(dir), "utf-8")) as ListsFile;
    expect(parsed.lists).toHaveLength(6);
  });

  it("does NOT overwrite existing file", async () => {
    const dir = makeDir();
    const original = defaultLists({ uuid: deterministicUuid("first") });
    await writeLists(dir, original);
    await ensureListsFile(dir, { uuid: deterministicUuid("second") });
    const back = readLists(dir);
    expect(back).toEqual(original);
  });
});

describe("getDefaultListForType", () => {
  it("returns the default for the requested type", async () => {
    const dir = makeDir();
    await ensureListsFile(dir, { uuid: deterministicUuid("g") });
    const def = getDefaultListForType(dir, "review");
    expect(def.type).toBe("review");
    expect(def.is_default_for_type).toBe(true);
    expect(def.name).toBe("Review");
  });

  it("throws when the file has no default for the type", async () => {
    const dir = makeDir();
    writeFileSync(
      listsFilePath(dir),
      `lists:\n  - id: only\n    name: Demoted\n    type: review\n    order: 0\n    is_default_for_type: false\ntombstone_ids: []\n`,
      "utf-8",
    );
    expect(() => getDefaultListForType(dir, "review")).toThrowError(
      /No default list for type "review"/,
    );
  });
});

describe("applyCreateList", () => {
  it("appends with auto-assigned order", () => {
    const file = defaultLists({ uuid: deterministicUuid("c") });
    const { file: next } = applyCreateList(
      file,
      { name: "Triage", type: "review" },
      { uuid: deterministicUuid("new") },
    );
    const created = next.lists.find((l) => l.name === "Triage")!;
    expect(created.type).toBe("review");
    // First non-default for an existing-default type stays non-default.
    expect(created.is_default_for_type).toBe(false);
    expect(created.order).toBeGreaterThan(0);
    expect(() => validateLists(next)).not.toThrow();
  });

  it("promotes when is_default_for_type=true is passed", () => {
    const file = defaultLists({ uuid: deterministicUuid("c2") });
    const { file: next } = applyCreateList(
      file,
      { name: "New Default", type: "review", is_default_for_type: true },
      { uuid: deterministicUuid("nd") },
    );
    const reviewLists = next.lists.filter((l) => l.type === "review");
    const defaults = reviewLists.filter((l) => l.is_default_for_type);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe("New Default");
    expect(() => validateLists(next)).not.toThrow();
  });

  it("rejects bad input shape", () => {
    const file = defaultLists();
    expect(() =>
      applyCreateList(file, { name: "", type: "review" }),
    ).toThrowError(ListsValidationError);
    expect(() =>
      applyCreateList(file, { name: "x", type: "nope" as never }),
    ).toThrowError(ListsValidationError);
  });

  it("rejects invalid color on create (DX-601)", () => {
    const file = defaultLists();
    expect(() =>
      applyCreateList(file, { name: "Bad", type: "review", color: "not-hex" }),
    ).toThrowError(/color must be a hex color/);
  });

  it("inherits the default-of-type color when caller omits color (DX-601)", () => {
    const file = defaultLists({ uuid: deterministicUuid("ci") });
    const { created } = applyCreateList(
      file,
      { name: "Second Review", type: "review" },
      { uuid: deterministicUuid("sr") },
    );
    expect(created.color).toBe("#3b82f6"); // review's seeded color
  });

  it("takes caller-supplied color when provided (DX-601)", () => {
    const file = defaultLists();
    const { created } = applyCreateList(file, {
      name: "Custom",
      type: "review",
      color: "#abcdef",
    });
    expect(created.color).toBe("#abcdef");
  });

  it("falls back to neutral gray when type has no existing default-of-type (DX-601)", () => {
    const file: ListsFile = {
      lists: defaultLists({ uuid: deterministicUuid("nf") }).lists.filter(
        (l) => l.type !== "cancelled",
      ),
      tombstone_ids: [],
    };
    const { created } = applyCreateList(
      file,
      { name: "First Cancelled", type: "cancelled" },
      { uuid: deterministicUuid("fc") },
    );
    expect(created.color).toBe("#94a3b8");
  });

  it("rejects negative order on create (DX-601)", () => {
    const file = defaultLists();
    expect(() =>
      applyCreateList(file, { name: "Bad", type: "review", order: -1 }),
    ).toThrowError(/order must be ≥ 0/);
  });
});

describe("applyCreateList — auto-promote first-of-new-type", () => {
  it("promotes the first list created for a previously-empty type", () => {
    // Build a file with NO entries for 'cancelled', then create one.
    const file: ListsFile = {
      lists: defaultLists({ uuid: deterministicUuid("s") }).lists.filter(
        (l) => l.type !== "cancelled",
      ),
      tombstone_ids: [],
    };
    const { created } = applyCreateList(
      file,
      { name: "New Cancelled", type: "cancelled" },
      { uuid: deterministicUuid("new") },
    );
    expect(created.is_default_for_type).toBe(true);
  });
});

describe("applyUpdateList", () => {
  it("renames", () => {
    const file = defaultLists({ uuid: deterministicUuid("u") });
    const target = file.lists.find((l) => l.type === "review")!;
    const next = applyUpdateList(file, target.id, { name: "Triage" });
    expect(next.lists.find((l) => l.id === target.id)!.name).toBe("Triage");
    expect(() => validateLists(next)).not.toThrow();
  });

  it("promotes default + demotes prior default", () => {
    let file = defaultLists({ uuid: deterministicUuid("u2") });
    file = applyCreateList(
      file,
      { name: "Second Review", type: "review" },
      { uuid: deterministicUuid("sr") },
    ).file;
    const second = file.lists.find((l) => l.name === "Second Review")!;
    const next = applyUpdateList(file, second.id, { is_default_for_type: true });
    const reviewLists = next.lists.filter((l) => l.type === "review");
    const defaults = reviewLists.filter((l) => l.is_default_for_type);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe("Second Review");
  });

  it("refuses to demote the only default of a type", () => {
    const file = defaultLists({ uuid: deterministicUuid("u3") });
    const review = file.lists.find((l) => l.type === "review")!;
    expect(() =>
      applyUpdateList(file, review.id, { is_default_for_type: false }),
    ).toThrowError(/Cannot set is_default_for_type=false on the only default/);
  });

  it("rejects unknown id", () => {
    const file = defaultLists();
    expect(() => applyUpdateList(file, "nope", { name: "x" })).toThrowError(
      /No list with id "nope"/,
    );
  });

  it("recolor patches color (DX-601)", () => {
    const file = defaultLists({ uuid: deterministicUuid("ru") });
    const target = file.lists.find((l) => l.type === "review")!;
    const next = applyUpdateList(file, target.id, { color: "#123456" });
    expect(next.lists.find((l) => l.id === target.id)!.color).toBe("#123456");
    expect(() => validateLists(next)).not.toThrow();
  });

  it("rejects invalid color on update (DX-601)", () => {
    const file = defaultLists();
    const target = file.lists[0];
    expect(() =>
      applyUpdateList(file, target.id, { color: "bad-color" }),
    ).toThrowError(/color must be a hex color/);
  });

  it("rejects negative order on update (DX-601)", () => {
    const file = defaultLists();
    const target = file.lists[0];
    expect(() =>
      applyUpdateList(file, target.id, { order: -1 }),
    ).toThrowError(/order must be ≥ 0/);
  });
});

describe("applySwapOrder", () => {
  it("swaps order values between two same-type lists", () => {
    let file = defaultLists({ uuid: deterministicUuid("sw") });
    file = applyCreateList(
      file,
      { name: "Triage", type: "review", order: 5 },
      { uuid: deterministicUuid("triage") },
    ).file;
    const a = file.lists.find((l) => l.type === "review" && l.name === "Review")!;
    const b = file.lists.find((l) => l.name === "Triage")!;
    const aOrig = a.order;
    const bOrig = b.order;
    const next = applySwapOrder(file, a.id, b.id);
    const aNext = next.lists.find((l) => l.id === a.id)!;
    const bNext = next.lists.find((l) => l.id === b.id)!;
    expect(aNext.order).toBe(bOrig);
    expect(bNext.order).toBe(aOrig);
    // Untouched fields preserved.
    expect(aNext.name).toBe(a.name);
    expect(bNext.name).toBe(b.name);
    expect(() => validateLists(next)).not.toThrow();
  });

  it("rejects cross-type swap", () => {
    const file = defaultLists({ uuid: deterministicUuid("sw2") });
    const review = file.lists.find((l) => l.type === "review")!;
    const ready = file.lists.find((l) => l.type === "ready")!;
    expect(() => applySwapOrder(file, review.id, ready.id)).toThrowError(
      /Cross-type swap rejected/,
    );
  });

  it("rejects unknown ids", () => {
    const file = defaultLists({ uuid: deterministicUuid("sw3") });
    const review = file.lists.find((l) => l.type === "review")!;
    expect(() => applySwapOrder(file, review.id, "bogus")).toThrowError(
      /No list with id "bogus"/,
    );
    expect(() => applySwapOrder(file, "nope", review.id)).toThrowError(
      /No list with id "nope"/,
    );
  });

  it("rejects identical ids", () => {
    const file = defaultLists({ uuid: deterministicUuid("sw4") });
    const review = file.lists.find((l) => l.type === "review")!;
    expect(() => applySwapOrder(file, review.id, review.id)).toThrowError(
      /a_id and b_id must differ/,
    );
  });

  it("rejects empty string ids", () => {
    const file = defaultLists({ uuid: deterministicUuid("sw5") });
    expect(() => applySwapOrder(file, "", "x")).toThrowError(ListsValidationError);
  });
});

describe("applyDeleteList", () => {
  it("refuses last-of-type", () => {
    const file = defaultLists({ uuid: deterministicUuid("d") });
    const review = file.lists.find((l) => l.type === "review")!;
    expect(() => applyDeleteList(file, review.id)).toThrowError(
      /Cannot delete "Review" — it is the last list of type "review"/,
    );
  });

  it("removes + records tombstone + returns reassignTo (non-default delete)", () => {
    let file = defaultLists({ uuid: deterministicUuid("d2") });
    file = applyCreateList(
      file,
      { name: "Second Review", type: "review" },
      { uuid: deterministicUuid("sr") },
    ).file;
    const second = file.lists.find((l) => l.name === "Second Review")!;
    const result = applyDeleteList(file, second.id);
    expect(result.deleted.id).toBe(second.id);
    expect(result.reassignTo.name).toBe("Review"); // existing default
    expect(result.file.lists.find((l) => l.id === second.id)).toBeUndefined();
    expect(result.file.tombstone_ids).toContain(second.id);
    expect(() => validateLists(result.file)).not.toThrow();
  });

  it("promotes a sibling to default when deleting the default-of-type", () => {
    let file = defaultLists({ uuid: deterministicUuid("d3") });
    file = applyCreateList(
      file,
      { name: "Second Review", type: "review", order: 99 },
      { uuid: deterministicUuid("sr") },
    ).file;
    const review = file.lists.find(
      (l) => l.type === "review" && l.name === "Review",
    )!;
    const result = applyDeleteList(file, review.id);
    expect(result.reassignTo.name).toBe("Second Review");
    const remainingReview = result.file.lists.filter((l) => l.type === "review");
    expect(remainingReview).toHaveLength(1);
    expect(remainingReview[0].is_default_for_type).toBe(true);
  });
});

describe("ListsValidationError.code (DX-616)", () => {
  it("defaults code to \"shape\" for batched validation errors", () => {
    const file = defaultLists();
    file.lists[0] = { ...file.lists[0], color: "not-a-color" };
    try {
      validateLists(file);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ListsValidationError);
      expect((err as ListsValidationError).code).toBe("shape");
    }
  });

  it("defaults code to \"shape\" for validateCreateInput", () => {
    const file = defaultLists();
    try {
      applyCreateList(file, { name: "", type: "review" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ListsValidationError).code).toBe("shape");
    }
  });

  it("defaults code to \"shape\" for validateUpdateInput (empty patch)", () => {
    const file = defaultLists();
    const target = file.lists[0];
    try {
      applyUpdateList(file, target.id, {});
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ListsValidationError).code).toBe("shape");
    }
  });

  it("stamps \"not_found\" on applyUpdateList unknown id", () => {
    const file = defaultLists();
    try {
      applyUpdateList(file, "nope", { name: "x" });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ListsValidationError).code).toBe("not_found");
    }
  });

  it("stamps \"shape\" on applyUpdateList cannot-demote-only-default", () => {
    const file = defaultLists();
    const review = file.lists.find((l) => l.type === "review")!;
    try {
      applyUpdateList(file, review.id, { is_default_for_type: false });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ListsValidationError).code).toBe("shape");
    }
  });

  it("stamps \"not_found\" on applyDeleteList unknown id", () => {
    const file = defaultLists();
    try {
      applyDeleteList(file, "nope");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ListsValidationError).code).toBe("not_found");
    }
  });

  it("stamps \"last_of_type\" on applyDeleteList last-of-type", () => {
    const file = defaultLists();
    const review = file.lists.find((l) => l.type === "review")!;
    try {
      applyDeleteList(file, review.id);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ListsValidationError).code).toBe("last_of_type");
    }
  });

  it("stamps \"not_found\" on applySwapOrder unknown id", () => {
    const file = defaultLists();
    const review = file.lists.find((l) => l.type === "review")!;
    try {
      applySwapOrder(file, review.id, "bogus");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ListsValidationError).code).toBe("not_found");
    }
  });

  it("stamps \"cross_type\" on applySwapOrder cross-type swap", () => {
    const file = defaultLists();
    const review = file.lists.find((l) => l.type === "review")!;
    const ready = file.lists.find((l) => l.type === "ready")!;
    try {
      applySwapOrder(file, review.id, ready.id);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ListsValidationError).code).toBe("cross_type");
    }
  });

  it("stamps \"shape\" on applySwapOrder empty / identical ids", () => {
    const file = defaultLists();
    const review = file.lists.find((l) => l.type === "review")!;
    try {
      applySwapOrder(file, "", "x");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ListsValidationError).code).toBe("shape");
    }
    try {
      applySwapOrder(file, review.id, review.id);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ListsValidationError).code).toBe("shape");
    }
  });

  it("accepts an explicit code override in constructor", () => {
    const err = new ListsValidationError(["x"], "tombstoned");
    expect(err.code).toBe("tombstoned");
    expect(err.errors).toEqual(["x"]);
  });

  it("httpStatusForListsValidationCode maps every code to its HTTP status", () => {
    expect(httpStatusForListsValidationCode("not_found")).toBe(404);
    expect(httpStatusForListsValidationCode("cross_type")).toBe(409);
    expect(httpStatusForListsValidationCode("last_of_type")).toBe(409);
    expect(httpStatusForListsValidationCode("shape")).toBe(400);
    expect(httpStatusForListsValidationCode("tombstoned")).toBe(400);
  });
});

describe("tombstone enforcement on write", () => {
  it("rejects a re-introduced previously-deleted id", async () => {
    const dir = makeDir();
    let file = defaultLists({ uuid: deterministicUuid("t") });
    file = applyCreateList(
      file,
      { name: "Second Review", type: "review" },
      { uuid: deterministicUuid("sr") },
    ).file;
    const second = file.lists.find((l) => l.name === "Second Review")!;
    const result = applyDeleteList(file, second.id);
    await writeLists(dir, result.file);

    const reintroduced: ListsFile = {
      ...result.file,
      lists: [
        ...result.file.lists,
        {
          id: second.id, // reuse the deleted id
          name: "Sneaky",
          type: "review",
          order: 5,
          is_default_for_type: false,
          color: "#3b82f6",
        },
      ],
    };
    await expect(writeLists(dir, reintroduced)).rejects.toBeInstanceOf(
      ListsValidationError,
    );
  });
});
