import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PluginPathError,
  parsePluginSkill,
  resolvePluginSkillPaths,
} from "./plugin-paths.js";

describe("parsePluginSkill", () => {
  it("splits a well-formed plugin:skill spec", () => {
    expect(parsePluginSkill("dev:debugging")).toEqual({
      plugin: "dev",
      skill: "debugging",
    });
  });

  it("splits on the FIRST colon only (multi-colon skills allowed)", () => {
    expect(parsePluginSkill("danxbot:foo:bar")).toEqual({
      plugin: "danxbot",
      skill: "foo:bar",
    });
  });

  it("rejects an empty string", () => {
    expect(() => parsePluginSkill("")).toThrow(PluginPathError);
  });

  it("rejects a spec with no colon", () => {
    expect(() => parsePluginSkill("dev-debugging")).toThrow(/colon/);
  });

  it("rejects a spec with empty plugin segment", () => {
    expect(() => parsePluginSkill(":debugging")).toThrow(/plugin/);
  });

  it("rejects a spec with empty skill segment", () => {
    expect(() => parsePluginSkill("dev:")).toThrow(/skill/);
  });

  it("rejects a spec with path-traversal segments in plugin", () => {
    expect(() => parsePluginSkill("../foo:bar")).toThrow(/invalid/);
    expect(() => parsePluginSkill("..:bar")).toThrow(/invalid/);
  });

  it("rejects a spec with path-traversal segments in skill", () => {
    expect(() => parsePluginSkill("dev:../escape")).toThrow(/invalid/);
    expect(() => parsePluginSkill("dev:..")).toThrow(/invalid/);
  });

  it("rejects a spec with leading/trailing whitespace", () => {
    expect(() => parsePluginSkill(" dev:debugging")).toThrow();
    expect(() => parsePluginSkill("dev:debugging ")).toThrow();
  });
});

describe("resolvePluginSkillPaths", () => {
  let sourceRoot: string;
  let cacheRoot: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "plugin-paths-"));
    sourceRoot = join(base, "src");
    cacheRoot = join(base, "cache");
    mkdirSync(join(sourceRoot, "dev", "skills", "debugging"), {
      recursive: true,
    });
    writeFileSync(
      join(sourceRoot, "dev", "skills", "debugging", "SKILL.md"),
      "---\nname: debugging\ndescription: 'd'\n---\nbody",
    );
    mkdirSync(join(cacheRoot, "dev", "skills", "debugging"), {
      recursive: true,
    });
    writeFileSync(
      join(cacheRoot, "dev", "skills", "debugging", "SKILL.md"),
      "---\nname: debugging\ndescription: 'd'\n---\nbody",
    );
  });

  afterEach(() => {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("resolves source + cache SKILL.md paths", () => {
    const r = resolvePluginSkillPaths({
      pluginSkill: "dev:debugging",
      sourceRoot,
      cacheRoot,
    });
    expect(r.sourceSkillPath).toBe(
      join(sourceRoot, "dev", "skills", "debugging", "SKILL.md"),
    );
    expect(r.cacheSkillPath).toBe(
      join(cacheRoot, "dev", "skills", "debugging", "SKILL.md"),
    );
    expect(r.plugin).toBe("dev");
    expect(r.skill).toBe("debugging");
  });

  it("throws when the source SKILL.md does not exist", () => {
    expect(() =>
      resolvePluginSkillPaths({
        pluginSkill: "dev:nonexistent",
        sourceRoot,
        cacheRoot,
      }),
    ).toThrow(/source/);
  });

  it("throws when the cache SKILL.md does not exist", () => {
    rmSync(join(cacheRoot, "dev", "skills", "debugging"), {
      recursive: true,
      force: true,
    });
    expect(() =>
      resolvePluginSkillPaths({
        pluginSkill: "dev:debugging",
        sourceRoot,
        cacheRoot,
      }),
    ).toThrow(/cache/);
  });

  it("propagates parse errors with the original category", () => {
    expect(() =>
      resolvePluginSkillPaths({
        pluginSkill: "no-colon-here",
        sourceRoot,
        cacheRoot,
      }),
    ).toThrow(PluginPathError);
  });
});
