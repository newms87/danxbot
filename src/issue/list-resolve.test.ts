/**
 * DX-584 — Tests for `src/issue/list-resolve.ts`.
 *
 * Covers the pure semantic-status → list-type mapping AND the
 * lists.yaml-backed name lookup (via `ensureListsFile` seeded with
 * the canonical 7-list defaults).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveListTypeFromSemanticStatus,
  resolveListNameForType,
} from "./list-resolve.js";
import { _resetForTesting, ensureListsFile } from "../lists-file.js";

describe("deriveListTypeFromSemanticStatus", () => {
  it.each([
    ["Backlog", "archived"],
    ["Review", "review"],
    ["ToDo", "ready"],
    ["In Progress", "in_progress"],
    ["Done", "completed"],
    ["Cancelled", "cancelled"],
  ] as const)("maps semantic %s → list type %s", (status, type) => {
    expect(deriveListTypeFromSemanticStatus(status)).toBe(type);
  });
});

describe("resolveListNameForType (seeded lists.yaml)", () => {
  let dir: string;

  beforeEach(async () => {
    _resetForTesting();
    dir = mkdtempSync(join(tmpdir(), "list-resolve-"));
    await ensureListsFile(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ["archived", "Backlog"],
    ["review", "Review"],
    ["ready", "To Do"],
    ["in_progress", "In Progress"],
    ["completed", "Done"],
    ["cancelled", "Cancelled"],
  ] as const)("returns canonical seed name for type %s", (type, name) => {
    expect(resolveListNameForType(dir, type)).toBe(name);
  });
});
