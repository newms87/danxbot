import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  appendFileSync,
  symlinkSync,
} from "node:fs";
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionLogWatcher,
  deriveSessionDir,
  findNewestJsonlFile,
  findSessionFileByDispatchId,
  convertJsonlEntry,
  DISPATCH_TAG_PREFIX,
} from "./session-log-watcher.js";
import type { AgentLogEntry } from "../types.js";

// --- Test helpers ---

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "session-log-watcher-test-"));
}

function writeJsonlFile(
  dir: string,
  filename: string,
  entries: Record<string, unknown>[],
): string {
  const filePath = join(dir, filename);
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(filePath, content);
  return filePath;
}

function appendJsonlEntry(
  filePath: string,
  entry: Record<string, unknown>,
): void {
  appendFileSync(filePath, JSON.stringify(entry) + "\n");
}

// --- JSONL fixture entries (raw Claude Code format) ---

function rawSystemInit(): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    session_id: "sess-abc-123",
    model: "claude-sonnet-4-5-20250929",
    tools: ["Read", "Grep", "Bash"],
    timestamp: "2026-04-12T10:00:00.000Z",
    sessionId: "sess-abc-123",
    cwd: "/home/test/project",
  };
}

function rawAssistantEntry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      model: "claude-sonnet-4-5-20250929",
      content: [
        {
          type: "thinking",
          thinking: "Let me analyze this.",
          signature: "abc...",
        },
        { type: "text", text: "I'll read the file." },
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Read",
          input: { file_path: "/src/main.ts" },
        },
      ],
      usage: {
        input_tokens: 500,
        output_tokens: 100,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 3000,
      },
    },
    timestamp: "2026-04-12T10:00:05.000Z",
    sessionId: "sess-abc-123",
    cwd: "/home/test/project",
    ...overrides,
  };
}

function rawToolResultEntry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: "File contents here...",
        },
      ],
    },
    timestamp: "2026-04-12T10:00:06.000Z",
    sessionId: "sess-abc-123",
    ...overrides,
  };
}

function rawUserTextEntry(): Record<string, unknown> {
  return {
    type: "user",
    message: {
      role: "user",
      content: "Hello, can you help me?",
    },
    timestamp: "2026-04-12T10:00:01.000Z",
    sessionId: "sess-abc-123",
  };
}

function rawResultEntry(): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    result: "Task completed successfully.",
    cost_usd: 0.0125,
    num_turns: 5,
    duration_ms: 30000,
    duration_api_ms: 25000,
    is_error: false,
    timestamp: "2026-04-12T10:00:30.000Z",
  };
}

function rawMetadataEntry(type: string): Record<string, unknown> {
  return { type, timestamp: "2026-04-12T10:00:00.000Z" };
}

function rawTurnDurationEntry(): Record<string, unknown> {
  return {
    type: "system",
    subtype: "turn_duration",
    durationMs: 5000,
    messageCount: 10,
    timestamp: "2026-04-12T10:00:10.000Z",
    sessionId: "sess-abc-123",
  };
}

// --- Tests ---

describe("deriveSessionDir", () => {
  it("converts absolute path to Claude session directory format", () => {
    const result = deriveSessionDir("/home/newms/web/gpt-manager");
    expect(result).toMatch(/\.claude\/projects\/-home-newms-web-gpt-manager$/);
  });

  it("handles paths without leading slash", () => {
    const result = deriveSessionDir("home/newms/project");
    expect(result).toMatch(/\.claude\/projects\/-home-newms-project$/);
  });

  it("resolves symlinks before deriving directory name", () => {
    const realDir = mkdtempSync(join(tmpdir(), "real-project-"));
    const symlinkDir = join(tmpdir(), `symlink-project-${Date.now()}`);
    symlinkSync(realDir, symlinkDir);

    try {
      const fromReal = deriveSessionDir(realDir);
      const fromSymlink = deriveSessionDir(symlinkDir);
      expect(fromSymlink).toBe(fromReal);
    } finally {
      rmSync(symlinkDir);
      rmSync(realDir, { recursive: true });
    }
  });
});

