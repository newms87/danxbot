import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub out the db module so importing the helper doesn't pull
// `db/connection.ts`'s env-var requirements (DANXBOT_DB_*) into the test
// harness. The helper takes `updateDispatchFn` as an injectable option so
// every test passes its own mock; the import is just for the default
// export (never used in these tests).
vi.mock("../dashboard/dispatches-db.js", () => ({
  updateDispatch: vi.fn().mockResolvedValue(undefined),
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
  pairedWriteHostPid,
  PairedHostPidWriteError,
} from "./paired-host-pid-write.js";

describe("pairedWriteHostPid", () => {
  const dispatchId = "test-dispatch-1";
  const pid = 12345;
  let updateDispatch: ReturnType<
    typeof vi.fn<(id: string, updates: Record<string, unknown>) => Promise<void>>
  >;
  let yamlWrite: ReturnType<typeof vi.fn<(pid: number) => void>>;
  let yamlClear: ReturnType<typeof vi.fn<() => void>>;
  const fakeNow = () => 1_700_000_000_000;

  beforeEach(() => {
    updateDispatch = vi.fn<
      (id: string, updates: Record<string, unknown>) => Promise<void>
    >().mockResolvedValue(undefined);
    yamlWrite = vi.fn<(pid: number) => void>();
    yamlClear = vi.fn<() => void>();
  });

  it("stamps DB host_pid + YAML dispatch.pid with the same value when both succeed", async () => {
    await pairedWriteHostPid({
      dispatchId,
      pid,
      yaml: { write: yamlWrite, clear: yamlClear },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateDispatchFn: updateDispatch as any,
      now: fakeNow,
    });

    // YAML stamped with the agent PID
    expect(yamlWrite).toHaveBeenCalledTimes(1);
    expect(yamlWrite).toHaveBeenCalledWith(pid);

    // DB UPDATE carries the SAME PID + the stamping timestamp
    expect(updateDispatch).toHaveBeenCalledTimes(1);
    expect(updateDispatch).toHaveBeenCalledWith(dispatchId, {
      hostPid: pid,
      hostPidAt: fakeNow(),
    });

    // No rollback fired
    expect(yamlClear).not.toHaveBeenCalled();
  });

  it("rolls back DB host_pid + marks dispatch failed when the YAML write fails", async () => {
    const yamlErr = new Error("disk full");
    yamlWrite.mockImplementation(() => {
      throw yamlErr;
    });

    await expect(
      pairedWriteHostPid({
        dispatchId,
        pid,
        yaml: { write: yamlWrite, clear: yamlClear },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        updateDispatchFn: updateDispatch as any,
        now: fakeNow,
      }),
    ).rejects.toBeInstanceOf(PairedHostPidWriteError);

    // YAML failed first, so DB UPDATE for the stamp NEVER ran. Only the
    // failure-mark UPDATE fires.
    expect(updateDispatch).toHaveBeenCalledTimes(1);
    expect(updateDispatch).toHaveBeenCalledWith(dispatchId, {
      status: "failed",
      summary: "Paired host_pid write rolled back",
      completedAt: fakeNow(),
      hostPid: null,
      hostPidAt: null,
      pidTerminatedAt: fakeNow(),
    });

    // YAML clear is NOT called when the YAML write itself failed —
    // there's nothing to clear.
    expect(yamlClear).not.toHaveBeenCalled();
  });

  it("clears the YAML dispatch.pid + marks dispatch failed when the DB UPDATE fails", async () => {
    const dbErr = new Error("MySQL gone away");
    let stampCallCount = 0;
    updateDispatch.mockImplementation(async () => {
      stampCallCount++;
      // First call (the host_pid stamp) fails. Second call (the failure
      // mark) is allowed through so the rollback's bookkeeping completes.
      if (stampCallCount === 1) throw dbErr;
    });

    const err = await pairedWriteHostPid({
      dispatchId,
      pid,
      yaml: { write: yamlWrite, clear: yamlClear },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateDispatchFn: updateDispatch as any,
      now: fakeNow,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(PairedHostPidWriteError);
    expect((err as PairedHostPidWriteError).dbError).toBe(dbErr);

    // YAML stamp ran (success); DB stamp ran (failure); YAML clear ran
    // (rollback); failure-mark UPDATE ran.
    expect(yamlWrite).toHaveBeenCalledTimes(1);
    expect(yamlClear).toHaveBeenCalledTimes(1);
    expect(updateDispatch).toHaveBeenCalledTimes(2);

    // The failure-mark UPDATE is always the last call.
    expect(updateDispatch).toHaveBeenLastCalledWith(dispatchId, {
      status: "failed",
      summary: "Paired host_pid write rolled back",
      completedAt: fakeNow(),
      hostPid: null,
      hostPidAt: null,
      pidTerminatedAt: fakeNow(),
    });
  });

  it("does only the DB stamp (no YAML) when called with no yaml callback — Slack / api-launch path", async () => {
    await pairedWriteHostPid({
      dispatchId,
      pid,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateDispatchFn: updateDispatch as any,
      now: fakeNow,
    });

    expect(updateDispatch).toHaveBeenCalledTimes(1);
    expect(updateDispatch).toHaveBeenCalledWith(dispatchId, {
      hostPid: pid,
      hostPidAt: fakeNow(),
    });
  });
});
