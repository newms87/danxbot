import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getPool,
  getThreadPoolStats,
  destroyPool,
  runCanonicalHash,
  runJsonStringify,
  runParseYamlBatch,
  _resetPoolForTests,
} from "./pool.js";
import { canonicalize, sha256 } from "../db/canonicalize.js";

describe("threadpool/pool", () => {
  beforeEach(() => {
    _resetPoolForTests();
    delete process.env.DANXBOT_THREADPOOL_SIZE;
  });

  afterEach(async () => {
    await destroyPool();
  });

  it("returns default stats (size:2, active:0, queued:0) before any task runs", () => {
    const stats = getThreadPoolStats();
    expect(stats).toEqual({ size: 2, active: 0, queued: 0 });
  });

  it("respects DANXBOT_THREADPOOL_SIZE for default size", () => {
    process.env.DANXBOT_THREADPOOL_SIZE = "4";
    expect(getThreadPoolStats().size).toBe(4);
  });

  it("ignores invalid DANXBOT_THREADPOOL_SIZE and falls back to default", () => {
    process.env.DANXBOT_THREADPOOL_SIZE = "not-a-number";
    expect(getThreadPoolStats().size).toBe(2);
    process.env.DANXBOT_THREADPOOL_SIZE = "0";
    expect(getThreadPoolStats().size).toBe(2);
  });

  it("getPool returns the same singleton on repeat calls", () => {
    const a = getPool();
    const b = getPool();
    expect(a).toBe(b);
  });

  it("destroyPool is idempotent when no pool was ever created", async () => {
    await expect(destroyPool()).resolves.toBeUndefined();
  });

  it("runJsonStringify rejects undefined fail-loud", async () => {
    await expect(runJsonStringify(undefined)).rejects.toThrow(
      /value must be defined/,
    );
  });

  it("runCanonicalHash returns the same bytes + hash as the sync helper", async () => {
    const value = { id: "DX-1", title: "T", nested: { z: 1, a: 2 } };
    const out = await runCanonicalHash(value);
    expect(out.canonical).toBe(canonicalize(value));
    expect(out.hash).toBe(sha256(canonicalize(value)));
  }, 20_000);

  it("runJsonStringify matches JSON.stringify", async () => {
    const value = { x: [1, 2, { y: "z" }], n: null };
    expect(await runJsonStringify(value)).toBe(JSON.stringify(value));
  }, 20_000);

  it("runParseYamlBatch parses a batch via worker_threads", async () => {
    const out = await runParseYamlBatch([
      "id: DX-1\ntitle: A",
      "id: DX-2\ntitle: B",
    ]);
    expect(out).toEqual([
      { ok: true, data: { id: "DX-1", title: "A" } },
      { ok: true, data: { id: "DX-2", title: "B" } },
    ]);
  }, 20_000);

  it("after a task runs, stats reflect the pool's live state (size:2)", async () => {
    await runCanonicalHash({ id: "DX-1", title: "T" });
    const stats = getThreadPoolStats();
    expect(stats.size).toBe(2);
    expect(stats.queued).toBe(0);
  }, 20_000);
});