describe("findNewestJsonlFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null for empty directory", async () => {
    const result = await findNewestJsonlFile(tempDir);
    expect(result).toBeNull();
  });

  it("returns null for non-existent directory", async () => {
    const result = await findNewestJsonlFile("/nonexistent/path");
    expect(result).toBeNull();
  });

  it("finds the only jsonl file", async () => {
    writeFileSync(join(tempDir, "session-1.jsonl"), "{}");
    const result = await findNewestJsonlFile(tempDir);
    expect(result).toBe(join(tempDir, "session-1.jsonl"));
  });

  it("finds the newest jsonl file by mtime", async () => {
    // Use explicit utimes instead of wall-clock delay — filesystem mtime
    // precision can be coarser than a setTimeout under load, causing flakes.
    const oldPath = join(tempDir, "old.jsonl");
    const newPath = join(tempDir, "new.jsonl");
    writeFileSync(oldPath, "{}");
    writeFileSync(newPath, "{}");
    const now = Date.now() / 1000;
    utimesSync(oldPath, now - 10, now - 10);
    utimesSync(newPath, now, now);

    const result = await findNewestJsonlFile(tempDir);
    expect(result).toBe(newPath);
  });

  it("finds specific session by ID", async () => {
    writeFileSync(join(tempDir, "sess-123.jsonl"), "{}");
    writeFileSync(join(tempDir, "sess-456.jsonl"), "{}");

    const result = await findNewestJsonlFile(tempDir, "sess-123");
    expect(result).toBe(join(tempDir, "sess-123.jsonl"));
  });

  it("returns null when session ID not found", async () => {
    writeFileSync(join(tempDir, "sess-123.jsonl"), "{}");
    const result = await findNewestJsonlFile(tempDir, "sess-999");
    expect(result).toBeNull();
  });

  it("ignores non-jsonl files", async () => {
    writeFileSync(join(tempDir, "notes.txt"), "hello");
    writeFileSync(join(tempDir, "data.json"), "{}");
    const result = await findNewestJsonlFile(tempDir);
    expect(result).toBeNull();
  });
});

describe("convertJsonlEntry", () => {
  it("converts assistant entry to AgentLogEntry", () => {
    const raw = rawAssistantEntry();
    const result = convertJsonlEntry(raw, 0);
    expect(result).not.toBeNull();
    expect(result!.entry.type).toBe("assistant");
    expect(result!.entry.summary).toContain("Read");
    expect(result!.entry.data.content).toHaveLength(3);
    expect(result!.entry.data.usage).toBeDefined();
    expect(result!.entry.data.raw).toBe(raw);
  });

  it("computes delta_ms from previous timestamp", () => {
    const prevTs = new Date("2026-04-12T10:00:00.000Z").getTime();
    const result = convertJsonlEntry(rawAssistantEntry(), prevTs);
    expect(result!.entry.data.delta_ms).toBe(5000);
  });

  it("sets delta_ms to 0 when no previous timestamp", () => {
    const result = convertJsonlEntry(rawAssistantEntry(), 0);
    expect(result!.entry.data.delta_ms).toBe(0);
  });

  it("converts user tool_result entry to AgentLogEntry", () => {
    const result = convertJsonlEntry(rawToolResultEntry(), 0);
    expect(result).not.toBeNull();
    expect(result!.entry.type).toBe("user");
    expect(result!.entry.summary).toContain("toolu_01");
    expect(result!.entry.data.content).toHaveLength(1);
  });

  it("skips plain text user entries (prompts)", () => {
    const result = convertJsonlEntry(rawUserTextEntry(), 0);
    expect(result).toBeNull();
  });

  it("converts system init entry", () => {
    const result = convertJsonlEntry(rawSystemInit(), 0);
    expect(result).not.toBeNull();
    expect(result!.entry.type).toBe("system");
    expect(result!.entry.subtype).toBe("init");
    expect(result!.entry.data.session_id).toBe("sess-abc-123");
    expect(result!.entry.data.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("converts result entry", () => {
    const result = convertJsonlEntry(rawResultEntry(), 0);
    expect(result).not.toBeNull();
    expect(result!.entry.type).toBe("result");
    expect(result!.entry.data.total_cost_usd).toBe(0.0125);
    expect(result!.entry.data.num_turns).toBe(5);
    expect(result!.entry.data.duration_ms).toBe(30000);
  });

  it("skips metadata entries", () => {
    for (const type of [
      "permission-mode",
      "attachment",
      "file-history-snapshot",
      "queue-operation",
      "last-prompt",
    ]) {
      const result = convertJsonlEntry(rawMetadataEntry(type), 0);
      expect(result).toBeNull();
    }
  });

  it("skips system turn_duration entries", () => {
    const result = convertJsonlEntry(rawTurnDurationEntry(), 0);
    expect(result).toBeNull();
  });

  it("skips assistant entries with no message", () => {
    const result = convertJsonlEntry(
      { type: "assistant", timestamp: "2026-04-12T10:00:00.000Z" },
      0,
    );
    expect(result).toBeNull();
  });

  it("builds summary with text preview when no tool calls", () => {
    const entry = rawAssistantEntry();
    (entry.message as Record<string, unknown>).content = [
      { type: "text", text: "Here is my analysis of the problem." },
    ];
    const result = convertJsonlEntry(entry, 0);
    expect(result!.entry.summary).toBe(
      "Text: Here is my analysis of the problem.",
    );
  });

  it("builds summary with (empty) when no text or tools", () => {
    const entry = rawAssistantEntry();
    (entry.message as Record<string, unknown>).content = [
      { type: "thinking", thinking: "Hmm..." },
    ];
    const result = convertJsonlEntry(entry, 0);
    expect(result!.entry.summary).toBe("Text: (empty)");
  });

  it("skips user entry with empty content array", () => {
    const result = convertJsonlEntry(
      {
        type: "user",
        message: { content: [] },
        timestamp: "2026-04-12T10:00:00.000Z",
      },
      0,
    );
    expect(result).toBeNull();
  });

  it("skips user entry with non-tool_result content blocks", () => {
    const result = convertJsonlEntry(
      {
        type: "user",
        message: { content: [{ type: "text", text: "hello" }] },
        timestamp: "2026-04-12T10:00:00.000Z",
      },
      0,
    );
    expect(result).toBeNull();
  });

  it("uses Date.now() when timestamp is missing", () => {
    const before = Date.now();
    const result = convertJsonlEntry(
      { type: "assistant", message: { content: [], model: "test" } },
      0,
    );
    const after = Date.now();
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBeGreaterThanOrEqual(before);
    expect(result!.timestamp).toBeLessThanOrEqual(after);
  });

  it("builds summary with multiple tool_use blocks", () => {
    const entry = rawAssistantEntry();
    (entry.message as Record<string, unknown>).content = [
      {
        type: "tool_use",
        id: "t1",
        name: "Read",
        input: { file_path: "/a.ts" },
      },
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } },
    ];
    const result = convertJsonlEntry(entry, 0);
    expect(result!.entry.summary).toBe("Tools: Read(/a.ts), Bash(ls)");
  });

  it("propagates is_error=true on result entries", () => {
    const result = convertJsonlEntry(
      { ...rawResultEntry(), is_error: true, subtype: "error" },
      0,
    );
    expect(result!.entry.data.is_error).toBe(true);
    expect(result!.entry.subtype).toBe("error");
  });

  it("defaults missing result fields to 0", () => {
    const result = convertJsonlEntry(
      { type: "result", timestamp: "2026-04-12T10:00:00.000Z" },
      0,
    );
    expect(result).not.toBeNull();
    expect(result!.entry.data.total_cost_usd).toBe(0);
    expect(result!.entry.data.num_turns).toBe(0);
    expect(result!.entry.data.duration_ms).toBe(0);
  });

  it("builds summary with multiple tool results", () => {
    const result = convertJsonlEntry(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "ok" },
            { type: "tool_result", tool_use_id: "t2", content: "ok" },
          ],
        },
        timestamp: "2026-04-12T10:00:00.000Z",
      },
      0,
    );
    expect(result!.entry.summary).toBe("Tool results: t1, t2");
  });

  it("truncates text preview at 200 chars", () => {
    const longText = "x".repeat(250);
    const entry = rawAssistantEntry();
    (entry.message as Record<string, unknown>).content = [
      { type: "text", text: longText },
    ];
    const result = convertJsonlEntry(entry, 0);
    expect(result!.entry.summary).toBe(`Text: ${"x".repeat(200)}`);
  });

  it("stores full raw entry in data.raw for assistant", () => {
    const raw = rawAssistantEntry();
    const result = convertJsonlEntry(raw, 0);
    expect(result!.entry.data.raw).toBe(raw);
  });
});

