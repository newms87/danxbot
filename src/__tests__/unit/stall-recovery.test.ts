/**
 * Unit tests for completion-instruction plumbing. Historically this file also
 * covered `buildMcpSettings` (now deleted in Phase 2 of card XCptaJ34 — the
 * single `resolveDispatchTools` resolver in `src/agent/resolve-dispatch-tools.ts`
 * is the new source of truth and has its own dedicated test file).
 */

import { describe, it, expect, vi } from "vitest";

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
