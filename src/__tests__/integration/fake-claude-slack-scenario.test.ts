/**
 * Integration test for fake-claude.ts's `slack` scenario.
 *
 * Spawns fake-claude as a subprocess (mirrors the dispatch-pipeline test's
 * approach) and verifies it POSTs the right shapes to a CaptureServer
 * standing in for the worker's `/api/slack/{update,reply,stop}` endpoints.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CaptureServer } from "./helpers/capture-server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fakeClaudePath = resolve(__dirname, "helpers/fake-claude.ts");

interface SpawnEnv {
  FAKE_CLAUDE_SCENARIO?: string;
  FAKE_CLAUDE_SLACK_UPDATES?: string;
  FAKE_CLAUDE_SLACK_REPLY?: string;
  FAKE_CLAUDE_SLACK_SQL_BLOCK?: string;
  FAKE_CLAUDE_SLACK_STATUS?: string;
  FAKE_CLAUDE_SLACK_SUMMARY?: string;
  DANXBOT_SLACK_UPDATE_URL?: string;
  DANXBOT_SLACK_REPLY_URL?: string;
  DANXBOT_STOP_URL?: string;
  FAKE_CLAUDE_LINGER_MS?: string;
  FAKE_CLAUDE_WRITE_DELAY_MS?: string;
}

async function runFakeClaude(
  promptTag: string,
  sessionDir: string,
  envOverrides: SpawnEnv,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "node",
      [
        "--import",
        "tsx/esm",
        fakeClaudePath,
        "--dangerously-skip-permissions",
        "-p",
        promptTag,
      ],
      {
        env: {
          ...process.env,
          FAKE_CLAUDE_SESSION_DIR: sessionDir,
          FAKE_CLAUDE_LINGER_MS: "100",
          FAKE_CLAUDE_WRITE_DELAY_MS: "10",
          ...envOverrides,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolvePromise({ exitCode: code ?? -1, stderr });
    });
  });
}

describe("fake-claude.ts slack scenario", () => {
  let server: CaptureServer;
  let sessionDir: string;

  beforeEach(async () => {
    server = new CaptureServer();
    await server.start();
    sessionDir = mkdtempSync(join(tmpdir(), "fake-claude-slack-"));
  });

  afterEach(async () => {
    await server.stop();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("POSTs each FAKE_CLAUDE_SLACK_UPDATES line to DANXBOT_SLACK_UPDATE_URL in order", async () => {
    const result = await runFakeClaude(
      "<!-- danxbot-dispatch:test1 --> some prompt",
      sessionDir,
      {
        FAKE_CLAUDE_SCENARIO: "slack",
        FAKE_CLAUDE_SLACK_UPDATES: "Looking into it...\nAlmost there...",
        FAKE_CLAUDE_SLACK_REPLY: "All done.",
        DANXBOT_SLACK_UPDATE_URL: `${server.baseUrl}/api/slack/update/test1`,
        DANXBOT_SLACK_REPLY_URL: `${server.baseUrl}/api/slack/reply/test1`,
        DANXBOT_STOP_URL: `${server.baseUrl}/api/stop/test1`,
      },
    );

    expect(result.exitCode).toBe(0);

    const updates = server
      .getRequestsByPath("/api/slack/update/")
      .map((r) => JSON.parse(r.body) as { text: string });
    expect(updates.map((u) => u.text)).toEqual([
      "Looking into it...",
      "Almost there...",
    ]);
  });

  it("POSTs FAKE_CLAUDE_SLACK_REPLY verbatim to DANXBOT_SLACK_REPLY_URL when no SQL block is set", async () => {
    await runFakeClaude(
      "<!-- danxbot-dispatch:test2 --> hi",
      sessionDir,
      {
        FAKE_CLAUDE_SCENARIO: "slack",
        FAKE_CLAUDE_SLACK_REPLY: "Hello world",
        DANXBOT_SLACK_UPDATE_URL: `${server.baseUrl}/api/slack/update/test2`,
        DANXBOT_SLACK_REPLY_URL: `${server.baseUrl}/api/slack/reply/test2`,
        DANXBOT_STOP_URL: `${server.baseUrl}/api/stop/test2`,
      },
    );

    const replies = server.getRequestsByPath("/api/slack/reply/");
    expect(replies).toHaveLength(1);
    const body = JSON.parse(replies[0].body) as { text: string };
    expect(body.text).toBe("Hello world");
  });

  it("appends a ```sql:execute …``` block to the final reply when FAKE_CLAUDE_SLACK_SQL_BLOCK is set (K2zQYIdX regression-guard path)", async () => {
    await runFakeClaude(
      "<!-- danxbot-dispatch:test3 --> what's in users?",
      sessionDir,
      {
        FAKE_CLAUDE_SCENARIO: "slack",
        FAKE_CLAUDE_SLACK_REPLY: "Here is the count:",
        FAKE_CLAUDE_SLACK_SQL_BLOCK: "SELECT COUNT(*) FROM users",
        DANXBOT_SLACK_UPDATE_URL: `${server.baseUrl}/api/slack/update/test3`,
        DANXBOT_SLACK_REPLY_URL: `${server.baseUrl}/api/slack/reply/test3`,
        DANXBOT_STOP_URL: `${server.baseUrl}/api/stop/test3`,
      },
    );

    const replies = server.getRequestsByPath("/api/slack/reply/");
    expect(replies).toHaveLength(1);
    const body = JSON.parse(replies[0].body) as { text: string };
    expect(body.text).toContain("Here is the count:");
    expect(body.text).toContain("```sql:execute");
    expect(body.text).toContain("SELECT COUNT(*) FROM users");
    expect(body.text).toContain("```");
  });

  it("POSTs {status:'completed', summary} to DANXBOT_STOP_URL via the danxbot_complete MCP shape after the reply", async () => {
    await runFakeClaude(
      "<!-- danxbot-dispatch:test4 --> hi",
      sessionDir,
      {
        FAKE_CLAUDE_SCENARIO: "slack",
        FAKE_CLAUDE_SLACK_REPLY: "Done.",
        DANXBOT_SLACK_UPDATE_URL: `${server.baseUrl}/api/slack/update/test4`,
        DANXBOT_SLACK_REPLY_URL: `${server.baseUrl}/api/slack/reply/test4`,
        DANXBOT_STOP_URL: `${server.baseUrl}/api/stop/test4`,
      },
    );

    const stops = server.getRequestsByPath("/api/stop/");
    expect(stops).toHaveLength(1);
    const body = JSON.parse(stops[0].body) as { status: string; summary?: string };
    expect(body.status).toBe("completed");
    expect(body.summary).toBe("Done.");
  });

  it("supports failure injection via FAKE_CLAUDE_SLACK_STATUS=failed + FAKE_CLAUDE_SLACK_SUMMARY", async () => {
    await runFakeClaude(
      "<!-- danxbot-dispatch:test5 --> hi",
      sessionDir,
      {
        FAKE_CLAUDE_SCENARIO: "slack",
        FAKE_CLAUDE_SLACK_REPLY: "I tried but failed.",
        FAKE_CLAUDE_SLACK_STATUS: "failed",
        FAKE_CLAUDE_SLACK_SUMMARY: "Schema not found",
        DANXBOT_SLACK_UPDATE_URL: `${server.baseUrl}/api/slack/update/test5`,
        DANXBOT_SLACK_REPLY_URL: `${server.baseUrl}/api/slack/reply/test5`,
        DANXBOT_STOP_URL: `${server.baseUrl}/api/stop/test5`,
      },
    );

    const stops = server.getRequestsByPath("/api/stop/");
    expect(stops).toHaveLength(1);
    const body = JSON.parse(stops[0].body) as { status: string; summary?: string };
    expect(body.status).toBe("failed");
    expect(body.summary).toBe("Schema not found");
  });

  it("POST ordering is updates → reply → stop (so the listener's reaction lifecycle observes the right sequence)", async () => {
    await runFakeClaude(
      "<!-- danxbot-dispatch:test6 --> hi",
      sessionDir,
      {
        FAKE_CLAUDE_SCENARIO: "slack",
        FAKE_CLAUDE_SLACK_UPDATES: "step 1\nstep 2",
        FAKE_CLAUDE_SLACK_REPLY: "final",
        DANXBOT_SLACK_UPDATE_URL: `${server.baseUrl}/api/slack/update/test6`,
        DANXBOT_SLACK_REPLY_URL: `${server.baseUrl}/api/slack/reply/test6`,
        DANXBOT_STOP_URL: `${server.baseUrl}/api/stop/test6`,
      },
    );

    const requests = server.getRequests();
    const slackPaths = requests
      .filter(
        (r) =>
          r.path.startsWith("/api/slack/update/") ||
          r.path.startsWith("/api/slack/reply/") ||
          r.path.startsWith("/api/stop/"),
      )
      .map((r) => r.path);
    expect(slackPaths).toEqual([
      "/api/slack/update/test6",
      "/api/slack/update/test6",
      "/api/slack/reply/test6",
      "/api/stop/test6",
    ]);
  });

  it("exits non-zero when DANXBOT_SLACK_UPDATE_URL is missing (loud failure, not silent skip)", async () => {
    const result = await runFakeClaude(
      "<!-- danxbot-dispatch:test7 --> hi",
      sessionDir,
      {
        FAKE_CLAUDE_SCENARIO: "slack",
        FAKE_CLAUDE_SLACK_REPLY: "Done.",
        // All three URLs are required. Empty + empty + empty forces the
        // failure path even when the parent vitest process happens to
        // have one of these set.
        DANXBOT_SLACK_UPDATE_URL: "",
        DANXBOT_SLACK_REPLY_URL: "",
        DANXBOT_STOP_URL: "",
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/DANXBOT_SLACK_UPDATE_URL/);
  });

  it("exits non-zero when only DANXBOT_STOP_URL is missing (the third required URL — no silent skip of the completion signal)", async () => {
    const result = await runFakeClaude(
      "<!-- danxbot-dispatch:test7b --> hi",
      sessionDir,
      {
        FAKE_CLAUDE_SCENARIO: "slack",
        FAKE_CLAUDE_SLACK_REPLY: "Done.",
        DANXBOT_SLACK_UPDATE_URL: "http://127.0.0.1:1/u",
        DANXBOT_SLACK_REPLY_URL: "http://127.0.0.1:1/r",
        DANXBOT_STOP_URL: "",
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/DANXBOT_STOP_URL/);
  });

  it("writes JSONL tool_use + tool_result entries between POSTs so SessionLogWatcher stays attached (regression guard for the slack-scenario header comment)", async () => {
    await runFakeClaude(
      "<!-- danxbot-dispatch:jsonl --> hi",
      sessionDir,
      {
        FAKE_CLAUDE_SCENARIO: "slack",
        FAKE_CLAUDE_SLACK_UPDATES: "step 1\nstep 2",
        FAKE_CLAUDE_SLACK_REPLY: "final answer",
        DANXBOT_SLACK_UPDATE_URL: `${server.baseUrl}/api/slack/update/jsonl`,
        DANXBOT_SLACK_REPLY_URL: `${server.baseUrl}/api/slack/reply/jsonl`,
        DANXBOT_STOP_URL: `${server.baseUrl}/api/stop/jsonl`,
      },
    );

    const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(sessionDir, files[0]), "utf-8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));

    // The first user entry holds the prompt as `content: <string>`;
    // tool_use / tool_result entries hold `content: [{type, ...}]`.
    // Only the array shape carries the per-tool entries we want to count.
    type Entry = {
      type?: string;
      subtype?: string;
      message?: { content?: unknown };
    };
    const blocksOf = (l: Entry): { type?: string }[] =>
      Array.isArray(l.message?.content) ? l.message!.content : [];
    const toolUseEntries = (lines as Entry[]).filter((l) =>
      blocksOf(l).some((c) => c.type === "tool_use"),
    );
    expect(toolUseEntries).toHaveLength(3); // 2 updates + 1 reply

    const toolResultEntries = (lines as Entry[]).filter((l) =>
      blocksOf(l).some((c) => c.type === "tool_result"),
    );
    expect(toolResultEntries).toHaveLength(3);

    const resultEntries = (lines as Entry[]).filter((l) => l.type === "result");
    expect(resultEntries).toHaveLength(1);
    expect(resultEntries[0]).toMatchObject({ subtype: "success" });
  });

  it("exits non-zero when the worker (capture server) returns a 5xx — postJson must fail loud, not retry silently", async () => {
    // Stand up a separate server that returns 500 for every request,
    // then point fake-claude at it. The shared CaptureServer in
    // beforeEach always returns 200, which is wrong for this case.
    let failingServer: Server | null = null;
    const failingPort = await new Promise<number>((resolvePort, reject) => {
      const s = createServer((_req, res) => {
        res.writeHead(500);
        res.end("server error");
      });
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const addr = s.address();
        if (typeof addr === "object" && addr !== null) {
          failingServer = s;
          resolvePort(addr.port);
        } else {
          reject(new Error("could not get port"));
        }
      });
    });

    try {
      const result = await runFakeClaude(
        "<!-- danxbot-dispatch:fail --> hi",
        sessionDir,
        {
          FAKE_CLAUDE_SCENARIO: "slack",
          FAKE_CLAUDE_SLACK_REPLY: "wont-arrive",
          DANXBOT_SLACK_UPDATE_URL: `http://127.0.0.1:${failingPort}/u`,
          DANXBOT_SLACK_REPLY_URL: `http://127.0.0.1:${failingPort}/r`,
          DANXBOT_STOP_URL: `http://127.0.0.1:${failingPort}/s`,
        },
      );

      expect(result.exitCode).not.toBe(0);
      // postJson's error message is the form `fake-claude slack POST <url> -> <status>`.
      expect(result.stderr).toMatch(/-> 500/);
    } finally {
      await new Promise<void>((r) => failingServer!.close(() => r()));
    }
  });

  it("works with empty FAKE_CLAUDE_SLACK_UPDATES (zero progress posts before the final reply)", async () => {
    await runFakeClaude(
      "<!-- danxbot-dispatch:test8 --> hi",
      sessionDir,
      {
        FAKE_CLAUDE_SCENARIO: "slack",
        FAKE_CLAUDE_SLACK_UPDATES: "",
        FAKE_CLAUDE_SLACK_REPLY: "instant",
        DANXBOT_SLACK_UPDATE_URL: `${server.baseUrl}/api/slack/update/test8`,
        DANXBOT_SLACK_REPLY_URL: `${server.baseUrl}/api/slack/reply/test8`,
        DANXBOT_STOP_URL: `${server.baseUrl}/api/stop/test8`,
      },
    );

    expect(server.getRequestsByPath("/api/slack/update/")).toHaveLength(0);
    expect(server.getRequestsByPath("/api/slack/reply/")).toHaveLength(1);
  });
});
