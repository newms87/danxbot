import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const envBackup = { ...process.env };

// Set env vars before config.ts module evaluation (triggered by import)
vi.hoisted(() => {
  process.env.TRELLO_API_KEY = "test-key";
  process.env.TRELLO_API_TOKEN = "test-token";
});

// Mock constants.ts since it reads from a YAML file that doesn't exist in tests
vi.mock("./constants.js", () => ({
  BOARD_ID: "mock-board-id",
  REVIEW_LIST_ID: "mock-review-list-id",
  TODO_LIST_ID: "mock-todo-list-id",
  IN_PROGRESS_LIST_ID: "mock-in-progress-list-id",
  NEEDS_HELP_LIST_ID: "mock-needs-help-list-id",
  DONE_LIST_ID: "mock-done-list-id",
  CANCELLED_LIST_ID: "mock-cancelled-list-id",
  ACTION_ITEMS_LIST_ID: "mock-action-items-list-id",
  BUG_LABEL_ID: "mock-bug-label-id",
  FEATURE_LABEL_ID: "mock-feature-label-id",
  EPIC_LABEL_ID: "mock-epic-label-id",
  NEEDS_HELP_LABEL_ID: "mock-needs-help-label-id",
  REVIEW_MIN_CARDS: 10,
  DANXBOT_COMMENT_MARKER: "<!-- danxbot -->",
}));

import { createConfig, BOARD_ID, TODO_LIST_ID, NEEDS_HELP_LIST_ID, DANXBOT_COMMENT_MARKER } from "./config.js";

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
  it("exports board and list IDs from trello.yml", () => {
    expect(BOARD_ID).toBe("mock-board-id");
    expect(TODO_LIST_ID).toBe("mock-todo-list-id");
    expect(NEEDS_HELP_LIST_ID).toBe("mock-needs-help-list-id");
  });

  it("exports danxbot comment marker", () => {
    expect(DANXBOT_COMMENT_MARKER).toBe("<!-- danxbot -->");
  });
});
