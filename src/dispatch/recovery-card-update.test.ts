/**
 * Tests for `findLastModifiedOpenCard` + `appendNeedsHelpComment`.
 * Real filesystem + real `yaml` parser — these helpers are the only IO
 * surface the recovery flow has, so we exercise them against real card
 * shapes (the regex-splice approach in the previous draft was the C1
 * critical bug code review caught — this file pins the parser-based
 * replacement against every YAML shape that bit us).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  appendNeedsHelpComment,
  findLastModifiedOpenCard,
} from "./recovery-card-update.js";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";

let tmpRepo: string;

beforeEach(() => {
  tmpRepo = mkdtempSync(join(tmpdir(), "danxbot-rcu-test-"));
});

afterEach(() => {
  rmSync(tmpRepo, { recursive: true, force: true });
});

describe("findLastModifiedOpenCard", () => {
  it("returns null when issues/open does not exist", async () => {
    const result = await findLastModifiedOpenCard(
      makeRepoContext({ localPath: tmpRepo }),
    );
    expect(result).toBeNull();
  });

  it("returns null when issues/open is empty", async () => {
    mkdirSync(join(tmpRepo, ".danxbot", "issues", "open"), { recursive: true });
    const result = await findLastModifiedOpenCard(
      makeRepoContext({ localPath: tmpRepo }),
    );
    expect(result).toBeNull();
  });

  it("returns the YAML with the highest mtime", async () => {
    const openDir = join(tmpRepo, ".danxbot", "issues", "open");
    mkdirSync(openDir, { recursive: true });
    const oldYaml = join(openDir, "DX-1.yml");
    const newYaml = join(openDir, "DX-99.yml");
    writeFileSync(oldYaml, "id: DX-1\n", "utf-8");
    writeFileSync(newYaml, "id: DX-99\n", "utf-8");
    utimesSync(oldYaml, new Date(2020, 0, 1), new Date(2020, 0, 1));

    const result = await findLastModifiedOpenCard(
      makeRepoContext({ localPath: tmpRepo }),
    );
    expect(result).toEqual({ id: "DX-99", path: newYaml });
  });

  it("ignores non-yaml files in the directory", async () => {
    const openDir = join(tmpRepo, ".danxbot", "issues", "open");
    mkdirSync(openDir, { recursive: true });
    writeFileSync(join(openDir, "README.md"), "not a card", "utf-8");
    writeFileSync(join(openDir, ".gitignore"), "x", "utf-8");
    writeFileSync(join(openDir, "DX-1.yml"), "id: DX-1\n", "utf-8");

    const result = await findLastModifiedOpenCard(
      makeRepoContext({ localPath: tmpRepo }),
    );
    expect(result?.id).toBe("DX-1");
  });
});

describe("appendNeedsHelpComment", () => {
  function writeCard(name: string, content: string): string {
    const path = join(tmpRepo, name);
    writeFileSync(path, content, "utf-8");
    return path;
  }

  it("appends to a card with `comments: []` (empty list)", async () => {
    const path = writeCard(
      "DX-1.yml",
      "schema_version: 5\nid: DX-1\nstatus: ToDo\ncomments: []\n",
    );
    await appendNeedsHelpComment(path, "## Test body\n\nbullet line");

    const doc = parseYaml(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(Array.isArray(doc.comments)).toBe(true);
    const comments = doc.comments as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe("## Test body\n\nbullet line");
    expect(comments[0].author).toBe("danxbot");
    expect(comments[0].id).toMatch(/^[a-f0-9]{24}$/);
    expect(typeof comments[0].timestamp).toBe("string");
    // Surrounding fields preserved.
    expect(doc.id).toBe("DX-1");
    expect(doc.status).toBe("ToDo");
  });

  it("appends to a card with existing comments — preserves prior entries (C1 fix — regex would clobber here)", async () => {
    // This is the shape that exposed the regex-splice bug: a real card
    // with an existing `comments[]` list followed by a `retro:` field.
    // The previous regex would prepend the new entry, dropping the prior
    // comment's `id` and corrupting the document. With the parser-based
    // implementation, the new entry must land AFTER the existing one.
    const path = writeCard(
      "DX-160.yml",
      [
        "schema_version: 5",
        "id: DX-160",
        "status: Done",
        "comments:",
        "  - id: aaabbbcccdddeeefff111222",
        "    author: danxbot",
        '    timestamp: "2026-05-09T18:00:00.000Z"',
        "    text: |-",
        "      ## Implementation summary",
        "",
        "      First comment body.",
        "retro:",
        "  good: existing good",
        "  bad: existing bad",
        "  action_item_ids: []",
        "  commits: []",
        "waiting_on: null",
        "blocked: null",
      ].join("\n") + "\n",
    );

    await appendNeedsHelpComment(path, "## New comment\n\nappended body");

    const doc = parseYaml(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const comments = doc.comments as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(2);
    // Original first.
    expect(comments[0].id).toBe("aaabbbcccdddeeefff111222");
    expect(comments[0].text).toContain("First comment body.");
    // Append second.
    expect(comments[1].text).toBe("## New comment\n\nappended body");
    expect(comments[1].id).toMatch(/^[a-f0-9]{24}$/);
    // retro field preserved untouched.
    expect((doc.retro as { good: string }).good).toBe("existing good");
    expect((doc.retro as { bad: string }).bad).toBe("existing bad");
  });

  it("appends to a card whose body contains lines that look like top-level YAML keys (regex would have terminated early)", async () => {
    // The previous regex anchored to `(?=\n[a-z_]+:)`. A comment body
    // containing markdown like `bash:` or `output:` at column 0 would
    // have terminated the splice mid-body, corrupting the document. The
    // parser-based replacement is immune.
    const path = writeCard(
      "DX-2.yml",
      [
        "schema_version: 5",
        "id: DX-2",
        "status: ToDo",
        "comments:",
        "  - id: 111111111111111111111111",
        "    author: danxbot",
        '    timestamp: "2026-05-09T18:00:00.000Z"',
        "    text: |-",
        "      ## Build output",
        "",
        "      ```bash",
        "      output: success",
        "      command: npm test",
        "      ```",
        "history: []",
        "retro:",
        "  good: x",
        "  bad: y",
        "  action_item_ids: []",
        "  commits: []",
      ].join("\n") + "\n",
    );

    await appendNeedsHelpComment(path, "## Recovery still dirty\n\nplease help");

    const doc = parseYaml(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const comments = doc.comments as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(2);
    expect(comments[0].text).toContain("output: success");
    expect(comments[0].text).toContain("command: npm test");
    expect(comments[1].text).toBe("## Recovery still dirty\n\nplease help");
  });

  it("appends to a card with no `comments:` field at all (creates the array)", async () => {
    const path = writeCard(
      "DX-3.yml",
      "schema_version: 5\nid: DX-3\nstatus: ToDo\nblocked: null\n",
    );
    await appendNeedsHelpComment(path, "first comment");

    const doc = parseYaml(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(Array.isArray(doc.comments)).toBe(true);
    const comments = doc.comments as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe("first comment");
  });
});
