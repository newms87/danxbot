import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildClaudeProbeEnv,
  dispatchTagFor,
  findJsonlByTag,
  jsonlDiscoveryMessage,
  ProbeError,
  runProbe,
  sumUsageFromJsonl,
  type SessionDirResolver,
  type SpawnFn,
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
 * `sumUsageFromJsonl` walks the JSONL body and sums usage across every
 * assistant entry, deduping by `message.id`. The dedup contract is
 * load-bearing: Claude Code stamps identical `message.usage` on every
 * JSONL line carrying a content block from the same API response, so a
 * multi-block turn (text + tool_use + thinking) would count 2-5× its
 * real cost without it. See `.claude/rules/agent-dispatch.md`.
 */
describe("sumUsageFromJsonl", () => {
  it("returns zero usage on empty body", () => {
    expect(sumUsageFromJsonl("")).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("sums every assistant entry's usage when message.ids are distinct", () => {
    const body =
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-a",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-b",
          usage: {
            input_tokens: 200,
            output_tokens: 80,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 10,
          },
        },
      }) +
      "\n";
    expect(sumUsageFromJsonl(body)).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
    });
  });

  it("dedupes usage when multiple JSONL lines stamp the same message.id (the gpt-manager prod bug)", () => {
    // Three lines, all stamped with the same message.id `msg-1` (the
    // multi-block turn Claude Code emits). Without dedup the totals
    // would triple.
    const oneUsage = {
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 25,
    };
    const lines = [0, 1, 2].map(() =>
      JSON.stringify({
        type: "assistant",
        message: { id: "msg-1", usage: oneUsage },
      }),
    );
    const body = lines.join("\n") + "\n";
    expect(sumUsageFromJsonl(body)).toEqual({
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 25,
    });
  });

  it("keeps lines without message.id (defensive — never seen in real Claude output)", () => {
    const body =
      JSON.stringify({
        type: "assistant",
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }) +
      "\n";
    expect(sumUsageFromJsonl(body)).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("skips non-assistant entries (user, system, tool_result)", () => {
    const body =
      JSON.stringify({
        type: "user",
        message: { content: "hello", usage: { input_tokens: 999 } },
      }) +
      "\n" +
      JSON.stringify({
        type: "system",
        usage: { input_tokens: 999 },
      }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-real",
          usage: {
            input_tokens: 100,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }) +
      "\n";
    expect(sumUsageFromJsonl(body).inputTokens).toBe(100);
  });

  it("skips unparseable lines without crashing the walk", () => {
    const body =
      "not json at all\n" +
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          usage: {
            input_tokens: 5,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }) +
      "\n" +
      "{also broken\n";
    expect(sumUsageFromJsonl(body).inputTokens).toBe(5);
  });

  it("coerces string usage fields to numbers (drift-safe)", () => {
    const body =
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          usage: {
            input_tokens: "42",
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }) + "\n";
    expect(sumUsageFromJsonl(body).inputTokens).toBe(42);
  });
});

