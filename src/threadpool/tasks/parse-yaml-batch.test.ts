import { describe, it, expect } from "vitest";
import parseYamlBatchTask from "./parse-yaml-batch.mjs";

describe("parse-yaml-batch task", () => {
  it("parses every YAML in the batch", () => {
    const texts = [
      "id: DX-1\ntitle: One",
      "id: DX-2\ntitle: Two\nac:\n  - title: foo\n    checked: false",
      "name: simple",
    ];
    const out = parseYamlBatchTask({ texts });
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ ok: true, data: { id: "DX-1", title: "One" } });
    expect(out[1]).toEqual({
      ok: true,
      data: { id: "DX-2", title: "Two", ac: [{ title: "foo", checked: false }] },
    });
    expect(out[2]).toEqual({ ok: true, data: { name: "simple" } });
  });

  it("reports per-entry parse errors without aborting the batch", () => {
    const texts = ["id: DX-1\ntitle: OK", "this: is: not: yaml:\n  - [a, b"];
    const out = parseYamlBatchTask({ texts });
    expect(out[0].ok).toBe(true);
    expect(out[1].ok).toBe(false);
    if (out[1].ok === false) {
      expect(out[1].error).toMatch(/./); // non-empty error
    }
  });

  it("returns an empty array for an empty batch", () => {
    expect(parseYamlBatchTask({ texts: [] })).toEqual([]);
  });

  it("handles a 100-text batch (boot-scan scale)", () => {
    const texts = Array.from(
      { length: 100 },
      (_, i) => `id: DX-${i}\ntitle: T${i}\nschema_version: 10\n`,
    );
    const out = parseYamlBatchTask({ texts });
    expect(out).toHaveLength(100);
    expect(out.every((e: { ok: boolean }) => e.ok)).toBe(true);
  });
});
