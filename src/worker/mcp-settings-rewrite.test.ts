import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteMcpSettingsIfPortChanged } from "./mcp-settings-rewrite.js";

let tempDir: string;

function writeSettings(content: unknown): string {
  const path = join(tempDir, "settings.json");
  writeFileSync(path, JSON.stringify(content, null, 2));
  return path;
}

function readSettings(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "mcp-settings-rewrite-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("rewriteMcpSettingsIfPortChanged", () => {
  it("returns rewritten=false and leaves the file untouched when the port matches", async () => {
    const path = writeSettings({
      mcpServers: {
        danxbot: {
          command: "npx",
          args: ["tsx", "/danxbot/src/mcp/danxbot-server.ts"],
          env: {
            DANXBOT_STOP_URL: "http://localhost:9300/api/stop/dispatch-1",
          },
        },
      },
    });
    const before = readFileSync(path, "utf-8");

    const result = await rewriteMcpSettingsIfPortChanged(path, 9300);

    expect(result.rewritten).toBe(false);
    expect(result.oldPort).toBe(9300);
    expect(result.newPort).toBe(9300);
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("rewrites every localhost URL across every server's env when the port differs", async () => {
    // Multiple URLs typically share the same worker port (DX-209 +
    // dispatch core injects DANXBOT_STOP_URL, DANXBOT_SLACK_REPLY_URL,
    // etc. all derived from one port). Fixing one without the others
    // would leave a half-broken MCP file.
    const path = writeSettings({
      mcpServers: {
        danxbot: {
          command: "npx",
          args: ["tsx", "/x.ts"],
          env: {
            DANXBOT_STOP_URL: "http://localhost:9300/api/stop/d-1",
            DANXBOT_SLACK_REPLY_URL: "http://localhost:9300/api/slack/reply/d-1",
            DANXBOT_ISSUE_CREATE_URL:
              "http://localhost:9300/api/issue-create/d-1",
            UNRELATED: "https://api.example.com/foo",
          },
        },
        otherServer: {
          command: "x",
          env: {
            CALLBACK: "http://localhost:9300/api/x",
          },
        },
      },
    });

    const result = await rewriteMcpSettingsIfPortChanged(path, 9400);

    expect(result.rewritten).toBe(true);
    expect(result.oldPort).toBe(9300);
    expect(result.newPort).toBe(9400);

    const updated = readSettings(path) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    expect(updated.mcpServers.danxbot.env.DANXBOT_STOP_URL).toBe(
      "http://localhost:9400/api/stop/d-1",
    );
    expect(updated.mcpServers.danxbot.env.DANXBOT_SLACK_REPLY_URL).toBe(
      "http://localhost:9400/api/slack/reply/d-1",
    );
    expect(updated.mcpServers.danxbot.env.DANXBOT_ISSUE_CREATE_URL).toBe(
      "http://localhost:9400/api/issue-create/d-1",
    );
    // Unrelated URLs (different host) are NOT touched.
    expect(updated.mcpServers.danxbot.env.UNRELATED).toBe(
      "https://api.example.com/foo",
    );
    // Sibling servers in the same file get the same port swap.
    expect(updated.mcpServers.otherServer.env.CALLBACK).toBe(
      "http://localhost:9400/api/x",
    );
  });

  it("returns rewritten=false when the file is missing (ENOENT)", async () => {
    const path = join(tempDir, "does-not-exist.json");
    const result = await rewriteMcpSettingsIfPortChanged(path, 9400);
    expect(result.rewritten).toBe(false);
    expect(result.oldPort).toBeUndefined();
    expect(result.newPort).toBe(9400);
  });

  it("throws when the file exists but cannot be parsed (corrupt JSON is operator-visible, not silently ignored)", async () => {
    const path = join(tempDir, "settings.json");
    writeFileSync(path, "{not json}");
    await expect(
      rewriteMcpSettingsIfPortChanged(path, 9400),
    ).rejects.toThrow();
  });

  it("returns rewritten=false when DANXBOT_STOP_URL is absent (cannot detect old port; nothing to rewrite)", async () => {
    const path = writeSettings({
      mcpServers: {
        danxbot: {
          command: "npx",
          args: ["tsx", "/x.ts"],
          env: {
            // No STOP_URL — pre-DX-209 file shape or a non-danxbot-only
            // server. Without the canonical port reference we cannot
            // safely rewrite; bail out as a no-op.
            UNRELATED: "https://example.com",
          },
        },
      },
    });
    const before = readFileSync(path, "utf-8");

    const result = await rewriteMcpSettingsIfPortChanged(path, 9400);

    expect(result.rewritten).toBe(false);
    expect(result.oldPort).toBeUndefined();
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("writes atomically via a sibling tmp file + rename (a partial write never lands in place)", async () => {
    // Mechanical proof: after a successful rewrite the only file that
    // exists alongside `settings.json` is `settings.json` itself — the
    // tmp file is renamed away. A non-atomic implementation that fsync'd
    // through the original path could leave half-written JSON visible to
    // the agent's MCP server; the rename pattern guarantees the file
    // ALWAYS contains a complete document.
    const path = writeSettings({
      mcpServers: {
        danxbot: {
          command: "x",
          env: { DANXBOT_STOP_URL: "http://localhost:9300/api/stop/d-1" },
        },
      },
    });

    await rewriteMcpSettingsIfPortChanged(path, 9400);

    const { readdirSync } = await import("node:fs");
    const files = readdirSync(tempDir);
    expect(files).toContain("settings.json");
    // No leftover .tmp file
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
