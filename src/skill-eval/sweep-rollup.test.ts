import { describe, expect, it } from "vitest";
import type { SideAccuracy } from "./aggregate.js";
import {
  ERROR_MESSAGE_MAX_CODEPOINTS,
  sanitizeErrorForGfm,
  type SweepEntryResult,
} from "./sweep-rollup.js";

function makeSideAccuracy(
  label: "train" | "test",
  correct: number,
  total: number,
): SideAccuracy {
  return {
    label,
    correct,
    total,
    accuracy: total === 0 ? 0 : correct / total,
  };
}

describe("sanitizeErrorForGfm — extended character set", () => {
  it("strips backticks (would close an inline-code span)", () => {
    expect(sanitizeErrorForGfm("oops `code` here")).not.toMatch(/`/);
  });

  it("strips square brackets (would parse as a link)", () => {
    const out = sanitizeErrorForGfm("oops [link](url)");
    expect(out).not.toMatch(/[[\]]/);
  });

  it("strips asterisks (would parse as bold / italic)", () => {
    expect(sanitizeErrorForGfm("oops **bold** here")).not.toMatch(/\*/);
  });

  it("still strips pipes and newlines (existing contract)", () => {
    const out = sanitizeErrorForGfm("a|b\nc\rd");
    expect(out).not.toMatch(/[|\r\n]/);
  });

  it("collapses any run of the stripped chars to a single space", () => {
    const out = sanitizeErrorForGfm("a||||b");
    expect(out).toBe("a b");
  });
});

describe("sanitizeErrorForGfm — codepoint-aware truncation", () => {
  it("truncates a long ASCII message to the configured codepoint cap", () => {
    const raw = "a".repeat(ERROR_MESSAGE_MAX_CODEPOINTS + 50);
    const out = sanitizeErrorForGfm(raw);
    expect(Array.from(out).length).toBe(ERROR_MESSAGE_MAX_CODEPOINTS);
  });

  it("does NOT split a surrogate pair (astral codepoint) at the boundary", () => {
    // `🦀` is U+1F980 — a single codepoint that takes two UTF-16 code
    // units. A `.slice` on the UTF-16 string at chars 79..80 in front
    // of one would orphan its leading surrogate and produce U+FFFD
    // when rendered. The Array.from path treats each emoji as one
    // codepoint, so truncation lands on a clean boundary.
    const padded = "a".repeat(ERROR_MESSAGE_MAX_CODEPOINTS - 1);
    const raw = `${padded}🦀extra`;
    const out = sanitizeErrorForGfm(raw);
    // Trailing codepoint MUST be a clean 🦀 — no orphan surrogate.
    expect(out.endsWith("🦀")).toBe(true);
    // No U+FFFD (the replacement-character marker for orphans).
    expect(out).not.toMatch(/�/);
    // Length is the cap — 79 chars + one full emoji codepoint.
    expect(Array.from(out).length).toBe(ERROR_MESSAGE_MAX_CODEPOINTS);
  });

  it("leaves short messages untouched (other than sanitizer regex)", () => {
    expect(sanitizeErrorForGfm("short")).toBe("short");
  });
});

describe("SweepEntryResult typing", () => {
  it("accepts the canonical entry shape that runAllSweepCore emits", () => {
    const entry: SweepEntryResult = {
      pluginSkill: "dev:debugging",
      evalSetDir: "/tmp/dev-debugging",
      evalSetPath: "/tmp/dev-debugging/eval-set.json",
      overallPass: true,
      train: makeSideAccuracy("train", 12, 12),
      test: makeSideAccuracy("test", 8, 8),
      runsPerQuery: 3,
      costUsd: 0.5,
      elapsedMs: 60_000,
      status: "GREEN",
    };
    expect(entry.status).toBe("GREEN");
  });
});
