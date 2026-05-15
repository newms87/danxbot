import { describe, it, expect } from "vitest";
import { canonicalize, hashCanonical, sha256 } from "./canonicalize.js";
import { createEmptyIssue } from "../issue-tracker/yaml.js";

describe("canonicalize", () => {
  it("sorts top-level keys alphabetically", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts nested object keys recursively", () => {
    expect(canonicalize({ outer: { z: 1, a: 2 } })).toBe(
      '{"outer":{"a":2,"z":1}}',
    );
  });

  it("preserves array order (arrays are positional)", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("canonicalizes objects nested inside arrays", () => {
    expect(canonicalize([{ b: 2, a: 1 }, { d: 4, c: 3 }])).toBe(
      '[{"a":1,"b":2},{"c":3,"d":4}]',
    );
  });

  it("treats undefined as null (canonicalize is JSON-shaped)", () => {
    expect(canonicalize({ a: undefined })).toBe('{"a":null}');
  });

  it("two semantically-equal objects with reordered keys produce the same bytes", () => {
    const a = { x: 1, y: { p: 1, q: 2 }, z: [1, 2] };
    const b = { z: [1, 2], y: { q: 2, p: 1 }, x: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("differing values produce differing bytes", () => {
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }));
  });
});

describe("sha256", () => {
  it("produces a 64-char hex digest", () => {
    expect(sha256("hello").length).toBe(64);
    expect(sha256("hello")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(sha256("danxbot")).toBe(sha256("danxbot"));
  });

  it("is sensitive to input changes", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });
});

describe("hashCanonical", () => {
  it("produces the same hash for semantically-equal inputs with reordered keys", () => {
    const a = { foo: "bar", baz: 42 };
    const b = { baz: 42, foo: "bar" };
    expect(hashCanonical(a)).toBe(hashCanonical(b));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical({ a: 2 }));
  });

  // DX-547 Phase 2 — `db_updated_at` is EXCLUDED from the canonical
  // hash at the top level (see HASH_EXCLUDED_TOP_KEYS in
  // `src/db/canonicalize.ts`). The writer stamps `db_updated_at` on
  // every save; including it in the hash would defeat the canonical
  // no-op short-circuit in `upsertIssueRowNow` (every re-save of
  // identical content would produce a new history row because the
  // timestamp changed). Excluding lets the spec's
  // `existing.content_hash === contentHash` check fire correctly on
  // back-to-back identical saves.
  //
  // (The Phase 1 test in this file previously pinned the OPPOSITE
  // behavior; that pin was inverted in Phase 2 because Phase 1's
  // rationale — "Phase 2 needs db_updated_at hashed so the mirror can
  // detect timestamp-only saves" — turned out to be backwards. Phase 2
  // explicitly does NOT want timestamp-only saves to appear as content
  // changes.)
  it("db_updated_at is EXCLUDED from the top-level canonical hash", () => {
    const base = createEmptyIssue({ id: "DX-1", title: "t" });
    const a = { ...base, db_updated_at: "2026-01-01T00:00:00.000Z" };
    const b = { ...base, db_updated_at: "2026-06-01T00:00:00.000Z" };
    expect(canonicalize(a)).not.toContain("db_updated_at");
    expect(hashCanonical(a)).toBe(hashCanonical(b));
  });

  it("a nested `db_updated_at` field is NOT excluded (top-level filter only)", () => {
    // Defends against an over-broad refactor that filters the key at
    // every depth — only the top-level Issue.db_updated_at is the
    // writer-bumped sentinel; any nested object that happens to use
    // the same key (extremely unlikely but possible) MUST keep its
    // hash contribution.
    const a = { nested: { db_updated_at: "2026-01-01T00:00:00.000Z" } };
    const b = { nested: { db_updated_at: "2026-06-01T00:00:00.000Z" } };
    expect(hashCanonical(a)).not.toBe(hashCanonical(b));
  });
});
