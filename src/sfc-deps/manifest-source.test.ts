/**
 * Manifest source tests — S3 + local-dev impls.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  createS3ManifestSource,
  createLocalManifestSource,
  resolveManifestSourceFromEnv,
} from "./manifest-source.js";

describe("createLocalManifestSource", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sfc-deps-local-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists every <version>/shared_deps_lock.json under dir", async () => {
    await mkdir(join(dir, "1.0.0"), { recursive: true });
    await writeFile(
      join(dir, "1.0.0", "shared_deps_lock.json"),
      JSON.stringify({ shell_version: "1.0.0", deps: { vue: "3.5.13" } }),
    );
    await mkdir(join(dir, "2.0.0"), { recursive: true });
    await writeFile(
      join(dir, "2.0.0", "shared_deps_lock.json"),
      JSON.stringify({ shell_version: "2.0.0", deps: { vue: "3.6.0" } }),
    );

    const src = createLocalManifestSource(dir);
    const list = await src.list();
    expect(list.map((e) => e.shell_version).sort()).toEqual(["1.0.0", "2.0.0"]);
    const m = await src.fetch(list.find((e) => e.shell_version === "1.0.0")!);
    expect(m).toEqual({ shell_version: "1.0.0", deps: { vue: "3.5.13" } });
  });

  it("ignores dirs without a shared_deps_lock.json", async () => {
    await mkdir(join(dir, "empty"), { recursive: true });
    const src = createLocalManifestSource(dir);
    const list = await src.list();
    expect(list).toEqual([]);
  });

  it("returns empty when dir does not exist", async () => {
    const src = createLocalManifestSource(join(dir, "nope"));
    const list = await src.list();
    expect(list).toEqual([]);
  });

  it("fetch throws on malformed JSON", async () => {
    await mkdir(join(dir, "1.0.0"), { recursive: true });
    await writeFile(join(dir, "1.0.0", "shared_deps_lock.json"), "{not json");
    const src = createLocalManifestSource(dir);
    const list = await src.list();
    await expect(src.fetch(list[0])).rejects.toThrow();
  });
});

describe("createS3ManifestSource", () => {
  it("list parses `aws s3 ls` output for top-level prefixes", async () => {
    const calls: string[][] = [];
    const src = createS3ManifestSource({
      bucket: "mybucket",
      prefix: "template-shell/",
      awsProfile: "danxbot",
      runCmd: async (cmd, args) => {
        calls.push([cmd, ...args]);
        // `aws s3 ls s3://bucket/template-shell/` lists "PRE <prefix>/"
        return [
          "                           PRE 1.0.0/",
          "                           PRE 2.0.0/",
          "2026-05-01 00:00:00          0 something-else.txt",
          "",
        ].join("\n");
      },
    });
    const list = await src.list();
    expect(list.map((e) => e.shell_version).sort()).toEqual(["1.0.0", "2.0.0"]);
    expect(list[0].locator).toMatch(/^s3:\/\/mybucket\/template-shell\//);
    expect(calls[0]).toContain("s3");
    expect(calls[0]).toContain("ls");
  });

  it("fetch shells `aws s3 cp <locator> -` and parses the body", async () => {
    const src = createS3ManifestSource({
      bucket: "mybucket",
      prefix: "template-shell/",
      awsProfile: "danxbot",
      runCmd: async (cmd, args) => {
        if (args.includes("cp"))
          return JSON.stringify({
            shell_version: "1.0.0",
            deps: { vue: "3.5.13" },
          });
        return "";
      },
    });
    const m = await src.fetch({
      shell_version: "1.0.0",
      locator: "s3://mybucket/template-shell/1.0.0/shared_deps_lock.json",
    });
    expect(m.deps).toEqual({ vue: "3.5.13" });
  });

  it("list ignores object-row lines whose key contains the literal string 'PRE'", async () => {
    const src = createS3ManifestSource({
      bucket: "mybucket",
      prefix: "template-shell/",
      awsProfile: "danxbot",
      runCmd: async () =>
        [
          "                           PRE 1.0.0/",
          "2026-05-01 00:00:00       1234 PRE-stamp.txt",
          "2026-05-01 00:00:00       1234 some-PRE-key",
        ].join("\n"),
    });
    const list = await src.list();
    expect(list.map((e) => e.shell_version)).toEqual(["1.0.0"]);
  });

  it("S3.fetch rejects manifest body whose shell_version disagrees with entry", async () => {
    const src = createS3ManifestSource({
      bucket: "mybucket",
      prefix: "template-shell/",
      awsProfile: "danxbot",
      runCmd: async (cmd, args) => {
        if (args.includes("cp"))
          return JSON.stringify({
            shell_version: "9.9.9",
            deps: { vue: "3.5.13" },
          });
        return "";
      },
    });
    await expect(
      src.fetch({
        shell_version: "1.0.0",
        locator: "s3://mybucket/template-shell/1.0.0/shared_deps_lock.json",
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("S3.fetch rejects bodies above the size cap", async () => {
    const src = createS3ManifestSource({
      bucket: "mybucket",
      prefix: "template-shell/",
      awsProfile: "danxbot",
      runCmd: async () => "x".repeat(1024 * 1024),
    });
    await expect(
      src.fetch({
        shell_version: "1.0.0",
        locator: "s3://mybucket/template-shell/1.0.0/shared_deps_lock.json",
      }),
    ).rejects.toThrow(/exceeds/);
  });

  it("list filters out unsafe shell_version names from S3 listing", async () => {
    const src = createS3ManifestSource({
      bucket: "mybucket",
      prefix: "template-shell/",
      awsProfile: "danxbot",
      runCmd: async () =>
        [
          "                           PRE 1.0.0/",
          "                           PRE ../escape/",
          "                           PRE has spaces/",
        ].join("\n"),
    });
    const list = await src.list();
    expect(list.map((e) => e.shell_version)).toEqual(["1.0.0"]);
  });
});

describe("resolveManifestSourceFromEnv", () => {
  it("prefers SFC_DEPS_LOCAL_MANIFEST_DIR when set", () => {
    const src = resolveManifestSourceFromEnv({
      SFC_DEPS_LOCAL_MANIFEST_DIR: "/tmp/local",
      SFC_DEPS_S3_BUCKET: "ignored",
    });
    expect(src?.kind).toBe("local");
  });

  it("falls back to S3 when only SFC_DEPS_S3_BUCKET is set", () => {
    const src = resolveManifestSourceFromEnv({
      SFC_DEPS_S3_BUCKET: "mybucket",
    });
    expect(src?.kind).toBe("s3");
  });

  it("returns null when neither is set", () => {
    expect(resolveManifestSourceFromEnv({})).toBeNull();
  });
});
