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
    issueId: null,
    status: "running",
    startedAt: 1000,
    completedAt: null,
    summary: null,
    error: null,
    runtimeMode: "host",
    hostPid: 4242,
    hostPidAt: null,
    pidTerminatedAt: null,
    tokensTotal: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolCallCount: 0,
    subagentCount: 0,
    nudgeCount: 0,
    danxbotCommit: null,
    agentName: null,
    mcpSettingsPath: null,
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
    // over, and reattachOrResolveDispatches (DX-209) has separately
    // marked the row failed at startup.
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

  // Internal-issue-id matcher (covers the auto-resume case: child
  // dispatch is `trigger: "api"`, so it can't match via trello's
  // `triggerMetadata.cardId` — but its `issueId` column carries the
  // internal `DX-N` id).
  it("returns true when an api-trigger row matches via internalIssueId (auto-resume child)", async () => {
    deps.findNonTerminalDispatches = vi.fn().mockResolvedValue([
      makeRow({
        trigger: "api",
        triggerMetadata: {
          endpoint: "/internal/auto-resume",
          callerIp: null,
          statusUrl: null,
          initialPrompt: "",
          workspace: "issue-worker",
        },
        issueId: "DX-142",
        hostPid: process.pid,
      }),
    ]);
    deps.isPidAlive = vi.fn().mockReturnValue(true);

    const live = await hasLiveDispatchForCard(
      "danxbot",
      "card-target",
      deps,
      "DX-142",
    );

    expect(live).toBe(true);
  });

  it("ignores internalIssueId mismatch — api row for a different internal id does not match", async () => {
    deps.findNonTerminalDispatches = vi.fn().mockResolvedValue([
      makeRow({
        trigger: "api",
        triggerMetadata: {
          endpoint: "/internal/auto-resume",
          callerIp: null,
          statusUrl: null,
          initialPrompt: "",
          workspace: "issue-worker",
        },
        issueId: "DX-999",
        hostPid: process.pid,
      }),
    ]);
    deps.isPidAlive = vi.fn().mockReturnValue(true);

    const live = await hasLiveDispatchForCard(
      "danxbot",
      "card-target",
      deps,
      "DX-142",
    );

    expect(live).toBe(false);
  });

  it("trello + internalIssueId both supplied — matches via EITHER (defense in depth)", async () => {
    deps.findNonTerminalDispatches = vi.fn().mockResolvedValue([
      // Row matches via trello cardId but NOT internalIssueId.
      makeRow({ hostPid: process.pid }),
    ]);
    deps.isPidAlive = vi.fn().mockReturnValue(true);

    const live = await hasLiveDispatchForCard(
      "danxbot",
      "card-target",
      deps,
      "DX-142",
    );

    expect(live).toBe(true);
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
