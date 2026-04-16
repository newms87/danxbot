import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildCleanEnv } from "./process-utils.js";

describe("buildCleanEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      CLAUDECODE_SESSION: "abc123",
      CLAUDECODE_MODE: "piped",
      CUSTOM_VAR: "hello",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("strips CLAUDECODE vars from process.env", () => {
    const result = buildCleanEnv();
    expect(result).not.toHaveProperty("CLAUDECODE_SESSION");
    expect(result).not.toHaveProperty("CLAUDECODE_MODE");
  });

  it("preserves non-CLAUDECODE vars", () => {
    const result = buildCleanEnv();
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/home/user");
    expect(result.CUSTOM_VAR).toBe("hello");
  });

  it("merges extra vars on top", () => {
    const result = buildCleanEnv({ EXTRA: "value", PATH: "/override" });
    expect(result.EXTRA).toBe("value");
    expect(result.PATH).toBe("/override");
  });

  it("returns env without CLAUDECODE vars when no extras provided", () => {
    const result = buildCleanEnv();
    const keys = Object.keys(result);
    expect(keys).not.toContain("CLAUDECODE_SESSION");
    expect(keys).toContain("PATH");
  });
});