describe("SessionLogWatcher", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("discovers and reads entries from a session file", async () => {
    const entries: AgentLogEntry[] = [];
    writeJsonlFile(tempDir, "session.jsonl", [
      rawAssistantEntry(),
      rawToolResultEntry(),
    ]);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    // Wait for initial poll
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    // Should have synthesized init + assistant + tool_result = 3 entries
    expect(entries.length).toBe(3);
    expect(entries[0].type).toBe("system"); // synthesized init
    expect(entries[0].subtype).toBe("init");
    expect(entries[1].type).toBe("assistant");
    expect(entries[2].type).toBe("user");
  });

  it("synthesizes init entry from first assistant message", async () => {
    const entries: AgentLogEntry[] = [];
    writeJsonlFile(tempDir, "session.jsonl", [rawAssistantEntry()]);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    expect(entries[0].type).toBe("system");
    expect(entries[0].subtype).toBe("init");
    expect(entries[0].data.session_id).toBe("sess-abc-123");
    expect(entries[0].data.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("does not synthesize init when system init already exists", async () => {
    const entries: AgentLogEntry[] = [];
    writeJsonlFile(tempDir, "session.jsonl", [
      rawSystemInit(),
      rawAssistantEntry(),
    ]);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    // system init from file + assistant = 2 (no duplicate synthesized init)
    const initEntries = entries.filter(
      (e) => e.type === "system" && e.subtype === "init",
    );
    expect(initEntries).toHaveLength(1);
  });

  it("picks up new entries appended after start", async () => {
    const entries: AgentLogEntry[] = [];
    const filePath = writeJsonlFile(tempDir, "session.jsonl", [
      rawAssistantEntry(),
    ]);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));

    // Append a new entry
    appendJsonlEntry(filePath, rawToolResultEntry());
    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    // init + assistant + tool_result = 3
    expect(entries.length).toBe(3);
    expect(entries[2].type).toBe("user");
  });

  it("skips metadata entries", async () => {
    const entries: AgentLogEntry[] = [];
    writeJsonlFile(tempDir, "session.jsonl", [
      rawMetadataEntry("permission-mode"),
      rawMetadataEntry("attachment"),
      rawMetadataEntry("file-history-snapshot"),
      rawAssistantEntry(),
    ]);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    // Only init (synthesized) + assistant
    expect(entries.length).toBe(2);
  });

  it("handles partial lines gracefully", async () => {
    const entries: AgentLogEntry[] = [];
    const filePath = join(tempDir, "session.jsonl");
    // Write a partial line (no newline)
    const partialJson = JSON.stringify(rawAssistantEntry());
    writeFileSync(filePath, partialJson);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));

    // No entries yet — line is incomplete
    expect(entries.length).toBe(0);

    // Complete the line
    appendFileSync(filePath, "\n");
    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    // Now the entry should be processed
    expect(entries.length).toBe(2); // init + assistant
  });

  it("accumulates entries in getEntries()", async () => {
    writeJsonlFile(tempDir, "session.jsonl", [
      rawAssistantEntry(),
      rawToolResultEntry(),
    ]);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    const accumulated = watcher.getEntries();
    expect(accumulated.length).toBe(3); // init + assistant + tool_result
    expect(accumulated[0].type).toBe("system");
  });

  it("supports multiple consumers", async () => {
    const consumer1: AgentLogEntry[] = [];
    const consumer2: AgentLogEntry[] = [];
    writeJsonlFile(tempDir, "session.jsonl", [rawAssistantEntry()]);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((e) => consumer1.push(e));
    watcher.onEntry((e) => consumer2.push(e));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    expect(consumer1.length).toBe(2);
    expect(consumer2.length).toBe(2);
  });

  it("handles consumer errors without stopping", async () => {
    const entries: AgentLogEntry[] = [];
    writeJsonlFile(tempDir, "session.jsonl", [rawAssistantEntry()]);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });

    // First consumer throws
    watcher.onEntry(() => {
      throw new Error("consumer crash");
    });
    // Second consumer should still receive entries
    watcher.onEntry((e) => entries.push(e));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    expect(entries.length).toBe(2);
  });

  it("finds file by session ID", async () => {
    writeJsonlFile(tempDir, "sess-target.jsonl", [rawAssistantEntry()]);
    writeJsonlFile(tempDir, "sess-other.jsonl", [rawAssistantEntry()]);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      sessionId: "sess-target",
      pollIntervalMs: 50,
    });

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    expect(watcher.getSessionFilePath()).toBe(
      join(tempDir, "sess-target.jsonl"),
    );
  });

  it("stop() prevents further polling", async () => {
    const entries: AgentLogEntry[] = [];
    const filePath = writeJsonlFile(tempDir, "session.jsonl", [
      rawAssistantEntry(),
    ]);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((e) => entries.push(e));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    const countAfterStop = entries.length;

    // Append more entries — should not be picked up
    appendJsonlEntry(filePath, rawToolResultEntry());
    await new Promise((r) => setTimeout(r, 150));

    expect(entries.length).toBe(countAfterStop);
  });

  it("full session produces a stream of typed entries", async () => {
    writeJsonlFile(tempDir, "session.jsonl", [
      rawAssistantEntry(),
      rawToolResultEntry(),
      rawAssistantEntry({
        message: {
          model: "claude-sonnet-4-5-20250929",
          content: [{ type: "text", text: "Done! The task is complete." }],
          usage: {
            input_tokens: 800,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 4000,
          },
        },
        timestamp: "2026-04-12T10:00:10.000Z",
      }),
    ]);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    const accumulated = watcher.getEntries();

    // synthesized init + assistant + user (tool_result) + assistant = 4
    expect(accumulated).toHaveLength(4);
    expect(accumulated[0].type).toBe("system");
    expect(accumulated[0].subtype).toBe("init");
    expect(accumulated[1].type).toBe("assistant");
    expect(accumulated[2].type).toBe("user");
    expect(accumulated[3].type).toBe("assistant");

    const lastAssistantContent = accumulated[3].data.content as Array<{
      type: string;
      text?: string;
    }>;
    expect(lastAssistantContent[0].text).toBe("Done! The task is complete.");
  });

  it("handles malformed JSON lines gracefully", async () => {
    const entries: AgentLogEntry[] = [];
    const filePath = join(tempDir, "session.jsonl");
    writeFileSync(
      filePath,
      `{invalid json here\n${JSON.stringify(rawAssistantEntry())}\n`,
    );

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((e) => entries.push(e));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    // Should skip the malformed line and process the valid one
    expect(entries.length).toBe(2); // init + assistant
    expect(entries[1].type).toBe("assistant");
  });

  it("start() is idempotent", async () => {
    writeJsonlFile(tempDir, "session.jsonl", [rawAssistantEntry()]);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });

    await watcher.start();
    await watcher.start(); // second call should be no-op
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    // Should have entries from one poll cycle, not doubled
    const entries = watcher.getEntries();
    expect(entries.length).toBe(2); // init + assistant (not 4)
  });

  it("handles empty file", async () => {
    writeFileSync(join(tempDir, "session.jsonl"), "");

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    expect(watcher.getEntries().length).toBe(0);
  });

  it("getSessionFilePath() returns null before start", () => {
    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    expect(watcher.getSessionFilePath()).toBeNull();
  });

  it("recovers when file disappears (ENOENT)", async () => {
    const entries: AgentLogEntry[] = [];
    const filePath = writeJsonlFile(tempDir, "session.jsonl", [
      rawAssistantEntry(),
    ]);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((e) => entries.push(e));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));

    const countBefore = entries.length;

    // Delete the file and create a new one
    rmSync(filePath);
    writeJsonlFile(tempDir, "new-session.jsonl", [rawToolResultEntry()]);

    // Wait for rediscovery + poll
    await new Promise((r) => setTimeout(r, 300));
    watcher.stop();

    // Should have entries from both files
    expect(entries.length).toBeGreaterThan(countBefore);
  });
});

