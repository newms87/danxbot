import { describe, it, expect, vi } from "vitest";

// Mock the main config.ts before importing poller config
vi.mock("../config.js", () => ({
  config: {
    agent: { model: "claude-opus-4-1" },
    dashboard: { port: 5555 },
  },
}));

// Mock constants.ts since it reads from a YAML file that doesn't exist in tests
vi.mock("./constants.js", () => ({
  REVIEW_MIN_CARDS: 10,
  DANXBOT_COMMENT_MARKER: "<!-- danxbot -->",
}));

import { config, DANXBOT_COMMENT_MARKER } from "./config.js";

describe("config", () => {
  it("re-exports config from main config.ts", () => {
    expect(config).toBeTruthy();
    expect(config.agent).toBeTruthy();
  });
});

describe("constants", () => {
  it("exports danxbot comment marker", () => {
    expect(DANXBOT_COMMENT_MARKER).toBe("<!-- danxbot -->");
  });
});
