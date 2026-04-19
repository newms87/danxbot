import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getReposBase } from "./constants.js";

describe("getReposBase", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.DANXBOT_REPOS_BASE;
    delete process.env.DANXBOT_REPOS_BASE;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DANXBOT_REPOS_BASE;
    } else {
      process.env.DANXBOT_REPOS_BASE = originalEnv;
    }
  });

  it("falls back to project-relative repos/ when DANXBOT_REPOS_BASE is not set", () => {
    const result = getReposBase();
    expect(result).toMatch(/\/repos$/);
    expect(result).not.toBe("");
  });

  it("returns DANXBOT_REPOS_BASE override when set", () => {
    process.env.DANXBOT_REPOS_BASE = "/danxbot/repos";
    expect(getReposBase()).toBe("/danxbot/repos");
  });

  it("trims whitespace from DANXBOT_REPOS_BASE", () => {
    process.env.DANXBOT_REPOS_BASE = "  /danxbot/repos  ";
    expect(getReposBase()).toBe("/danxbot/repos");
  });

  it("ignores empty DANXBOT_REPOS_BASE and uses project-relative path", () => {
    process.env.DANXBOT_REPOS_BASE = "";
    const result = getReposBase();
    expect(result).toMatch(/\/repos$/);
  });

  it("ignores whitespace-only DANXBOT_REPOS_BASE and uses project-relative path", () => {
    process.env.DANXBOT_REPOS_BASE = "   ";
    const result = getReposBase();
    expect(result).toMatch(/\/repos$/);
  });
});
