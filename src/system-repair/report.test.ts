import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool } from "pg";
import { reportSystemError, _resetWarnDedupForTest } from "./report.js";

/**
 * DX-562 — the wrapper's contract is "never throws, never rejects."
 * Tests pin the swallow paths (DB rejects, getPool throws, non-Error
 * input) + the success path (recordError called once with normalized
 * args + stack capped at 5 frames).
 *
 * No real Postgres needed — we inject a stub `db` via the test seam.
 */

function makeStubPool(queryImpl: (sql: string) => unknown): Pool {
  return {
    query: vi.fn(async (sql: string) => {
      const out = queryImpl(sql);
      return Promise.resolve(out);
    }),
  } as unknown as Pool;
}

const INSERT_ROW = {
  id: 1,
  signature_hash: "abcd1234abcd1234",
  category_key: "test-component:Error",
  component: "test-component",
  err_class: "Error",
  normalized_msg: "boom",
  sample_payload: { raw_msg: "boom" },
  count: 1,
  first_seen: new Date(),
  last_seen: new Date(),
  status: "open",
  repo: "danxbot",
};

describe("reportSystemError — success path", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _resetWarnDedupForTest();
  });

  it("calls db.query exactly once and resolves", async () => {
    const stub = makeStubPool(() => ({ rows: [INSERT_ROW] }));
    await reportSystemError({
      repo: "danxbot",
      component: "test-component",
      err: new Error("boom"),
      db: stub,
    });
    expect(stub.query).toHaveBeenCalledTimes(1);
  });

  it("caps the stack at 5 frames in the sample payload", async () => {
    const longStack = Array.from({ length: 20 }, (_, i) => `  at frame${i}`).join("\n");
    const err = new Error("boom");
    err.stack = `Error: boom\n${longStack}`;
    let captured: SamplePayloadCapture | null = null;
    const stub = makeStubPool(() => {
      // Capture happens in the parameter array via vi.fn — read it after.
      return { rows: [INSERT_ROW] };
    });
    (stub.query as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_sql: string, params: unknown[]) => {
        captured = { payload: JSON.parse(params[5] as string) };
        return { rows: [INSERT_ROW] };
      },
    );
    await reportSystemError({
      repo: "danxbot",
      component: "test-component",
      err,
      db: stub,
    });
    expect(captured).not.toBeNull();
    const stackLines = (captured!.payload.stack as string).split("\n");
    expect(stackLines).toHaveLength(5);
    expect(stackLines[0]).toBe("Error: boom");
    expect(stackLines[4]).toBe("  at frame3");
  });

  it("rejects caller attempts to overwrite the 5-frame stack cap", async () => {
    // Caller fields land FIRST so wrapper-derived stack / raw_msg
    // win — code reviewer NIT during DX-562. Otherwise a caller
    // accidentally passing a full stack via samplePayload.stack
    // would silently defeat the cap.
    const longStack = Array.from({ length: 20 }, (_, i) => `  at frame${i}`).join("\n");
    const err = new Error("boom");
    err.stack = `Error: boom\n${longStack}`;
    let captured: SamplePayloadCapture | null = null;
    const stub = makeStubPool(() => ({ rows: [INSERT_ROW] }));
    (stub.query as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_sql: string, params: unknown[]) => {
        captured = { payload: JSON.parse(params[5] as string) };
        return { rows: [INSERT_ROW] };
      },
    );
    await reportSystemError({
      repo: "danxbot",
      component: "test-component",
      err,
      samplePayload: {
        // Caller tries to inject a 100-frame "stack" — wrapper must overwrite.
        stack: "PAYLOAD_INJECTED_STACK\n".repeat(100),
      },
      db: stub,
    });
    const stackLines = (captured!.payload.stack as string).split("\n");
    expect(stackLines).toHaveLength(5);
    expect(stackLines[0]).toBe("Error: boom");
    expect(captured!.payload.stack).not.toMatch(/PAYLOAD_INJECTED_STACK/);
  });

  it("merges caller-supplied samplePayload fields (path, issue_id)", async () => {
    let captured: SamplePayloadCapture | null = null;
    const stub = makeStubPool(() => ({ rows: [INSERT_ROW] }));
    (stub.query as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_sql: string, params: unknown[]) => {
        captured = { payload: JSON.parse(params[5] as string) };
        return { rows: [INSERT_ROW] };
      },
    );
    await reportSystemError({
      repo: "danxbot",
      component: "issues-mirror",
      err: new Error("boom"),
      samplePayload: { path: "/x/y/DX-525.yml", issue_id: "DX-525" },
      db: stub,
    });
    expect(captured!.payload.path).toBe("/x/y/DX-525.yml");
    expect(captured!.payload.issue_id).toBe("DX-525");
    expect(captured!.payload.raw_msg).toBe("boom");
  });
});

