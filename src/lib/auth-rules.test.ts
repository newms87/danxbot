import { describe, it, expect } from "vitest";
import {
  validateUsername,
  validatePassword,
  USERNAME_PATTERN,
  USERNAME_MIN_LEN,
  USERNAME_MAX_LEN,
  PASSWORD_MIN_LEN,
} from "./auth-rules.js";

describe("USERNAME_PATTERN constants", () => {
  it("matches the documented [a-zA-Z0-9_-] charset", () => {
    expect(USERNAME_PATTERN.test("alice")).toBe(true);
    expect(USERNAME_PATTERN.test("alice_bob-99")).toBe(true);
    expect(USERNAME_PATTERN.test("alice bob")).toBe(false);
    expect(USERNAME_PATTERN.test("alice@x")).toBe(false);
  });

  it("documents min/max as 3/64", () => {
    expect(USERNAME_MIN_LEN).toBe(3);
    expect(USERNAME_MAX_LEN).toBe(64);
  });

  it("documents PASSWORD_MIN_LEN as 12", () => {
    expect(PASSWORD_MIN_LEN).toBe(12);
  });
});

describe("validateUsername", () => {
  it("accepts boundary-OK inputs", () => {
    expect(() => validateUsername("abc")).not.toThrow();
    expect(() => validateUsername("a".repeat(64))).not.toThrow();
    expect(() => validateUsername("alice_bob-9")).not.toThrow();
  });

  it("rejects too short (<3)", () => {
    expect(() => validateUsername("ab")).toThrow(/3-64/);
    expect(() => validateUsername("")).toThrow(/3-64/);
  });

  it("rejects too long (>64)", () => {
    expect(() => validateUsername("a".repeat(65))).toThrow(/3-64/);
  });

  it("rejects bad characters", () => {
    expect(() => validateUsername("alice bob")).toThrow(/letters, numbers/);
    expect(() => validateUsername("alice@x")).toThrow(/letters, numbers/);
    expect(() => validateUsername("alíce")).toThrow(/letters, numbers/);
    // Shell-injection attempts MUST be rejected — this is the security gate
    expect(() => validateUsername("alice; rm -rf /")).toThrow();
    expect(() => validateUsername("alice`pwd`")).toThrow();
    expect(() => validateUsername("$(whoami)")).toThrow();
  });
});

describe("validatePassword", () => {
  it("accepts >=12 chars", () => {
    expect(() => validatePassword("a".repeat(12))).not.toThrow();
    expect(() => validatePassword("a".repeat(100))).not.toThrow();
  });

  it("rejects <12 chars", () => {
    expect(() => validatePassword("a".repeat(11))).toThrow(/12/);
    expect(() => validatePassword("")).toThrow(/12/);
  });
});
