/**
 * DX-565 (Phase 5): `publishRepairErrorUpdated` fetches the post-write
 * snapshot via `getRepairErrorDetail` and publishes it to the
 * `system-repair-error:updated` topic on the shared event bus. Errors
 * are swallowed — a failed publish must never propagate to the write
 * path that triggered it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { detailSpy } = vi.hoisted(() => ({ detailSpy: vi.fn() }));
vi.mock("./db-reads.js", () => ({
  getRepairErrorDetail: detailSpy,
}));

import { publishRepairErrorUpdated } from "./publish.js";
import type { BusEvent } from "../dashboard/event-bus.js";

beforeEach(() => {
  detailSpy.mockReset();
});

function makeBus() {
  return { publish: vi.fn((_e: BusEvent) => {}) };
}

const fakeDb = {} as never;

describe("publishRepairErrorUpdated", () => {
  it("publishes the full {error, attempts} snapshot on hit", async () => {
    const snapshot = {
      error: { id: 7, status: "open" },
      attempts: [{ id: 1, attempt_n: 1 }],
    };
    detailSpy.mockResolvedValueOnce(snapshot);
    const bus = makeBus();
    await publishRepairErrorUpdated({ db: fakeDb, errorId: 7, bus });
    expect(bus.publish).toHaveBeenCalledWith({
      topic: "system-repair-error:updated",
      data: { error_id: 7, row: snapshot },
    });
  });

  it("publishes a removed payload when the row no longer exists", async () => {
    detailSpy.mockResolvedValueOnce(null);
    const bus = makeBus();
    await publishRepairErrorUpdated({ db: fakeDb, errorId: 7, bus });
    expect(bus.publish).toHaveBeenCalledWith({
      topic: "system-repair-error:updated",
      data: { error_id: 7, removed: true },
    });
  });

  it("swallows fetch failures (never throws)", async () => {
    detailSpy.mockRejectedValueOnce(new Error("db down"));
    const bus = makeBus();
    await expect(
      publishRepairErrorUpdated({ db: fakeDb, errorId: 7, bus }),
    ).resolves.toBeUndefined();
    expect(bus.publish).not.toHaveBeenCalled();
  });
});
