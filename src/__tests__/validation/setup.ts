import { vi } from "vitest";

/**
 * Budget tracker for validation tests that use real Claude API calls.
 * Throws if cumulative cost exceeds the ceiling.
 */
export class BudgetTracker {
  private spent = 0;
  private ceiling: number;

  constructor(ceilingUsd = 2.0) {
    this.ceiling = ceilingUsd;
  }

  add(costUsd: number): void {
    this.spent += costUsd;
    if (this.spent > this.ceiling) {
      throw new Error(
        `Budget exceeded: $${this.spent.toFixed(4)} spent, ceiling is $${this.ceiling.toFixed(2)}`,
      );
    }
  }

  get total(): number {
    return this.spent;
  }
}

/**
 * Returns true if the ANTHROPIC_API_KEY env var is set.
 * Use with describe.skipIf(!hasApiKey()) to safely skip in CI.
 */
export function hasApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Mocks only Slack and filesystem dependencies so that router/agent
 * code can run against real Claude APIs without side effects.
 */
export function setupValidationMocks(): void {
  // Mock filesystem operations (agent log writing)
  vi.mock("fs/promises", () => ({
    readFile: vi.fn().mockImplementation(async (path: string) => {
      // Allow reading the real system prompt
      if (typeof path === "string" && path.endsWith("system-prompt.md")) {
        const { readFile } = await vi.importActual<typeof import("fs/promises")>("fs/promises");
        return readFile(path, "utf-8");
      }
      return "mock file content";
    }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  }));

  // Mock thread persistence
  vi.mock("../../threads.js", () => ({
    getOrCreateThread: vi.fn().mockResolvedValue({
      threadTs: "validation-thread",
      channelId: "C-VALIDATION",
      sessionId: null,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    addMessageToThread: vi.fn(),
    updateSessionId: vi.fn(),
    isBotParticipant: vi.fn().mockResolvedValue(false),
  }));
}