describe("reportSystemError — swallow paths", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    _resetWarnDedupForTest();
  });

  it("does not throw when db.query rejects (DB hiccup)", async () => {
    const stub = makeStubPool(() => {
      throw new Error("PG pool dead");
    });
    // The `try { queryImpl }` happens inside our stub; here we need a
    // promise-rejecting stub instead.
    (stub.query as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error("PG pool dead");
    });
    await expect(
      reportSystemError({
        repo: "danxbot",
        component: "test-component",
        err: new Error("boom"),
        db: stub,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when err is a non-Error value (string)", async () => {
    const stub = makeStubPool(() => ({ rows: [INSERT_ROW] }));
    await expect(
      reportSystemError({
        repo: "danxbot",
        component: "test-component",
        err: "string error message",
        db: stub,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when err is a non-Error value (object)", async () => {
    const stub = makeStubPool(() => ({ rows: [INSERT_ROW] }));
    await expect(
      reportSystemError({
        repo: "danxbot",
        component: "test-component",
        err: { weird: "shape" },
        db: stub,
      }),
    ).resolves.toBeUndefined();
  });

  it("swallows DB writes via the pool query rejecting with a real Error", async () => {
    const stub = {
      query: vi.fn().mockRejectedValue(new Error("relation \"system_errors\" does not exist")),
    } as unknown as Pool;
    await expect(
      reportSystemError({
        repo: "danxbot",
        component: "issues-mirror",
        err: new Error("boom"),
        db: stub,
      }),
    ).resolves.toBeUndefined();
    expect(stub.query).toHaveBeenCalledTimes(1);
  });

  it("rate-limits warn logs to one per (component, errMsg) per process lifetime", async () => {
    const stub = {
      query: vi.fn().mockRejectedValue(new Error("recurring boom")),
    } as unknown as Pool;
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Call 5× with the SAME component + err.message — wrapper still
    // attempts the DB write each time (count would increment if the
    // table existed), but only the first one emits a warn line.
    for (let i = 0; i < 5; i++) {
      await reportSystemError({
        repo: "danxbot",
        component: "issues-mirror",
        err: new Error("recurring boom"),
        db: stub,
      });
    }
    expect(stub.query).toHaveBeenCalledTimes(5);
    // Logger writes to stdout — count warn-level lines.
    const warnLines = warnSpy.mock.calls
      .map((c) => c[0])
      .filter((line): line is string =>
        typeof line === "string" && line.includes("\"level\":\"warn\""),
      );
    expect(warnLines.filter((l) => l.includes("issues-mirror"))).toHaveLength(1);
  });

  it("emits separate warn lines for DIFFERENT (component, errMsg) pairs", async () => {
    const stub = {
      query: vi.fn().mockRejectedValue(new Error("dead pool")),
    } as unknown as Pool;
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await reportSystemError({
      repo: "danxbot",
      component: "issues-mirror",
      err: new Error("dead pool"),
      db: stub,
    });
    await reportSystemError({
      repo: "danxbot",
      component: "audit-pass",
      err: new Error("dead pool"),
      db: stub,
    });
    const warnLines = warnSpy.mock.calls
      .map((c) => c[0])
      .filter((line): line is string =>
        typeof line === "string" && line.includes("\"level\":\"warn\""),
      );
    expect(warnLines.filter((l) => l.includes("issues-mirror"))).toHaveLength(1);
    expect(warnLines.filter((l) => l.includes("audit-pass"))).toHaveLength(1);
  });

  it("does not throw when the wrapper falls through to the shared getPool() and the DB hiccups", async () => {
    // No `db` override → wrapper resolves the shared pool via
    // `getPool()`. In the test process this either resolves a real
    // local pool (whose `system_errors` table may be absent on a
    // fresh fixture) or throws a configuration error if no PG env
    // vars are set. Either way, the wrapper must swallow.
    await expect(
      reportSystemError({
        repo: "danxbot",
        component: "test-component",
        err: new Error("boom"),
      }),
    ).resolves.toBeUndefined();
  });
});

interface SamplePayloadCapture {
  payload: Record<string, unknown>;
}
