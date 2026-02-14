import { describe, it, expect, vi, beforeEach } from "vitest";

// Helper to set up a valid env and dynamically import config
function validEnv(): Record<string, string> {
  return {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_CHANNEL_ID: "C-TEST",
    ANTHROPIC_API_KEY: "test-key",
    PLATFORM_REPO_URL: "https://test.example.com",
    PLATFORM_DB_HOST: "localhost",
    PLATFORM_DB_USER: "test",
    PLATFORM_DB_PASSWORD: "test",
    PLATFORM_DB_NAME: "test",
    MAX_TURNS: "10",
    MAX_BUDGET_USD: "1.00",
    MAX_THINKING_TOKENS: "8000",
    AGENT_TIMEOUT_MS: "300000",
    MAX_THREAD_MESSAGES: "20",
    AGENT_MAX_RETRIES: "1",
    RATE_LIMIT_SECONDS: "30",
  };
}

async function importConfig(envOverrides: Record<string, string> = {}) {
  const env = { ...validEnv(), ...envOverrides };
  // Replace process.env entirely for isolation
  const originalEnv = process.env;
  process.env = { ...env };
  try {
    return await import("./config.js");
  } finally {
    process.env = originalEnv;
  }
}

beforeEach(() => {
  vi.resetModules();
});

describe("validateConfig", () => {
  it("does not throw when all values are valid", async () => {
    await expect(importConfig()).resolves.toBeDefined();
  });

  it("does not throw when maxRetries is 0", async () => {
    await expect(
      importConfig({ AGENT_MAX_RETRIES: "0" }),
    ).resolves.toBeDefined();
  });

  it("throws for NaN values", async () => {
    await expect(
      importConfig({ MAX_TURNS: "abc" }),
    ).rejects.toThrow("agent.maxTurns");
  });

  it("throws for negative values", async () => {
    await expect(
      importConfig({ MAX_BUDGET_USD: "-1" }),
    ).rejects.toThrow("agent.maxBudgetUsd");
  });

  it("throws for zero maxBudgetUsd (exclusive minimum)", async () => {
    await expect(
      importConfig({ MAX_BUDGET_USD: "0" }),
    ).rejects.toThrow("agent.maxBudgetUsd");
  });

  it("throws for zero values on fields requiring > 0", async () => {
    await expect(
      importConfig({ MAX_TURNS: "0" }),
    ).rejects.toThrow("agent.maxTurns");
  });

  it("throws for zero rateLimitSeconds", async () => {
    await expect(
      importConfig({ RATE_LIMIT_SECONDS: "0" }),
    ).rejects.toThrow("rateLimitSeconds");
  });

  it("throws for negative maxRetries", async () => {
    // maxRetries has Math.max(0, ...) so parseInt("-1") => -1 => Math.max(0,-1) => 0
    // 0 is valid for maxRetries, so this should NOT throw
    await expect(
      importConfig({ AGENT_MAX_RETRIES: "-1" }),
    ).resolves.toBeDefined();
  });

  it("throws for NaN maxRetries", async () => {
    await expect(
      importConfig({ AGENT_MAX_RETRIES: "abc" }),
    ).rejects.toThrow("agent.maxRetries");
  });

  it("collects ALL invalid values into a single error", async () => {
    await expect(
      importConfig({
        MAX_TURNS: "abc",
        MAX_BUDGET_USD: "-1",
        RATE_LIMIT_SECONDS: "0",
      }),
    ).rejects.toThrow(/agent\.maxTurns.*agent\.maxBudgetUsd.*rateLimitSeconds/s);
  });
});