describe("SessionLogWatcher — sub-agent coverage", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Claude Code layout:
   *   <sessionDir>/<session-uuid>.jsonl
   *   <sessionDir>/<session-uuid>/subagents/agent-<hash>.jsonl
   *   <sessionDir>/<session-uuid>/subagents/agent-<hash>.meta.json
   */
  function setupParentPlusSubagent(
    parentStem: string,
    subagentId: string,
    parentEntries: Record<string, unknown>[],
    subagentEntries: Record<string, unknown>[],
    meta?: { agentType?: string; description?: string },
  ): { parentPath: string; subagentPath: string; subagentDir: string } {
    const parentPath = writeJsonlFile(
      tempDir,
      `${parentStem}.jsonl`,
      parentEntries,
    );
    const subagentDir = join(tempDir, parentStem, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    const subagentPath = writeJsonlFile(
      subagentDir,
      `${subagentId}.jsonl`,
      subagentEntries,
    );
    if (meta) {
      writeFileSync(
        join(subagentDir, `${subagentId}.meta.json`),
        JSON.stringify(meta),
      );
    }
    return { parentPath, subagentPath, subagentDir };
  }

  it("emits sub-agent entries with lineage in data", async () => {
    const entries: AgentLogEntry[] = [];
    const subagentAssistant = rawAssistantEntry({
      sessionId: "subagent-sess-001",
      message: {
        model: "claude-sonnet-4-5-20250929",
        content: [{ type: "text", text: "Sub-agent working." }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      timestamp: "2026-04-12T10:00:07.000Z",
    });
    setupParentPlusSubagent(
      "parent-session",
      "agent-abc",
      [rawSystemInit(), rawAssistantEntry()],
      [subagentAssistant],
      { agentType: "Explore", description: "Explore the codebase" },
    );

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    const subagentEntries = entries.filter(
      (e) => e.data.subagent_id !== undefined,
    );
    expect(subagentEntries.length).toBeGreaterThan(0);
    const assistantSub = subagentEntries.find((e) => e.type === "assistant");
    expect(assistantSub).toBeDefined();
    expect(assistantSub!.data.subagent_id).toBe("agent-abc");
    expect(assistantSub!.data.parent_session_id).toBe("sess-abc-123");
    expect(assistantSub!.data.agent_type).toBe("Explore");
  });

  it("parent entries do not carry any lineage fields", async () => {
    const entries: AgentLogEntry[] = [];
    setupParentPlusSubagent(
      "parent-session",
      "agent-abc",
      [rawSystemInit(), rawAssistantEntry()],
      [rawAssistantEntry({ sessionId: "sub-001" })],
      { agentType: "Explore", description: "Explore" },
    );

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    const parentEntries = entries.filter(
      (e) => !Object.prototype.hasOwnProperty.call(e.data, "subagent_id"),
    );
    expect(parentEntries.length).toBeGreaterThan(0);
    for (const entry of parentEntries) {
      expect(entry.data).not.toHaveProperty("subagent_id");
      expect(entry.data).not.toHaveProperty("parent_session_id");
      expect(entry.data).not.toHaveProperty("agent_type");
    }
  });

  it("propagates lineage on sub-agent tool_result (user) entries", async () => {
    const entries: AgentLogEntry[] = [];
    const { subagentPath } = setupParentPlusSubagent(
      "parent-tr",
      "agent-tr",
      [rawSystemInit(), rawAssistantEntry()],
      [rawAssistantEntry({ sessionId: "sub-tr" })],
      { agentType: "Explore", description: "explore" },
    );

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 150));

    // Append a tool_result (user entry) to the sub-agent file — lineage must stamp.
    appendJsonlEntry(subagentPath, rawToolResultEntry({
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "sub-tool", content: "ok" },
        ],
      },
      timestamp: "2026-04-12T10:00:11.000Z",
    }));
    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    const toolResult = entries.find(
      (e) => e.type === "user" && e.data.subagent_id === "agent-tr",
    );
    expect(toolResult).toBeDefined();
    expect(toolResult!.data.parent_session_id).toBe("sess-abc-123");
    expect(toolResult!.data.agent_type).toBe("Explore");
  });

  it("back-fills agent_type when meta.json appears after the jsonl", async () => {
    const entries: AgentLogEntry[] = [];
    const parentStem = "parent-late-meta";
    writeJsonlFile(tempDir, `${parentStem}.jsonl`, [
      rawSystemInit(),
      rawAssistantEntry(),
    ]);
    const subagentDir = join(tempDir, parentStem, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    // jsonl exists but meta does NOT — Claude Code splits those writes.
    writeJsonlFile(subagentDir, "agent-slow.jsonl", [
      rawAssistantEntry({ sessionId: "sub-slow" }),
    ]);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));

    // No meta yet — first entry emitted with agent_type undefined.
    const firstEmit = entries.find((e) => e.data.subagent_id === "agent-slow");
    expect(firstEmit).toBeDefined();
    expect(firstEmit!.data.agent_type).toBeUndefined();

    // Now write meta + append a new sub-agent entry to force another poll read.
    writeFileSync(
      join(subagentDir, "agent-slow.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "explore" }),
    );
    appendJsonlEntry(
      join(subagentDir, "agent-slow.jsonl"),
      rawAssistantEntry({
        sessionId: "sub-slow",
        timestamp: "2026-04-12T10:00:20.000Z",
      }),
    );

    await new Promise((r) => setTimeout(r, 200));
    watcher.stop();

    // The SECOND emission picks up the now-present agent_type.
    const later = entries
      .filter((e) => e.data.subagent_id === "agent-slow")
      .slice(-1)[0];
    expect(later.data.agent_type).toBe("Explore");
  });

  it("tolerates malformed meta.json without crashing the watcher", async () => {
    const entries: AgentLogEntry[] = [];
    const parentStem = "parent-bad-meta";
    writeJsonlFile(tempDir, `${parentStem}.jsonl`, [
      rawSystemInit(),
      rawAssistantEntry(),
    ]);
    const subagentDir = join(tempDir, parentStem, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeJsonlFile(subagentDir, "agent-bad.jsonl", [
      rawAssistantEntry({ sessionId: "sub-bad" }),
    ]);
    writeFileSync(
      join(subagentDir, "agent-bad.meta.json"),
      "{not valid json",
    );

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    const sub = entries.find((e) => e.data.subagent_id === "agent-bad");
    expect(sub).toBeDefined();
    expect(sub!.data.agent_type).toBeUndefined();
  });

  it("drops sub-agent tail on ENOENT without resetting the parent tail", async () => {
    const entries: AgentLogEntry[] = [];
    const { parentPath, subagentPath } = setupParentPlusSubagent(
      "parent-enoent",
      "agent-drop",
      [rawSystemInit(), rawAssistantEntry()],
      [rawAssistantEntry({ sessionId: "sub-drop" })],
      { agentType: "Explore", description: "explore" },
    );

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 150));

    // Delete the sub-agent file mid-session.
    rmSync(subagentPath);

    // Append to the parent — it must keep emitting without rediscovery.
    appendJsonlEntry(parentPath, rawToolResultEntry());
    await new Promise((r) => setTimeout(r, 200));
    watcher.stop();

    // Parent path unchanged (no forced rediscovery).
    expect(watcher.getSessionFilePath()).toBe(parentPath);
    // Parent tool_result still came through.
    const parentTR = entries.find(
      (e) =>
        e.type === "user" &&
        !Object.prototype.hasOwnProperty.call(e.data, "subagent_id"),
    );
    expect(parentTR).toBeDefined();
  });

  it("picks up sub-agent files created after the watcher starts", async () => {
    const entries: AgentLogEntry[] = [];
    const parentPath = writeJsonlFile(tempDir, "parent.jsonl", [
      rawSystemInit(),
      rawAssistantEntry(),
    ]);
    const subagentDir = join(tempDir, "parent", "subagents");

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));

    // Now lazily create sub-agent directory + files
    mkdirSync(subagentDir, { recursive: true });
    writeJsonlFile(subagentDir, "agent-late.jsonl", [
      rawAssistantEntry({ sessionId: "late-sub" }),
    ]);
    writeFileSync(
      join(subagentDir, "agent-late.meta.json"),
      JSON.stringify({ agentType: "test-reviewer", description: "review" }),
    );

    await new Promise((r) => setTimeout(r, 200));
    watcher.stop();

    const lateSub = entries.find((e) => e.data.subagent_id === "agent-late");
    expect(lateSub).toBeDefined();
    expect(lateSub!.data.agent_type).toBe("test-reviewer");
    expect(parentPath).toContain("parent.jsonl");
  });

  it("leaves agent_type undefined when meta.json is absent but still emits entries", async () => {
    const entries: AgentLogEntry[] = [];
    setupParentPlusSubagent(
      "parent-session",
      "agent-nometa",
      [rawSystemInit(), rawAssistantEntry()],
      [rawAssistantEntry({ sessionId: "sub-nometa" })],
      // no meta
    );

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    const sub = entries.find((e) => e.data.subagent_id === "agent-nometa");
    expect(sub).toBeDefined();
    expect(sub!.data.agent_type).toBeUndefined();
    expect(sub!.data.parent_session_id).toBe("sess-abc-123");
  });

  it("does not error and emits only parent entries when subagents/ is missing", async () => {
    const entries: AgentLogEntry[] = [];
    // Parent-only session — no subagents/ directory at all
    writeJsonlFile(tempDir, "session.jsonl", [
      rawSystemInit(),
      rawAssistantEntry(),
    ]);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    expect(entries.length).toBeGreaterThan(0);
    expect(
      entries.every((e) => e.data.subagent_id === undefined),
    ).toBe(true);
  });

  it("handles multiple sub-agents under the same parent", async () => {
    const entries: AgentLogEntry[] = [];
    const parentStem = "multi-parent";
    writeJsonlFile(tempDir, `${parentStem}.jsonl`, [
      rawSystemInit(),
      rawAssistantEntry(),
    ]);
    const subagentDir = join(tempDir, parentStem, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeJsonlFile(subagentDir, "agent-one.jsonl", [
      rawAssistantEntry({ sessionId: "sub-one" }),
    ]);
    writeFileSync(
      join(subagentDir, "agent-one.meta.json"),
      JSON.stringify({ agentType: "Explore", description: "e1" }),
    );
    writeJsonlFile(subagentDir, "agent-two.jsonl", [
      rawAssistantEntry({ sessionId: "sub-two" }),
    ]);
    writeFileSync(
      join(subagentDir, "agent-two.meta.json"),
      JSON.stringify({ agentType: "code-reviewer", description: "e2" }),
    );

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 200));
    watcher.stop();

    const subOne = entries.find((e) => e.data.subagent_id === "agent-one");
    const subTwo = entries.find((e) => e.data.subagent_id === "agent-two");
    expect(subOne).toBeDefined();
    expect(subTwo).toBeDefined();
    expect(subOne!.data.agent_type).toBe("Explore");
    expect(subTwo!.data.agent_type).toBe("code-reviewer");
  });

  it("does not synthesize a system/init event for sub-agent streams", async () => {
    const entries: AgentLogEntry[] = [];
    setupParentPlusSubagent(
      "parent-session",
      "agent-abc",
      [rawSystemInit(), rawAssistantEntry()],
      [rawAssistantEntry({ sessionId: "sub-abc" })],
      { agentType: "Explore", description: "Explore" },
    );

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 200));
    watcher.stop();

    const subInits = entries.filter(
      (e) =>
        e.type === "system" &&
        e.subtype === "init" &&
        e.data.subagent_id !== undefined,
    );
    expect(subInits).toHaveLength(0);
  });

  it("picks up sub-agent entries appended after start", async () => {
    const entries: AgentLogEntry[] = [];
    const { subagentPath } = setupParentPlusSubagent(
      "parent-session",
      "agent-growing",
      [rawSystemInit(), rawAssistantEntry()],
      [rawAssistantEntry({ sessionId: "sub-grow" })],
      { agentType: "Explore", description: "Explore" },
    );

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 150));

    const countBefore = entries.filter(
      (e) => e.data.subagent_id === "agent-growing",
    ).length;

    appendJsonlEntry(
      subagentPath,
      rawToolResultEntry({
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-sub-1",
              content: "sub result",
            },
          ],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 150));
    watcher.stop();

    const countAfter = entries.filter(
      (e) => e.data.subagent_id === "agent-growing",
    ).length;
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});

