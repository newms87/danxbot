import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREP_VERDICTS,
  isPrepVerdict,
  parsePrepVerdictArgs,
  mapTerminalVerdictToDispatchStatus,
  writePrepVerdictFsQueueEntry,
  callDanxbotPrepVerdict,
  PREP_VERDICT_QUEUE_DIR,
} from "./danxbot-prep-verdict.js";

describe("PREP_VERDICTS — verdict literals", () => {
  it("exposes the five expected values in declaration order", () => {
    // Pin the literal order so a future shrink (e.g. accidentally dropping
    // `abort`) surfaces here, not as a silent route mis-dispatch. Mirrors
    // the COMPLETE_STATUSES pinning test in danxbot-server.test.ts.
    // waiting_on re-introduced 2026-05-15 as a separate verdict for
    // one-way sequential precedence (distinct from conflict_on's
    // symmetric file-overlap mutex).
    expect([...PREP_VERDICTS]).toEqual([
      "ok",
      "conflict_on",
      "waiting_on",
      "blocked",
      "abort",
    ]);
  });

  it("isPrepVerdict accepts every value and rejects junk", () => {
    for (const v of PREP_VERDICTS) {
      expect(isPrepVerdict(v)).toBe(true);
    }
    expect(isPrepVerdict("")).toBe(false);
    expect(isPrepVerdict(undefined)).toBe(false);
    expect(isPrepVerdict(null)).toBe(false);
    expect(isPrepVerdict(42)).toBe(false);
  });
});

describe("parsePrepVerdictArgs — happy paths", () => {
  it("accepts a minimal ok verdict", () => {
    const out = parsePrepVerdictArgs({
      verdict: "ok",
      reason: "no overlap with any open card",
    });
    expect(out).toEqual({
      verdict: "ok",
      reason: "no overlap with any open card",
    });
  });

  it("accepts a conflict_on verdict with conflict_with[]", () => {
    const out = parsePrepVerdictArgs({
      verdict: "conflict_on",
      reason: "both modify src/foo.ts",
      conflict_with: ["DX-200", "DX-201"],
    });
    expect(out).toEqual({
      verdict: "conflict_on",
      reason: "both modify src/foo.ts",
      conflict_with: ["DX-200", "DX-201"],
    });
  });

  it("accepts a blocked verdict (no extra args)", () => {
    const out = parsePrepVerdictArgs({
      verdict: "blocked",
      reason: "spec ambiguous on auth shape",
    });
    expect(out).toEqual({
      verdict: "blocked",
      reason: "spec ambiguous on auth shape",
    });
  });

  it("accepts an abort verdict with broken_details", () => {
    const out = parsePrepVerdictArgs({
      verdict: "abort",
      reason: "Bash tool returning ENOENT",
      broken_details: {
        suggested_steps: [
          "ssh to host",
          "check claude binary path",
        ],
      },
    });
    expect(out).toEqual({
      verdict: "abort",
      reason: "Bash tool returning ENOENT",
      broken_details: {
        suggested_steps: [
          "ssh to host",
          "check claude binary path",
        ],
      },
    });
  });

  it("accepts an abort verdict with empty broken_details.suggested_steps", () => {
    // Empty steps array is permitted (discouraged but not invalid — see
    // settings-file.ts validateBrokenInput which also accepts empty array).
    const out = parsePrepVerdictArgs({
      verdict: "abort",
      reason: "env broken — no recovery hint",
      broken_details: { suggested_steps: [] },
    });
    if (out.verdict !== "abort") throw new Error("expected abort verdict");
    expect(out.broken_details.suggested_steps).toEqual([]);
  });

  it("accepts a waiting_on verdict with depends_on[]", () => {
    const out = parsePrepVerdictArgs({
      verdict: "waiting_on",
      reason: "Phase 2 needs Phase 1 to land first",
      depends_on: ["DX-200"],
    });
    expect(out).toEqual({
      verdict: "waiting_on",
      reason: "Phase 2 needs Phase 1 to land first",
      depends_on: ["DX-200"],
    });
  });
});

