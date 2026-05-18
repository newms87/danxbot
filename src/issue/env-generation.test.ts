import { afterEach, describe, expect, it } from "vitest";
import {
  bumpEnvGen,
  getEnvGen,
  graphFieldsChanged,
  _resetEnvGen,
} from "./env-generation.js";

afterEach(() => {
  _resetEnvGen();
});

describe("env-generation", () => {
  it("cold read returns 0", () => {
    expect(getEnvGen("repo-a")).toBe(0);
  });

  it("bump advances the counter and returns the new value", () => {
    expect(bumpEnvGen("repo-a", "lists-write")).toBe(1);
    expect(bumpEnvGen("repo-a", "agents-write")).toBe(2);
    expect(getEnvGen("repo-a")).toBe(2);
  });

  it("counters are per-repo (bump in A does not move B)", () => {
    bumpEnvGen("repo-a", "lists-write");
    bumpEnvGen("repo-a", "lists-write");
    bumpEnvGen("repo-b", "lists-write");
    expect(getEnvGen("repo-a")).toBe(2);
    expect(getEnvGen("repo-b")).toBe(1);
  });

  it("_resetEnvGen drops every per-repo counter back to 0", () => {
    bumpEnvGen("repo-a", "x");
    bumpEnvGen("repo-b", "y");
    _resetEnvGen();
    expect(getEnvGen("repo-a")).toBe(0);
    expect(getEnvGen("repo-b")).toBe(0);
  });
});

describe("graphFieldsChanged", () => {
  it("treats prev === null (brand-new card) as a graph mutation", () => {
    expect(graphFieldsChanged(null, { parent_id: null, children: [] })).toBe(
      true,
    );
  });

  it("returns true when parent_id flips", () => {
    expect(
      graphFieldsChanged(
        { parent_id: null, children: [] },
        { parent_id: "DX-1", children: [] },
      ),
    ).toBe(true);
    expect(
      graphFieldsChanged(
        { parent_id: "DX-1", children: [] },
        { parent_id: null, children: [] },
      ),
    ).toBe(true);
    expect(
      graphFieldsChanged(
        { parent_id: "DX-1", children: [] },
        { parent_id: "DX-2", children: [] },
      ),
    ).toBe(true);
  });

  it("returns true when children[] mutates", () => {
    expect(
      graphFieldsChanged(
        { parent_id: null, children: [] },
        { parent_id: null, children: ["DX-1"] },
      ),
    ).toBe(true);
    expect(
      graphFieldsChanged(
        { parent_id: null, children: ["DX-1", "DX-2"] },
        { parent_id: null, children: ["DX-2", "DX-1"] },
      ),
    ).toBe(true);
  });

  it("returns false on byte-stable rewrites (no graph movement)", () => {
    const prev = {
      parent_id: "DX-1",
      children: ["DX-2", "DX-3"],
      status: "ToDo",
      title: "before",
    };
    const next = {
      parent_id: "DX-1",
      children: ["DX-2", "DX-3"],
      status: "ToDo",
      title: "after — title changed but graph unchanged",
    };
    expect(graphFieldsChanged(prev, next)).toBe(false);
  });

  it("returns false when both sides have missing/non-array children", () => {
    expect(
      graphFieldsChanged(
        { parent_id: null },
        { parent_id: null, children: [] },
      ),
    ).toBe(false);
  });
});
