import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetWarnedStems,
  maxIssueNumber,
  nextIssueId,
} from "../../issue-tracker/id-generator.js";

describe("nextIssueId", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "danx-idgen-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns ISS-1 when issues root does not exist", async () => {
    const id = await nextIssueId(path.join(root, "missing"), "ISS");
    expect(id).toBe("ISS-1");
  });

  it("returns ISS-1 when open + closed are empty", async () => {
    await fs.mkdir(path.join(root, "open"), { recursive: true });
    await fs.mkdir(path.join(root, "closed"), { recursive: true });
    expect(await nextIssueId(root, "ISS")).toBe("ISS-1");
  });

  it("returns max(N)+1 across open and closed", async () => {
    await fs.mkdir(path.join(root, "open"), { recursive: true });
    await fs.mkdir(path.join(root, "closed"), { recursive: true });
    await fs.writeFile(path.join(root, "open", "ISS-3.yml"), "");
    await fs.writeFile(path.join(root, "open", "ISS-7.yml"), "");
    await fs.writeFile(path.join(root, "closed", "ISS-12.yml"), "");
    await fs.writeFile(path.join(root, "closed", "ISS-2.yml"), "");
    expect(await nextIssueId(root, "ISS")).toBe("ISS-13");
  });

  it("ignores draft slug files and non-yml entries", async () => {
    await fs.mkdir(path.join(root, "open"), { recursive: true });
    await fs.writeFile(path.join(root, "open", "ISS-5.yml"), "");
    await fs.writeFile(path.join(root, "open", "add-jsonl-tail.yml"), "");
    await fs.writeFile(path.join(root, "open", "ISS-99.txt"), "");
    await fs.writeFile(path.join(root, "open", "iss-50.yml"), ""); // wrong case
    expect(await nextIssueId(root, "ISS")).toBe("ISS-6");
  });

  it("rejects malformed numeric ids (leading zeros etc.)", async () => {
    await fs.mkdir(path.join(root, "open"), { recursive: true });
    await fs.writeFile(path.join(root, "open", "ISS-1.yml"), "");
    // ISSUE_ID_REGEX is `/^ISS-\d+$/` so leading-zero forms are accepted by
    // regex; they parse as their numeric value (`007` → 7). This is the
    // intended behavior — only file naming errors that the regex rejects
    // (`ISS--1`, `ISS-`, `iss-1`) are skipped.
    await fs.writeFile(path.join(root, "open", "ISS-007.yml"), "");
    expect(await nextIssueId(root, "ISS")).toBe("ISS-8");
  });

  it("maxIssueNumber returns 0 on empty tree", async () => {
    expect(await maxIssueNumber(root, "ISS")).toBe(0);
  });
});

// ---- ISS-99 Phase 1: prefix-aware allocation ----

