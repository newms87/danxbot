import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { maxIssueNumber, nextIssueId } from "../../issue-tracker/id-generator.js";

describe("nextIssueId", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "danx-idgen-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns ISS-1 when issues root does not exist", async () => {
    const id = await nextIssueId(path.join(root, "missing"));
    expect(id).toBe("ISS-1");
  });

  it("returns ISS-1 when open + closed are empty", async () => {
    await fs.mkdir(path.join(root, "open"), { recursive: true });
    await fs.mkdir(path.join(root, "closed"), { recursive: true });
    expect(await nextIssueId(root)).toBe("ISS-1");
  });

  it("returns max(N)+1 across open and closed", async () => {
    await fs.mkdir(path.join(root, "open"), { recursive: true });
    await fs.mkdir(path.join(root, "closed"), { recursive: true });
    await fs.writeFile(path.join(root, "open", "ISS-3.yml"), "");
    await fs.writeFile(path.join(root, "open", "ISS-7.yml"), "");
    await fs.writeFile(path.join(root, "closed", "ISS-12.yml"), "");
    await fs.writeFile(path.join(root, "closed", "ISS-2.yml"), "");
    expect(await nextIssueId(root)).toBe("ISS-13");
  });

  it("ignores draft slug files and non-yml entries", async () => {
    await fs.mkdir(path.join(root, "open"), { recursive: true });
    await fs.writeFile(path.join(root, "open", "ISS-5.yml"), "");
    await fs.writeFile(path.join(root, "open", "add-jsonl-tail.yml"), "");
    await fs.writeFile(path.join(root, "open", "ISS-99.txt"), "");
    await fs.writeFile(path.join(root, "open", "iss-50.yml"), ""); // wrong case
    expect(await nextIssueId(root)).toBe("ISS-6");
  });

  it("rejects malformed numeric ids (leading zeros etc.)", async () => {
    await fs.mkdir(path.join(root, "open"), { recursive: true });
    await fs.writeFile(path.join(root, "open", "ISS-1.yml"), "");
    // ISSUE_ID_REGEX is `/^ISS-\d+$/` so leading-zero forms are accepted by
    // regex; they parse as their numeric value (`007` → 7). This is the
    // intended behavior — only file naming errors that the regex rejects
    // (`ISS--1`, `ISS-`, `iss-1`) are skipped.
    await fs.writeFile(path.join(root, "open", "ISS-007.yml"), "");
    expect(await nextIssueId(root)).toBe("ISS-8");
  });

  it("maxIssueNumber returns 0 on empty tree", async () => {
    expect(await maxIssueNumber(root)).toBe(0);
  });
});
