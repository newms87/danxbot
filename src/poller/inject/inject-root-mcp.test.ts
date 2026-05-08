/**
 * DX-201: inject `danx-issue` MCP server into a connected repo's root
 * `.mcp.json` so a host-session `claude` invocation at the repo root sees
 * the danx-issue tool surface (atomic id allocation via
 * `danx_issue_create`, etc).
 *
 * The contract is strict: ADD `danx-issue` if missing, NEVER touch any
 * other key (other `mcpServers` entries OR top-level keys). Operator
 * overrides of the `danx-issue` entry are preserved byte-identical.
 * Malformed JSON aborts the write loudly. Atomic write via `.tmp` +
 * rename so a poller crash mid-write leaves the original intact.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  injectDanxIssueMcp,
  buildDanxIssueEntry,
} from "./inject-root-mcp.js";

describe("injectDanxIssueMcp", () => {
  let repoRoot: string;
  let mcpPath: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "danxbot-mcp-inject-"));
    mcpPath = join(repoRoot, ".mcp.json");
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("creates the file with canonical danx-issue server when absent", () => {
    const result = injectDanxIssueMcp({ repoRoot });
    expect(result.changed).toBe(true);
    expect(result.path).toBe(mcpPath);
    const parsed = JSON.parse(readFileSync(mcpPath, "utf-8"));
    expect(parsed.mcpServers["danx-issue"]).toEqual(buildDanxIssueEntry(repoRoot, "trello"));
  });

  it("adds danx-issue when file exists with empty mcpServers", () => {
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }, null, 2) + "\n");
    const result = injectDanxIssueMcp({ repoRoot });
    expect(result.changed).toBe(true);
    const parsed = JSON.parse(readFileSync(mcpPath, "utf-8"));
    expect(parsed.mcpServers["danx-issue"]).toEqual(buildDanxIssueEntry(repoRoot, "trello"));
  });

  it("preserves pre-existing mcpServers entries byte-identical", () => {
    const playwright = {
      command: "npx",
      args: ["tsx", "mcp-servers/playwright/src/index.ts"],
      env: { PLAYWRIGHT_URL: "http://playwright:3000" },
    };
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { playwright } }, null, 2) + "\n",
    );
    const result = injectDanxIssueMcp({ repoRoot });
    expect(result.changed).toBe(true);
    const parsed = JSON.parse(readFileSync(mcpPath, "utf-8"));
    expect(parsed.mcpServers.playwright).toEqual(playwright);
    expect(parsed.mcpServers["danx-issue"]).toEqual(buildDanxIssueEntry(repoRoot, "trello"));
  });

  it("is a no-op when canonical danx-issue already present", () => {
    writeFileSync(
      mcpPath,
      JSON.stringify(
        { mcpServers: { "danx-issue": buildDanxIssueEntry(repoRoot, "trello") } },
        null,
        2,
      ) + "\n",
    );
    const before = statSync(mcpPath).mtimeMs;
    const beforeBytes = readFileSync(mcpPath, "utf-8");
    const result = injectDanxIssueMcp({ repoRoot });
    expect(result.changed).toBe(false);
    expect(readFileSync(mcpPath, "utf-8")).toBe(beforeBytes);
    expect(statSync(mcpPath).mtimeMs).toBe(before);
  });

  it("preserves operator override of danx-issue entry", () => {
    const operatorEntry = {
      type: "stdio",
      command: "node",
      args: ["my-custom-danx-issue.js"],
      env: { CUSTOM: "value" },
    };
    const original = JSON.stringify(
      { mcpServers: { "danx-issue": operatorEntry } },
      null,
      2,
    ) + "\n";
    writeFileSync(mcpPath, original);
    const result = injectDanxIssueMcp({ repoRoot });
    expect(result.changed).toBe(false);
    expect(readFileSync(mcpPath, "utf-8")).toBe(original);
  });

  it("logs error and does not write when existing JSON is malformed", () => {
    const malformed = "{ this is not json";
    writeFileSync(mcpPath, malformed);
    const before = statSync(mcpPath).mtimeMs;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = injectDanxIssueMcp({ repoRoot });
    expect(result.changed).toBe(false);
    expect(readFileSync(mcpPath, "utf-8")).toBe(malformed);
    expect(statSync(mcpPath).mtimeMs).toBe(before);
    errorSpy.mockRestore();
  });

  it("preserves top-level keys outside mcpServers byte-identical", () => {
    const original = {
      mcpServers: {},
      extensions: ["foo", "bar"],
      otherKey: { nested: true },
    };
    writeFileSync(mcpPath, JSON.stringify(original, null, 2) + "\n");
    const result = injectDanxIssueMcp({ repoRoot });
    expect(result.changed).toBe(true);
    const parsed = JSON.parse(readFileSync(mcpPath, "utf-8"));
    expect(parsed.extensions).toEqual(["foo", "bar"]);
    expect(parsed.otherKey).toEqual({ nested: true });
    expect(parsed.mcpServers["danx-issue"]).toEqual(buildDanxIssueEntry(repoRoot, "trello"));
  });

  it("writes atomically via .tmp + rename (no .tmp left behind on success)", () => {
    injectDanxIssueMcp({ repoRoot });
    expect(existsSync(mcpPath)).toBe(true);
    expect(existsSync(mcpPath + ".tmp")).toBe(false);
  });

  it("rename mid-write fails → .tmp cleaned, original intact, error rethrown (AC #8)", () => {
    const original =
      JSON.stringify({ mcpServers: { existing: { x: 1 } } }, null, 2) + "\n";
    writeFileSync(mcpPath, original);

    expect(() =>
      injectDanxIssueMcp({
        repoRoot,
        _fsHooks: {
          renameSync: () => {
            throw new Error("simulated EXDEV");
          },
        },
      }),
    ).toThrow(/simulated EXDEV/);

    expect(readFileSync(mcpPath, "utf-8")).toBe(original);
    expect(existsSync(mcpPath + ".tmp")).toBe(false);
  });

  it("non-object top-level JSON (array) → no write", () => {
    const original = JSON.stringify([1, 2, 3], null, 2) + "\n";
    writeFileSync(mcpPath, original);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = injectDanxIssueMcp({ repoRoot });
    expect(result.changed).toBe(false);
    expect(readFileSync(mcpPath, "utf-8")).toBe(original);
    errorSpy.mockRestore();
  });

  it("malformed mcpServers value (non-object) → no write, original preserved", () => {
    const original =
      JSON.stringify({ mcpServers: "not-an-object", other: 42 }, null, 2) + "\n";
    writeFileSync(mcpPath, original);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = injectDanxIssueMcp({ repoRoot });
    expect(result.changed).toBe(false);
    expect(readFileSync(mcpPath, "utf-8")).toBe(original);
    errorSpy.mockRestore();
  });

  it("two-tick idempotency: second call is changed:false and bytes match", () => {
    const first = injectDanxIssueMcp({ repoRoot });
    expect(first.changed).toBe(true);
    const afterFirst = readFileSync(mcpPath, "utf-8");
    const second = injectDanxIssueMcp({ repoRoot });
    expect(second.changed).toBe(false);
    expect(readFileSync(mcpPath, "utf-8")).toBe(afterFirst);
  });
});
