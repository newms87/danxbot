/**
 * Unit tests for the pure helpers exported by `issues-reader.ts`. The
 * full reader (DB-backed) is exercised by `src/__tests__/integration/`
 * coverage; this file isolates the small helpers that are easy to
 * unit-test without spinning up Postgres.
 */

import { describe, it, expect } from "vitest";
import { deriveCreatedAt } from "./issue-created-at.js";

describe("deriveCreatedAt", () => {
  it("parses a Trello-style ObjectId external_id (first 8 hex chars = unix seconds)", () => {
    // 0x64f1a2b3 = 1693568691 = 2023-09-01T11:44:51Z
    const id = "64f1a2b3c4d5e6f789012345";
    const expected = Number.parseInt("64f1a2b3", 16) * 1000;
    expect(deriveCreatedAt(id, 0)).toBe(expected);
  });

  it("uppercases hex still parse (case-insensitive ObjectId regex)", () => {
    const id = "64F1A2B3C4D5E6F789012345";
    const expected = Number.parseInt("64f1a2b3", 16) * 1000;
    expect(deriveCreatedAt(id, 0)).toBe(expected);
  });

  it("falls back to mirrorUpdatedAtMs when external_id is empty", () => {
    expect(deriveCreatedAt("", 1700000000000)).toBe(1700000000000);
  });

  it("falls back to mirrorUpdatedAtMs for malformed ids (wrong length)", () => {
    expect(deriveCreatedAt("not-an-objectid", 1700000000000)).toBe(
      1700000000000,
    );
    expect(deriveCreatedAt("64f1a2b3", 999)).toBe(999); // too short
    expect(deriveCreatedAt("64f1a2b3c4d5e6f7890123456", 999)).toBe(999); // too long
  });

  it("falls back when the parsed timestamp is non-positive (defense-in-depth)", () => {
    // 24 zeros parses to 0 seconds — a real card couldn't have this id,
    // but the fallback path makes the helper robust to a bogus value
    // landing in the column.
    expect(deriveCreatedAt("000000000000000000000000", 1700000000000)).toBe(
      1700000000000,
    );
  });
});
