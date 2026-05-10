import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePortableRepoPath,
  PortableRepoPathError,
} from "./portable-path.js";

describe("ensurePortableRepoPath", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "portable-path-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("noop when localPath === hostPath (host runtime)", () => {
    expect(() => ensurePortableRepoPath(root, root)).not.toThrow();
  });

  it("passes when hostPath exists as a directory (docker mirror-bind)", () => {
    const localPath = join(root, "container");
    const hostPath = join(root, "host");
    mkdirSync(localPath);
    mkdirSync(hostPath);
    expect(() => ensurePortableRepoPath(localPath, hostPath)).not.toThrow();
  });

  it("throws when hostPath does not exist (mount drift)", () => {
    const localPath = join(root, "container");
    const hostPath = join(root, "missing");
    mkdirSync(localPath);
    expect(() => ensurePortableRepoPath(localPath, hostPath)).toThrow(
      PortableRepoPathError,
    );
  });

  it("throws when hostPath exists but is a file", () => {
    const localPath = join(root, "container");
    const hostPath = join(root, "host");
    mkdirSync(localPath);
    writeFileSync(hostPath, "not a directory");
    expect(() => ensurePortableRepoPath(localPath, hostPath)).toThrow(
      PortableRepoPathError,
    );
  });

  it("error message names hostPath, env var, and the compose.yml fix", () => {
    // Operators read this message to fix mount drift. The shape is part
    // of the contract — a refactor that drops `DANXBOT_REPO_HOST_PATH`
    // or `compose.yml` would strand the operator with a generic message.
    const localPath = join(root, "container");
    const hostPath = join(root, "missing");
    mkdirSync(localPath);
    let captured: Error | null = null;
    try {
      ensurePortableRepoPath(localPath, hostPath);
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeInstanceOf(PortableRepoPathError);
    expect(captured!.message).toContain(hostPath);
    expect(captured!.message).toContain("DANXBOT_REPO_HOST_PATH");
    expect(captured!.message).toContain("compose.yml");
  });
});
