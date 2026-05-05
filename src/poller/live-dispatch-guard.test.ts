import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Dispatch } from "../dashboard/dispatches.js";
import {
  hasLiveDispatchForCard,
  type LiveDispatchGuardDeps,
} from "./live-dispatch-guard.js";

function makeRow(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: "job-id",
    repoName: "danxbot",
    trigger: "trello",
    triggerMetadata: {
      cardId: "card-target",
      cardName: "Card",
      cardUrl: "https://trello.com/c/card-target",
      listId: "list-1",
      listName: "ToDo",
    },
    slackThreadTs: null,
    slackChannelId: null,
    sessionUuid: null,
    jsonlPath: null,
    parentJobId: null,
    status: "running",
    startedAt: 1000,
    completedAt: null,
    summary: null,
    error: null,
    runtimeMode: "host",
    hostPid: 4242,
    tokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 0,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: null,
    ...overrides,
  };
}

let deps: LiveDispatchGuardDeps;
let warns: string[];

beforeEach(() => {
  warns = [];
  deps = {
    findNonTerminalDispatches: vi.fn().mockResolvedValue([]),
    isPidAlive: vi.fn().mockReturnValue(false),
    log: { warn: (msg: string) => warns.push(msg) },
  };
});

describe("hasLiveDispatchForCard", () => {
  it("returns true when a trello dispatch row for the card has a live host_pid", async () => {
    deps.findNonTerminalDispatches = vi
      .fn()
      .mockResolvedValue([makeRow({ hostPid: process.pid })]);
    deps.isPidAlive = vi.fn().mockReturnValue(true);

    const live = await hasLiveDispatchForCard("danxbot", "card-target", deps);

    expect(live).toBe(true);
    expect(deps.isPidAlive).toHaveBeenCalledWith(process.pid);
  });

  it("returns false when the row's host_pid is dead — preserves existing TTL semantics", async () => {
    // ISS-69 AC: poller still reclaims cards whose dispatch row has dead
    // PID. The guard must NOT block; the tracker-side lock TTL takes
    // over, and reconcileOrphanedDispatches has separately marked the
    // row failed at startup.
    deps.findNonTerminalDispatches = vi
      .fn()
      .mockResolvedValue([makeRow({ hostPid: 999_991 })]);
    deps.isPidAlive = vi.fn().mockReturnValue(false);

    const live = await hasLiveDispatchForCard("danxbot", "card-target", deps);

    expect(live).toBe(false);
  });

  it("returns false when host_pid is null without ever consulting the kernel", async () => {
    deps.findNonTerminalDispatches = vi
      .fn()
      .mockResolvedValue([makeRow({ hostPid: null })]);

    const live = await hasLiveDispatchForCard("danxbot", "card-target", deps);

    expect(live).toBe(false);
    expect(deps.isPidAlive).not.toHaveBeenCalled();
  });

  it("ignores rows for OTHER trello cards", async () => {
    deps.findNonTerminalDispatches = vi.fn().mockResolvedValue([
      makeRow({
        triggerMetadata: {
          cardId: "different-card",
          cardName: "X",
          cardUrl: "u",
          listId: "l",
          listName: "ToDo",
        },
        hostPid: process.pid,
      }),
    ]);
    deps.isPidAlive = vi.fn().mockReturnValue(true);

    const live = await hasLiveDispatchForCard("danxbot", "card-target", deps);

    expect(live).toBe(false);
    expect(deps.isPidAlive).not.toHaveBeenCalled();
  });

  it("ignores non-trello triggers (api / slack)", async () => {
    deps.findNonTerminalDispatches = vi.fn().mockResolvedValue([
      makeRow({
        trigger: "api",
        triggerMetadata: {
          endpoint: "/api/launch",
          callerIp: null,
          statusUrl: null,
          initialPrompt: "",
        },
        hostPid: process.pid,
      }),
    ]);
    deps.isPidAlive = vi.fn().mockReturnValue(true);

    const live = await hasLiveDispatchForCard("danxbot", "card-target", deps);

    expect(live).toBe(false);
  });

  it("returns false when no non-terminal rows exist", async () => {
    deps.findNonTerminalDispatches = vi.fn().mockResolvedValue([]);
    const live = await hasLiveDispatchForCard("danxbot", "card-target", deps);
    expect(live).toBe(false);
  });

  it("fails open with a warn log when the DB lookup throws", async () => {
    deps.findNonTerminalDispatches = vi
      .fn()
      .mockRejectedValue(new Error("connection lost"));

    const live = await hasLiveDispatchForCard("danxbot", "card-target", deps);

    expect(live).toBe(false);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("connection lost");
    expect(warns[0]).toContain("continuing without guard");
  });
});
