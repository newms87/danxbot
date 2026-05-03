import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { scrubLegacyTrelloWorkerSymlink } from "./legacy-trello-worker-scrub.js";

let workspacesDir: string;

beforeEach(() => {
  workspacesDir = mkdtempSync(resolve(tmpdir(), "danxbot-scrub-test-"));
});

afterEach(() => {
  rmSync(workspacesDir, { recursive: true, force: true });
});

function makeSibling(name: string): string {
  const dir = resolve(workspacesDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("scrubLegacyTrelloWorkerSymlink", () => {
  it("removes a symlink whose name matches the legacy alias and whose target is the sibling new workspace", () => {
    const target = makeSibling("issue-worker");
    const legacyPath = resolve(workspacesDir, "trello-worker");
    symlinkSync(target, legacyPath, "dir");

    scrubLegacyTrelloWorkerSymlink(workspacesDir);

    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  it("removes a relative-target symlink that resolves to the sibling new workspace", () => {
    makeSibling("issue-worker");
    const legacyPath = resolve(workspacesDir, "trello-worker");
    symlinkSync("./issue-worker", legacyPath, "dir");

    scrubLegacyTrelloWorkerSymlink(workspacesDir);

    expect(existsSync(legacyPath)).toBe(false);
  });

  it("leaves a symlink whose target is some other path untouched (operator may have rebound it)", () => {
    const wrong = makeSibling("somewhere-else");
    const legacyPath = resolve(workspacesDir, "trello-worker");
    symlinkSync(wrong, legacyPath, "dir");

    scrubLegacyTrelloWorkerSymlink(workspacesDir);

    expect(lstatSync(legacyPath).isSymbolicLink()).toBe(true);
  });

  it("leaves a real directory at the legacy path untouched (operator-authored workspace preserved)", () => {
    const operatorDir = resolve(workspacesDir, "trello-worker");
    mkdirSync(operatorDir, { recursive: true });
    writeFileSync(
      resolve(operatorDir, "workspace.yml"),
      "name: schema-builder\ndescription: operator-authored\n",
    );
    writeFileSync(resolve(operatorDir, "DATA.txt"), "must survive\n");

    scrubLegacyTrelloWorkerSymlink(workspacesDir);

    expect(lstatSync(operatorDir).isSymbolicLink()).toBe(false);
    expect(lstatSync(operatorDir).isDirectory()).toBe(true);
    expect(readFileSync(resolve(operatorDir, "DATA.txt"), "utf-8")).toBe(
      "must survive\n",
    );
  });

  it("is a no-op when the legacy path does not exist", () => {
    makeSibling("issue-worker");
    scrubLegacyTrelloWorkerSymlink(workspacesDir);
    expect(existsSync(resolve(workspacesDir, "trello-worker"))).toBe(false);
  });

  it("removes a dangling symlink whose path string still resolves to the sibling new workspace (target dir absent)", () => {
    // Operator may have nuked the new workspace dir manually; the
    // leftover symlink at the legacy name is still alias rubble we
    // want gone. `resolve()` is a string operation — it doesn't
    // require the target to exist.
    const legacyPath = resolve(workspacesDir, "trello-worker");
    symlinkSync("./issue-worker", legacyPath, "dir");
    expect(existsSync(resolve(workspacesDir, "issue-worker"))).toBe(false);

    scrubLegacyTrelloWorkerSymlink(workspacesDir);

    expect(existsSync(legacyPath)).toBe(false);
  });

  it("is idempotent — running twice on the same dir is fine", () => {
    const target = makeSibling("issue-worker");
    const legacyPath = resolve(workspacesDir, "trello-worker");
    symlinkSync(target, legacyPath, "dir");

    scrubLegacyTrelloWorkerSymlink(workspacesDir);
    scrubLegacyTrelloWorkerSymlink(workspacesDir);

    expect(existsSync(legacyPath)).toBe(false);
  });
});