describe("DISPATCH_TAG_PREFIX", () => {
  it("is a recognizable tag format", () => {
    expect(DISPATCH_TAG_PREFIX).toBe("<!-- danxbot-dispatch:");
  });
});

describe("findSessionFileByDispatchId", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null for empty directory", async () => {
    const result = await findSessionFileByDispatchId(tempDir, "job-123");
    expect(result).toBeNull();
  });

  it("returns null when no file contains the dispatch tag", async () => {
    writeJsonlFile(tempDir, "session-a.jsonl", [rawAssistantEntry()]);
    writeJsonlFile(tempDir, "session-b.jsonl", [rawToolResultEntry()]);
    const result = await findSessionFileByDispatchId(tempDir, "job-123");
    expect(result).toBeNull();
  });

  it("finds the file containing the dispatch tag in a user entry", async () => {
    // File without dispatch tag
    writeJsonlFile(tempDir, "other-session.jsonl", [
      rawAssistantEntry(),
      rawToolResultEntry(),
    ]);

    // File WITH dispatch tag embedded in the piped prompt
    writeJsonlFile(tempDir, "agent-session.jsonl", [
      {
        type: "user",
        message: {
          role: "user",
          content: `${DISPATCH_TAG_PREFIX}job-abc-123 -->\n\n# Schema Builder Task\n\nBuild the schema...`,
        },
        timestamp: "2026-04-13T04:33:03.000Z",
        sessionId: "agent-sess-001",
      },
      rawAssistantEntry(),
    ]);

    const result = await findSessionFileByDispatchId(tempDir, "job-abc-123");
    expect(result).toBe(join(tempDir, "agent-session.jsonl"));
  });

  it("ignores non-jsonl files", async () => {
    writeFileSync(
      join(tempDir, "notes.txt"),
      `${DISPATCH_TAG_PREFIX}job-123 -->`,
    );
    const result = await findSessionFileByDispatchId(tempDir, "job-123");
    expect(result).toBeNull();
  });

  it("handles non-existent directory", async () => {
    const result = await findSessionFileByDispatchId(
      "/nonexistent/path",
      "job-123",
    );
    expect(result).toBeNull();
  });

  it("returns null when dispatch tag is beyond the 64KB scan limit", async () => {
    const padding = "x".repeat(70_000);
    const entry = {
      type: "user",
      message: {
        role: "user",
        content: `${padding}${DISPATCH_TAG_PREFIX}deep-tag -->`,
      },
      timestamp: "2026-04-13T04:33:03.000Z",
    };
    writeJsonlFile(tempDir, "deep-tag.jsonl", [entry]);
    const result = await findSessionFileByDispatchId(tempDir, "deep-tag");
    expect(result).toBeNull();
  });

  it("only matches the exact dispatch ID", async () => {
    writeJsonlFile(tempDir, "session.jsonl", [
      {
        type: "user",
        message: {
          role: "user",
          content: `${DISPATCH_TAG_PREFIX}job-abc -->`,
        },
        timestamp: "2026-04-13T04:33:03.000Z",
      },
    ]);

    // Should NOT match a different dispatch ID
    const noMatch = await findSessionFileByDispatchId(tempDir, "job-abc-123");
    expect(noMatch).toBeNull();

    // Should match the exact ID
    const match = await findSessionFileByDispatchId(tempDir, "job-abc");
    expect(match).toBe(join(tempDir, "session.jsonl"));
  });
});

