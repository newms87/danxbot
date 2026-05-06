import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    const entry = prepared[0]!;
    expect(entry.kind).toBe("content");
    expect(entry.absolutePath).toBe("/tmp/schemas/42/schema.json");
    if (entry.kind === "content") {
      expect(entry.content).toBe("{}");
    }
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

  it("rejects entry with neither content nor source_url", () => {
    expect(() =>
      prepareStagedFiles({
        stagedFiles: [{ path: "/tmp/x/y.json" } as unknown as never],
        stagingPaths: ["/tmp/x/"],
        overlay: {},
      }),
    ).toThrow(/must provide either content/);
  });

  it("rejects entry that supplies both content and source_url", () => {
    expect(() =>
      prepareStagedFiles({
        stagedFiles: [
          {
            path: "/tmp/x/y.bin",
            content: "x",
            source_url: "https://example.com/y.bin",
          } as unknown as never,
        ],
        stagingPaths: ["/tmp/x/"],
        overlay: {},
      }),
    ).toThrow(/not both/);
  });

  it("rejects source_url entry with empty source_url", () => {
    expect(() =>
      prepareStagedFiles({
        stagedFiles: [
          { path: "/tmp/x/y.bin", source_url: "" } as unknown as never,
        ],
        stagingPaths: ["/tmp/x/"],
        overlay: {},
      }),
    ).toThrow(/source_url must be a non-empty string/);
  });

  it("rejects source_url entry with non-object headers", () => {
    expect(() =>
      prepareStagedFiles({
        stagedFiles: [
          {
            path: "/tmp/x/y.bin",
            source_url: "https://example.com/y.bin",
            headers: ["bad"],
          } as unknown as never,
        ],
        stagingPaths: ["/tmp/x/"],
        overlay: {},
      }),
    ).toThrow(/headers must be an object/);
  });

  it("rejects source_url entry with non-string header value", () => {
    expect(() =>
      prepareStagedFiles({
        stagedFiles: [
          {
            path: "/tmp/x/y.bin",
            source_url: "https://example.com/y.bin",
            headers: { Authorization: 42 },
          } as unknown as never,
        ],
        stagingPaths: ["/tmp/x/"],
        overlay: {},
      }),
    ).toThrow(/headers\["Authorization"\] must be a string/);
  });

  it("substitutes placeholders in source_url and header values", () => {
    const prepared = prepareStagedFiles({
      stagedFiles: [
        {
          path: "/tmp/schemas/${ID}/img.png",
          source_url: "https://api.example.com/schemas/${ID}/img.png",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
      ],
      stagingPaths: ["/tmp/schemas/42/"],
      overlay: { ID: "42", TOKEN: "secret-abc" },
    });
    expect(prepared).toHaveLength(1);
    const entry = prepared[0]!;
    expect(entry.kind).toBe("source_url");
    if (entry.kind === "source_url") {
      expect(entry.absolutePath).toBe("/tmp/schemas/42/img.png");
      expect(entry.sourceUrl).toBe(
        "https://api.example.com/schemas/42/img.png",
      );
      expect(entry.headers).toEqual({ Authorization: "Bearer secret-abc" });
    }
  });

  it("rejects placeholder substitution failure on header value", () => {
    expect(() =>
      prepareStagedFiles({
        stagedFiles: [
          {
            path: "/tmp/schemas/42/img.png",
            source_url: "https://example.com/x.png",
            headers: { Authorization: "Bearer ${MISSING}" },
          },
        ],
        stagingPaths: ["/tmp/schemas/42/"],
        overlay: {},
      }),
    ).toThrow(/headers\["Authorization"\]/);
  });
});

describe("writeStagedFiles + cleanupStagedFiles", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "staged-files-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("creates parent directories and writes every content file", async () => {
    const a = resolve(tmp, "deep/nested/a.json");
    const b = resolve(tmp, "deep/other/b.json");
    const written = await writeStagedFiles([
      { kind: "content", absolutePath: a, content: "AAA" },
      { kind: "content", absolutePath: b, content: "BBB" },
    ]);
    expect(written).toEqual([a, b]);
    expect(readFileSync(a, "utf-8")).toBe("AAA");
    expect(readFileSync(b, "utf-8")).toBe("BBB");
  });

  it("rolls back already-written files when a later write fails", async () => {
    const ok = resolve(tmp, "ok.json");
    // Make a directory at the path of the second file so writeFileSync fails.
    const blockedPath = resolve(tmp, "blocked");
    mkdirSync(blockedPath);
    await expect(
      writeStagedFiles([
        { kind: "content", absolutePath: ok, content: "ok" },
        { kind: "content", absolutePath: blockedPath, content: "fail" },
      ]),
    ).rejects.toThrow(StagedFilesError);
    expect(existsSync(ok)).toBe(false);
  });

  it("fetches source_url entries and writes their bytes to disk", async () => {
    const target = resolve(tmp, "img.png");
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );

    const written = await writeStagedFiles([
      {
        kind: "source_url",
        absolutePath: target,
        sourceUrl: "https://example.com/img.png",
        headers: { Authorization: "Bearer abc" },
      },
    ]);

    expect(written).toEqual([target]);
    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/img.png", {
      headers: { Authorization: "Bearer abc" },
    });
    const onDisk = readFileSync(target);
    expect(onDisk.equals(Buffer.from(bytes))).toBe(true);
  });

  it("rolls back when source_url returns non-2xx", async () => {
    const ok = resolve(tmp, "ok.json");
    const bad = resolve(tmp, "bad.png");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not found", { status: 404, statusText: "Not Found" }),
    );

    await expect(
      writeStagedFiles([
        { kind: "content", absolutePath: ok, content: "ok" },
        {
          kind: "source_url",
          absolutePath: bad,
          sourceUrl: "https://example.com/missing.png",
        },
      ]),
    ).rejects.toThrow(/HTTP 404/);

    expect(existsSync(ok)).toBe(false);
    expect(existsSync(bad)).toBe(false);
  });

  it("rolls back when fetch rejects (network error)", async () => {
    const ok = resolve(tmp, "ok.json");
    const bad = resolve(tmp, "bad.png");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      writeStagedFiles([
        { kind: "content", absolutePath: ok, content: "ok" },
        {
          kind: "source_url",
          absolutePath: bad,
          sourceUrl: "https://example.com/x.png",
        },
      ]),
    ).rejects.toThrow(/failed to fetch staged file source_url/);

    expect(existsSync(ok)).toBe(false);
    expect(existsSync(bad)).toBe(false);
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
