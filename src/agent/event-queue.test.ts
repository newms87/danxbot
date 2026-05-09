import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventQueue } from "./event-queue.js";
import type { EventPayload } from "./laravel-forwarder.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "event-queue-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function qPath(name: string): string {
  return join(tempDir, `${name}.jsonl`);
}

function sampleBatch(label: string): EventPayload[] {
  return [
    { type: "agent_event", message: `${label}-1` },
    { type: "agent_event", message: `${label}-2` },
  ];
}

describe("EventQueue", () => {
  it("enqueue → peekAll returns the batch in order", async () => {
    const q = new EventQueue(qPath("d1"));
    await q.enqueue(sampleBatch("a"));
    await q.enqueue(sampleBatch("b"));

    const batches = await q.peekAll();
    expect(batches).toEqual([sampleBatch("a"), sampleBatch("b")]);
  });

  it("peekAll returns empty array when the queue file does not exist", async () => {
    const q = new EventQueue(qPath("missing"));
    expect(await q.peekAll()).toEqual([]);
  });

  it("hasPending reflects queue state", async () => {
    const q = new EventQueue(qPath("hp"));
    expect(await q.hasPending()).toBe(false);

    await q.enqueue(sampleBatch("x"));
    expect(await q.hasPending()).toBe(true);

    await q.clear();
    expect(await q.hasPending()).toBe(false);
  });

  it("enqueue([]) is a no-op (empty batches are not persisted)", async () => {
    const q = new EventQueue(qPath("empty"));
    await q.enqueue([]);
    expect(await q.hasPending()).toBe(false);
    expect(await q.peekAll()).toEqual([]);
  });

  it("retain([]) clears the queue file", async () => {
    const q = new EventQueue(qPath("retain-empty"));
    await q.enqueue(sampleBatch("x"));
    await q.retain([]);
    expect(await q.hasPending()).toBe(false);
    expect(existsSync(qPath("retain-empty"))).toBe(false);
  });

  it("retain(partialBatches) rewrites the queue with only those batches", async () => {
    const q = new EventQueue(qPath("retain"));
    await q.enqueue(sampleBatch("a"));
    await q.enqueue(sampleBatch("b"));
    await q.enqueue(sampleBatch("c"));

    // Simulate: batch "a" was successfully delivered; keep b and c.
    await q.retain([sampleBatch("b"), sampleBatch("c")]);

    const pending = await q.peekAll();
    expect(pending).toEqual([sampleBatch("b"), sampleBatch("c")]);
  });

  it("clear removes the file even when already empty (idempotent)", async () => {
    const q = new EventQueue(qPath("clear"));
    await q.clear();
    await q.clear();
    expect(await q.hasPending()).toBe(false);
  });

  it("a new EventQueue instance picks up state from a pre-existing file", async () => {
    // Simulates worker restart — the queue file survives.
    const path = qPath("survives");
    const q1 = new EventQueue(path);
    await q1.enqueue(sampleBatch("before-restart"));

    const q2 = new EventQueue(path);
    expect(await q2.peekAll()).toEqual([sampleBatch("before-restart")]);
  });

  it("tolerates a malformed trailing line (JSONL resumes on next enqueue)", async () => {
    const path = qPath("malformed");
    writeFileSync(
      path,
      `${JSON.stringify(sampleBatch("good"))}\n{not-json\n`,
    );
    const q = new EventQueue(path);
    // Bad line should be skipped, not crash.
    const batches = await q.peekAll();
    expect(batches).toEqual([sampleBatch("good")]);
  });

  it("creates the containing directory if it does not exist", () => {
    const deepPath = join(tempDir, "nested", "dispatch-xyz.jsonl");
    expect(() => new EventQueue(deepPath)).not.toThrow();
  });

  it("two queues with different paths are independent", async () => {
    const q1 = new EventQueue(qPath("one"));
    const q2 = new EventQueue(qPath("two"));
    await q1.enqueue(sampleBatch("to-one"));
    expect(await q1.peekAll()).toHaveLength(1);
    expect(await q2.peekAll()).toHaveLength(0);
  });

  // Regression for DX-13. Boot replay (replayQueueOnBoot) and the running
  // forwarder both reach `retain → writeFile` after `peekAll`. If a log
  // reaper or test teardown rm -rf's the parent dir between the two calls,
  // writeFile throws ENOENT. Without this swallow, replayQueueOnBoot has no
  // outer catch and the throw escapes — best-effort delivery becomes a
  // worker-crashing operation. peekAll, clear, and hasPending all swallow
  // ENOENT already; retain keeps the symmetry.
  it("retain swallows ENOENT and logs a warn instead of throwing", async () => {
    const subDir = join(tempDir, "reaper-race");
    const path = join(subDir, "d-race.jsonl");
    const q = new EventQueue(path);
    await q.enqueue(sampleBatch("a"));
    await q.enqueue(sampleBatch("b"));

    // Simulate a log reaper / test teardown wiping the parent dir between
    // peekAll() and retain(). Real boot path: peekAll reads a file that
    // exists, then a reaper rm -rf's the dir, then retain tries writeFile.
    rmSync(subDir, { recursive: true, force: true });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(q.retain([sampleBatch("b")])).resolves.toBeUndefined();

    const warnLines = errorSpy.mock.calls
      .map((c) => c[0] as string)
      .filter((line) => typeof line === "string" && line.includes('"level":"warn"'))
      .filter((line) => line.includes("event-queue"));
    expect(warnLines.length).toBeGreaterThanOrEqual(1);
    expect(warnLines[0]).toContain("ENOENT");
    expect(warnLines[0]).toContain(path);
    // Operator-facing fields — pinning these prevents a future agent from
    // dropping the batch count or dispatch id from the warn message.
    expect(warnLines[0]).toContain("batches_lost=1");
    expect(warnLines[0]).toContain("dispatch=d-race");
    errorSpy.mockRestore();
  });

  // Companion to the ENOENT swallow test: the catch must be narrow. A
  // future agent dropping the `if (code === "ENOENT")` guard and silently
  // eating every writeFile error would mask EROFS, ENOSPC, and EISDIR
  // failures the operator needs to see.
  it("retain re-throws non-ENOENT errors from writeFile", async () => {
    const subDir = join(tempDir, "is-a-dir");
    mkdirSync(subDir, { recursive: true });
    const path = join(subDir, "queue.jsonl");
    // Make the queue-file path itself a directory → writeFile errors with
    // EISDIR (not ENOENT). The constructor's mkdirSync targets dirname,
    // which is subDir (already exists), so construction still succeeds.
    // POSIX (Linux/macOS) returns EISDIR; Windows would return EPERM. The
    // danxbot test suite runs on Linux/macOS only, so this trick is stable.
    mkdirSync(path);

    const q = new EventQueue(path);
    await expect(q.retain([sampleBatch("x")])).rejects.toMatchObject({
      code: "EISDIR",
    });
  });
});
