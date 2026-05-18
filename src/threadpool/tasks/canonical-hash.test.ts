import { describe, it, expect } from "vitest";
import canonicalHashTask from "./canonical-hash.mjs";
import { canonicalize, sha256 } from "../../db/canonicalize.js";

describe("canonical-hash task", () => {
  it("returns the same canonical bytes + hash as the sync helper", () => {
    const issue = {
      schema_version: 10,
      id: "DX-1",
      title: "Test",
      description: "body",
      ac: [{ check_item_id: "", title: "do thing", checked: false }],
      nested: { z: 1, a: 2, m: { y: "y", x: "x" } },
    };
    const out = canonicalHashTask({ value: issue });
    expect(out.canonical).toBe(canonicalize(issue));
    expect(out.hash).toBe(sha256(canonicalize(issue)));
  });

  it("excludes db_updated_at from the hash (write-time stamp)", () => {
    const baseline = { id: "DX-1", title: "T" };
    const stamped = { id: "DX-1", title: "T", db_updated_at: "2026-05-18T00:00:00Z" };
    expect(canonicalHashTask({ value: baseline }).hash).toBe(
      canonicalHashTask({ value: stamped }).hash,
    );
  });

  it("sorts object keys recursively so reorderings produce identical bytes", () => {
    const a = { b: 1, a: { z: 1, y: 2 } };
    const b = { a: { y: 2, z: 1 }, b: 1 };
    expect(canonicalHashTask({ value: a }).canonical).toBe(
      canonicalHashTask({ value: b }).canonical,
    );
  });

  it("preserves array order (canonical only sorts keys, not entries)", () => {
    const out = canonicalHashTask({ value: { list: [3, 1, 2] } });
    expect(out.canonical).toBe(`{"list":[3,1,2]}`);
  });

  it("handles null + undefined + primitives without throwing", () => {
    expect(canonicalHashTask({ value: null }).canonical).toBe("null");
    expect(canonicalHashTask({ value: 0 }).canonical).toBe("0");
    expect(canonicalHashTask({ value: "x" }).canonical).toBe('"x"');
  });
});
