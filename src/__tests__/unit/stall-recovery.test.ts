/**
 * Unit tests for stall recovery in dispatch.ts.
 *
 * Tests that:
 * 1. onStall kills the stalled process and spawns a replacement
 * 2. The replacement gets the nudge prompt
 * 3. After MAX_RESUMES, the job is marked failed instead of respawned
 * 4. buildMcpSettings includes danxbot server when stop URL is provided
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { buildMcpSettings } from "../../agent/launcher.js";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Mock config to avoid DB connection requirement
vi.mock("../../config.js", () => ({
  config: {
    runtime: "docker",
    isHost: false,
    dispatch: {
      defaultApiUrl: "http://localhost:80",
      agentTimeoutMs: 30_000,
    },
    logsDir: "/tmp/danxbot-test-logs",
  },
}));

vi.mock("../../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../poller/constants.js", () => ({
  getReposBase: () => "/tmp/danxbot-test-repos",
}));

vi.mock("../../terminal.js", () => ({
  buildDispatchScript: vi.fn(),
  getTerminalLogPath: vi.fn(),
  spawnInTerminal: vi.fn(),
}));

describe("buildMcpSettings with danxbot server", () => {
  let settingsDirs: string[] = [];

  afterEach(() => {
    for (const dir of settingsDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    settingsDirs = [];
  });

  it("does not include danxbot server when no stop URL", () => {
    const dir = buildMcpSettings({ apiToken: "tok", apiUrl: "http://api" });
    settingsDirs.push(dir);

    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
    expect(settings.mcpServers.schema).toBeDefined();
    expect(settings.mcpServers.danxbot).toBeUndefined();
  });

  it("includes danxbot server when stop URL is provided", () => {
    const dir = buildMcpSettings({
      apiToken: "tok",
      apiUrl: "http://api",
      danxbotStopUrl: "http://localhost:5560/api/stop/test-job-id",
    });
    settingsDirs.push(dir);

    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
    expect(settings.mcpServers.schema).toBeDefined();
    expect(settings.mcpServers.danxbot).toBeDefined();

    const danxbotServer = settings.mcpServers.danxbot;
    expect(danxbotServer.command).toBeDefined();
    expect(Array.isArray(danxbotServer.args)).toBe(true);
    expect(danxbotServer.env.DANXBOT_STOP_URL).toBe("http://localhost:5560/api/stop/test-job-id");
  });

  it("danxbot server env contains the exact stop URL", () => {
    const stopUrl = "http://localhost:5560/api/stop/abc-123-def";
    const dir = buildMcpSettings({ apiToken: "tok", apiUrl: "http://api", danxbotStopUrl: stopUrl });
    settingsDirs.push(dir);

    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
    expect(settings.mcpServers.danxbot.env.DANXBOT_STOP_URL).toBe(stopUrl);
  });
});

describe("buildCompletionInstruction", () => {
  it("returns instruction text referencing danxbot_complete with newline separator", async () => {
    const { buildCompletionInstruction } = await import("../../agent/launcher.js");
    const instruction = buildCompletionInstruction();
    expect(instruction).toContain("danxbot_complete");
    // Instruction must start with separator so it's visually distinct from the task
    expect(instruction).toMatch(/^\n\n---\n/);
    expect(instruction.length).toBeGreaterThan(20);
  });

  it("appended instruction appears in the task prompt when concatenated", async () => {
    const { buildCompletionInstruction } = await import("../../agent/launcher.js");
    const task = "Fix the authentication bug";
    const combined = task + buildCompletionInstruction();
    expect(combined).toContain(task);
    expect(combined).toContain("danxbot_complete");
    // Task and instruction are distinct sections
    expect(combined.indexOf(task)).toBeLessThan(combined.indexOf("danxbot_complete"));
  });
});
