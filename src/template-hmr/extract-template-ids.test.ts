import { describe, it, expect } from "vitest";
import { extractTemplateIds } from "./extract-template-ids.js";

describe("extractTemplateIds", () => {
  it("returns empty for paths with no template/source segment", () => {
    expect(
      extractTemplateIds([
        "/tmp/schemas/123/schema.json",
        "/tmp/schemas/123/annotations/notes.json",
        "/tmp/schemas/123/templates/45.json",
      ]),
    ).toEqual([]);
  });

  it("extracts one entry per template referenced in source paths", () => {
    const paths = [
      "/tmp/schemas/123/templates/45/source/App.vue",
      "/tmp/schemas/123/templates/45/source/main.ts",
      "/tmp/schemas/123/templates/45/source/style.css",
      "/tmp/schemas/123/templates/45/source/package.json",
      "/tmp/schemas/123/templates/45/source/sample_data.json",
    ];
    expect(extractTemplateIds(paths)).toEqual([
      {
        templateId: "45",
        sourceDir: "/tmp/schemas/123/templates/45/source",
      },
    ]);
  });

  it("emits separate entries per distinct templateId, stable-sorted", () => {
    const paths = [
      "/tmp/schemas/9/templates/22/source/App.vue",
      "/tmp/schemas/9/templates/3/source/App.vue",
      "/tmp/schemas/9/templates/22/source/main.ts",
      "/tmp/schemas/9/templates/100/source/App.vue",
    ];
    const out = extractTemplateIds(paths);
    expect(out.map((t) => t.templateId)).toEqual(["3", "22", "100"]);
    expect(out.find((t) => t.templateId === "22")?.sourceDir).toBe(
      "/tmp/schemas/9/templates/22/source",
    );
  });

  it("ignores metadata template files that are NOT under /source/", () => {
    const paths = [
      // Metadata file — must NOT trigger HMR (no source).
      "/tmp/schemas/123/templates/45.json",
      // Sibling sample-data path (pre-SG-187 location) — also NOT under /source/.
      "/tmp/schemas/123/templates/sample-data-45.json",
    ];
    expect(extractTemplateIds(paths)).toEqual([]);
  });

  it("does NOT match a path that ends mid-segment (e.g. /sources/)", () => {
    // Guard against future foot-gun: /templates/45/sources/ (plural typo)
    // should NOT match.
    expect(
      extractTemplateIds([
        "/tmp/schemas/9/templates/45/sources/App.vue",
        "/tmp/schemas/9/templates/45-something/source/App.vue",
      ]),
    ).toEqual([]);
  });

  it("tolerates a path that is exactly the source dir (no trailing file)", () => {
    expect(
      extractTemplateIds(["/tmp/schemas/9/templates/45/source"]),
    ).toEqual([
      {
        templateId: "45",
        sourceDir: "/tmp/schemas/9/templates/45/source",
      },
    ]);
  });
});