/**
 * `runProbe` end-to-end tests. We stub the `spawn` function so we can
 * simulate exit codes, errors, and timeouts without launching a real
 * claude subprocess. A fake ChildProcess emits `close` (success path)
 * or `error` (spawn-failure path); the test writes the JSONL on disk
 * BEFORE resolving close so discovery succeeds in the success path.
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
    rmSync(probeRoot, { recursive: true, force: true });
  });

  function baseArgs() {
    return {
      query: "test query",
      expectSkill: "dev:debugging",
      workspace: "skill-eval",
      workspaceCwd: "/some/workspace/cwd",
      timeoutMs: 10_000,
    };
  }

  function makeFakeChild(): EventEmitter & {
    kill: (signal?: NodeJS.Signals) => boolean;
  } {
    const child = new EventEmitter() as EventEmitter & {
      kill: (signal?: NodeJS.Signals) => boolean;
    };
    child.kill = () => true;
    return child;
  }

  /**
   * Build a SpawnFn stub whose `close` event fires AFTER a side effect
   * lets us drop the matching JSONL on disk. The callback receives the
   * dispatchTag the runner generated, so the JSONL can be written under
   * the right name + with the tag inside.
   */
  function stubSpawn(opts: {
    writeJsonl: (dispatchTag: string) => void;
    exitCode?: number;
    spawnThrows?: Error;
    childErrorAfterSpawn?: Error;
  }): SpawnFn {
    const fn: unknown = vi.fn((_cmd: string, args: readonly string[]) => {
      if (opts.spawnThrows) throw opts.spawnThrows;
      const taggedPrompt = args[1] as string;
      const match = taggedPrompt.match(/<!--\s*danxbot-dispatch:[^\s]+\s*-->/);
      const dispatchTag = match ? match[0] : "";
      const child = makeFakeChild();
      setImmediate(() => {
        if (opts.childErrorAfterSpawn) {
          child.emit("error", opts.childErrorAfterSpawn);
          return;
        }
        opts.writeJsonl(dispatchTag);
        child.emit("close", opts.exitCode ?? 0);
      });
      return child as unknown as ReturnType<SpawnFn>;
    });
    return fn as SpawnFn;
  }

  function writeJsonlFor(dispatchTag: string, lines: object[]): void {
    const userEntry = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: `${dispatchTag} test` }] },
    };
    writeFileSync(
      join(sessionDir, `session-${Date.now()}.jsonl`),
      [userEntry, ...lines].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  }

  it("returns a PASS verdict when JSONL shows the expected Skill before any text", async () => {
    const spawnFn = stubSpawn({
      writeJsonl: (tag) => {
        writeJsonlFor(tag, [
          {
            type: "assistant",
            message: {
              id: "msg-1",
              role: "assistant",
              content: [
                { type: "tool_use", name: "Skill", input: { skill: "dev:debugging" } },
              ],
              usage: {
                input_tokens: 1234,
                output_tokens: 567,
                cache_read_input_tokens: 89,
                cache_creation_input_tokens: 10,
              },
            },
          },
          {
            type: "assistant",
            message: {
              id: "msg-2",
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              usage: {
                input_tokens: 5,
                output_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          },
        ]);
      },
      exitCode: 0,
    });
    const result = await runProbe(baseArgs(), resolver, spawnFn);
    expect(result.verdict.pass).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.usage.inputTokens).toBe(1239);
    expect(result.usage.outputTokens).toBe(568);
    expect(result.usage.cacheReadTokens).toBe(89);
    expect(result.usage.cacheCreationTokens).toBe(10);
    expect(result.dispatchTag).toContain("<!-- danxbot-dispatch:");
    expect(result.jsonlPath).toContain(".jsonl");
  });

  it("returns a FAIL verdict when the assistant produces text without invoking the expected Skill", async () => {
    const spawnFn = stubSpawn({
      writeJsonl: (tag) => {
        writeJsonlFor(tag, [
          {
            type: "assistant",
            message: {
              id: "msg-1",
              role: "assistant",
              content: [{ type: "text", text: "Answering directly..." }],
              usage: {
                input_tokens: 100,
                output_tokens: 200,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          },
        ]);
      },
    });
    const result = await runProbe(baseArgs(), resolver, spawnFn);
    expect(result.verdict.pass).toBe(false);
    expect(result.verdict.firstAssistantText).toContain("Answering directly");
  });

  it("dedupes usage when Claude Code stamps the same message.id across two JSONL lines", async () => {
    const spawnFn = stubSpawn({
      writeJsonl: (tag) => {
        // Two lines, identical message.id → dedup keeps one.
        writeJsonlFor(tag, [
          {
            type: "assistant",
            message: {
              id: "msg-multi",
              role: "assistant",
              content: [{ type: "tool_use", name: "Skill", input: { skill: "dev:debugging" } }],
              usage: {
                input_tokens: 500,
                output_tokens: 100,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          },
          {
            type: "assistant",
            message: {
              id: "msg-multi",
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              usage: {
                input_tokens: 500,
                output_tokens: 100,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          },
        ]);
      },
    });
    const result = await runProbe(baseArgs(), resolver, spawnFn);
    expect(result.usage.inputTokens).toBe(500);
    expect(result.usage.outputTokens).toBe(100);
  });

  it("throws ProbeError(spawn-failed) when spawn itself throws synchronously", async () => {
    const spawnFn: unknown = vi.fn(() => {
      throw new Error("ENOENT: claude not found");
    });
    await expect(
      runProbe(baseArgs(), resolver, spawnFn as SpawnFn),
    ).rejects.toMatchObject({ category: "spawn-failed" });
  });

  it("throws ProbeError(spawn-failed) when the child emits 'error' (post-fork)", async () => {
    const spawnFn = stubSpawn({
      writeJsonl: () => {},
      childErrorAfterSpawn: new Error("write EPIPE"),
    });
    await expect(runProbe(baseArgs(), resolver, spawnFn)).rejects.toMatchObject({
      category: "spawn-failed",
    });
  });

  it("throws ProbeError(timeout) when claude does not exit before timeoutMs", async () => {
    // Child never emits 'close' — the runner's setTimeout fires first
    // and rejects with category=timeout.
    const spawnFn: unknown = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        kill: (signal?: NodeJS.Signals) => boolean;
      };
      child.kill = () => true;
      return child as unknown as ReturnType<SpawnFn>;
    });
    await expect(
      runProbe({ ...baseArgs(), timeoutMs: 20 }, resolver, spawnFn as SpawnFn),
    ).rejects.toMatchObject({ category: "timeout" });
  });

  it("throws ProbeError(jsonl-not-found) when the dispatch tag never lands in any JSONL", async () => {
    const spawnFn = stubSpawn({
      writeJsonl: () => {
        // Write a JSONL with a different tag so discovery returns
        // `tag-not-in-any-file` instead of `no-files`.
        writeFileSync(
          join(sessionDir, "other.jsonl"),
          JSON.stringify({
            type: "user",
            message: { content: "<!-- danxbot-dispatch:DIFFERENT --> hi" },
          }) + "\n",
        );
      },
    });
    await expect(runProbe(baseArgs(), resolver, spawnFn)).rejects.toMatchObject({
      category: "jsonl-not-found",
    });
  });

  it("propagates a non-zero exit code into ProbeResult.exitCode (failure still produces a verdict)", async () => {
    const spawnFn = stubSpawn({
      writeJsonl: (tag) => {
        writeJsonlFor(tag, [
          {
            type: "assistant",
            message: {
              id: "msg-1",
              role: "assistant",
              content: [{ type: "tool_use", name: "Skill", input: { skill: "dev:debugging" } }],
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          },
        ]);
      },
      exitCode: 2,
    });
    const result = await runProbe(baseArgs(), resolver, spawnFn);
    expect(result.exitCode).toBe(2);
    expect(result.verdict.pass).toBe(true); // The JSONL still shows a Skill call → verdict is independent of exit code.
  });

  it("strips ANTHROPIC_API_KEY from the spawn env when CLAUDE_AUTH_MODE=subscription (so claude CLI falls back to OAuth)", async () => {
    const prevAuthMode = process.env.CLAUDE_AUTH_MODE;
    const prevApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_AUTH_MODE = "subscription";
    process.env.ANTHROPIC_API_KEY = "sk-ant-stale-key-should-be-stripped";
    try {
      const captured: Array<{ opts: { env?: NodeJS.ProcessEnv } }> = [];
      const spawnFn: unknown = vi.fn(
        (_cmd: string, argv: readonly string[], opts: unknown) => {
          captured.push({ opts: opts as { env?: NodeJS.ProcessEnv } });
          const tag =
            (argv[1] as string).match(/<!--\s*danxbot-dispatch:[^\s]+\s*-->/)?.[0] ??
            "";
          const child = makeFakeChild();
          setImmediate(() => {
            writeJsonlFor(tag, [
              {
                type: "assistant",
                message: {
                  id: "m",
                  role: "assistant",
                  content: [
                    { type: "tool_use", name: "Skill", input: { skill: "dev:debugging" } },
                  ],
                  usage: {
                    input_tokens: 1,
                    output_tokens: 0,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                  },
                },
              },
            ]);
            child.emit("close", 0);
          });
          return child as unknown as ReturnType<SpawnFn>;
        },
      );
      await runProbe(baseArgs(), resolver, spawnFn as SpawnFn);
      expect(captured).toHaveLength(1);
      expect(captured[0].opts.env).toBeDefined();
      expect(captured[0].opts.env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(captured[0].opts.env?.CLAUDE_AUTH_MODE).toBe("subscription");
    } finally {
      if (prevAuthMode === undefined) delete process.env.CLAUDE_AUTH_MODE;
      else process.env.CLAUDE_AUTH_MODE = prevAuthMode;
      if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevApiKey;
    }
  });

  it("preserves ANTHROPIC_API_KEY in the spawn env when CLAUDE_AUTH_MODE is unset (legacy api-key auth)", async () => {
    const prevAuthMode = process.env.CLAUDE_AUTH_MODE;
    const prevApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_AUTH_MODE;
    process.env.ANTHROPIC_API_KEY = "sk-ant-real-key";
    try {
      const captured: Array<{ opts: { env?: NodeJS.ProcessEnv } }> = [];
      const spawnFn: unknown = vi.fn(
        (_cmd: string, argv: readonly string[], opts: unknown) => {
          captured.push({ opts: opts as { env?: NodeJS.ProcessEnv } });
          const tag =
            (argv[1] as string).match(/<!--\s*danxbot-dispatch:[^\s]+\s*-->/)?.[0] ??
            "";
          const child = makeFakeChild();
          setImmediate(() => {
            writeJsonlFor(tag, [
              {
                type: "assistant",
                message: {
                  id: "m",
                  role: "assistant",
                  content: [
                    { type: "tool_use", name: "Skill", input: { skill: "dev:debugging" } },
                  ],
                  usage: {
                    input_tokens: 1,
                    output_tokens: 0,
                    cache_read_input_tokens: 0,
                    cache_creation_input_tokens: 0,
                  },
                },
              },
            ]);
            child.emit("close", 0);
          });
          return child as unknown as ReturnType<SpawnFn>;
        },
      );
      await runProbe(baseArgs(), resolver, spawnFn as SpawnFn);
      expect(captured).toHaveLength(1);
      expect(captured[0].opts.env?.ANTHROPIC_API_KEY).toBe("sk-ant-real-key");
    } finally {
      if (prevAuthMode === undefined) delete process.env.CLAUDE_AUTH_MODE;
      else process.env.CLAUDE_AUTH_MODE = prevAuthMode;
      if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevApiKey;
    }
  });

  it("passes --strict-mcp-config + --mcp-config + --dangerously-skip-permissions to claude", async () => {
    const captured: Array<{ cmd: string; argv: readonly string[]; opts: unknown }> = [];
    const spawnFn: unknown = vi.fn(
      (cmd: string, argv: readonly string[], opts: unknown) => {
        captured.push({ cmd, argv, opts });
        const tag =
          (argv[1] as string).match(/<!--\s*danxbot-dispatch:[^\s]+\s*-->/)?.[0] ??
          "";
        const child = makeFakeChild();
        setImmediate(() => {
          writeJsonlFor(tag, [
            {
              type: "assistant",
              message: {
                id: "m",
                role: "assistant",
                content: [
                  { type: "tool_use", name: "Skill", input: { skill: "dev:debugging" } },
                ],
                usage: {
                  input_tokens: 1,
                  output_tokens: 0,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              },
            },
          ]);
          child.emit("close", 0);
        });
        return child as unknown as ReturnType<SpawnFn>;
      },
    );
    await runProbe(
      { ...baseArgs(), workspaceCwd: "/custom/workspace/cwd" },
      resolver,
      spawnFn as SpawnFn,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].cmd).toBe("claude");
    expect(captured[0].argv).toContain("--strict-mcp-config");
    expect(captured[0].argv).toContain("--mcp-config");
    expect(captured[0].argv).toContain(".mcp.json");
    expect(captured[0].argv).toContain("--dangerously-skip-permissions");
    expect((captured[0].opts as { cwd: string }).cwd).toBe(
      "/custom/workspace/cwd",
    );
  });
});

/**
 * `buildClaudeProbeEnv` mirrors the OAuth-mode discipline from
 * `anthropic-client.ts`: when the operator opted into subscription auth,
 * a stale `ANTHROPIC_API_KEY` inherited by the spawned `claude` CLI
 * causes it to send `X-Api-Key` + `Authorization: Bearer` simultaneously,
 * and the server rejects on the stale key. Symptom: probes report
 * `Invalid API key · Fix external API key` as the first assistant text,
 * which masquerades as a skill-trigger false-negative.
 */
describe("buildClaudeProbeEnv", () => {
  it("strips ANTHROPIC_API_KEY when CLAUDE_AUTH_MODE=subscription", () => {
    const env = {
      CLAUDE_AUTH_MODE: "subscription",
      ANTHROPIC_API_KEY: "sk-ant-stale",
      PATH: "/usr/bin",
    } as NodeJS.ProcessEnv;
    const result = buildClaudeProbeEnv(env);
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.CLAUDE_AUTH_MODE).toBe("subscription");
    expect(result.PATH).toBe("/usr/bin");
  });

  it("preserves ANTHROPIC_API_KEY when CLAUDE_AUTH_MODE is unset (legacy default)", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-real",
      PATH: "/usr/bin",
    } as NodeJS.ProcessEnv;
    const result = buildClaudeProbeEnv(env);
    expect(result.ANTHROPIC_API_KEY).toBe("sk-ant-real");
  });

  it("preserves ANTHROPIC_API_KEY when CLAUDE_AUTH_MODE is something other than 'subscription'", () => {
    const env = {
      CLAUDE_AUTH_MODE: "api-key",
      ANTHROPIC_API_KEY: "sk-ant-real",
    } as NodeJS.ProcessEnv;
    const result = buildClaudeProbeEnv(env);
    expect(result.ANTHROPIC_API_KEY).toBe("sk-ant-real");
    expect(result.CLAUDE_AUTH_MODE).toBe("api-key");
  });

  it("is a no-op when CLAUDE_AUTH_MODE=subscription but ANTHROPIC_API_KEY is unset", () => {
    const env = {
      CLAUDE_AUTH_MODE: "subscription",
      PATH: "/usr/bin",
    } as NodeJS.ProcessEnv;
    const result = buildClaudeProbeEnv(env);
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.CLAUDE_AUTH_MODE).toBe("subscription");
    expect(result.PATH).toBe("/usr/bin");
  });

  it("does not mutate the input env (returns a new object on subscription strip)", () => {
    const env = {
      CLAUDE_AUTH_MODE: "subscription",
      ANTHROPIC_API_KEY: "sk-ant-stale",
    } as NodeJS.ProcessEnv;
    buildClaudeProbeEnv(env);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-stale");
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