describe("parsePrepVerdictArgs — legacy rename rejects", () => {
  it("rejects blocked_by arg with a hint pointing at conflict_with AND depends_on", () => {
    // 2026-05-15: blocked_by message now mentions both successor args
    // since waiting_on is a real verdict again. Agent gets both targets
    // listed so the right one matches their intent on the next turn.
    expect(() =>
      parsePrepVerdictArgs({
        verdict: "conflict_on",
        reason: "x",
        blocked_by: ["DX-1"],
      }),
    ).toThrow(/conflict_with.*depends_on|depends_on.*conflict_with/);
  });
});

describe("parsePrepVerdictArgs — unknown-key reject (M4)", () => {
  it("rejects unknown keys with a helpful 'allowed keys' message", () => {
    // Typo like `conflict_With` would otherwise fall through to
    // "missing conflict_with" — confusing. The unknown-key reject
    // points at the right culprit on the first turn.
    expect(() =>
      parsePrepVerdictArgs({
        verdict: "conflict_on",
        reason: "x",
        conflict_With: ["DX-1"],
      }),
    ).toThrow(/unknown arg "conflict_With"/);
  });

  it("includes the allowed-keys list in the error so the agent can self-correct", () => {
    try {
      parsePrepVerdictArgs({ verdict: "ok", reason: "x", foo: 1 });
      throw new Error("expected throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Allowed keys list MUST surface so an agent doesn't have to
      // grep the source to figure out the contract.
      expect(msg).toMatch(/verdict/);
      expect(msg).toMatch(/reason/);
      expect(msg).toMatch(/conflict_with/);
      expect(msg).toMatch(/depends_on/);
      expect(msg).toMatch(/broken_details/);
    }
  });
});

describe("parsePrepVerdictArgs — waiting_on branch", () => {
  it("rejects waiting_on without depends_on", () => {
    expect(() =>
      parsePrepVerdictArgs({ verdict: "waiting_on", reason: "x" }),
    ).toThrow(/depends_on must be a non-empty array/);
  });

  it("rejects waiting_on with empty depends_on", () => {
    expect(() =>
      parsePrepVerdictArgs({
        verdict: "waiting_on",
        reason: "x",
        depends_on: [],
      }),
    ).toThrow(/depends_on must be a non-empty array/);
  });

  it("rejects waiting_on with non-string depends_on entry", () => {
    expect(() =>
      parsePrepVerdictArgs({
        verdict: "waiting_on",
        reason: "x",
        depends_on: ["DX-1", 42],
      }),
    ).toThrow(/every entry in depends_on must be a non-empty issue id/);
  });

  it("validates depends_on entries against the repo prefix when supplied", () => {
    expect(() =>
      parsePrepVerdictArgs(
        {
          verdict: "waiting_on",
          reason: "x",
          depends_on: ["banana"],
        },
        { issuePrefix: "DX" },
      ),
    ).toThrow(/does not match the repo's <PREFIX>-N shape/);
  });

  it("accepts a well-formed depends_on list under issuePrefix", () => {
    const out = parsePrepVerdictArgs(
      {
        verdict: "waiting_on",
        reason: "Phase 2 needs Phase 1",
        depends_on: ["DX-1", "DX-42"],
      },
      { issuePrefix: "DX" },
    );
    if (out.verdict !== "waiting_on") {
      throw new Error("expected waiting_on verdict");
    }
    expect(out.depends_on).toEqual(["DX-1", "DX-42"]);
  });
});

describe("parsePrepVerdictArgs — issuePrefix shape validation (M3)", () => {
  it("rejects conflict_with entries that don't match ^${prefix}-\\d+$", () => {
    expect(() =>
      parsePrepVerdictArgs(
        {
          verdict: "conflict_on",
          reason: "x",
          conflict_with: ["banana"],
        },
        { issuePrefix: "DX" },
      ),
    ).toThrow(/does not match the repo's <PREFIX>-N shape/);
  });

  it("rejects 'DX-NaN' (digits-only after the dash)", () => {
    expect(() =>
      parsePrepVerdictArgs(
        {
          verdict: "conflict_on",
          reason: "x",
          conflict_with: ["DX-NaN"],
        },
        { issuePrefix: "DX" },
      ),
    ).toThrow(/does not match.*DX-N/);
  });

  it("rejects wrong-prefix ids (e.g. 'SG-1' against DX prefix)", () => {
    expect(() =>
      parsePrepVerdictArgs(
        {
          verdict: "conflict_on",
          reason: "x",
          conflict_with: ["DX-1", "SG-1"],
        },
        { issuePrefix: "DX" },
      ),
    ).toThrow(/SG-1/);
  });

  it("accepts well-formed ids matching the prefix", () => {
    const out = parsePrepVerdictArgs(
      {
        verdict: "conflict_on",
        reason: "x",
        conflict_with: ["DX-1", "DX-42", "DX-1000"],
      },
      { issuePrefix: "DX" },
    );
    if (out.verdict !== "conflict_on") throw new Error("expected conflict_on");
    expect(out.conflict_with).toEqual(["DX-1", "DX-42", "DX-1000"]);
  });

  it("falls back to 'non-blank string' validation when issuePrefix is absent", () => {
    // Back-compat: tests / fixtures without a repo context call the
    // parser without a prefix and get the looser validation.
    const out = parsePrepVerdictArgs({
      verdict: "conflict_on",
      reason: "x",
      conflict_with: ["banana"],
    });
    if (out.verdict !== "conflict_on") throw new Error("expected conflict_on");
    expect(out.conflict_with).toEqual(["banana"]);
  });
});

describe("parsePrepVerdictArgs — fail-loud branches", () => {
  it("rejects unknown verdict literal", () => {
    expect(() =>
      parsePrepVerdictArgs({ verdict: "nope", reason: "x" }),
    ).toThrow(/verdict must be one of/);
  });

  it("rejects missing reason", () => {
    expect(() => parsePrepVerdictArgs({ verdict: "ok" })).toThrow(
      /reason must be a non-empty string/,
    );
  });

  it("rejects blank reason", () => {
    expect(() =>
      parsePrepVerdictArgs({ verdict: "ok", reason: "   " }),
    ).toThrow(/reason must be a non-empty string/);
  });

  it("rejects conflict_on without conflict_with", () => {
    expect(() =>
      parsePrepVerdictArgs({ verdict: "conflict_on", reason: "x" }),
    ).toThrow(/conflict_with must be a non-empty array/);
  });

  it("rejects conflict_on with empty conflict_with", () => {
    expect(() =>
      parsePrepVerdictArgs({
        verdict: "conflict_on",
        reason: "x",
        conflict_with: [],
      }),
    ).toThrow(/non-empty array/);
  });

  it("rejects conflict_on with non-string conflict_with entry", () => {
    expect(() =>
      parsePrepVerdictArgs({
        verdict: "conflict_on",
        reason: "x",
        conflict_with: ["DX-1", 42],
      }),
    ).toThrow(/non-empty issue id string/);
  });

  it("rejects abort without broken_details", () => {
    expect(() =>
      parsePrepVerdictArgs({ verdict: "abort", reason: "x" }),
    ).toThrow(/broken_details is required/);
  });

  it("rejects abort with non-array suggested_steps", () => {
    expect(() =>
      parsePrepVerdictArgs({
        verdict: "abort",
        reason: "x",
        broken_details: { suggested_steps: "just a string" as unknown as string[] },
      }),
    ).toThrow(/suggested_steps must be an array/);
  });

  it("rejects abort with non-string entries in suggested_steps", () => {
    expect(() =>
      parsePrepVerdictArgs({
        verdict: "abort",
        reason: "x",
        broken_details: { suggested_steps: ["a", 1 as unknown as string] },
      }),
    ).toThrow(/entry must be a string/);
  });
});

describe("mapTerminalVerdictToDispatchStatus", () => {
  it("maps abort → failed (env-broken signal flows to picker via agents.broken)", () => {
    expect(mapTerminalVerdictToDispatchStatus("abort")).toBe("failed");
  });

  it("maps conflict_on → completed (prep finished cleanly — surfaced the overlap)", () => {
    expect(mapTerminalVerdictToDispatchStatus("conflict_on")).toBe("completed");
  });

  it("maps waiting_on → completed (prep finished cleanly — surfaced the sequential dep)", () => {
    expect(mapTerminalVerdictToDispatchStatus("waiting_on")).toBe("completed");
  });

  it("maps blocked → completed (prep finished cleanly — candidate is self-stuck)", () => {
    expect(mapTerminalVerdictToDispatchStatus("blocked")).toBe("completed");
  });
});

describe("writePrepVerdictFsQueueEntry", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "danxbot-prep-verdict-test-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("writes an atomic JSON entry under .danxbot/prep-verdicts/", () => {
    const ok = writePrepVerdictFsQueueEntry(
      {
        dispatchId: "abc-123",
        payload: { verdict: "ok", reason: "no conflicts" },
      },
      tmpRoot,
    );
    expect(ok).toBe(true);
    const filePath = join(tmpRoot, PREP_VERDICT_QUEUE_DIR, "abc-123.json");
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(parsed.dispatchId).toBe("abc-123");
    expect(parsed.payload).toEqual({ verdict: "ok", reason: "no conflicts" });
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("uses a separate directory from dispatch-stops/ so completion + verdict queues don't collide", () => {
    writePrepVerdictFsQueueEntry(
      {
        dispatchId: "same-id",
        payload: { verdict: "ok", reason: "x" },
      },
      tmpRoot,
    );
    // The directory name itself is the contract — if a future refactor
    // changes the literal, the boot replay (when it lands) breaks
    // silently. Pin the relative path so the AC#7 split survives.
    expect(PREP_VERDICT_QUEUE_DIR).toBe(".danxbot/prep-verdicts");
    expect(
      existsSync(join(tmpRoot, ".danxbot", "dispatch-stops", "same-id.json")),
    ).toBe(false);
    expect(
      existsSync(join(tmpRoot, ".danxbot", "prep-verdicts", "same-id.json")),
    ).toBe(true);
  });

  it("returns false on IO failure rather than throwing", () => {
    // Pointing at a non-existent root WITHOUT mkdir permission should
    // surface as `false`, not a thrown exception — the MCP server falls
    // back to a thrown error only after BOTH HTTP + fs queue fail.
    const ok = writePrepVerdictFsQueueEntry(
      {
        dispatchId: "x",
        payload: { verdict: "ok", reason: "x" },
      },
      // The path itself is `/dev/null/...` — mkdir on top of /dev/null
      // fails on every Unix.
      "/dev/null/cannot-mkdir-here",
    );
    expect(ok).toBe(false);
  });
});

describe("callDanxbotPrepVerdict — happy path", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs the parsed payload to the worker URL and returns its body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        '{"status":"applied","verdict":"conflict_on","conflictsAppended":2,"candidateBlocked":false,"agentMarkedBroken":false,"dispatchTerminal":"completed"}',
    } as unknown as Response);

    const out = await callDanxbotPrepVerdict(
      {
        verdict: "conflict_on",
        reason: "overlap on src/foo.ts",
        conflict_with: ["DX-200", "DX-201"],
      },
      { url: "http://localhost:5562/api/prep-verdict/job-1" },
    );

    expect(out).toMatch(/applied/);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5562/api/prep-verdict/job-1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          verdict: "conflict_on",
          reason: "overlap on src/foo.ts",
          conflict_with: ["DX-200", "DX-201"],
        }),
      }),
    );
  });

  it("falls back to fs queue when HTTP fails AND fallback context is set", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "danxbot-prep-fb-"));
    try {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const out = await callDanxbotPrepVerdict(
        { verdict: "ok", reason: "no conflicts" },
        {
          url: "http://localhost:5562/api/prep-verdict/job-1",
          fallback: { repoRoot: tmpRoot, dispatchId: "job-1" },
        },
      );

      expect(out).toMatch(/queued for boot replay/);
      const filePath = join(
        tmpRoot,
        PREP_VERDICT_QUEUE_DIR,
        "job-1.json",
      );
      expect(existsSync(filePath)).toBe(true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("throws when HTTP fails AND no fallback context is configured", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    await expect(
      callDanxbotPrepVerdict(
        { verdict: "ok", reason: "x" },
        { url: "http://localhost:5562/api/prep-verdict/job-1" },
      ),
    ).rejects.toThrow(/unreachable.*no fallback context/);
  });

  it("validates the payload BEFORE attempting the HTTP POST", async () => {
    // A bad payload must surface as a validation error, not a network
    // error — the agent's next turn should see the hint.
    await expect(
      callDanxbotPrepVerdict(
        {
          verdict: "conflict_on",
          reason: "x",
          blocked_by: ["DX-1"],
        },
        { url: "http://localhost:5562/api/prep-verdict/job-1" },
      ),
    ).rejects.toThrow(/conflict_with|depends_on/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when the worker returns a non-2xx (e.g. 502) and no fallback context", async () => {
    // Distinct from the rejected-fetch path: the response IS received,
    // it just isn't ok. Pin the error surface so a future client
    // refactor doesn't silently swallow non-2xx as "queued" or
    // "applied".
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: async () => "bad gateway",
    } as unknown as Response);
    await expect(
      callDanxbotPrepVerdict(
        { verdict: "ok", reason: "x" },
        { url: "http://localhost:5562/api/prep-verdict/job-1" },
      ),
    ).rejects.toThrow(/HTTP 502/);
  });

  it("returns a synthesized ack when the worker returns 200 with empty body", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "",
    } as unknown as Response);
    const out = await callDanxbotPrepVerdict(
      { verdict: "ok", reason: "no conflicts" },
      { url: "http://localhost:5562/api/prep-verdict/job-1" },
    );
    expect(out).toMatch(/prep verdict ok accepted/);
  });

  it("throws 'no fallback context' when only one of repoRoot / dispatchId is supplied", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      callDanxbotPrepVerdict(
        { verdict: "ok", reason: "x" },
        {
          url: "http://localhost:5562/api/prep-verdict/job-1",
          // Missing dispatchId — half-configured fallback is the
          // same as no fallback.
          fallback: { repoRoot: "/tmp" },
        },
      ),
    ).rejects.toThrow(/no fallback context/);
  });

  it("throws 'filesystem queue also failed' when HTTP fails AND fs-queue write fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(
      callDanxbotPrepVerdict(
        { verdict: "ok", reason: "x" },
        {
          url: "http://localhost:5562/api/prep-verdict/job-1",
          fallback: {
            // mkdir under /dev/null/... always fails — exercises the
            // bottom of the fallback chain.
            repoRoot: "/dev/null/cannot-mkdir-here",
            dispatchId: "job-1",
          },
        },
      ),
    ).rejects.toThrow(/filesystem queue also failed/);
  });

  it("propagates issuePrefix into the parser (rejects bogus ids before POST)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '{"status":"applied"}',
    } as unknown as Response);
    await expect(
      callDanxbotPrepVerdict(
        {
          verdict: "conflict_on",
          reason: "x",
          conflict_with: ["banana"],
        },
        {
          url: "http://localhost:5562/api/prep-verdict/job-1",
          issuePrefix: "DX",
        },
      ),
    ).rejects.toThrow(/<PREFIX>-N shape/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
