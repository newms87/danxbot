import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { injectIssueWorkerAlias } from "./issue-worker-alias.js";

let workspacesDir: string;

beforeEach(() => {
  workspacesDir = mkdtempSync(resolve(tmpdir(), "danxbot-alias-test-"));
});

afterEach(() => {
  rmSync(workspacesDir, { recursive: true, force: true });
});

function makeIssueWorker(): string {
  const dir = resolve(workspacesDir, "issue-worker");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, "workspace.yml"),
    "name: issue-worker\n",
  );
  return dir;
}

describe("injectIssueWorkerAlias", () => {
  it("creates a `trello-worker` symlink to `issue-worker` on a fresh install", () => {
    const target = makeIssueWorker();
    injectIssueWorkerAlias(workspacesDir);
    const aliasPath = resolve(workspacesDir, "trello-worker");
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(true);
    expect(resolve(workspacesDir, readlinkSync(aliasPath))).toBe(target);
  });

  it("is a no-op when `issue-worker` is missing — refuses to write a dangling symlink", () => {
    injectIssueWorkerAlias(workspacesDir);
    expect(existsSync(resolve(workspacesDir, "trello-worker"))).toBe(false);
  });

  it("leaves a correct existing symlink untouched (no churn on every tick)", () => {
    const target = makeIssueWorker();
    const aliasPath = resolve(workspacesDir, "trello-worker");
    symlinkSync(target, aliasPath, "dir");
    const before = lstatSync(aliasPath).mtimeMs;
    injectIssueWorkerAlias(workspacesDir);
    const after = lstatSync(aliasPath).mtimeMs;
    expect(after).toBe(before);
  });

  it("recognizes a relative-target symlink as correct (no churn)", () => {
    // Earlier inject runs may have written `trello-worker → ./issue-worker`
    // (relative). The implementation resolves both sides through the
    // workspaces dir before comparing, so a relative link still equals
    // the absolute one we'd write today and is left untouched.
    makeIssueWorker();
    const aliasPath = resolve(workspacesDir, "trello-worker");
    symlinkSync("./issue-worker", aliasPath, "dir");
    const before = lstatSync(aliasPath).mtimeMs;
    injectIssueWorkerAlias(workspacesDir);
    const after = lstatSync(aliasPath).mtimeMs;
    expect(after).toBe(before);
    // Sanity: the link is still relative (we did not silently rewrite
    // it to absolute).
    expect(readlinkSync(aliasPath)).toBe("./issue-worker");
  });

  it("rewrites a stale symlink that points at the wrong target", () => {
    makeIssueWorker();
    const aliasPath = resolve(workspacesDir, "trello-worker");
    const wrongTarget = resolve(workspacesDir, "somewhere-else");
    mkdirSync(wrongTarget, { recursive: true });
    symlinkSync(wrongTarget, aliasPath, "dir");
    injectIssueWorkerAlias(workspacesDir);
    const linkTarget = resolve(workspacesDir, readlinkSync(aliasPath));
    expect(linkTarget).toBe(resolve(workspacesDir, "issue-worker"));
  });

  it("converts a pre-P5 danxbot-authored real `trello-worker/` directory to a symlink", () => {
    // Reproduce the on-disk shape `injectDanxWorkspaces` left in every
    // connected repo on every tick before Phase 5: a real directory
    // whose `workspace.yml` declares `name: trello-worker`.
    const target = makeIssueWorker();
    const legacyDir = resolve(workspacesDir, "trello-worker");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      resolve(legacyDir, "workspace.yml"),
      "name: trello-worker\ndescription: legacy\n",
    );
    writeFileSync(
      resolve(legacyDir, "CLAUDE.md"),
      "# legacy danxbot-authored fixture\n",
    );

    injectIssueWorkerAlias(workspacesDir);

    const aliasPath = resolve(workspacesDir, "trello-worker");
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(true);
    expect(resolve(workspacesDir, readlinkSync(aliasPath))).toBe(target);
  });

  it("leaves an operator-authored `trello-worker/` directory untouched (no `workspace.yml`)", () => {
    makeIssueWorker();
    const operatorDir = resolve(workspacesDir, "trello-worker");
    mkdirSync(operatorDir, { recursive: true });
    writeFileSync(
      resolve(operatorDir, "README.md"),
      "operator-authored workspace\n",
    );
    injectIssueWorkerAlias(workspacesDir);
    const aliasPath = resolve(workspacesDir, "trello-worker");
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(false);
    expect(lstatSync(aliasPath).isDirectory()).toBe(true);
    expect(readFileSync(resolve(aliasPath, "README.md"), "utf-8")).toBe(
      "operator-authored workspace\n",
    );
  });

  it("leaves an operator-authored `trello-worker/` with a malformed/empty workspace.yml untouched (fails safe → preserves operator data)", () => {
    // `isPreP5DanxbotAuthored` matches `^name:\s*trello-worker\s*$/m`. A
    // manifest that fails the regex (empty file, comment-only, malformed
    // YAML) is treated as "not danxbot-authored" — the dir is preserved.
    // The right failure mode for ambiguous data is "leave operator
    // content alone," not "guess and clobber."
    makeIssueWorker();
    const operatorDir = resolve(workspacesDir, "trello-worker");
    mkdirSync(operatorDir, { recursive: true });
    writeFileSync(
      resolve(operatorDir, "workspace.yml"),
      "# operator's empty manifest\n",
    );
    writeFileSync(
      resolve(operatorDir, "DATA.txt"),
      "operator data must survive\n",
    );
    injectIssueWorkerAlias(workspacesDir);
    const aliasPath = resolve(workspacesDir, "trello-worker");
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(resolve(aliasPath, "DATA.txt"), "utf-8")).toBe(
      "operator data must survive\n",
    );
  });

  it("leaves an operator-authored `trello-worker/workspace.yml` with a different name untouched", () => {
    makeIssueWorker();
    const operatorDir = resolve(workspacesDir, "trello-worker");
    mkdirSync(operatorDir, { recursive: true });
    writeFileSync(
      resolve(operatorDir, "workspace.yml"),
      "name: schema-builder\ndescription: operator-authored\n",
    );
    injectIssueWorkerAlias(workspacesDir);
    const aliasPath = resolve(workspacesDir, "trello-worker");
    expect(lstatSync(aliasPath).isSymbolicLink()).toBe(false);
    expect(lstatSync(aliasPath).isDirectory()).toBe(true);
  });
});
