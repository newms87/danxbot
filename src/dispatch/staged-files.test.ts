import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  cleanupStagedFiles,
  prepareStagedFiles,
  StagedFilesError,
  writeStagedFiles,
} from "./staged-files.js";

describe("prepareStagedFiles", () => {
  const overlay = { ID: "42", OTHER: "evil" };

  it("returns empty list when stagedFiles is empty", () => {
    expect(
      prepareStagedFiles({
        stagedFiles: [],
        stagingPaths: ["/tmp/schemas/${ID}/"],
        overlay,
      }),
    ).toEqual([]);
  });

  it("rejects non-empty stagedFiles when stagingPaths is empty", () => {
    expect(() =>
      prepareStagedFiles({
        stagedFiles: [{ path: "/tmp/x.json", content: "{}" }],
        stagingPaths: [],
        overlay,
      }),
    ).toThrow(StagedFilesError);
    expect(() =>
      prepareStagedFiles({
        stagedFiles: [{ path: "/tmp/x.json", content: "{}" }],
        stagingPaths: [],
        overlay,
      }),
    ).toThrow(/no staging-paths/);
  });

  it("substitutes ${KEY} placeholders in path against the overlay", () => {
    const prepared = prepareStagedFiles({
      stagedFiles: [{ path: "/tmp/schemas/${ID}/schema.json", content: "{}" }],
      // stagingPaths arrive already-substituted from the resolver.
      stagingPaths: ["/tmp/schemas/42/"],
      overlay,
    });
    expect(prepared).toHaveLength(1);
    expect(prepared[0]!.absolutePath).toBe("/tmp/schemas/42/schema.json");
    expect(prepared[0]!.content).toBe("{}");
  });

  it("throws when path references an unknown placeholder", () => {
    expect(() =>
      prepareStagedFiles({
        stagedFiles: [
          { path: "/tmp/schemas/${MISSING}/x.json", content: "{}" },
        ],
        stagingPaths: ["/tmp/schemas/${ID}/"],
        overlay,
      }),
    ).toThrow(StagedFilesError);
    expect(() =>
      prepareStagedFiles({
        stagedFiles: [
          { path: "/tmp/schemas/${MISSING}/x.json", content: "{}" },
        ],
        stagingPaths: ["/tmp/schemas/${ID}/"],
        overlay,
      }),
    ).toThrow(/staged_files\[0\]\.path/);
  });

  it("rejects path that resolves outside the allowlist", () => {
    expect(() =>
      prepareStagedFiles({
        stagedFiles: [{ path: "/etc/passwd", content: "x" }],
        stagingPaths: ["/tmp/schemas/42/"],
        overlay,
      }),
    ).toThrow(/outside the workspace allowlist/);
  });

  it("rejects path-traversal that walks outside the allowlist", () => {
    expect(() =>
      prepareStagedFiles({
        stagedFiles: [
          {
            path: "/tmp/schemas/42/../../../etc/passwd",
            content: "x",
          },
        ],
        stagingPaths: ["/tmp/schemas/42/"],
        overlay,
      }),
    ).toThrow(/outside the workspace allowlist/);
  });

  it("rejects relative paths that resolve outside the allowlist", () => {
    expect(() =>
      prepareStagedFiles({
        stagedFiles: [{ path: "../../etc/passwd", content: "x" }],
        stagingPaths: ["/tmp/schemas/42/"],
        overlay,
      }),
    ).toThrow(/outside the workspace allowlist/);
  });

  it("rejects sibling-prefix path that almost matches a root (/tmp/schemas/42 vs /tmp/schemas/42-evil)", () => {
    expect(() =>
      prepareStagedFiles({
        stagedFiles: [{ path: "/tmp/schemas/42-evil/x.json", content: "{}" }],
        stagingPaths: ["/tmp/schemas/42/"],
        overlay,
      }),
    ).toThrow(/outside the workspace allowlist/);
  });

  it("accepts paths under any of multiple allowlist roots", () => {
    const prepared = prepareStagedFiles({
      stagedFiles: [
        { path: "/tmp/a/file1.json", content: "1" },
        { path: "/tmp/b/file2.json", content: "2" },
      ],
      stagingPaths: ["/tmp/a/", "/tmp/b/"],
      overlay: {},
    });
    expect(prepared.map((p) => p.absolutePath)).toEqual([
      "/tmp/a/file1.json",
      "/tmp/b/file2.json",
    ]);
  });

  it("rejects non-object stagedFiles entry", () => {
    expect(() =>
      prepareStagedFiles({
        stagedFiles: ["not-an-object"] as unknown as never[],
        stagingPaths: ["/tmp/x/"],
        overlay: {},
      }),
    ).toThrow(/must be an object/);
  });

  it("rejects entry with missing path", () => {
    expect(() =>
      prepareStagedFiles({
        stagedFiles: [{ content: "x" } as unknown as never],
        stagingPaths: ["/tmp/x/"],
        overlay: {},
      }),
    ).toThrow(/path must be a non-empty string/);
  });

  it("rejects entry with non-string content", () => {
    expect(() =>
      prepareStagedFiles({
        stagedFiles: [
          { path: "/tmp/x/y.json", content: 42 } as unknown as never,
        ],
        stagingPaths: ["/tmp/x/"],
        overlay: {},
      }),
    ).toThrow(/content must be a string/);
  });
});

describe("writeStagedFiles + cleanupStagedFiles", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "staged-files-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates parent directories and writes every file", () => {
    const a = resolve(tmp, "deep/nested/a.json");
    const b = resolve(tmp, "deep/other/b.json");
    const written = writeStagedFiles([
      { absolutePath: a, content: "AAA" },
      { absolutePath: b, content: "BBB" },
    ]);
    expect(written).toEqual([a, b]);
    expect(readFileSync(a, "utf-8")).toBe("AAA");
    expect(readFileSync(b, "utf-8")).toBe("BBB");
  });

  it("rolls back already-written files when a later write fails", () => {
    const ok = resolve(tmp, "ok.json");
    // Make a directory at the path of the second file so writeFileSync fails.
    const blockedPath = resolve(tmp, "blocked");
    mkdirSync(blockedPath);
    expect(() =>
      writeStagedFiles([
        { absolutePath: ok, content: "ok" },
        { absolutePath: blockedPath, content: "fail" },
      ]),
    ).toThrow(StagedFilesError);
    expect(existsSync(ok)).toBe(false);
  });

  it("cleanupStagedFiles removes only the listed files, not siblings", () => {
    const staged = resolve(tmp, "staged.json");
    const sibling = resolve(tmp, "sibling.json");
    writeFileSync(staged, "s");
    writeFileSync(sibling, "x");
    cleanupStagedFiles([staged]);
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  it("cleanupStagedFiles is idempotent on missing files", () => {
    const ghost = resolve(tmp, "never-existed.json");
    expect(() => cleanupStagedFiles([ghost])).not.toThrow();
  });
});
