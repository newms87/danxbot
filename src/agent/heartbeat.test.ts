import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class {
      messages = { create: mockCreate };
    },
  };
});

vi.mock("../config.js", () => ({
  config: {
    anthropic: { apiKey: "test-key" },
    agent: { routerModel: "test-router-model" },
  },
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { VALID_SLACK_EMOJIS, HEARTBEAT_SYSTEM_PROMPT, generateHeartbeatMessage } =
  await import("./heartbeat.js");

const MOCK_USAGE = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

// --- Tests ---

beforeEach(() => {
  mockCreate.mockReset();
});

describe("VALID_SLACK_EMOJIS", () => {
  it("is a non-empty array of strings", () => {
    expect(Array.isArray(VALID_SLACK_EMOJIS)).toBe(true);
    expect(VALID_SLACK_EMOJIS.length).toBeGreaterThan(10);
    for (const emoji of VALID_SLACK_EMOJIS) {
      expect(typeof emoji).toBe("string");
    }
  });

  it("entries do not have colons", () => {
    for (const emoji of VALID_SLACK_EMOJIS) {
      expect(emoji).not.toContain(":");
    }
  });
});

describe("HEARTBEAT_SYSTEM_PROMPT", () => {
  it("includes the valid emoji list", () => {
    for (const emoji of VALID_SLACK_EMOJIS) {
      expect(HEARTBEAT_SYSTEM_PROMPT).toContain(`:${emoji}:`);
    }
  });

  it("instructs the LLM to only pick from the list", () => {
    expect(HEARTBEAT_SYSTEM_PROMPT).toMatch(/only|ONLY/i);
  });
});

describe("generateHeartbeatMessage emoji validation", () => {
  it("returns a valid emoji from the list when the LLM picks one", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '{"emoji": ":mag:", "color": "#3498db", "text": "Searching the codebase"}',
        },
      ],
    });

    const result = await generateHeartbeatMessage("Elapsed: 10s", []);

    expect(result.update.emoji).toBe(":mag:");
    expect(result.usage).not.toBeNull();
  });

  it("replaces invalid emoji with fallback", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '{"emoji": ":detective:", "color": "#e67e22", "text": "Investigating the issue"}',
        },
      ],
    });

    const result = await generateHeartbeatMessage("Elapsed: 10s", []);

    expect(result.update.emoji).toBe(":hourglass_flowing_sand:");
    // Other fields should be preserved
    expect(result.update.color).toBe("#e67e22");
    expect(result.update.text).toBe("Investigating the issue");
  });

  it("replaces another invalid emoji with fallback", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '{"emoji": ":totally_fake_emoji:", "color": "#abc123", "text": "Doing stuff"}',
        },
      ],
    });

    const result = await generateHeartbeatMessage("Elapsed: 10s", []);

    expect(result.update.emoji).toBe(":hourglass_flowing_sand:");
  });

  it("normalizes bare emoji name (no colons) to :name: format", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '{"emoji": "rocket", "color": "#e74c3c", "text": "Blasting off"}',
        },
      ],
    });

    const result = await generateHeartbeatMessage("Elapsed: 10s", []);

    expect(result.update.emoji).toBe(":rocket:");
  });

  it("normalizes emoji with single leading colon to :name: format", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '{"emoji": ":rocket", "color": "#e74c3c", "text": "Blasting off"}',
        },
      ],
    });

    const result = await generateHeartbeatMessage("Elapsed: 10s", []);

    expect(result.update.emoji).toBe(":rocket:");
  });

  it("does not send output_config (Haiku does not support effort)", async () => {
    mockCreate.mockResolvedValueOnce({
      usage: MOCK_USAGE,
      content: [
        {
          type: "text",
          text: '{"emoji": ":mag:", "color": "#3498db", "text": "Searching"}',
        },
      ],
    });

    await generateHeartbeatMessage("Elapsed: 10s", []);

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.output_config).toBeUndefined();
  });

  it("accepts a sample of emojis from the valid list", async () => {
    for (const emoji of VALID_SLACK_EMOJIS.slice(0, 3)) {
      mockCreate.mockResolvedValueOnce({
        usage: MOCK_USAGE,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              emoji: `:${emoji}:`,
              color: "#000000",
              text: "Test",
            }),
          },
        ],
      });

      const result = await generateHeartbeatMessage("Elapsed: 10s", []);
      expect(result.update.emoji).toBe(`:${emoji}:`);
    }
  });
});
