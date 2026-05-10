/**
 * Unit tests for the worker's stop-queue boot replay (DX-242).
 *
 * Tests inject deterministic deps for `getDispatch`, `updateDispatch`,
 * `autoSync`, and `writeFlag` so the unit suite covers branching and
 * file-cleanup semantics without booting the full worker. The boot
 * wiring in `src/index.ts` is a thin "call replayStopQueue, log" shim
 * — covered by integration / smoke rather than unit.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { replayStopQueue, STOP_QUEUE_DIR } from "./replay-stop-queue.js";
import * as systemErrorsModule from "../dashboard/system-errors.js";
import type { Dispatch } from "../dashboard/dispatches.js";
import type { RepoContext } from "../types.js";

interface QueueEntry {
  dispatchId: string;
  status: "completed" | "failed" | "critical_failure";
  summary: string;
  timestamp: string;
}

function writeQueueFile(repoLocalPath: string, entry: QueueEntry): string {
  const dir = join(repoLocalPath, STOP_QUEUE_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${entry.dispatchId}.json`);
  writeFileSync(path, JSON.stringify(entry));
  return path;
}

function fakeDispatch(overrides: Partial<Dispatch> = {}): Dispatch {
  return {
    id: "d1",
    sessionId: null,
    repoName: "danxbot",
    workspace: "issue-worker",
    parentJobId: null,
    issueId: null,
    summary: null,
    title: null,
    status: "running",
    trigger: "trello",
    triggerMetadata: { cardId: "card-1" },
    startedAt: 0,
    completedAt: null,
    nudgeCount: 0,
    cwd: "/tmp",
    jsonlPath: null,
    settingsDir: null,
    error: null,
    usage: null,
    runtime: "host",
    hostPid: null,
    hostPidAt: null,
    pidTerminatedAt: null,
    mcpSettingsPath: null,
    ...overrides,
  } as Dispatch;
}

function makeRepo(localPath: string): RepoContext {
  return {
    name: "danxbot",
    localPath,
    hostPath: localPath,
    issuePrefix: "DX",
    // Other RepoContext fields aren't read by replayStopQueue — minimal
    // stub keeps the test free of config wiring.
  } as unknown as RepoContext;
}

describe("replayStopQueue (DX-242)", () => {
  let workArea: string;
  let recordSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workArea = mkdtempSync(join(tmpdir(), "danxbot-replay-"));
    recordSpy = vi.spyOn(systemErrorsModule, "recordSystemError");
  });

  afterEach(() => {
    rmSync(workArea, { recursive: true, force: true });
    recordSpy.mockRestore();
  });

  it("ensures the queue dir exists and returns scanned: 0 when empty", async () => {
    const result = await replayStopQueue(makeRepo(workArea), {
      getDispatch: async () => null,
      updateDispatchFn: async () => {},
      autoSync: async () => {},
      writeFlagFn: () =>
        ({
          timestamp: "",
          source: "agent",
          dispatchId: "",
          reason: "",
        }) as never,
    });
    expect(result.scanned).toBe(0);
    expect(existsSync(join(workArea, STOP_QUEUE_DIR))).toBe(true);
  });

  it("replays a normal terminal entry: autoSync → updateDispatch → delete (load-bearing ordering)", async () => {
    writeQueueFile(workArea, {
      dispatchId: "d1",
      status: "completed",
      summary: "agent finished while worker was down",
      timestamp: new Date().toISOString(),
    });

    // Single shared events array proves autoSync runs BEFORE
    // updateDispatch — load-bearing per the source comment "Same
    // ordering as the live handleStop path." A regression that
    // reverses the calls (or fires them in parallel) would lose the
    // tracker push on transient DB success that immediately clears
    // the file before the tracker sync lands.
    const events: string[] = [];
    const updateCalls: Array<[string, Record<string, unknown>]> = [];

    const result = await replayStopQueue(makeRepo(workArea), {
      getDispatch: async (id) => fakeDispatch({ id }),
      updateDispatchFn: async (id, patch) => {
        events.push(`update:${id}`);
        updateCalls.push([id, patch as Record<string, unknown>]);
      },
      autoSync: async (id) => {
        events.push(`autoSync:${id}`);
      },
      writeFlagFn: () =>
        ({
          timestamp: "",
          source: "agent",
          dispatchId: "",
          reason: "",
        }) as never,
    });

    expect(result.scanned).toBe(1);
    expect(result.replayed).toEqual(["d1"]);
    // Ordering: autoSync first, then updateDispatch.
    expect(events).toEqual(["autoSync:d1", "update:d1"]);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][0]).toBe("d1");
    expect(updateCalls[0][1]).toMatchObject({
      status: "completed",
      summary: "agent finished while worker was down",
    });
    // File is gone — the boot path consumed it.
    expect(
      existsSync(join(workArea, STOP_QUEUE_DIR, "d1.json")),
    ).toBe(false);
  });

  it("rejects malformed-shape entries (valid JSON, wrong keys/types) as malformed", async () => {
    const dir = join(workArea, STOP_QUEUE_DIR);
    mkdirSync(dir, { recursive: true });
    // Valid JSON but `status` is not a CompleteStatus.
    writeFileSync(
      join(dir, "shape.json"),
      JSON.stringify({
        dispatchId: "x",
        status: "bogus-status",
        summary: "y",
        timestamp: "z",
      }),
    );

    const result = await replayStopQueue(makeRepo(workArea), {
      getDispatch: async () => null,
      updateDispatchFn: async () => {},
      autoSync: async () => {},
      writeFlagFn: () => ({}) as never,
    });

    expect(result.failed).toEqual([{ file: "shape.json", error: "malformed" }]);
    expect(existsSync(join(dir, "shape.json"))).toBe(false);
    expect(recordSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects entries missing required fields", async () => {
    const dir = join(workArea, STOP_QUEUE_DIR);
    mkdirSync(dir, { recursive: true });
    // Missing `summary` — required by parseEntry.
    writeFileSync(
      join(dir, "missing-field.json"),
      JSON.stringify({
        dispatchId: "x",
        status: "completed",
        timestamp: "z",
      }),
    );

    const result = await replayStopQueue(makeRepo(workArea), {
      getDispatch: async () => null,
      updateDispatchFn: async () => {},
      autoSync: async () => {},
      writeFlagFn: () => ({}) as never,
    });

    expect(result.failed).toEqual([
      { file: "missing-field.json", error: "malformed" },
    ]);
    expect(existsSync(join(dir, "missing-field.json"))).toBe(false);
  });

  it("replays a `failed` agent status as DB-status `failed`", async () => {
    writeQueueFile(workArea, {
      dispatchId: "d-fail",
      status: "failed",
      summary: "fatal error",
      timestamp: new Date().toISOString(),
    });

    const updateCalls: Array<[string, Record<string, unknown>]> = [];
    await replayStopQueue(makeRepo(workArea), {
      getDispatch: async (id) => fakeDispatch({ id }),
      updateDispatchFn: async (id, patch) => {
        updateCalls.push([id, patch as Record<string, unknown>]);
      },
      autoSync: async () => {},
      writeFlagFn: () =>
        ({
          timestamp: "",
          source: "agent",
          dispatchId: "",
          reason: "",
        }) as never,
    });

    expect(updateCalls[0][1]).toMatchObject({
      status: "failed",
      summary: "fatal error",
    });
  });

  it("replays a `critical_failure` entry: writeFlag + row failed", async () => {
    writeQueueFile(workArea, {
      dispatchId: "d-crit",
      status: "critical_failure",
      summary: "MCP not loaded",
      timestamp: new Date().toISOString(),
    });

    const flagCalls: Array<{
      localPath: string;
      detail: string;
      reason: string;
    }> = [];
    const updateCalls: Array<[string, Record<string, unknown>]> = [];
    const autoSyncCalls: string[] = [];

    await replayStopQueue(makeRepo(workArea), {
      getDispatch: async (id) => fakeDispatch({ id }),
      updateDispatchFn: async (id, patch) => {
        updateCalls.push([id, patch as Record<string, unknown>]);
      },
      autoSync: async (id) => {
        autoSyncCalls.push(id);
      },
      writeFlagFn: ((path: string, opts: { detail?: string; reason: string }) => {
        flagCalls.push({
          localPath: path,
          detail: opts.detail ?? "",
          reason: opts.reason,
        });
        return {} as never;
      }) as never,
    });

    expect(flagCalls).toHaveLength(1);
    expect(flagCalls[0].localPath).toBe(workArea);
    expect(flagCalls[0].detail).toBe("MCP not loaded");
    // critical_failure routes around auto-sync (the flag is the operator
    // surface; the row terminates as failed). Mirrors the in-memory
    // handleStop branching.
    expect(autoSyncCalls).toEqual([]);
    expect(updateCalls[0][1]).toMatchObject({
      status: "failed",
      summary: "MCP not loaded",
    });
    expect(
      existsSync(join(workArea, STOP_QUEUE_DIR, "d-crit.json")),
    ).toBe(false);
  });

  it("skips already-terminal rows (idempotent — preserve original reason)", async () => {
    writeQueueFile(workArea, {
      dispatchId: "d-term",
      status: "completed",
      summary: "should not overwrite original",
      timestamp: new Date().toISOString(),
    });

    const updateCalls: Array<[string, unknown]> = [];
    const result = await replayStopQueue(makeRepo(workArea), {
      getDispatch: async (id) =>
        fakeDispatch({ id, status: "completed" }), // already terminal
      updateDispatchFn: async (id, patch) => {
        updateCalls.push([id, patch]);
      },
      autoSync: async () => {},
      writeFlagFn: () =>
        ({
          timestamp: "",
          source: "agent",
          dispatchId: "",
          reason: "",
        }) as never,
    });

    expect(result.skipped).toEqual(["d-term"]);
    expect(updateCalls).toEqual([]);
    expect(
      existsSync(join(workArea, STOP_QUEUE_DIR, "d-term.json")),
    ).toBe(false);
  });

  it("discards entries whose dispatch row is gone (cleanup pass already ran)", async () => {
    writeQueueFile(workArea, {
      dispatchId: "d-orphan",
      status: "completed",
      summary: "ok",
      timestamp: new Date().toISOString(),
    });

    const result = await replayStopQueue(makeRepo(workArea), {
      getDispatch: async () => null, // row deleted
      updateDispatchFn: async () => {},
      autoSync: async () => {},
      writeFlagFn: () =>
        ({
          timestamp: "",
          source: "agent",
          dispatchId: "",
          reason: "",
        }) as never,
    });

    expect(result.skipped).toEqual(["d-orphan"]);
    expect(
      existsSync(join(workArea, STOP_QUEUE_DIR, "d-orphan.json")),
    ).toBe(false);
  });

  it("discards malformed JSON files and records a system error", async () => {
    const dir = join(workArea, STOP_QUEUE_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.json"), "{not-valid-json");

    const result = await replayStopQueue(makeRepo(workArea), {
      getDispatch: async () => null,
      updateDispatchFn: async () => {},
      autoSync: async () => {},
      writeFlagFn: () =>
        ({
          timestamp: "",
          source: "agent",
          dispatchId: "",
          reason: "",
        }) as never,
    });

    expect(result.failed).toEqual([{ file: "bad.json", error: "malformed" }]);
    expect(existsSync(join(dir, "bad.json"))).toBe(false);
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const payload = recordSpy.mock.calls[0][0] as {
      source: string;
      severity: string;
    };
    expect(payload.source).toBe("stop-replay");
    expect(payload.severity).toBe("warn");
  });

  it("keeps the file on disk when updateDispatch throws (next boot retries)", async () => {
    writeQueueFile(workArea, {
      dispatchId: "d-retry",
      status: "completed",
      summary: "ok",
      timestamp: new Date().toISOString(),
    });

    const result = await replayStopQueue(makeRepo(workArea), {
      getDispatch: async (id) => fakeDispatch({ id }),
      updateDispatchFn: async () => {
        throw new Error("connection refused");
      },
      autoSync: async () => {},
      writeFlagFn: () =>
        ({
          timestamp: "",
          source: "agent",
          dispatchId: "",
          reason: "",
        }) as never,
    });

    // File preserved — the next boot will retry.
    expect(
      existsSync(join(workArea, STOP_QUEUE_DIR, "d-retry.json")),
    ).toBe(true);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain("connection refused");
    // System error surface fires.
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const payload = recordSpy.mock.calls[0][0] as {
      source: string;
      severity: string;
    };
    expect(payload.source).toBe("stop-replay");
    expect(payload.severity).toBe("error");
  });

  it("processes multiple entries in a single pass", async () => {
    for (const id of ["a", "b", "c"]) {
      writeQueueFile(workArea, {
        dispatchId: id,
        status: "completed",
        summary: id,
        timestamp: new Date().toISOString(),
      });
    }
    const updates: string[] = [];
    const result = await replayStopQueue(makeRepo(workArea), {
      getDispatch: async (id) => fakeDispatch({ id }),
      updateDispatchFn: async (id) => {
        updates.push(id);
      },
      autoSync: async () => {},
      writeFlagFn: () =>
        ({
          timestamp: "",
          source: "agent",
          dispatchId: "",
          reason: "",
        }) as never,
    });
    expect(result.scanned).toBe(3);
    expect(result.replayed.sort()).toEqual(["a", "b", "c"]);
    expect(updates.sort()).toEqual(["a", "b", "c"]);
    expect(readdirSync(join(workArea, STOP_QUEUE_DIR))).toEqual([]);
  });

  it("records autoSync rejection but still keeps file for retry", async () => {
    writeQueueFile(workArea, {
      dispatchId: "d-sync",
      status: "completed",
      summary: "ok",
      timestamp: new Date().toISOString(),
    });

    const result = await replayStopQueue(makeRepo(workArea), {
      getDispatch: async (id) => fakeDispatch({ id }),
      updateDispatchFn: async () => {},
      autoSync: async () => {
        throw new Error("tracker push failed");
      },
      writeFlagFn: () =>
        ({
          timestamp: "",
          source: "agent",
          dispatchId: "",
          reason: "",
        }) as never,
    });

    // File stays on disk because autoSync rejection escaped — a stricter
    // contract than the live `handleStop` (which swallows tracker
    // errors), but the boot replay can afford to retry.
    expect(
      existsSync(join(workArea, STOP_QUEUE_DIR, "d-sync.json")),
    ).toBe(true);
    expect(result.failed).toHaveLength(1);
  });
});
