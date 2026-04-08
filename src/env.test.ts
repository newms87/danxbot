import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { required, optional } from "./env.js";

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
});

describe("required", () => {
  it("returns the value when set", () => {
    process.env.TEST_VAR = "hello";
    expect(required("TEST_VAR")).toBe("hello");
  });

  it("throws when the variable is missing", () => {
    delete process.env.TEST_VAR;
    expect(() => required("TEST_VAR")).toThrow("Missing required environment variable: TEST_VAR");
  });

  it("throws when the variable is empty string", () => {
    process.env.TEST_VAR = "";
    expect(() => required("TEST_VAR")).toThrow("Missing required environment variable: TEST_VAR");
  });
});

describe("optional", () => {
  it("returns the value when set", () => {
    process.env.TEST_VAR = "hello";
    expect(optional("TEST_VAR", "default")).toBe("hello");
  });

  it("returns default when the variable is missing", () => {
    delete process.env.TEST_VAR;
    expect(optional("TEST_VAR", "default")).toBe("default");
  });

  it("returns default when the variable is empty string", () => {
    process.env.TEST_VAR = "";
    expect(optional("TEST_VAR", "default")).toBe("default");
  });
});