describe("SessionLogWatcher with dispatchId", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("discovers the correct file by dispatch ID, ignoring newer files", async () => {
    const entries: AgentLogEntry[] = [];

    // Write an older file (human session) with more recent mtime
    const humanFile = writeJsonlFile(tempDir, "human-session.jsonl", [
      rawAssistantEntry(),
      rawToolResultEntry(),
      rawAssistantEntry(),
    ]);

    // Small delay so mtime differs
    await new Promise((r) => setTimeout(r, 50));

    // Write the agent session with the dispatch tag
    writeJsonlFile(tempDir, "agent-session.jsonl", [
      {
        type: "user",
        message: {
          role: "user",
          content: `${DISPATCH_TAG_PREFIX}dispatch-xyz -->\n\nBuild a schema.`,
        },
        timestamp: "2026-04-13T04:33:03.000Z",
        sessionId: "agent-sess",
      },
      rawAssistantEntry(),
    ]);

    // Touch human file to make it newer by mtime (simulates active session)
    appendJsonlEntry(humanFile, rawAssistantEntry());

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      dispatchId: "dispatch-xyz",
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    await watcher.start();
    await new Promise((r) => setTimeout(r, 100));
    watcher.stop();

    // Should have picked the agent session, not the human session
    expect(watcher.getSessionFilePath()).toBe(
      join(tempDir, "agent-session.jsonl"),
    );
    // init (synthesized) + assistant = 2 (from agent file, NOT the 3+ from human file)
    expect(entries.length).toBe(2);
  });

  it("waits for the dispatch file to appear when not immediately available", async () => {
    const entries: AgentLogEntry[] = [];

    // Write a decoy file (no dispatch tag)
    writeJsonlFile(tempDir, "other.jsonl", [rawAssistantEntry()]);

    const watcher = new SessionLogWatcher({
      cwd: "/test",
      sessionDir: tempDir,
      dispatchId: "late-dispatch",
      pollIntervalMs: 50,
    });
    watcher.onEntry((entry) => entries.push(entry));

    // Start the watcher — dispatch file doesn't exist yet
    const startPromise = watcher.start();

    // After 200ms, create the dispatch file (simulates agent startup delay)
    setTimeout(() => {
      writeJsonlFile(tempDir, "dispatch-session.jsonl", [
        {
          type: "user",
          message: {
            role: "user",
            content: `${DISPATCH_TAG_PREFIX}late-dispatch -->\n\nDo the thing.`,
          },
          timestamp: "2026-04-13T04:33:06.000Z",
          sessionId: "late-sess",
        },
        rawAssistantEntry(),
      ]);
    }, 200);

    await startPromise;
    await new Promise((r) => setTimeout(r, 300));
    watcher.stop();

    expect(watcher.getSessionFilePath()).toBe(
      join(tempDir, "dispatch-session.jsonl"),
    );
    expect(entries.length).toBeGreaterThan(0);
  });
});
