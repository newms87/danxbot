// All filesystem operations in this test go through `homeDir: home` (a
// mkdtempSync-rooted dir) so the real `homedir()` is never touched. If you
// add a test, ALWAYS pass `homeDir` explicitly — omitting it would litter
// the developer's `~/.claude/projects/`.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureHostProjectsSymlink,
  perRepoProjectsBase,
} from "./host-projects-symlink.js";
import {
  deriveSessionDir,
  encodeClaudeProjectsCwd,
  findNewestJsonlFile,
} from "./session-log-watcher.js";

describe("encodeClaudeProjectsCwd (encoder consumers must agree)", () => {
  it("replaces / and . with - so .danxbot/workspaces/issue-worker encodes to a single subdir name", () => {
    // Both `/` and `.` collapse to `-`, so the leading slash + `.danxbot`
    // produce the canonical `--danxbot` double-dash run claude actually
    // writes under. Path is non-existent so realpathSync ENOENTs and the
    // test exercises the pure encoding rather than whatever the local fs
    // resolves to.
    expect(
      encodeClaudeProjectsCwd(
        "/nonexistent-dx240-test/.danxbot/workspaces/issue-worker",
      ),
    ).toBe("-nonexistent-dx240-test--danxbot-workspaces-issue-worker");
  });

  it("resolves cwd through symlinks via realpathSync before encoding", () => {
    // realpath is what claude itself uses on its cwd, so the encoder MUST
    // resolve symlinks the same way — otherwise the symlinked-cwd encoded
    // value disagrees with what the watcher sees.
    const root = mkdtempSync(join(tmpdir(), "host-projects-encode-"));
    try {
      const realDir = join(root, "real", "workspace");
      mkdirSync(realDir, { recursive: true });
      const symlinked = join(root, "via-symlink");
      symlinkSync(realDir, symlinked);

      expect(encodeClaudeProjectsCwd(symlinked)).toBe(
        encodeClaudeProjectsCwd(realDir),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deriveSessionDir agrees with encodeClaudeProjectsCwd byte-for-byte (drift guard)", () => {
    // The host-projects-symlink helper and the SessionLogWatcher both depend
    // on this encoding. Divergence between them silently breaks every
    // host-mode resume — see Trello `9ZurZCK2` for the prior incident.
    // This test is the central drift-guard for the two consumers.
    const cwd = "/nonexistent-dx240-test/.danxbot/workspaces/issue-worker";
    expect(deriveSessionDir(cwd).endsWith(encodeClaudeProjectsCwd(cwd))).toBe(
      true,
    );
  });
});

describe("ensureHostProjectsSymlink", () => {
  let root: string;
  let home: string;
  let repoLocalPath: string;
  let workspaceCwd: string;
  let encoded: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "host-projects-sym-"));
    home = join(root, "home");
    repoLocalPath = join(root, "repos", "danxbot");
    workspaceCwd = join(repoLocalPath, ".danxbot", "workspaces", "issue-worker");
    mkdirSync(workspaceCwd, { recursive: true });
    encoded = encodeClaudeProjectsCwd(workspaceCwd);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a symlink ~/.claude/projects/<encoded> → <repo>/claude-projects/<encoded> when nothing exists", () => {
    ensureHostProjectsSymlink({ workspaceCwd, repoLocalPath, homeDir: home });

    const linkPath = join(home, ".claude", "projects", encoded);
    const target = readlinkSync(linkPath);
    expect(target).toBe(join(perRepoProjectsBase(repoLocalPath), encoded));
  });

  it("is idempotent — second call leaves the same inode (early-return branch is taken)", () => {
    ensureHostProjectsSymlink({ workspaceCwd, repoLocalPath, homeDir: home });

    const linkPath = join(home, ".claude", "projects", encoded);
    const inoBefore = lstatSync(linkPath).ino;

    ensureHostProjectsSymlink({ workspaceCwd, repoLocalPath, homeDir: home });

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(lstatSync(linkPath).ino).toBe(inoBefore);
  });

  it("replaces a wrong-target symlink with the correct target without disturbing the wrong target's content", () => {
    const linkPath = join(home, ".claude", "projects", encoded);
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    const wrongTarget = join(root, "elsewhere");
    mkdirSync(wrongTarget, { recursive: true });
    writeFileSync(join(wrongTarget, "keep-me.jsonl"), "important\n");
    symlinkSync(wrongTarget, linkPath);

    ensureHostProjectsSymlink({ workspaceCwd, repoLocalPath, homeDir: home });

    expect(readlinkSync(linkPath)).toBe(
      join(perRepoProjectsBase(repoLocalPath), encoded),
    );
    // The wrong-target dir + its contents must survive — `unlinkSync` on the
    // symlink only removes the link, not the target. A future regression that
    // swaps in `rmSync(linkPath, {recursive:true})` would silently destroy
    // unrelated user data.
    expect(lstatSync(wrongTarget).isDirectory()).toBe(true);
    expect(readFileSync(join(wrongTarget, "keep-me.jsonl"), "utf-8")).toBe(
      "important\n",
    );
  });

  it("works when the wrong-target symlink points at a now-dangling path", () => {
    // readlinkSync succeeds even if the target doesn't exist; the helper
    // should compare strings, not check existence. Locks in the contract
    // against a future "be helpful and existsSync first" refactor.
    const linkPath = join(home, ".claude", "projects", encoded);
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    symlinkSync(join(root, "never-existed"), linkPath);

    ensureHostProjectsSymlink({ workspaceCwd, repoLocalPath, homeDir: home });

    expect(readlinkSync(linkPath)).toBe(
      join(perRepoProjectsBase(repoLocalPath), encoded),
    );
  });

  it("replaces an empty real dir with the symlink", () => {
    const linkPath = join(home, ".claude", "projects", encoded);
    mkdirSync(linkPath, { recursive: true });

    ensureHostProjectsSymlink({ workspaceCwd, repoLocalPath, homeDir: home });

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });

  it("migrates existing JSONL files from a real dir into the per-repo dir, then symlinks", () => {
    const realDir = join(home, ".claude", "projects", encoded);
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "session-1.jsonl"), '{"hello":"world"}\n');
    writeFileSync(join(realDir, "session-2.jsonl"), '{"second":true}\n');

    ensureHostProjectsSymlink({ workspaceCwd, repoLocalPath, homeDir: home });

    const linkPath = join(home, ".claude", "projects", encoded);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);

    const perRepoDir = join(perRepoProjectsBase(repoLocalPath), encoded);
    expect(readFileSync(join(perRepoDir, "session-1.jsonl"), "utf-8")).toBe(
      '{"hello":"world"}\n',
    );
    expect(readFileSync(join(perRepoDir, "session-2.jsonl"), "utf-8")).toBe(
      '{"second":true}\n',
    );
  });

  it("rejects a regular file at the symlink path (refuses to clobber)", () => {
    const linkPath = join(home, ".claude", "projects", encoded);
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    writeFileSync(linkPath, "unexpected file content");

    expect(() =>
      ensureHostProjectsSymlink({ workspaceCwd, repoLocalPath, homeDir: home }),
    ).toThrow(/refusing to clobber/);
  });

  it("rejects a migration with same-named files in BOTH dirs (divergent state) BEFORE any rename runs", () => {
    const realDir = join(home, ".claude", "projects", encoded);
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "session-1.jsonl"), '{"from":"host"}\n');
    writeFileSync(join(realDir, "session-2.jsonl"), '{"second":true}\n');

    const perRepoDir = join(perRepoProjectsBase(repoLocalPath), encoded);
    mkdirSync(perRepoDir, { recursive: true });
    writeFileSync(
      join(perRepoDir, "session-1.jsonl"),
      '{"from":"docker"}\n',
    );

    expect(() =>
      ensureHostProjectsSymlink({ workspaceCwd, repoLocalPath, homeDir: home }),
    ).toThrow(/divergent session state/);

    // Pre-flight invariant: NEITHER dir was mutated. session-2.jsonl must
    // still be in the host dir (no partial rename), and the docker-side
    // file must be untouched.
    expect(readFileSync(join(realDir, "session-1.jsonl"), "utf-8")).toBe(
      '{"from":"host"}\n',
    );
    expect(readFileSync(join(realDir, "session-2.jsonl"), "utf-8")).toBe(
      '{"second":true}\n',
    );
    expect(readFileSync(join(perRepoDir, "session-1.jsonl"), "utf-8")).toBe(
      '{"from":"docker"}\n',
    );
  });

  it("rejects when workspaceCwd does not live under repoLocalPath (fail-loud invariant)", () => {
    // Defends against a future caller that miscomputes repoLocalPath (e.g.
    // a workspace path-shape change drifting from the dirname-based
    // derivation in spawnHostMode). Without this, the symlink would point
    // into a non-bound location and JSONLs would silently land off-bind.
    const otherRepo = join(root, "repos", "other");
    mkdirSync(otherRepo, { recursive: true });

    expect(() =>
      ensureHostProjectsSymlink({
        workspaceCwd,
        repoLocalPath: otherRepo,
        homeDir: home,
      }),
    ).toThrow(/does not live under repoLocalPath/);
  });

  it("creates the per-repo target dir if missing", () => {
    ensureHostProjectsSymlink({ workspaceCwd, repoLocalPath, homeDir: home });

    const perRepoDir = join(perRepoProjectsBase(repoLocalPath), encoded);
    expect(lstatSync(perRepoDir).isDirectory()).toBe(true);
  });

  it("creates the ~/.claude/projects/ parent dir if missing", () => {
    ensureHostProjectsSymlink({ workspaceCwd, repoLocalPath, homeDir: home });

    expect(lstatSync(join(home, ".claude", "projects")).isDirectory()).toBe(
      true,
    );
  });

  describe("cross-runtime path equivalence (AC3 + AC4) — same physical file", () => {
    it("a JSONL written through the docker bind path resolves to the SAME inode through the host symlink", () => {
      ensureHostProjectsSymlink({ workspaceCwd, repoLocalPath, homeDir: home });
      const perRepoFile = join(
        perRepoProjectsBase(repoLocalPath),
        encoded,
        "abc.jsonl",
      );
      writeFileSync(perRepoFile, '{"from":"docker"}\n');

      const hostFile = join(home, ".claude", "projects", encoded, "abc.jsonl");
      // Inode equivalence proves "same physical file", not just "same content".
      expect(statSync(hostFile).ino).toBe(statSync(perRepoFile).ino);
      expect(realpathSync(hostFile)).toBe(realpathSync(perRepoFile));
      expect(readFileSync(hostFile, "utf-8")).toBe('{"from":"docker"}\n');
    });

    it("a JSONL written through the host symlink lands in the per-repo dir as the SAME inode", () => {
      ensureHostProjectsSymlink({ workspaceCwd, repoLocalPath, homeDir: home });

      const hostFile = join(home, ".claude", "projects", encoded, "xyz.jsonl");
      writeFileSync(hostFile, '{"from":"host"}\n');

      const perRepoFile = join(
        perRepoProjectsBase(repoLocalPath),
        encoded,
        "xyz.jsonl",
      );
      expect(statSync(perRepoFile).ino).toBe(statSync(hostFile).ino);
      expect(realpathSync(hostFile)).toBe(realpathSync(perRepoFile));
      expect(readFileSync(perRepoFile, "utf-8")).toBe('{"from":"host"}\n');
    });

    it("findNewestJsonlFile via deriveSessionDir(workspaceCwd) resolves a docker-written file (AC4 — watcher's actual code path)", async () => {
      // Routes through the watcher's PUBLIC API (`deriveSessionDir`), not a
      // hand-constructed host path — proving the encoder + watcher agree at
      // runtime, not just in this test's ad-hoc derivation.
      ensureHostProjectsSymlink({ workspaceCwd, repoLocalPath, homeDir: home });
      const perRepoDir = join(perRepoProjectsBase(repoLocalPath), encoded);
      const sessionFile = join(perRepoDir, "deadbeef-1234.jsonl");
      writeFileSync(sessionFile, '{"type":"system","subtype":"init"}\n');

      // Stand in for `homedir()` at the watcher level. Vitest restoreMocks
      // doesn't cover env mutation, so restore manually in finally.
      const originalHome = process.env.HOME;
      process.env.HOME = home;
      try {
        const hostDir = deriveSessionDir(workspaceCwd);
        const found = await findNewestJsonlFile(hostDir);
        expect(found).not.toBeNull();
        // realpathSync resolves the symlink — same inode as the per-repo file
        // proves the watcher attaches to the SAME physical file the docker
        // worker wrote through its bind.
        expect(realpathSync(found!)).toBe(realpathSync(sessionFile));
        expect(statSync(found!).ino).toBe(statSync(sessionFile).ino);
      } finally {
        if (originalHome !== undefined) {
          process.env.HOME = originalHome;
        } else {
          delete process.env.HOME;
        }
      }
    });
  });
});