describe("nextIssueId with custom prefix", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "danx-idgen-prefix-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns DX-1 on an empty tree with prefix DX", async () => {
    expect(await nextIssueId(root, "DX")).toBe("DX-1");
  });

  it("returns SG-1 on an empty tree with prefix SG", async () => {
    expect(await nextIssueId(root, "SG")).toBe("SG-1");
  });

  it("returns FD-1 on an empty tree with prefix FD", async () => {
    expect(await nextIssueId(root, "FD")).toBe("FD-1");
  });

  it("returns max+1 across open + closed for the given prefix", async () => {
    await fs.mkdir(path.join(root, "open"), { recursive: true });
    await fs.mkdir(path.join(root, "closed"), { recursive: true });
    await fs.writeFile(path.join(root, "open", "DX-3.yml"), "");
    await fs.writeFile(path.join(root, "open", "DX-7.yml"), "");
    await fs.writeFile(path.join(root, "closed", "DX-12.yml"), "");
    expect(await nextIssueId(root, "DX")).toBe("DX-13");
  });

  it("ignores files with the wrong prefix", async () => {
    await fs.mkdir(path.join(root, "open"), { recursive: true });
    await fs.writeFile(path.join(root, "open", "DX-5.yml"), "");
    // ISS-99.yml is from a different repo's id space (or pre-migration)
    // — must not be counted toward DX's max.
    await fs.writeFile(path.join(root, "open", "ISS-99.yml"), "");
    await fs.writeFile(path.join(root, "open", "SG-50.yml"), "");
    expect(await nextIssueId(root, "DX")).toBe("DX-6");
  });

  it("treats prefix as a strict filter (DX vs SG vs FD repos can co-exist on disk)", async () => {
    await fs.mkdir(path.join(root, "open"), { recursive: true });
    await fs.writeFile(path.join(root, "open", "DX-2.yml"), "");
    await fs.writeFile(path.join(root, "open", "SG-3.yml"), "");
    await fs.writeFile(path.join(root, "open", "FD-7.yml"), "");
    expect(await nextIssueId(root, "DX")).toBe("DX-3");
    expect(await nextIssueId(root, "SG")).toBe("SG-4");
    expect(await nextIssueId(root, "FD")).toBe("FD-8");
  });

  it("preserves backward-compat default ISS when prefix is omitted", async () => {
    await fs.mkdir(path.join(root, "open"), { recursive: true });
    await fs.writeFile(path.join(root, "open", "ISS-4.yml"), "");
    expect(await nextIssueId(root, "ISS")).toBe("ISS-5");
    expect(await maxIssueNumber(root, "ISS")).toBe(4);
  });

  it("draft slug filenames + non-yml entries are skipped under any prefix", async () => {
    await fs.mkdir(path.join(root, "open"), { recursive: true });
    await fs.writeFile(path.join(root, "open", "DX-5.yml"), "");
    await fs.writeFile(path.join(root, "open", "add-jsonl-tail.yml"), "");
    await fs.writeFile(path.join(root, "open", "DX-99.txt"), "");
    await fs.writeFile(path.join(root, "open", "dx-50.yml"), ""); // wrong case
    expect(await nextIssueId(root, "DX")).toBe("DX-6");
  });
});

// ---- ISS-99 Phase 1: warn-once dedup behavior on cross-prefix YAMLs ----

describe("warnMismatchedPrefix dedup", () => {
  let root: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "danx-idgen-warn-"));
    _resetWarnedStems();
    // src/logger.ts writes warn/error via console.error; spy there to
    // count emitted log lines per stem.
    warnSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    warnSpy.mockRestore();
    _resetWarnedStems();
  });

  function countWarnsContaining(needle: string): number {
    return warnSpy.mock.calls.filter((call: unknown[]) =>
      call.some((arg) => typeof arg === "string" && arg.includes(needle)),
    ).length;
  }

  it("warns exactly once per (dir, stem) across repeated calls", async () => {
    await fs.mkdir(path.join(root, "open"), { recursive: true });
    await fs.writeFile(path.join(root, "open", "ISS-99.yml"), "");
    await fs.writeFile(path.join(root, "open", "DX-1.yml"), "");

    expect(await nextIssueId(root, "DX")).toBe("DX-2");
    expect(await nextIssueId(root, "DX")).toBe("DX-2");
    expect(await nextIssueId(root, "DX")).toBe("DX-2");

    expect(countWarnsContaining("ISS-99.yml")).toBe(1);
  });

  it("does NOT warn for draft slug filenames (no prefix shape)", async () => {
    await fs.mkdir(path.join(root, "open"), { recursive: true });
    await fs.writeFile(path.join(root, "open", "DX-1.yml"), "");
    await fs.writeFile(path.join(root, "open", "add-jsonl-tail.yml"), "");
    await fs.writeFile(path.join(root, "open", "iss-50.yml"), ""); // wrong case

    expect(await nextIssueId(root, "DX")).toBe("DX-2");

    expect(countWarnsContaining("add-jsonl-tail.yml")).toBe(0);
    expect(countWarnsContaining("iss-50.yml")).toBe(0);
  });

  it("warns separately for distinct cross-prefix stems", async () => {
    await fs.mkdir(path.join(root, "open"), { recursive: true });
    await fs.writeFile(path.join(root, "open", "DX-1.yml"), "");
    await fs.writeFile(path.join(root, "open", "ISS-99.yml"), "");
    await fs.writeFile(path.join(root, "open", "SG-50.yml"), "");
    await fs.writeFile(path.join(root, "open", "FD-7.yml"), "");

    expect(await nextIssueId(root, "DX")).toBe("DX-2");

    expect(countWarnsContaining("ISS-99.yml")).toBe(1);
    expect(countWarnsContaining("SG-50.yml")).toBe(1);
    expect(countWarnsContaining("FD-7.yml")).toBe(1);
  });
});
