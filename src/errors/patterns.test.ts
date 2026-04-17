import { describe, it, expect } from "vitest";
import { isOperationalError, isTransientError } from "./patterns.js";

describe("isOperationalError", () => {
  it.each([
    ["credit balance is too low for your plan", true],
    ["billing information is required", true],
    ["authentication failed", true],
    ["unauthorized access", true],
    ["AUTHENTICATION_ERROR: invalid key", true],
  ])("returns true for '%s'", (message, expected) => {
    expect(isOperationalError(message)).toBe(expected);
  });

  it.each([
    ["connect ETIMEDOUT", false],
    ["Internal server error", false],
    ["rate limit exceeded", false],
    ["", false],
  ])("returns false for '%s'", (message, expected) => {
    expect(isOperationalError(message)).toBe(expected);
  });
});

describe("isTransientError", () => {
  it.each([
    ["connect ETIMEDOUT", true],
    ["connect ETIMEDOUT 1.2.3.4:443", true],
    ["connect ECONNREFUSED 127.0.0.1:3306", true],
    ["getaddrinfo ENOTFOUND api.anthropic.com", true],
    ["read ECONNRESET", true],
    ["connect EHOSTUNREACH 10.0.0.1:80", true],
    ["connect ECONNABORTED", true],
  ])("returns true for '%s'", (message, expected) => {
    expect(isTransientError(message)).toBe(expected);
  });

  it.each([
    ["Internal server error", false],
    ["credit balance is too low", false],
    ["authentication failed", false],
    ["Agent timed out after 300s", false],
    ["", false],
  ])("returns false for '%s'", (message, expected) => {
    expect(isTransientError(message)).toBe(expected);
  });
});
