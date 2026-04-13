import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "fs/promises";

async function loadPrompt(filename: string): Promise<string> {
  return readFile(new URL(`./${filename}`, import.meta.url), "utf-8");
}

/**
 * Extract the contents of all ```bash code blocks from text.
 */
function extractBashBlocks(text: string): string[] {
  const blocks: string[] = [];
  const regex = /```bash\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

describe("system-prompt.md", () => {
  let prompt: string;

  beforeAll(async () => {
    prompt = await loadPrompt("system-prompt.md");
  });

  it("does not contain mysql CLI instructions or Bash query patterns", () => {
    // No mysql CLI invocation pattern (covers -h, --host, etc.)
    expect(prompt).not.toMatch(/mysql\s+(-|--|')/i);
    // No instructions to run queries via Bash
    expect(prompt).not.toMatch(/run queries yourself via bash/i);
    expect(prompt).not.toMatch(/running queries yourself/i);
    // No bash code block that invokes mysql
    for (const block of extractBashBlocks(prompt)) {
      expect(block).not.toMatch(/\bmysql\b/i);
    }
  });

  it("instructs agent to use sql:execute blocks for all data queries", () => {
    expect(prompt).toContain("sql:execute");
    expect(prompt).toMatch(/never.*(?:execute|run).*sql.*(?:bash|mysql|command)/i);
  });
});

describe("fast-system-prompt.md", () => {
  let prompt: string;

  beforeAll(async () => {
    prompt = await loadPrompt("fast-system-prompt.md");
  });

  it("does not contain mysql CLI instructions or Bash query patterns", () => {
    expect(prompt).not.toMatch(/run queries yourself via bash/i);
    expect(prompt).not.toMatch(/mysql\s+(-|--|')/i);
    for (const block of extractBashBlocks(prompt)) {
      expect(block).not.toMatch(/\bmysql\b/i);
    }
  });

  it("instructs agent to use sql:execute blocks", () => {
    expect(prompt).toContain("sql:execute");
    // Fast prompt delegates query restrictions to the tools rule file
    expect(prompt).toMatch(/tools\.md/i);
  });
});
