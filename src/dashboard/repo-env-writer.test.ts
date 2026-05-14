/**
 * Tests for the atomic per-repo `.env` writer that powers DX-303's
 * Trello credential rotation surface. See `repo-env-writer.ts` for the
 * full contract — preservation of unrelated lines, atomic temp+rename,
 * per-file in-process queue.
 */

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
  _resetForTesting,
  _setRenameImplForTesting,
  unwatchAllRepoEnvFiles,
  watchRepoEnvFile,
  writeRepoEnvVars,
  repoEnvFilePath,
} from "./repo-env-writer.js";

let workDir = "";

function makeRepo(envContent: string | null): string {
  workDir = mkdtempSync(join(tmpdir(), "repo-env-writer-test-"));
  const repoLocalPath = workDir;
  if (envContent !== null) {
    mkdirSync(resolve(repoLocalPath, ".danxbot"), { recursive: true });
    writeFileSync(repoEnvFilePath(repoLocalPath), envContent, "utf-8");
  }
  return repoLocalPath;
}

beforeEach(() => {
  _resetForTesting();
});

afterEach(() => {
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

describe("writeRepoEnvVars", () => {
  it("updates an existing key in place and preserves unrelated keys, comments, blank lines", async () => {
    const repoLocalPath = makeRepo(
      [
        "# Header comment",
        "OTHER=keep",
        "",
        "FOO=old",
        "# trailing comment",
        "BAR=untouched",
        "",
      ].join("\n"),
    );

    await writeRepoEnvVars({
      repoLocalPath,
      updates: { FOO: "new-value" },
      writtenBy: "test",
    });

    const after = readFileSync(repoEnvFilePath(repoLocalPath), "utf-8");
    expect(after).toBe(
      [
        "# Header comment",
        "OTHER=keep",
        "",
        "FOO=new-value",
        "# trailing comment",
        "BAR=untouched",
        "",
      ].join("\n"),
    );
  });

  it("appends absent keys at the end without touching anything else", async () => {
    const repoLocalPath = makeRepo(
      ["OTHER=keep", "ANOTHER=also-keep", ""].join("\n"),
    );

    await writeRepoEnvVars({
      repoLocalPath,
      updates: { NEW_KEY: "fresh" },
      writtenBy: "test",
    });

    const after = readFileSync(repoEnvFilePath(repoLocalPath), "utf-8");
    expect(after).toBe(
      ["OTHER=keep", "ANOTHER=also-keep", "NEW_KEY=fresh", ""].join("\n"),
    );
  });

  it("handles a mix of updates and appends in a single call", async () => {
    const repoLocalPath = makeRepo(
      ["FOO=old", "OTHER=keep", "BAR=stale", ""].join("\n"),
    );

    await writeRepoEnvVars({
      repoLocalPath,
      updates: { FOO: "new-foo", BAR: "new-bar", FRESH: "appended" },
      writtenBy: "test",
    });

    const after = readFileSync(repoEnvFilePath(repoLocalPath), "utf-8");
    expect(after).toBe(
      ["FOO=new-foo", "OTHER=keep", "BAR=new-bar", "FRESH=appended", ""].join(
        "\n",
      ),
    );
  });

  it("throws when the .env file is missing — the dashboard never auto-creates one", async () => {
    const repoLocalPath = makeRepo(null);

    await expect(
      writeRepoEnvVars({
        repoLocalPath,
        updates: { FOO: "bar" },
        writtenBy: "test",
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("treats an empty updates object as a no-op (no file mutation)", async () => {
    const repoLocalPath = makeRepo("FOO=keep\n");
    const before = readFileSync(repoEnvFilePath(repoLocalPath), "utf-8");

    await writeRepoEnvVars({
      repoLocalPath,
      updates: {},
      writtenBy: "test",
    });

    const after = readFileSync(repoEnvFilePath(repoLocalPath), "utf-8");
    expect(after).toBe(before);
  });

  it("writes via an atomic temp file in the same directory (no .tmp left behind)", async () => {
    const repoLocalPath = makeRepo("FOO=old\n");

    await writeRepoEnvVars({
      repoLocalPath,
      updates: { FOO: "new" },
      writtenBy: "test",
    });

    const fs = await import("node:fs");
    const dir = resolve(repoLocalPath, ".danxbot");
    const entries = fs.readdirSync(dir);
    // .env survives; no temp file leaked.
    expect(entries).toContain(".env");
    expect(entries.filter((e) => e.includes(".tmp."))).toEqual([]);
  });

  it("atomic-failure: rename throwing mid-write leaves the original .env intact AND removes the leaked temp file containing the rotated secret", async () => {
    // AC1 invariant + code-review finding #1 (DX-303 review pass).
    // If the rename fails after the temp file has been written with
    // the new plaintext secret, two things MUST hold:
    //  - the original .env is unchanged (still carries the old value)
    //  - the temp file is unlinked (no plaintext-secret residue in
    //    <repo>/.danxbot/.env.tmp.PID.<TS> for an operator to discover
    //    months later in a config audit)
    const repoLocalPath = makeRepo("FOO=old-secret\nOTHER=keep\n");
    const fs = await import("node:fs");
    const originalContent = readFileSync(
      repoEnvFilePath(repoLocalPath),
      "utf-8",
    );

    _setRenameImplForTesting(() => {
      throw new Error("simulated fs failure");
    });

    try {
      await expect(
        writeRepoEnvVars({
          repoLocalPath,
          updates: { FOO: "new-rotated-secret" },
          writtenBy: "test",
        }),
      ).rejects.toThrow(/simulated fs failure/);

      // Original file untouched — temp+rename atomicity holds even
      // when the rename leg fails.
      expect(readFileSync(repoEnvFilePath(repoLocalPath), "utf-8")).toBe(
        originalContent,
      );

      // No `.tmp.PID.<TS>` file left behind carrying the new plaintext
      // secret. This is the DX-303 secret-handling invariant.
      const dirEntries = fs.readdirSync(
        resolve(repoLocalPath, ".danxbot"),
      );
      const tmpLeftovers = dirEntries.filter((e) => e.includes(".tmp."));
      expect(tmpLeftovers).toEqual([]);
    } finally {
      _setRenameImplForTesting(null);
    }
  });

  it("preserves file mode (e.g. 0600) across the rename", async () => {
    const repoLocalPath = makeRepo("FOO=old\n");
    const fs = await import("node:fs");
    fs.chmodSync(repoEnvFilePath(repoLocalPath), 0o600);

    await writeRepoEnvVars({
      repoLocalPath,
      updates: { FOO: "new" },
      writtenBy: "test",
    });

    const stat = fs.statSync(repoEnvFilePath(repoLocalPath));
    // Mask to the permission bits — file type bits vary by platform.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("concurrent writes to the same .env land BOTH edits losslessly (per-file queue)", async () => {
    const repoLocalPath = makeRepo("FOO=initial\nBAR=initial\n");

    // Two writes kicked off in parallel — without the in-process queue
    // they read the same on-disk state and one would clobber the other.
    const [, ] = await Promise.all([
      writeRepoEnvVars({
        repoLocalPath,
        updates: { FOO: "from-A" },
        writtenBy: "writer-A",
      }),
      writeRepoEnvVars({
        repoLocalPath,
        updates: { BAR: "from-B" },
        writtenBy: "writer-B",
      }),
    ]);

    const after = readFileSync(repoEnvFilePath(repoLocalPath), "utf-8");
    const map = Object.fromEntries(
      after
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => {
          const idx = l.indexOf("=");
          return [l.slice(0, idx), l.slice(idx + 1)];
        }),
    );
    expect(map.FOO).toBe("from-A");
    expect(map.BAR).toBe("from-B");
  });

  it("concurrent writes to DIFFERENT .env files run in parallel (no cross-file blocking)", async () => {
    // Independent repos must have independent queues.
    const repoA = makeRepo("FOO=A\n");
    const workDirA = workDir;

    const repoB = mkdtempSync(join(tmpdir(), "repo-env-writer-test-B-"));
    mkdirSync(resolve(repoB, ".danxbot"), { recursive: true });
    writeFileSync(repoEnvFilePath(repoB), "FOO=B\n", "utf-8");

    try {
      await Promise.all([
        writeRepoEnvVars({
          repoLocalPath: repoA,
          updates: { FOO: "A-updated" },
          writtenBy: "A",
        }),
        writeRepoEnvVars({
          repoLocalPath: repoB,
          updates: { FOO: "B-updated" },
          writtenBy: "B",
        }),
      ]);

      expect(readFileSync(repoEnvFilePath(repoA), "utf-8")).toContain(
        "FOO=A-updated",
      );
      expect(readFileSync(repoEnvFilePath(repoB), "utf-8")).toContain(
        "FOO=B-updated",
      );
    } finally {
      rmSync(repoB, { recursive: true, force: true });
      workDir = workDirA;
    }
  });

  it("preserves a quoted value in an unrelated key verbatim", async () => {
    const repoLocalPath = makeRepo(
      [
        'QUOTED="value with spaces and = signs"',
        "FOO=old",
        "",
      ].join("\n"),
    );

    await writeRepoEnvVars({
      repoLocalPath,
      updates: { FOO: "new" },
      writtenBy: "test",
    });

    const after = readFileSync(repoEnvFilePath(repoLocalPath), "utf-8");
    expect(after).toContain('QUOTED="value with spaces and = signs"');
    expect(after).toContain("FOO=new");
  });

  it("matches keys only at the start of a line (no false positives on substrings)", async () => {
    // `NOT_FOO=` must NOT match a rewrite of `FOO`.
    const repoLocalPath = makeRepo(
      ["NOT_FOO=untouched", "FOO=old", ""].join("\n"),
    );

    await writeRepoEnvVars({
      repoLocalPath,
      updates: { FOO: "new" },
      writtenBy: "test",
    });

    const after = readFileSync(repoEnvFilePath(repoLocalPath), "utf-8");
    expect(after).toBe(["NOT_FOO=untouched", "FOO=new", ""].join("\n"));
  });

  it("does not match a key whose name lives inside a comment", async () => {
    const repoLocalPath = makeRepo(
      ["# FOO=this is a comment, not an assignment", "FOO=old", ""].join("\n"),
    );

    await writeRepoEnvVars({
      repoLocalPath,
      updates: { FOO: "new" },
      writtenBy: "test",
    });

    const after = readFileSync(repoEnvFilePath(repoLocalPath), "utf-8");
    expect(after).toBe(
      ["# FOO=this is a comment, not an assignment", "FOO=new", ""].join("\n"),
    );
  });
});

describe("watchRepoEnvFile", () => {
  afterEach(async () => {
    await unwatchAllRepoEnvFiles();
  });

  it("fires onChange when the .env file is rewritten by writeRepoEnvVars", async () => {
    const repoLocalPath = makeRepo("FOO=old\n");
    let fires = 0;
    let lastLocalPath: string | null = null;

    watchRepoEnvFile({
      localPath: repoLocalPath,
      onChange: (lp) => {
        fires += 1;
        lastLocalPath = lp;
      },
    });

    // chokidar needs a brief moment to attach before the first change
    // event can be observed. The 200ms awaitWriteFinish in the watcher
    // adds another debounce on top.
    await new Promise((r) => setTimeout(r, 100));

    await writeRepoEnvVars({
      repoLocalPath,
      updates: { FOO: "new" },
      writtenBy: "test",
    });

    // Wait past awaitWriteFinish (200ms) + a buffer.
    await new Promise((r) => setTimeout(r, 500));

    expect(fires).toBeGreaterThanOrEqual(1);
    expect(lastLocalPath).toBe(repoLocalPath);
  });

  it("registers the handle so unwatchAllRepoEnvFiles drains it", async () => {
    const repoLocalPath = makeRepo("FOO=initial\n");
    let fires = 0;

    watchRepoEnvFile({
      localPath: repoLocalPath,
      onChange: () => {
        fires += 1;
      },
    });
    await new Promise((r) => setTimeout(r, 100));

    await unwatchAllRepoEnvFiles();

    // Post-drain, further .env mutations must not fire onChange.
    await writeRepoEnvVars({
      repoLocalPath,
      updates: { FOO: "post-drain" },
      writtenBy: "test",
    });
    await new Promise((r) => setTimeout(r, 500));

    expect(fires).toBe(0);
  });

  it("re-watching the same path replaces the prior watcher (no duplicate fires)", async () => {
    const repoLocalPath = makeRepo("FOO=initial\n");
    let firesA = 0;
    let firesB = 0;

    watchRepoEnvFile({
      localPath: repoLocalPath,
      onChange: () => {
        firesA += 1;
      },
    });
    await new Promise((r) => setTimeout(r, 100));

    watchRepoEnvFile({
      localPath: repoLocalPath,
      onChange: () => {
        firesB += 1;
      },
    });
    await new Promise((r) => setTimeout(r, 100));

    await writeRepoEnvVars({
      repoLocalPath,
      updates: { FOO: "after-rewatch" },
      writtenBy: "test",
    });
    await new Promise((r) => setTimeout(r, 500));

    // Only the second registration's onChange should have fired.
    expect(firesB).toBeGreaterThanOrEqual(1);
    expect(firesA).toBe(0);
  });

  it("a throwing onChange does not crash the watcher", async () => {
    const repoLocalPath = makeRepo("FOO=initial\n");
    let secondFire = false;

    watchRepoEnvFile({
      localPath: repoLocalPath,
      onChange: () => {
        if (!secondFire) {
          secondFire = true;
          throw new Error("intentional");
        }
      },
    });
    await new Promise((r) => setTimeout(r, 100));

    // First write — handler throws but watcher must survive.
    await writeRepoEnvVars({
      repoLocalPath,
      updates: { FOO: "first" },
      writtenBy: "test",
    });
    // Poll for the chokidar fire instead of a fixed 500ms wait. Under
    // full-sweep load the watcher's debounce + inotify delivery can
    // exceed the 500ms ceiling (DX-502 verification surfaced this).
    // 2s deadline + 25ms poll keeps the happy path fast (~100ms) and
    // the slow path resilient.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !secondFire) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(secondFire).toBe(true);
  });
});
