import { describe, it, expect } from "vitest";
import jsonStringifyTask from "./json-stringify.mjs";

describe("json-stringify task", () => {
  it("matches JSON.stringify byte-for-byte on plain objects", () => {
    const value = {
      a: 1,
      b: [1, 2, { c: "x" }],
      d: null,
      e: false,
    };
    expect(jsonStringifyTask({ value })).toBe(JSON.stringify(value));
  });

  it("handles a large nested payload representative of audit-error details", () => {
    const payload = {
      issue_id: "DX-99",
      patch: Array.from({ length: 200 }, (_, i) => ({
        op: "replace",
        path: `/comments/${i}/text`,
        value: `c${i}`.repeat(50),
      })),
      errors: Array.from({ length: 20 }, (_, i) => ({
        step: `step-${i}`,
        message: `msg-${i}`,
        fatal: i % 2 === 0,
      })),
    };
    const out = jsonStringifyTask({ value: payload });
    expect(out).toBe(JSON.stringify(payload));
    expect(out.length).toBeGreaterThan(5000);
  });

  it("propagates JSON.stringify circular-ref error (no silent fallback)", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => jsonStringifyTask({ value: cyclic })).toThrow(/circular/i);
  });

  it("throws fail-loud on undefined (pg jsonb rejects undefined; defense in depth)", () => {
    expect(() => jsonStringifyTask({ value: undefined })).toThrow(
      /value must be defined/,
    );
  });

  it("byte-identical to JSON.stringify on a representative SystemErrorSamplePayload (drift guard)", () => {
    // Future edits to `json-stringify.mjs` (sorted keys, BigInt handling,
    // custom replacer) would silently diverge from the sync JSON.stringify
    // that pre-DX-635 production used. The recordError caller stores the
    // result in pg jsonb — divergence corrupts the row. Pin parity.
    const samplePayload = {
      raw_msg: "Audit reconcile rewrote DX-99 — drift detected",
      stack:
        "Error: ...\n  at reconcileIssue (src/issue/reconcile.ts:540:5)\n  at audit (src/cron/audit-pass.ts:116)",
      path: ".danxbot/issues/open/DX-99.yml",
      issue_id: "DX-99",
      patch: [
        { op: "replace", path: "/comments/0/text", value: "x".repeat(2000) },
        { op: "add", path: "/comments/1", value: { author: "x", text: "y" } },
      ],
    };
    expect(jsonStringifyTask({ value: samplePayload })).toBe(
      JSON.stringify(samplePayload),
    );
  });
});
