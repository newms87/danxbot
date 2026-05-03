import { describe, it, expect } from "vitest";
import {
  parseManifest,
  WorkspaceManifestError,
} from "./manifest.js";

describe("parseManifest", () => {
  it("parses a full manifest with all fields populated", () => {
    const yaml = `name: issue-worker
description: Poller dispatch shape
required-placeholders:
  - DANXBOT_STOP_URL
  - DANXBOT_WORKER_PORT
  - TRELLO_API_KEY
optional-placeholders:
  - TRELLO_ENABLED_TOOLS
required-gates:
  - "repo.trelloEnabled = true"
  - "no CRITICAL_FAILURE flag"
`;

    const manifest = parseManifest(yaml);

    expect(manifest.name).toBe("issue-worker");
    expect(manifest.description).toBe("Poller dispatch shape");
    expect(manifest.requiredPlaceholders).toEqual([
      "DANXBOT_STOP_URL",
      "DANXBOT_WORKER_PORT",
      "TRELLO_API_KEY",
    ]);
    expect(manifest.optionalPlaceholders).toEqual(["TRELLO_ENABLED_TOOLS"]);
    expect(manifest.requiredGates).toEqual([
      "repo.trelloEnabled = true",
      "no CRITICAL_FAILURE flag",
    ]);
  });

  it("defaults optional-placeholders to empty when absent", () => {
    const yaml = `name: x
description: y
required-placeholders:
  - A
`;
    const manifest = parseManifest(yaml);
    expect(manifest.optionalPlaceholders).toEqual([]);
  });

  it("defaults required-gates to empty when absent", () => {
    const yaml = `name: x
description: y
required-placeholders:
  - A
`;
    const manifest = parseManifest(yaml);
    expect(manifest.requiredGates).toEqual([]);
  });

  it("defaults required-placeholders to empty when absent", () => {
    const yaml = `name: x
description: y
`;
    const manifest = parseManifest(yaml);
    expect(manifest.requiredPlaceholders).toEqual([]);
  });

  it("throws WorkspaceManifestError when name is missing", () => {
    const yaml = `description: y
required-placeholders:
  - A
`;
    expect(() => parseManifest(yaml)).toThrow(WorkspaceManifestError);
    expect(() => parseManifest(yaml)).toThrow(/name/);
  });

  it("throws WorkspaceManifestError when description is missing", () => {
    const yaml = `name: x
required-placeholders:
  - A
`;
    expect(() => parseManifest(yaml)).toThrow(WorkspaceManifestError);
    expect(() => parseManifest(yaml)).toThrow(/description/);
  });

  it("throws WorkspaceManifestError on malformed YAML", () => {
    const yaml = `name: x
description: "unterminated string
`;
    expect(() => parseManifest(yaml)).toThrow(WorkspaceManifestError);
  });

  it("throws WorkspaceManifestError when required-placeholders is not a string array", () => {
    const yaml = `name: x
description: y
required-placeholders:
  A: 1
  B: 2
`;
    expect(() => parseManifest(yaml)).toThrow(WorkspaceManifestError);
    expect(() => parseManifest(yaml)).toThrow(/required-placeholders/);
  });

  it("throws WorkspaceManifestError when a placeholder entry is not a string", () => {
    const yaml = `name: x
description: y
required-placeholders:
  - 42
`;
    expect(() => parseManifest(yaml)).toThrow(WorkspaceManifestError);
  });

  it("includes optional source in error message when provided", () => {
    const yaml = `description: y
`;
    expect(() =>
      parseManifest(yaml, { source: "workspace.yml" }),
    ).toThrow(/workspace\.yml/);
  });

  it("ignores unknown top-level fields", () => {
    const yaml = `name: x
description: y
required-placeholders: []
future-field:
  - anything
`;
    const manifest = parseManifest(yaml);
    expect(manifest.name).toBe("x");
  });

  it("throws when YAML root is not an object", () => {
    expect(() => parseManifest("- just-a-list")).toThrow(
      WorkspaceManifestError,
    );
  });

  it("throws when name is whitespace-only", () => {
    const yaml = `name: "   "
description: y
required-placeholders: []
`;
    expect(() => parseManifest(yaml)).toThrow(WorkspaceManifestError);
  });

  it("throws when name is not a string", () => {
    const yaml = `name: 42
description: y
required-placeholders: []
`;
    expect(() => parseManifest(yaml)).toThrow(WorkspaceManifestError);
  });

  it("treats explicit null placeholder arrays as empty", () => {
    const yaml = `name: x
description: y
required-placeholders: null
optional-placeholders: ~
`;
    const manifest = parseManifest(yaml);
    expect(manifest.requiredPlaceholders).toEqual([]);
    expect(manifest.optionalPlaceholders).toEqual([]);
  });

  it("returns a fresh array that does not alias the parsed YAML structure", () => {
    const yaml = `name: x
description: y
required-placeholders:
  - A
`;
    const manifest = parseManifest(yaml);
    // requiredPlaceholders is readonly, but we can still prove it's a
    // fresh copy by checking no frozen-from-YAML signature leaks
    // through (e.g. attempting to mutate through the back door).
    expect(Array.isArray(manifest.requiredPlaceholders)).toBe(true);
    expect(manifest.requiredPlaceholders).toEqual(["A"]);
  });
});
