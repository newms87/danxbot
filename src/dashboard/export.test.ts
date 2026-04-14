import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock config to avoid requiring real environment variables
vi.mock("../config.js", () => ({
  config: {},
}));

// Mock the db connection module so persistence calls don't hit a real DB
vi.mock("../db/connection.js", () => ({
  getPool: vi.fn(() => ({
    query: vi.fn().mockResolvedValue([[], []]),
    execute: vi.fn().mockResolvedValue([[], []]),
  })),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createEvent,
  updateEvent,
  getEvents,
  resetEvents,
} from "./events.js";
import { eventsToCSV } from "./export.js";

beforeEach(() => {
  resetEvents();
});

function makeEvent(overrides: Partial<Parameters<typeof createEvent>[0]> = {}) {
  return createEvent({
    repoName: overrides.repoName ?? "test-repo",
    threadTs: overrides.threadTs ?? `t-${Date.now()}-${Math.random()}`,
    messageTs: overrides.messageTs ?? `m-${Date.now()}-${Math.random()}`,
    channelId: overrides.channelId ?? "C123",
    user: overrides.user ?? "U456",
    text: overrides.text ?? "test message",
  });
}

describe("eventsToCSV", () => {
  it("produces header-only CSV for empty events array", () => {
    const csv = eventsToCSV([]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("timestamp,user,text,status,subscription_cost,api_cost,feedback,response_time_ms");
    expect(lines.length).toBe(2); // header + trailing newline
    expect(lines[1]).toBe("");
  });

  it("produces correct CSV row for a single event", () => {
    const event = makeEvent();
    updateEvent(event.id, {
      userName: "Alice",
      status: "complete",
      subscriptionCostUsd: 0.05,
      feedback: "positive",
      routerResponseAt: event.receivedAt + 300,
      agentResponseAt: event.receivedAt + 1500,
    });

    const csv = eventsToCSV(getEvents());
    const lines = csv.split("\n");
    expect(lines.length).toBe(3); // header + 1 row + trailing newline

    const row = lines[1].split(",");
    // timestamp is ISO string
    expect(row[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // user
    expect(row[1]).toBe("Alice");
    // text
    expect(row[2]).toBe("test message");
    // status
    expect(row[3]).toBe("complete");
    // subscription_cost
    expect(row[4]).toBe("0.05");
    // api_cost
    expect(row[5]).toBe("");
    // feedback
    expect(row[6]).toBe("positive");
    // response_time_ms
    expect(row[7]).toBe("1500");
  });

  it("escapes fields containing commas", () => {
    const event = makeEvent({ text: "hello, world" });
    const csv = eventsToCSV(getEvents());
    const lines = csv.split("\n");
    // The text field should be wrapped in double quotes
    expect(lines[1]).toContain('"hello, world"');
  });

  it("escapes fields containing double quotes", () => {
    const event = makeEvent({ text: 'say "hello"' });
    const csv = eventsToCSV(getEvents());
    const lines = csv.split("\n");
    // Double quotes inside should be doubled, and the field wrapped in quotes
    expect(lines[1]).toContain('"say ""hello"""');
  });

  it("escapes fields containing newlines", () => {
    const event = makeEvent({ text: "line1\nline2" });
    const csv = eventsToCSV(getEvents());
    const lines = csv.split("\n");
    // The field with newline should be wrapped in double quotes
    // When we rejoin, the raw CSV should contain the quoted field
    expect(csv).toContain('"line1\nline2"');
  });

  it("produces empty values for missing optional fields", () => {
    const event = makeEvent();
    // Leave subscriptionCostUsd and feedback as null (defaults)
    const csv = eventsToCSV(getEvents());
    const lines = csv.split("\n");
    const row = lines[1].split(",");
    // subscription_cost (index 4) should be empty
    expect(row[4]).toBe("");
    // api_cost (index 5) should be empty
    expect(row[5]).toBe("");
    // feedback (index 6) should be empty
    expect(row[6]).toBe("");
  });

  it("falls back to user ID when userName is null", () => {
    const event = makeEvent();
    // userName defaults to null, user is "U456"
    const csv = eventsToCSV(getEvents());
    const lines = csv.split("\n");
    const row = lines[1].split(",");
    expect(row[1]).toBe("U456");
  });

  it("calculates response_time_ms from agentResponseAt when available", () => {
    const event = makeEvent();
    updateEvent(event.id, {
      status: "complete",
      routerResponseAt: event.receivedAt + 200,
      agentResponseAt: event.receivedAt + 2000,
    });

    const csv = eventsToCSV(getEvents());
    const lines = csv.split("\n");
    const row = lines[1].split(",");
    expect(row[7]).toBe("2000");
  });

  it("calculates response_time_ms from routerResponseAt when no agent", () => {
    const event = makeEvent();
    updateEvent(event.id, {
      status: "complete",
      routerResponseAt: event.receivedAt + 500,
    });

    const csv = eventsToCSV(getEvents());
    const lines = csv.split("\n");
    const row = lines[1].split(",");
    expect(row[7]).toBe("500");
  });

  it("calculates response_time_ms as 0 when no response times available", () => {
    const event = makeEvent();
    const csv = eventsToCSV(getEvents());
    const lines = csv.split("\n");
    const row = lines[1].split(",");
    expect(row[7]).toBe("0");
  });

  it("exports apiCostUsd when present", () => {
    const event = makeEvent();
    updateEvent(event.id, {
      status: "complete",
      apiCostUsd: 0.001,
    });

    const csv = eventsToCSV(getEvents());
    const lines = csv.split("\n");
    const row = lines[1].split(",");
    expect(row[5]).toBe("0.001");
  });

  it("neutralizes CSV injection with = prefix", () => {
    const event = makeEvent({ text: "=SUM(A1)" });
    const csv = eventsToCSV(getEvents());
    expect(csv).toContain("\"'=SUM(A1)\"");
  });

  it("neutralizes CSV injection with + prefix", () => {
    const event = makeEvent({ text: "+cmd" });
    const csv = eventsToCSV(getEvents());
    expect(csv).toContain("\"'+cmd\"");
  });

  it("neutralizes CSV injection with - prefix", () => {
    const event = makeEvent({ text: "-1+1" });
    const csv = eventsToCSV(getEvents());
    expect(csv).toContain("\"'-1+1\"");
  });

  it("neutralizes CSV injection with @ prefix", () => {
    const event = makeEvent({ text: "@SUM" });
    const csv = eventsToCSV(getEvents());
    expect(csv).toContain("\"'@SUM\"");
  });

  it("neutralizes CSV injection with tab prefix", () => {
    const event = makeEvent({ text: "\t=SUM(A1)" });
    const csv = eventsToCSV(getEvents());
    expect(csv).toContain("\"'\t=SUM(A1)\"");
  });

  it("neutralizes CSV injection with carriage return prefix", () => {
    const event = makeEvent({ text: "\r=SUM(A1)" });
    const csv = eventsToCSV(getEvents());
    expect(csv).toContain("\"'\r=SUM(A1)\"");
  });

  it("produces '0' for subscriptionCostUsd of 0 (falsy but valid)", () => {
    const event = makeEvent();
    updateEvent(event.id, {
      status: "complete",
      subscriptionCostUsd: 0,
    });

    const csv = eventsToCSV(getEvents());
    const lines = csv.split("\n");
    const row = lines[1].split(",");
    // subscription_cost is at index 4
    expect(row[4]).toBe("0");
    // api_cost at index 5 should be empty
    expect(row[5]).toBe("");
  });
});
