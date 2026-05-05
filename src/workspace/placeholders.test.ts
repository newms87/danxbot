import { describe, it, expect } from "vitest";
import {
  substitute,
  validateOverlay,
  buildSubstitutionMap,
  PlaceholderError,
} from "./placeholders.js";
import type { WorkspaceManifest } from "./manifest.js";

function manifest(
  required: string[] = [],
  optional: string[] = [],
): WorkspaceManifest {
  return {
    name: "test",
    description: "test",
    requiredPlaceholders: required,
    optionalPlaceholders: optional,
    requiredGates: [],
    stagingPaths: [],
  };
}

describe("substitute", () => {
  it("replaces a single placeholder", () => {
    const result = substitute("hello ${NAME}", { NAME: "world" });
    expect(result).toBe("hello world");
  });

  it("replaces the same placeholder in multiple positions", () => {
    const result = substitute("${A} and ${A} and ${A}", { A: "x" });
    expect(result).toBe("x and x and x");
  });

  it("replaces multiple distinct placeholders", () => {
    const result = substitute("${A}/${B}", { A: "left", B: "right" });
    expect(result).toBe("left/right");
  });

  it("passes through text with no placeholders untouched", () => {
    expect(substitute("no placeholders here", {})).toBe("no placeholders here");
  });

  it("throws PlaceholderError on unknown placeholder", () => {
    expect(() => substitute("hello ${UNKNOWN}", { OTHER: "x" })).toThrow(
      PlaceholderError,
    );
    expect(() => substitute("hello ${UNKNOWN}", { OTHER: "x" })).toThrow(
      /UNKNOWN/,
    );
  });

  it("substitutes empty-string overlay values", () => {
    expect(substitute("before[${X}]after", { X: "" })).toBe("before[]after");
  });

  it("does not recurse into substituted values", () => {
    expect(substitute("${A}", { A: "${B}", B: "should-not-appear" })).toBe(
      "${B}",
    );
  });

  it("ignores malformed placeholder syntax", () => {
    expect(substitute("$NAME and ${NAME", { NAME: "x" })).toBe(
      "$NAME and ${NAME",
    );
  });

  it("does not treat ${1FOO} as a placeholder (key must start with letter or underscore)", () => {
    expect(substitute("${1FOO}", {})).toBe("${1FOO}");
  });

  it("includes known overlay keys in the unknown-placeholder error message", () => {
    expect(() => substitute("${MISSING}", { A: "1", B: "2" })).toThrow(/A, B/);
  });

  it("reports '(none)' when overlay is empty and a placeholder is unknown", () => {
    expect(() => substitute("${X}", {})).toThrow(/\(none\)/);
  });
});

describe("validateOverlay", () => {
  it("passes when all required placeholders are present", () => {
    expect(() =>
      validateOverlay(manifest(["A", "B"]), { A: "1", B: "2" }),
    ).not.toThrow();
  });

  it("throws PlaceholderError when a required placeholder is missing", () => {
    expect(() => validateOverlay(manifest(["A", "B"]), { A: "1" })).toThrow(
      PlaceholderError,
    );
    expect(() => validateOverlay(manifest(["A", "B"]), { A: "1" })).toThrow(
      /B/,
    );
  });

  it("includes workspace name in error message", () => {
    expect(() => validateOverlay(manifest(["MISSING"]), {})).toThrow(/test/);
  });

  it("allows extra overlay keys that are not declared in the manifest", () => {
    expect(() =>
      validateOverlay(manifest(["A"], []), { A: "1", EXTRA: "2" }),
    ).not.toThrow();
  });

  it("allows missing optional placeholders", () => {
    expect(() => validateOverlay(manifest([], ["OPTIONAL"]), {})).not.toThrow();
  });

  it("throws for an empty-string value on a required placeholder", () => {
    expect(() => validateOverlay(manifest(["A"]), { A: "" })).toThrow(
      PlaceholderError,
    );
  });

  it("throws when a required placeholder has a non-string value", () => {
    expect(() =>
      // Simulate a caller that bypassed the typed surface (e.g. JSON
      // deserialization dropping through `any`) — the runtime guard
      // must still flag it loud.
      validateOverlay(manifest(["A"]), { A: 42 as unknown as string }),
    ).toThrow(PlaceholderError);
  });
});

describe("buildSubstitutionMap", () => {
  it("returns a fresh object that aliases none of the overlay's identity", () => {
    const overlay = { A: "1" };
    const result = buildSubstitutionMap(manifest(["A"]), overlay);
    expect(result).not.toBe(overlay);
  });

  it("pre-fills absent optional placeholders with empty string", () => {
    const m = manifest([], ["OPT"]);
    const subs = buildSubstitutionMap(m, {});
    expect(subs.OPT).toBe("");
  });

  it("does not overwrite a present optional placeholder", () => {
    const m = manifest([], ["OPT"]);
    const subs = buildSubstitutionMap(m, { OPT: "explicit" });
    expect(subs.OPT).toBe("explicit");
  });

  it("carries required-placeholder values forward without modification", () => {
    const m = manifest(["A"], ["OPT"]);
    const subs = buildSubstitutionMap(m, { A: "1" });
    expect(subs.A).toBe("1");
    expect(subs.OPT).toBe("");
  });

  it("carries extra overlay keys forward untouched", () => {
    const m = manifest(["A"]);
    const subs = buildSubstitutionMap(m, { A: "1", EXTRA: "2" });
    expect(subs.EXTRA).toBe("2");
  });
});
