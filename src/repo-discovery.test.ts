import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverConnectedRepos, findDanxbotRoot } from "./repo-discovery.js";

async function makeDanxbotRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "danxbot-discovery-test-"));
  await mkdir(join(root, "repos"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "danxbot" }),
    "utf-8",
  );
  return root;
}

describe("findDanxbotRoot", () => {
  it("returns null when no danxbot root is reachable", async () => {
    const empty = await mkdtemp(join(tmpdir(), "no-danxbot-"));
    expect(findDanxbotRoot(empty)).toBeNull();
  });

  it("walks up to find the danxbot root from a nested subdir", async () => {
    const root = await makeDanxbotRoot();
    const nested = join(root, "src", "deep", "nested");
    await mkdir(nested, { recursive: true });
    expect(findDanxbotRoot(nested)).toBe(root);
  });

  it("requires both package.json (name=danxbot) AND repos/ subdir", async () => {
    // A dir with only package.json should NOT match.
    const fake = await mkdtemp(join(tmpdir(), "fake-danxbot-"));
    await writeFile(
      join(fake, "package.json"),
      JSON.stringify({ name: "danxbot" }),
      "utf-8",
    );
    // No `repos/` subdir → walks past it and returns null.
    expect(findDanxbotRoot(fake)).toBeNull();
  });
});

describe("discoverConnectedRepos", () => {
  it("returns [] when no danxbot root is reachable", async () => {
    const empty = await mkdtemp(join(tmpdir(), "no-danxbot-"));
    expect(discoverConnectedRepos(empty)).toEqual([]);
  });

  it("returns [] when repos/ is empty", async () => {
    const root = await makeDanxbotRoot();
    expect(discoverConnectedRepos(root)).toEqual([]);
  });

  it("enumerates symlinked repos containing .danxbot/", async () => {
    const root = await makeDanxbotRoot();
    // Make two fake "connected" repos elsewhere; symlink them into repos/.
    const repoA = await mkdtemp(join(tmpdir(), "repo-a-"));
    await mkdir(join(repoA, ".danxbot"));
    await symlink(repoA, join(root, "repos", "alpha"));
    const repoB = await mkdtemp(join(tmpdir(), "repo-b-"));
    await mkdir(join(repoB, ".danxbot"));
    await symlink(repoB, join(root, "repos", "beta"));

    const found = discoverConnectedRepos(root);
    expect(found.map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
    // localPath is realpath-resolved (no symlink leakage)
    expect(found.find((r) => r.name === "alpha")?.localPath).toBe(repoA);
  });

  it("skips dot-entries and repos without .danxbot/", async () => {
    const root = await makeDanxbotRoot();
    const repoA = await mkdtemp(join(tmpdir(), "with-danxbot-"));
    await mkdir(join(repoA, ".danxbot"));
    await symlink(repoA, join(root, "repos", "valid"));
    const repoBad = await mkdtemp(join(tmpdir(), "without-danxbot-"));
    await symlink(repoBad, join(root, "repos", "no-danxbot-subdir"));
    // A dotted name should be skipped (e.g. `.DS_Store`-like)
    await writeFile(join(root, "repos", ".hidden"), "x", "utf-8");

    const found = discoverConnectedRepos(root);
    expect(found.map((r) => r.name)).toEqual(["valid"]);
  });
});
