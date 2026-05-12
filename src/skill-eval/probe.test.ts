import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  dispatchTagFor,
  findJsonlByTag,
  jsonlDiscoveryMessage,
  ProbeError,
  runProbe,
  type SessionDirResolver,
} from "./probe.js";

describe("dispatchTagFor", () => {
  it("renders the canonical dispatch-tag shape", () => {
    expect(dispatchTagFor("abc-123")).toBe(
      "<!-- danxbot-dispatch:abc-123 -->",
    );
  });
});

/**
 * Tests for `findJsonlByTag` cover the four distinct failure modes the
 * runner surfaces. We pass an injected `SessionDirResolver` so the
 * tests point at a tempdir — they NEVER touch the operator's real
 * `~/.claude/projects/`.
 */
describe("findJsonlByTag", () => {
  let probeRoot: string;
  let sessionDir: string;
  let resolver: SessionDirResolver;

  beforeEach(() => {
    probeRoot = mkdtempSync(join(tmpdir(), "skill-eval-probe-test-"));
    sessionDir = join(probeRoot, "session-dir");
    mkdirSync(sessionDir, { recursive: true });
    resolver = () => sessionDir;
  });

  afterEach(() => {
    rmSync(probeRoot, { recursive: true, force: true });
  });

  it("reason=dir-missing when projects dir was never created", () => {
    const nonexistent = join(probeRoot, "never-created");
    const result = findJsonlByTag(
      "/anything",
      "<!-- danxbot-dispatch:x -->",
      () => nonexistent,
    );
    expect(result.reason).toBe("dir-missing");
    expect(result.path).toBe(null);
  });

  it("reason=no-files when the projects dir is empty", () => {
    const result = findJsonlByTag(
      "/anything",
      "<!-- danxbot-dispatch:x -->",
      resolver,
    );
    expect(result.reason).toBe("no-files");
    expect(result.scannedFiles).toBe(0);
  });

  it("reason=tag-not-in-any-file when tag is absent from every JSONL", () => {
    writeFileSync(
      join(sessionDir, "session-a.jsonl"),
      JSON.stringify({ type: "user", message: { content: "no tag here" } }) + "\n",
    );
    writeFileSync(
      join(sessionDir, "session-b.jsonl"),
      JSON.stringify({ type: "assistant" }) + "\n",
    );
    const result = findJsonlByTag(
      "/anything",
      "<!-- danxbot-dispatch:missing -->",
      resolver,
    );
    expect(result.reason).toBe("tag-not-in-any-file");
    expect(result.scannedFiles).toBe(2);
  });

  it("reason=found returns the matching path", () => {
    writeFileSync(
      join(sessionDir, "session-a.jsonl"),
      JSON.stringify({ type: "user", message: { content: "no tag" } }) + "\n",
    );
    const target = join(sessionDir, "session-b.jsonl");
    const tag = "<!-- danxbot-dispatch:abc-123 -->";
    writeFileSync(
      target,
      JSON.stringify({
        type: "user",
        message: { content: `prefix ${tag} suffix` },
      }) + "\n",
    );
    const result = findJsonlByTag("/anything", tag, resolver);
    expect(result.reason).toBe("found");
    expect(result.path).toBe(resolve(target));
  });

  it("defaults to deriveSessionDir when no resolver is passed", () => {
    // Verify the overload exists (no-third-arg form) by calling against
    // a random non-existent workspace cwd. We do NOT touch the
    // operator's real `~/.claude/projects/` — production
    // deriveSessionDir produces a path that won't exist for this cwd,
    // so we expect either `dir-missing` (the typical case) or
    // `no-files` (if the encoded path incidentally exists). Both prove
    // the default resolver was consulted.
    const result = findJsonlByTag(
      join(probeRoot, "nonexistent-workspace"),
      "<!-- danxbot-dispatch:x -->",
    );
    expect(["dir-missing", "no-files"]).toContain(result.reason);
  });
});

