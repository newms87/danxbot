/**
 * DX-569 (Phase 6a of DX-560): unit tests for the dashboard-side
 * `system_errors` DB-poll → SSE bridge. Pins the diff contract that
 * makes worker-side writes visible to dashboard SSE subscribers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mockPublish = vi.fn();
vi.mock("./event-bus.js", () => ({
  eventBus: {
    publish: (...args: unknown[]) => mockPublish(...args),
  },
}));

const mockGetDetail = vi.fn();
vi.mock("../system-repair/db-reads.js", () => ({
  getRepairErrorDetail: (...args: unknown[]) => mockGetDetail(...args),
}));

vi.mock("../db/connection.js", () => ({
  getPool: () => ({ query: vi.fn() }),
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
  startSelfRepairStream,
  stopSelfRepairStream,
  type StartSelfRepairStreamOptions,
} from "./self-repair-stream.js";

interface FakeRow {
  id: number;
  status: string;
  count: number;
  last_seen: string;
  attempt_count: number;
}

function makeDbPool(rowsQueue: FakeRow[][]) {
  const query = vi.fn().mockImplementation(async () => {
    const rows = rowsQueue.length > 1 ? rowsQueue.shift()! : rowsQueue[0] ?? [];
    return { rows };
  });
  return { query } as unknown as StartSelfRepairStreamOptions["db"];
}

async function flushAsync(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  stopSelfRepairStream();
  mockGetDetail.mockResolvedValue({
    error: { id: 1, status: "open" },
    attempts: [],
  });
});

afterEach(() => {
  stopSelfRepairStream();
  vi.useRealTimers();
});

describe("startSelfRepairStream — DB → SSE diff bridge", () => {
  it("publishes system-repair-error:updated for a new row on the seed tick", async () => {
    const db = makeDbPool([
      [{ id: 1, status: "open", count: 3, last_seen: "2026-05-15T22:00:00Z", attempt_count: 0 }],
    ]);
    mockGetDetail.mockResolvedValueOnce({
      error: { id: 1, status: "open", count: 3 },
      attempts: [],
    });

    startSelfRepairStream({ db, pollIntervalMs: 1_000 });
    await flushAsync();

    expect(mockPublish).toHaveBeenCalledWith({
      topic: "system-repair-error:updated",
      data: {
        error_id: 1,
        row: { error: { id: 1, status: "open", count: 3 }, attempts: [] },
      },
    });
  });

  it("does NOT re-publish a row whose snapshot has not changed across ticks", async () => {
    const row: FakeRow = {
      id: 1,
      status: "open",
      count: 3,
      last_seen: "2026-05-15T22:00:00Z",
      attempt_count: 0,
    };
    const db = makeDbPool([[row]]);

    startSelfRepairStream({ db, pollIntervalMs: 1_000 });
    await flushAsync();
    mockPublish.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsync();

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("publishes again when status flips", async () => {
    const initial: FakeRow = {
      id: 1,
      status: "open",
      count: 3,
      last_seen: "2026-05-15T22:00:00Z",
      attempt_count: 0,
    };
    const changed: FakeRow = { ...initial, status: "repairing" };
    const db = makeDbPool([[initial], [changed]]);
    mockGetDetail.mockResolvedValue({
      error: { id: 1, status: "repairing" },
      attempts: [],
    });

    startSelfRepairStream({ db, pollIntervalMs: 1_000 });
    await flushAsync();
    mockPublish.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsync();

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0][0]).toMatchObject({
      topic: "system-repair-error:updated",
      data: { error_id: 1 },
    });
  });

  it("publishes again when attempt_count grows (a new repair attempt landed)", async () => {
    const t0: FakeRow = {
      id: 1,
      status: "repairing",
      count: 3,
      last_seen: "2026-05-15T22:00:00Z",
      attempt_count: 1,
    };
    const t1: FakeRow = { ...t0, attempt_count: 2 };
    const db = makeDbPool([[t0], [t1]]);

    startSelfRepairStream({ db, pollIntervalMs: 1_000 });
    await flushAsync();
    mockPublish.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsync();

    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it("emits removed:true with the cached id when a tracked row disappears from the DB", async () => {
    const db = makeDbPool([
      [
        {
          id: 42,
          status: "open",
          count: 3,
          last_seen: "2026-05-15T22:00:00Z",
          attempt_count: 0,
        },
      ],
      [],
    ]);

    startSelfRepairStream({ db, pollIntervalMs: 1_000 });
    await flushAsync();
    mockPublish.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsync();

    expect(mockPublish).toHaveBeenCalledWith({
      topic: "system-repair-error:updated",
      data: { error_id: 42, removed: true },
    });
  });

  it("emits removed:true when getRepairErrorDetail returns null mid-tick (row deleted between snapshot + detail)", async () => {
    const db = makeDbPool([
      [
        {
          id: 7,
          status: "open",
          count: 1,
          last_seen: "2026-05-15T22:00:00Z",
          attempt_count: 0,
        },
      ],
    ]);
    mockGetDetail.mockResolvedValueOnce(null);

    startSelfRepairStream({ db, pollIntervalMs: 1_000 });
    await flushAsync();

    expect(mockPublish).toHaveBeenCalledWith({
      topic: "system-repair-error:updated",
      data: { error_id: 7, removed: true },
    });
  });

  it("is idempotent — startSelfRepairStream called twice does not double-fire the seed tick", async () => {
    const db = makeDbPool([
      [
        {
          id: 1,
          status: "open",
          count: 1,
          last_seen: "2026-05-15T22:00:00Z",
          attempt_count: 0,
        },
      ],
    ]);

    startSelfRepairStream({ db, pollIntervalMs: 1_000 });
    startSelfRepairStream({ db, pollIntervalMs: 1_000 });
    await flushAsync();

    expect((db!.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("swallows DB errors and continues polling on the next tick", async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            status: "open",
            count: 1,
            last_seen: "2026-05-15T22:00:00Z",
            attempt_count: 0,
          },
        ],
      });
    const db = { query } as unknown as StartSelfRepairStreamOptions["db"];

    startSelfRepairStream({ db, pollIntervalMs: 1_000 });
    await flushAsync(); // bad tick — swallowed
    mockPublish.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsync();

    expect(mockPublish).toHaveBeenCalled();
  });

  it("treats a Date last_seen and its toISOString() form as the same snapshot (pg-driver coercion guard)", async () => {
    const isoDate = "2026-05-15T22:00:00.000Z";
    const t0: FakeRow = {
      id: 1,
      status: "open",
      count: 1,
      last_seen: new Date(isoDate) as unknown as string,
      attempt_count: 0,
    };
    const t1: FakeRow = {
      ...t0,
      last_seen: isoDate,
    };
    const db = makeDbPool([[t0], [t1]]);

    startSelfRepairStream({ db, pollIntervalMs: 1_000 });
    await flushAsync();
    mockPublish.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsync();

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("treats attempt_count returned as a numeric string the same as the equivalent number (pg COUNT bigint guard)", async () => {
    const t0: FakeRow = {
      id: 1,
      status: "repairing",
      count: 3,
      last_seen: "2026-05-15T22:00:00.000Z",
      attempt_count: "2" as unknown as number,
    };
    const t1: FakeRow = { ...t0, attempt_count: "2" as unknown as number };
    const db = makeDbPool([[t0], [t1]]);

    startSelfRepairStream({ db, pollIntervalMs: 1_000 });
    await flushAsync();
    mockPublish.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsync();

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("stopSelfRepairStream clears knownErrors so the next start re-publishes the same row", async () => {
    const row: FakeRow = {
      id: 1,
      status: "open",
      count: 1,
      last_seen: "2026-05-15T22:00:00.000Z",
      attempt_count: 0,
    };
    const db1 = makeDbPool([[row]]);
    startSelfRepairStream({ db: db1, pollIntervalMs: 1_000 });
    await flushAsync();
    expect(mockPublish).toHaveBeenCalledTimes(1);

    stopSelfRepairStream();
    mockPublish.mockClear();

    const db2 = makeDbPool([[row]]);
    startSelfRepairStream({ db: db2, pollIntervalMs: 1_000 });
    await flushAsync();

    // State was cleared on stop, so the new dashboard process re-publishes.
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it("stopSelfRepairStream halts the poller", async () => {
    const db = makeDbPool([
      [
        {
          id: 1,
          status: "open",
          count: 1,
          last_seen: "2026-05-15T22:00:00Z",
          attempt_count: 0,
        },
      ],
    ]);

    startSelfRepairStream({ db, pollIntervalMs: 1_000 });
    await flushAsync();
    stopSelfRepairStream();

    const queryFn = db!.query as ReturnType<typeof vi.fn>;
    const callsBefore = queryFn.mock.calls.length;

    await vi.advanceTimersByTimeAsync(5_000);
    await flushAsync();

    expect(queryFn.mock.calls.length).toBe(callsBefore);
  });
});
