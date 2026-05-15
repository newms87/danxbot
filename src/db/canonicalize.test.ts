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

  // DX-546 — `db_updated_at` participates in the canonical hash via the
  // generic object walk. Pinning the behavior so a future allowlist
  // refactor cannot accidentally exclude it. Phase 2 of the DB-mirror
  // sync relies on the field being hashed so the mirror can detect that
  // a save changed only the DB timestamp; an exclusion would mask
  // legitimate first-mirror-after-upgrade upserts.
  it("db_updated_at participates in Issue hash — differing values diverge", () => {
    const base = createEmptyIssue({ id: "DX-1", title: "t" });
    const a = { ...base, db_updated_at: "2026-01-01T00:00:00.000Z" };
    const b = { ...base, db_updated_at: "2026-06-01T00:00:00.000Z" };
    expect(canonicalize(a)).toContain("db_updated_at");
    expect(hashCanonical(a)).not.toBe(hashCanonical(b));
  });
});