describe("jsonlDiscoveryMessage", () => {
  it("renders distinct messages for each discovery failure mode", () => {
    const tag = "<!-- danxbot-dispatch:abc -->";
    const jobId = "abc";
    expect(
      jsonlDiscoveryMessage(
        { reason: "dir-missing", path: null, dir: "/d", scannedFiles: 0, unreadableFiles: [] },
        jobId,
        tag,
      ),
    ).toMatch(/never attached/);
    expect(
      jsonlDiscoveryMessage(
        { reason: "no-files", path: null, dir: "/d", scannedFiles: 0, unreadableFiles: [] },
        jobId,
        tag,
      ),
    ).toMatch(/may have failed before writing/);
    expect(
      jsonlDiscoveryMessage(
        { reason: "tag-not-in-any-file", path: null, dir: "/d", scannedFiles: 3, unreadableFiles: [] },
        jobId,
        tag,
      ),
    ).toMatch(/scanned 3 JSONL.*none contained/);
    expect(
      jsonlDiscoveryMessage(
        { reason: "unreadable-files", path: null, dir: "/d", scannedFiles: 5, unreadableFiles: ["/d/a.jsonl"] },
        jobId,
        tag,
      ),
    ).toMatch(/unreadable.*\/d\/a\.jsonl/);
  });
});

/**
 * `runProbe` end-to-end tests. We stub `fetch` via `vi.stubGlobal` so
 * `vi.unstubAllGlobals()` deterministically restores the original
 * between tests — saving + restoring manually leaks if a test throws
 * before the afterEach block runs. The session-dir resolver is
 * injected so we never touch `~/.claude/projects/`.
 */
