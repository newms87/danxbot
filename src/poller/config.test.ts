import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const envBackup = { ...process.env };

// Set env vars before config.ts module evaluation (triggered by import)
vi.hoisted(() => {
  process.env.TRELLO_API_KEY = "test-key";
  process.env.TRELLO_API_TOKEN = "test-token";
});

import { createConfig, BOARD_ID, TODO_LIST_ID } from "./config.js";

describe("createConfig", () => {
  beforeEach(() => {
    process.env = { ...envBackup };
    process.env.TRELLO_API_KEY = "test-key";
    process.env.TRELLO_API_TOKEN = "test-token";
  });

  afterEach(() => {
    process.env = envBackup;
  });

  it("throws when TRELLO_API_KEY is missing", () => {
    delete process.env.TRELLO_API_KEY;
    expect(() => createConfig()).toThrow("TRELLO_API_KEY");
  });

  it("throws when TRELLO_API_TOKEN is missing", () => {
    delete process.env.TRELLO_API_TOKEN;
    expect(() => createConfig()).toThrow("TRELLO_API_TOKEN");
  });

  it("loads config with required env vars", () => {
    const config = createConfig();
    expect(config.trello.apiKey).toBe("test-key");
    expect(config.trello.apiToken).toBe("test-token");
  });

  it("defaults pollerIntervalMs to 60000", () => {
    const config = createConfig();
    expect(config.pollerIntervalMs).toBe(60000);
  });

  it("respects POLLER_INTERVAL_MS override", () => {
    process.env.POLLER_INTERVAL_MS = "5000";
    const config = createConfig();
    expect(config.pollerIntervalMs).toBe(5000);
  });
});

describe("constants", () => {
  it("exports board and list IDs", () => {
    expect(BOARD_ID).toBe("698fc5b8847b787a3818ad82");
    expect(TODO_LIST_ID).toBe("698fc5be16a280cc321a13ec");
  });
});
