import { describe, it, expect } from "vitest";
import { extractDescription, renderSystemPrompt } from "./system-prompt-loader.js";

describe("extractDescription", () => {
  it("returns the first non-heading, non-blank paragraph verbatim", () => {
    const md = `# Platform Overview

Flytedesk's monorepo: Laravel backend, Vue 3 frontend, and Digital Playground.

## Tech Stack

| Layer | Technology |`;
    expect(extractDescription(md)).toBe(
      "Flytedesk's monorepo: Laravel backend, Vue 3 frontend, and Digital Playground.",
    );
  });

  it("skips multiple heading levels before finding the paragraph", () => {
    const md = `# Title
## Subtitle
### Deeper

The actual description lives here.`;
    expect(extractDescription(md)).toBe("The actual description lives here.");
  });

  it("returns empty string when no paragraph is present", () => {
    expect(extractDescription("# Only headings\n## Nothing else")).toBe("");
    expect(extractDescription("")).toBe("");
  });
});

describe("renderSystemPrompt", () => {
  const template = `You serve {{REPO_NAME}} ({{REPO_DESCRIPTION}}).

Review list: {{REVIEW_LIST_ID}}

Features:
{{FEATURE_LIST}}`;

  it("substitutes all four template variables", () => {
    const out = renderSystemPrompt(template, {
      repoName: "platform",
      repoDescription: "Flytedesk monorepo",
      reviewListId: "list-123",
      featureList: "- feature a\n- feature b",
    });
    expect(out).toContain("You serve platform (Flytedesk monorepo).");
    expect(out).toContain("Review list: list-123");
    expect(out).toContain("- feature a");
    expect(out).not.toContain("{{REPO_NAME}}");
    expect(out).not.toContain("{{REPO_DESCRIPTION}}");
    expect(out).not.toContain("{{REVIEW_LIST_ID}}");
    expect(out).not.toContain("{{FEATURE_LIST}}");
  });

  it("substitutes every occurrence of each variable", () => {
    const repeatTemplate = "{{REPO_NAME}} and {{REPO_NAME}} again";
    const out = renderSystemPrompt(repeatTemplate, {
      repoName: "platform",
      repoDescription: "d",
      reviewListId: "r",
      featureList: "f",
    });
    expect(out).toBe("platform and platform again");
  });
});

describe("system-prompt.md template", () => {
  it("names the connected repo via {{REPO_NAME}} and includes its description", async () => {
    const { readFile } = await import("fs/promises");
    const template = await readFile(
      new URL("./system-prompt.md", import.meta.url),
      "utf-8",
    );
    expect(template).toContain("{{REPO_NAME}}");
    expect(template).toContain("{{REPO_DESCRIPTION}}");
  });

  it("forbids asking which project and permits clarification only for overly-broad queries", async () => {
    const { readFile } = await import("fs/promises");
    const template = await readFile(
      new URL("./system-prompt.md", import.meta.url),
      "utf-8",
    );
    // Forbids project clarification
    expect(template).toMatch(/never ask.*which project/i);
    // Permits clarification for large result sets / scope
    expect(template).toMatch(/large|unreasonabl|narrow|broad|scope/i);
  });

  it("tells the agent to run read-only queries without asking permission", async () => {
    const { readFile } = await import("fs/promises");
    const template = await readFile(
      new URL("./system-prompt.md", import.meta.url),
      "utf-8",
    );
    // Explicit: running SELECT is not an action that needs approval.
    expect(template).toMatch(/don't ask.*permission|without asking|take agency|just run/i);
    // Frames reads as the agent's job, not a risky action.
    expect(template).toMatch(/read-only|reading.*data|not.*modification/i);
    // Forbids preamble like "I'll run a query for you"
    expect(template).toMatch(/do not describe|don't preview|no preamble|skip.*confirmation/i);
  });
});

describe("fast-system-prompt.md template", () => {
  it("also names the connected repo via {{REPO_NAME}}", async () => {
    const { readFile } = await import("fs/promises");
    const template = await readFile(
      new URL("./fast-system-prompt.md", import.meta.url),
      "utf-8",
    );
    expect(template).toContain("{{REPO_NAME}}");
  });

  it("also tells the agent to run queries without asking permission", async () => {
    const { readFile } = await import("fs/promises");
    const template = await readFile(
      new URL("./fast-system-prompt.md", import.meta.url),
      "utf-8",
    );
    expect(template).toMatch(/don't ask.*permission|without asking|take agency|just run/i);
  });
});
