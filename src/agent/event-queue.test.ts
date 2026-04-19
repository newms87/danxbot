import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
});
