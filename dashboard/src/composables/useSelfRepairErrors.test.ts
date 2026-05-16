import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { ref } from "vue";
import type { Ref } from "vue";
import type { RepairErrorWithAttempts } from "../types";

/**
 * DX-565 (Phase 5 of DX-560 — Self-Repair) composable tests. Same
 * shape as `useDispatches.test.ts`:
 *
 *   - Pure reducer (`applyRepairErrorEvent`) tests with no mocks.
 *   - Integration tests against a captured-handle SSE stream mock.
 *   - Source guard for `setInterval` so the no-polling rule (DX-227)
 *     cannot regress in this file.
 */

const mockFetchRepairErrors = vi.fn();
vi.mock("../api", () => ({
  fetchRepairErrors: (...args: unknown[]) => mockFetchRepairErrors(...args),
}));

type Handler = (e: { topic: string; data: unknown }) => void;
type StreamMock = {
  connectionState: Ref<"connecting" | "connected" | "disconnected">;
  subscribe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  emit(topic: string, data: unknown): void;
  handlerCount(topic: string): number;
};

function makeStreamMock(): StreamMock {
  const handlers = new Map<string, Set<Handler>>();
  return {
    connectionState: ref<"connecting" | "connected" | "disconnected">("connected"),
    subscribe: vi.fn().mockImplementation((topic: string, h: Handler) => {
      if (!handlers.has(topic)) handlers.set(topic, new Set());
      handlers.get(topic)!.add(h);
      return () => handlers.get(topic)?.delete(h);
    }),
    disconnect: vi.fn(),
    emit(topic, data) {
      handlers.get(topic)?.forEach((h) => h({ topic, data }));
    },
    handlerCount(topic) {
      return handlers.get(topic)?.size ?? 0;
    },
  };
}

let currentStream: StreamMock;
vi.mock("./useStream", async () => {
  const actual = await vi.importActual<typeof import("./useStream")>("./useStream");
  return {
    ...actual,
    useStream: () => currentStream,
  };
});

import { useSelfRepairErrors, applyRepairErrorEvent } from "./useSelfRepairErrors";

function makeRow(id: number, overrides: Partial<RepairErrorWithAttempts["error"]> = {}): RepairErrorWithAttempts {
  return {
    error: {
      id,
      signature_hash: `h${id}`,
      category_key: "foo:Error",
      component: "foo",
      err_class: "Error",
      normalized_msg: `msg-${id}`,
      sample_payload: { raw_msg: `msg-${id}` },
      count: 1,
      first_seen: new Date("2026-05-15T00:00:00Z"),
      last_seen: new Date("2026-05-15T00:00:00Z"),
      status: "open",
      repo: "danxbot",
      recurrence_count: 0,
      ...overrides,
    },
    attempts: [],
  };
}

describe("applyRepairErrorEvent — reducer", () => {
  it("inserts a new row sorted by count DESC", () => {
    const state = [makeRow(1, { count: 1 }), makeRow(2, { count: 3 })];
    const next = applyRepairErrorEvent(state, {
      error_id: 3,
      row: makeRow(3, { count: 5 }),
    });
    expect(next.map((e) => e.error.id)).toEqual([3, 2, 1]);
  });

  it("upserts an existing row in place and resorts", () => {
    const state = [makeRow(1, { count: 5 }), makeRow(2, { count: 1 })];
    const next = applyRepairErrorEvent(state, {
      error_id: 2,
      row: makeRow(2, { count: 10 }),
    });
    expect(next.map((e) => e.error.id)).toEqual([2, 1]);
  });

  it("removes a row when payload.removed = true", () => {
    const state = [makeRow(1), makeRow(2), makeRow(3)];
    const next = applyRepairErrorEvent(state, { error_id: 2, removed: true });
    expect(next.map((e) => e.error.id)).toEqual([1, 3]);
  });

  it("ignores a remove event for an unknown id", () => {
    const state = [makeRow(1), makeRow(2)];
    const next = applyRepairErrorEvent(state, { error_id: 99, removed: true });
    expect(next).toBe(state);
  });
});