describe("runProbe", () => {
  let probeRoot: string;
  let sessionDir: string;
  let resolver: SessionDirResolver;

  beforeEach(() => {
    probeRoot = mkdtempSync(join(tmpdir(), "skill-eval-probe-run-"));
    sessionDir = join(probeRoot, "session-dir");
    mkdirSync(sessionDir, { recursive: true });
    resolver = () => sessionDir;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(probeRoot, { recursive: true, force: true });
  });

  function baseArgs() {
    return {
      query: "test query",
      expectSkill: "dev:debugging",
      workspace: "skill-eval",
      workerPort: 5563,
      repoName: "danxbot",
      workspaceCwd: "/some/workspace/cwd",
      timeoutMs: 10_000,
      pollIntervalMs: 1,
    };
  }

  function stageFetch(opts: {
    jobId: string;
    statusBody: Record<string, unknown>;
    launchStatus?: number;
    statusStatusCode?: number;
  }) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/launch")) {
        return new Response(JSON.stringify({ job_id: opts.jobId }), {
          status: opts.launchStatus ?? 200,
        });
      }
      if (url.includes("/api/status/")) {
        return new Response(JSON.stringify(opts.statusBody), {
          status: opts.statusStatusCode ?? 200,
        });
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function writeJsonl(jobId: string, lines: object[]) {
    const tag = `<!-- danxbot-dispatch:${jobId} -->`;
    const userEntry = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: `${tag} test` }] },
    };
    writeFileSync(
      join(sessionDir, `${jobId}.jsonl`),
      [userEntry, ...lines].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  }

  it("returns a PASS verdict when JSONL shows the expected Skill before any text", async () => {
    const jobId = "probe-pass-1";
    stageFetch({
      jobId,
      statusBody: {
        status: "completed",
        input_tokens: 1234,
        output_tokens: 567,
        cache_read_input_tokens: 89,
        cache_creation_input_tokens: 10,
      },
    });
    writeJsonl(jobId, [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Skill", input: { skill: "dev:debugging" } },
          ],
        },
      },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    ]);
    const result = await runProbe(baseArgs(), resolver);
    expect(result.verdict.pass).toBe(true);
    expect(result.usage.inputTokens).toBe(1234);
    expect(result.usage.outputTokens).toBe(567);
    expect(result.usage.cacheReadTokens).toBe(89);
    expect(result.usage.cacheCreationTokens).toBe(10);
    expect(result.finalStatus).toBe("completed");
    expect(result.jobId).toBe(jobId);
    expect(result.dispatchTag).toBe(`<!-- danxbot-dispatch:${jobId} -->`);
    expect(result.jsonlPath).toContain(`${jobId}.jsonl`);
  });

  it("returns a FAIL verdict when the assistant produces text without invoking the expected Skill", async () => {
    const jobId = "probe-fail-1";
    stageFetch({
      jobId,
      statusBody: { status: "completed", input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    writeJsonl(jobId, [
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Answering directly..." }] },
      },
    ]);
    const result = await runProbe(baseArgs(), resolver);
    expect(result.verdict.pass).toBe(false);
    expect(result.verdict.firstAssistantText).toContain("Answering directly");
  });

  it("throws ProbeError(worker-unreachable) when /api/launch fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(runProbe(baseArgs(), resolver)).rejects.toMatchObject({
      category: "worker-unreachable",
    });
  });

  it("throws ProbeError(launch-failed) when /api/launch returns non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad request", { status: 400 })),
    );
    await expect(runProbe(baseArgs(), resolver)).rejects.toMatchObject({
      category: "launch-failed",
    });
  });

  it("throws ProbeError(launch-failed) when /api/launch returns non-JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );
    await expect(runProbe(baseArgs(), resolver)).rejects.toMatchObject({
      category: "launch-failed",
    });
  });

  it("throws ProbeError(launch-failed) when /api/launch JSON is missing job_id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ unrelated: "field" }), { status: 200 }),
      ),
    );
    await expect(runProbe(baseArgs(), resolver)).rejects.toMatchObject({
      category: "launch-failed",
    });
  });

  it("throws ProbeError(timeout) when status never reaches terminal", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/launch")) {
          return new Response(JSON.stringify({ job_id: "stuck" }), { status: 200 });
        }
        callCount++;
        return new Response(JSON.stringify({ status: "running" }), { status: 200 });
      }),
    );
    await expect(
      runProbe({ ...baseArgs(), timeoutMs: 10, pollIntervalMs: 1 }, resolver),
    ).rejects.toMatchObject({ category: "timeout" });
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  it("a 404 on /api/status terminates the poll with finalStatus='evicted' (NOT a silent 'completed')", async () => {
    // The 404 branch used to return `"completed"` silently — that is a
    // fail-quiet bug. The new contract surfaces a distinct `"evicted"`
    // status so the report can tell the operator the dispatch was
    // forgotten by the worker rather than reaching a real terminal.
    const jobId = "probe-evicted";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/launch")) {
          return new Response(JSON.stringify({ job_id: jobId }), { status: 200 });
        }
        return new Response("", { status: 404 });
      }),
    );
    writeJsonl(jobId, [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Skill", input: { skill: "dev:debugging" } }],
        },
      },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    ]);
    const result = await runProbe(baseArgs(), resolver);
    expect(result.finalStatus).toBe("evicted");
    expect(result.usage.inputTokens).toBe(0);
  });

  it("throws ProbeError(jsonl-not-found) when the dispatch tag never lands in any JSONL", async () => {
    const jobId = "probe-no-tag";
    stageFetch({
      jobId,
      statusBody: { status: "completed", input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    writeFileSync(
      join(sessionDir, "other.jsonl"),
      JSON.stringify({
        type: "user",
        message: { content: "<!-- danxbot-dispatch:DIFFERENT --> hi" },
      }) + "\n",
    );
    await expect(runProbe(baseArgs(), resolver)).rejects.toMatchObject({
      category: "jsonl-not-found",
    });
  });

  it("coerces a string `input_tokens` field to a number (defensive against status payload shape drift)", async () => {
    const jobId = "probe-string-usage";
    stageFetch({
      jobId,
      statusBody: {
        status: "completed",
        input_tokens: "42",
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    writeJsonl(jobId, [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Skill", input: { skill: "dev:debugging" } }],
        },
      },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    ]);
    const result = await runProbe(baseArgs(), resolver);
    expect(result.usage.inputTokens).toBe(42);
  });

  it("retains the LAST observed usage across polls (does not zero on a late-evict 404)", async () => {
    const jobId = "probe-late-evict";
    let pollIdx = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/api/launch")) {
          return new Response(JSON.stringify({ job_id: jobId }), { status: 200 });
        }
        pollIdx++;
        if (pollIdx === 1) {
          return new Response(
            JSON.stringify({
              status: "running",
              input_tokens: 500,
              output_tokens: 100,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            }),
            { status: 200 },
          );
        }
        return new Response("", { status: 404 });
      }),
    );

    writeJsonl(jobId, [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Skill", input: { skill: "dev:debugging" } }],
        },
      },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    ]);

    const result = await runProbe(baseArgs(), resolver);
    expect(result.usage.inputTokens).toBe(500);
    expect(result.usage.outputTokens).toBe(100);
    // And the status reflects what the worker actually reported, not a
    // silent "completed".
    expect(result.finalStatus).toBe("evicted");
  });
});

describe("ProbeError", () => {
  it("carries category for callers to branch on without string-parsing", () => {
    const err = new ProbeError("test", "timeout");
    expect(err.category).toBe("timeout");
    expect(err.message).toBe("test");
    expect(err).toBeInstanceOf(Error);
  });
});
