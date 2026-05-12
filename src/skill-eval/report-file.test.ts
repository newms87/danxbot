import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  persistEvalSetReport,
  persistEvalSetReportWithLog,
  writeEvalSetReportFile,
} from "./report-file.js";

describe("writeEvalSetReportFile", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skill-eval-report-file-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes REPORT.md inside the eval-set directory", () => {
    const result = writeEvalSetReportFile({
      evalSetDir: tmp,
      markdown: "# Skill-eval report: dev:debugging\n\n**Overall: PASS**\n",
      runAt: new Date("2026-05-12T05:45:00.000Z"),
    });

    expect(result.path).toBe(join(tmp, "REPORT.md"));
    expect(existsSync(result.path)).toBe(true);
    const written = readFileSync(result.path, "utf8");
    expect(written.startsWith("# Skill-eval report: dev:debugging")).toBe(true);
    expect(written).toContain("**Overall: PASS**");
  });

  it("appends a `_Last run: <ISO>_` footer line so REPORT.md is self-dated", () => {
    const result = writeEvalSetReportFile({
      evalSetDir: tmp,
      markdown: "# Skill-eval report: dev:debugging\n",
      runAt: new Date("2026-05-12T05:45:00.000Z"),
    });

    const written = readFileSync(result.path, "utf8");
    expect(written).toMatch(/\n_Last run: 2026-05-12T05:45:00\.000Z_\n$/);
  });

  it("strips trailing whitespace from the input markdown before stamping the footer (no double-blank-line)", () => {
    const result = writeEvalSetReportFile({
      evalSetDir: tmp,
      markdown: "# Skill-eval report\n\n\n\n",
      runAt: new Date("2026-05-12T05:45:00.000Z"),
    });

    const written = readFileSync(result.path, "utf8");
    expect(written).not.toMatch(/\n{4,}_Last run/);
    expect(written).toMatch(/# Skill-eval report\n\n_Last run: /);
  });

  it("overwrites an existing REPORT.md on a subsequent run (auto-regenerated semantics)", () => {
    writeEvalSetReportFile({
      evalSetDir: tmp,
      markdown: "# old\n",
      runAt: new Date("2026-05-11T00:00:00.000Z"),
    });
    writeEvalSetReportFile({
      evalSetDir: tmp,
      markdown: "# new\n",
      runAt: new Date("2026-05-12T05:45:00.000Z"),
    });

    const written = readFileSync(join(tmp, "REPORT.md"), "utf8");
    expect(written).toContain("# new");
    expect(written).not.toContain("# old");
    expect(written).toContain("2026-05-12T05:45:00.000Z");
  });

  it("writes atomically: temp file does not survive a successful write", () => {
    writeEvalSetReportFile({
      evalSetDir: tmp,
      markdown: "# clean\n",
      runAt: new Date("2026-05-12T05:45:00.000Z"),
    });
    const left = readdirSync(tmp);
    // Only REPORT.md remains. `.tmp` cleanup happens via the rename.
    expect(left).toEqual(["REPORT.md"]);
  });

  it("ends the file with exactly one trailing newline (no double-newline tail)", () => {
    // Prevents a regression where the footer grows a stray blank line that
    // confuses dashboard MarkdownEditor / GFM renderers.
    const result = writeEvalSetReportFile({
      evalSetDir: tmp,
      markdown: "# Skill-eval report\n\n**Overall: PASS**",
      runAt: new Date("2026-05-12T05:45:00.000Z"),
    });
    const written = readFileSync(result.path, "utf8");
    expect(written.endsWith("_\n")).toBe(true);
    expect(written.endsWith("_\n\n")).toBe(false);
  });

  it("returns the byte count of what landed on disk", () => {
    const md = "# Skill-eval report: dev:debugging\n\n**Overall: PASS**\n";
    const result = writeEvalSetReportFile({
      evalSetDir: tmp,
      markdown: md,
      runAt: new Date("2026-05-12T05:45:00.000Z"),
    });
    const written = readFileSync(result.path, "utf8");
    expect(result.bytesWritten).toBe(Buffer.byteLength(written, "utf8"));
  });

  it("throws ENOENT when the eval-set directory does not exist (fail loud, not silent mkdir)", () => {
    const missing = join(tmp, "does-not-exist");
    expect(() =>
      writeEvalSetReportFile({
        evalSetDir: missing,
        markdown: "# x\n",
        runAt: new Date(),
      }),
    ).toThrow(/ENOENT|no such file or directory/);
  });

  it("throws 'is not a directory' when evalSetDir is a regular file (no silent overwrite)", () => {
    // Cover the explicit `!isDirectory()` branch in report-file.ts:
    // a path that exists but is a FILE must fail loud, not get treated as
    // a writable dir for REPORT.md.
    const filePath = join(tmp, "actually-a-file");
    writeFileSync(filePath, "not a dir", "utf8");
    expect(() =>
      writeEvalSetReportFile({
        evalSetDir: filePath,
        markdown: "# x\n",
        runAt: new Date(),
      }),
    ).toThrow(/is not a directory/);
  });
});

describe("persistEvalSetReport", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skill-eval-persist-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("derives the eval-set directory from evalSetPath and writes REPORT.md alongside eval-set.json", () => {
    // Simulate the real-world shape: <evalSetDir>/eval-set.json exists.
    const evalSetPath = join(tmp, "eval-set.json");
    // No need to create the file — the writer only stats the directory.

    const result = persistEvalSetReport({
      evalSetPath,
      markdown: "# Skill-eval report: dev:debugging\n",
      runAt: new Date("2026-05-12T05:45:00.000Z"),
    });

    expect(result.path).toBe(join(tmp, "REPORT.md"));
    const written = readFileSync(result.path, "utf8");
    expect(written).toContain("# Skill-eval report: dev:debugging");
    expect(written).toContain("2026-05-12T05:45:00.000Z");
  });
});

describe("persistEvalSetReportWithLog", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skill-eval-persist-log-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes REPORT.md and announces the path on the injected stderr", () => {
    const evalSetPath = join(tmp, "eval-set.json");
    const chunks: string[] = [];
    const fakeStderr = {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    };

    const result = persistEvalSetReportWithLog(
      {
        evalSetPath,
        markdown: "# x\n",
        runAt: new Date("2026-05-12T05:45:00.000Z"),
      },
      fakeStderr,
    );

    expect(result.path).toBe(join(tmp, "REPORT.md"));
    const joined = chunks.join("");
    expect(joined).toContain("REPORT.md written:");
    expect(joined).toContain(result.path);
  });

  it("defaults the stderr param to process.stderr when omitted (single-arg call site)", () => {
    // Locks the default-param contract — run-eval-set.ts and run-iterate.ts
    // call this without a second arg in production. Regression would either
    // throw or silently drop the announce log.
    const evalSetPath = join(tmp, "eval-set.json");
    const result = persistEvalSetReportWithLog({
      evalSetPath,
      markdown: "# x\n",
      runAt: new Date("2026-05-12T05:45:00.000Z"),
    });
    expect(result.path).toBe(join(tmp, "REPORT.md"));
    expect(existsSync(result.path)).toBe(true);
  });
});