describe("useSelfRepairErrors — stream integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    currentStream = makeStreamMock();
    mockFetchRepairErrors.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function importFresh() {
    return await import("./useSelfRepairErrors");
  }

  it("contains no setInterval (source check — DX-227 no-polling guard)", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.resolve(__dirname, "useSelfRepairErrors.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/setInterval\s*\(/);
    expect(source).not.toMatch(/setTimeout\s*\(/);
  });

  it("init() hydrates via REST then subscribes to system-repair-error:updated", async () => {
    const { useSelfRepairErrors } = await importFresh();
    mockFetchRepairErrors.mockResolvedValueOnce([makeRow(1)]);

    const { init, errors, destroy } = useSelfRepairErrors();
    init();
    await flushPromises();

    expect(mockFetchRepairErrors).toHaveBeenCalledOnce();
    expect(errors.value.map((e) => e.error.id)).toEqual([1]);
    expect(currentStream.handlerCount("system-repair-error:updated")).toBe(1);
    destroy();
  });

  it("applies a live update to the local snapshot", async () => {
    const { useSelfRepairErrors } = await importFresh();
    mockFetchRepairErrors.mockResolvedValueOnce([makeRow(1, { count: 1 })]);
    const { init, errors, destroy } = useSelfRepairErrors();
    init();
    await flushPromises();

    currentStream.emit("system-repair-error:updated", {
      error_id: 1,
      row: makeRow(1, { count: 7, status: "repairing" }),
    });
    expect(errors.value[0].error.count).toBe(7);
    expect(errors.value[0].error.status).toBe("repairing");
    destroy();
  });

  it("unfixableCount reflects rows with status='unfixable'", async () => {
    const { useSelfRepairErrors } = await importFresh();
    mockFetchRepairErrors.mockResolvedValueOnce([
      makeRow(1, { status: "open" }),
      makeRow(2, { status: "unfixable" }),
      makeRow(3, { status: "unfixable" }),
    ]);
    const { init, unfixableCount, destroy } = useSelfRepairErrors();
    init();
    await flushPromises();
    expect(unfixableCount.value).toBe(2);
    destroy();
  });

  it("buffers events that arrive during REST hydrate and applies them post-hydrate", async () => {
    const { useSelfRepairErrors } = await importFresh();
    // Stall the fetch on purpose so the test can emit a stream event
    // mid-flight before the REST snapshot resolves.
    let resolveFetch!: (rows: RepairErrorWithAttempts[]) => void;
    const pending = new Promise<RepairErrorWithAttempts[]>((res) => {
      resolveFetch = res;
    });
    mockFetchRepairErrors.mockReturnValueOnce(pending);

    const { init, errors, destroy } = useSelfRepairErrors();
    init();
    // Stream event arrives BEFORE the fetch resolves — must be buffered.
    currentStream.emit("system-repair-error:updated", {
      error_id: 99,
      row: makeRow(99, { count: 1 }),
    });
    // Now resolve the fetch with a different row; the buffered event
    // gets replayed on top of the resolved snapshot.
    resolveFetch([makeRow(1, { count: 5 })]);
    await flushPromises();

    expect(errors.value.map((e) => e.error.id).sort()).toEqual([1, 99]);
    destroy();
  });

  it("re-hydrates with the new filter when selectedRepo changes", async () => {
    const { useSelfRepairErrors } = await importFresh();
    mockFetchRepairErrors.mockResolvedValueOnce([makeRow(1)]);
    const { init, selectedRepo, destroy } = useSelfRepairErrors();
    init();
    await flushPromises();

    mockFetchRepairErrors.mockResolvedValueOnce([makeRow(2)]);
    selectedRepo.value = "other-repo";
    await flushPromises();

    expect(mockFetchRepairErrors).toHaveBeenCalledTimes(2);
    expect(mockFetchRepairErrors.mock.calls[1][0]).toMatchObject({
      repo: "other-repo",
    });
    destroy();
  });

  it("drops malformed events (missing error_id) and leaves state untouched", async () => {
    const { useSelfRepairErrors } = await importFresh();
    mockFetchRepairErrors.mockResolvedValueOnce([makeRow(1)]);
    const { init, errors, destroy } = useSelfRepairErrors();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    init();
    await flushPromises();

    currentStream.emit("system-repair-error:updated", { wrong: "shape" });
    expect(errors.value.map((e) => e.error.id)).toEqual([1]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    destroy();
  });

  it("destroy() unsubscribes the SSE handler and stops the filter watcher", async () => {
    const { useSelfRepairErrors } = await importFresh();
    mockFetchRepairErrors.mockResolvedValueOnce([]);
    const { init, selectedRepo, destroy } = useSelfRepairErrors();
    init();
    await flushPromises();
    expect(currentStream.handlerCount("system-repair-error:updated")).toBe(1);

    destroy();
    expect(currentStream.handlerCount("system-repair-error:updated")).toBe(0);

    // After destroy, filter changes do NOT trigger a refetch.
    selectedRepo.value = "after-destroy";
    await flushPromises();
    expect(mockFetchRepairErrors).toHaveBeenCalledTimes(1);
  });

  it("surfaces fetch failures via the error ref", async () => {
    const { useSelfRepairErrors } = await importFresh();
    mockFetchRepairErrors.mockRejectedValueOnce(new Error("db down"));
    const { init, error, destroy } = useSelfRepairErrors();
    init();
    await flushPromises();
    expect(error.value).toMatch(/db down/);
    destroy();
  });
});
