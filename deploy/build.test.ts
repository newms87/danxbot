import { describe, it, expect, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  buildDockerBuildCommand,
  buildImageTags,
  buildRemoteBuildScript,
  buildRemotePushScript,
  buildTarCommand,
  getDanxbotShaForBuild,
  readDockerignoreExcludes,
  resolveRemoteBuildPaths,
} from "./build.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { setDryRun } from "./exec.js";
import { DRY_RUN_SHA } from "./dry-run-placeholders.js";

describe("buildImageTags", () => {
  it("emits latest + timestamp tags", () => {
    const tags = buildImageTags(
      "123.dkr.ecr.us-east-1.amazonaws.com/danxbot-production",
    );
    expect(tags.latestTag).toBe(
      "123.dkr.ecr.us-east-1.amazonaws.com/danxbot-production:latest",
    );
    expect(tags.timestampTag).toMatch(
      /^123\.dkr\.ecr\.us-east-1\.amazonaws\.com\/danxbot-production:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/,
    );
  });

  it("timestamp suffix has no colons or dots (docker tag rules)", () => {
    const tags = buildImageTags("repo/img");
    const suffix = tags.timestampTag.split(":")[1];
    expect(suffix).not.toContain(":");
    expect(suffix).not.toContain(".");
  });

  it("latest tag always pins to :latest", () => {
    const tags = buildImageTags("any-repo-url");
    expect(tags.latestTag).toBe("any-repo-url:latest");
  });
});

describe("buildDockerBuildCommand", () => {
  const TAGS = {
    latestTag: "repo/img:latest",
    timestampTag: "repo/img:2026-04-25T00-00-00",
  };

  it("injects --build-arg DANXBOT_COMMIT when a SHA is provided", () => {
    const cmd = buildDockerBuildCommand(TAGS, "abc1234");
    expect(cmd).toContain("--build-arg DANXBOT_COMMIT=abc1234");
    expect(cmd).toContain("-t repo/img:latest");
    expect(cmd).toContain("-t repo/img:2026-04-25T00-00-00");
    expect(cmd.endsWith(" .")).toBe(true);
  });

  it("omits the build-arg when called with an empty SHA", () => {
    const cmd = buildDockerBuildCommand(TAGS, "");
    expect(cmd).not.toContain("--build-arg");
    expect(cmd).toBe(
      "docker build -t repo/img:latest -t repo/img:2026-04-25T00-00-00 .",
    );
  });
});

describe("getDanxbotShaForBuild dry-run", () => {
  afterEach(() => {
    setDryRun(false);
  });

  it("returns the placeholder SHA in dry-run without invoking git", () => {
    setDryRun(true);
    expect(getDanxbotShaForBuild()).toBe(DRY_RUN_SHA);
  });
});

describe("resolveRemoteBuildPaths", () => {
  it("scopes tarball + build dir by SHA so concurrent deploys do not collide", () => {
    const paths = resolveRemoteBuildPaths("abc1234");
    expect(paths.localTarball).toBe(
      resolve(tmpdir(), "danxbot-deploy-abc1234.tar.gz"),
    );
    expect(paths.remoteTarball).toBe("/tmp/danxbot-deploy-abc1234.tar.gz");
    expect(paths.remoteBuildDir).toBe("/tmp/danxbot-build-abc1234");
  });

  it("different SHAs produce different paths", () => {
    const a = resolveRemoteBuildPaths("aaa1111");
    const b = resolveRemoteBuildPaths("bbb2222");
    expect(a.remoteBuildDir).not.toBe(b.remoteBuildDir);
    expect(a.localTarball).not.toBe(b.localTarball);
  });
});

describe("buildRemoteBuildScript", () => {
  const PATHS = {
    localTarball: "/tmp/danxbot-deploy-abc.tar.gz",
    remoteTarball: "/tmp/danxbot-deploy-abc.tar.gz",
    remoteBuildDir: "/tmp/danxbot-build-abc",
  };
  const BUILD_CMD = "docker build -t repo:latest .";

  it("starts with set -euo pipefail so any step failure aborts the deploy", () => {
    const script = buildRemoteBuildScript({ paths: PATHS, buildCmd: BUILD_CMD });
    expect(script.startsWith("set -euo pipefail && ")).toBe(true);
  });

  it("clears the build dir before extracting so re-deploys are idempotent", () => {
    const script = buildRemoteBuildScript({ paths: PATHS, buildCmd: BUILD_CMD });
    const rmIdx = script.indexOf("rm -rf /tmp/danxbot-build-abc");
    const tarIdx = script.indexOf("tar -xzf");
    expect(rmIdx).toBeGreaterThan(-1);
    expect(tarIdx).toBeGreaterThan(rmIdx);
  });

  it("invokes the build command after cd into the build dir", () => {
    const script = buildRemoteBuildScript({ paths: PATHS, buildCmd: BUILD_CMD });
    const cdIdx = script.indexOf("cd /tmp/danxbot-build-abc");
    const buildIdx = script.indexOf(BUILD_CMD);
    expect(cdIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeGreaterThan(cdIdx);
  });

  it("invokes the canonical ECR login helper after the build", () => {
    const script = buildRemoteBuildScript({ paths: PATHS, buildCmd: BUILD_CMD });
    const buildIdx = script.indexOf(BUILD_CMD);
    const loginIdx = script.indexOf("/usr/local/bin/ecr-login.sh");
    expect(loginIdx).toBeGreaterThan(buildIdx);
  });

  it("allows overriding the ECR login script for testability", () => {
    const script = buildRemoteBuildScript({
      paths: PATHS,
      buildCmd: BUILD_CMD,
      ecrLoginScript: "/custom/login.sh",
    });
    expect(script).toContain("/custom/login.sh");
    expect(script).not.toContain("/usr/local/bin/ecr-login.sh");
  });
});

describe("buildRemotePushScript", () => {
  const PATHS = {
    localTarball: "/tmp/danxbot-deploy-abc.tar.gz",
    remoteTarball: "/tmp/danxbot-deploy-abc.tar.gz",
    remoteBuildDir: "/tmp/danxbot-build-abc",
  };
  const TAGS = {
    latestTag: "repo/img:latest",
    timestampTag: "repo/img:2026-04-25T00-00-00",
  };
  const PREFIX = "set -euo pipefail && build_step";

  it("pushes both tags after the build prefix", () => {
    const cmd = buildRemotePushScript({ prefix: PREFIX, tags: TAGS, paths: PATHS });
    const buildIdx = cmd.indexOf("build_step");
    const latestIdx = cmd.indexOf(`docker push ${TAGS.latestTag}`);
    const tsIdx = cmd.indexOf(`docker push ${TAGS.timestampTag}`);
    expect(latestIdx).toBeGreaterThan(buildIdx);
    expect(tsIdx).toBeGreaterThan(latestIdx);
  });

  it("cleans up the build dir + tarball after pushes succeed", () => {
    const cmd = buildRemotePushScript({ prefix: PREFIX, tags: TAGS, paths: PATHS });
    const tsIdx = cmd.indexOf(`docker push ${TAGS.timestampTag}`);
    const cleanupIdx = cmd.indexOf(
      `rm -rf ${PATHS.remoteBuildDir} ${PATHS.remoteTarball}`,
    );
    expect(cleanupIdx).toBeGreaterThan(tsIdx);
  });

  it("uses && between every step so any step failure aborts cleanup", () => {
    // If pushes failed and we still ran rm -rf, we'd lose the build dir
    // for triage. Asserting the && joins between push and cleanup is the
    // mechanical guard.
    const cmd = buildRemotePushScript({ prefix: PREFIX, tags: TAGS, paths: PATHS });
    expect(cmd).toContain(`docker push ${TAGS.timestampTag} && rm -rf`);
  });
});

// packDanxbotSource + buildAndPush both call runStreaming + RemoteHost
// methods which are exercised via integration tests in cli.test.ts (where
// every shell command is captured). Unit-testing the io-shaped wrappers
// directly would just re-mock node:child_process and assert on the same
// strings the helpers above already cover.
//
// One smoke: the build cwd flag on packDanxbotSource is implicit (REPO_ROOT
// is module-private). Verify by spying that the runStreaming call shape
// would archive HEAD. Lightweight and catches a future regression that
// drops `cwd` and ends up archiving the operator's $PWD.
describe("readDockerignoreExcludes", () => {
  let tmp: string;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("strips comments and empty lines, returns one exclude per pattern", () => {
    tmp = mkdtempSync(resolve(tmpdir(), "dx-test-"));
    writeFileSync(
      resolve(tmp, ".dockerignore"),
      "# comment\nnode_modules\n\n.git\nclaude-auth\n",
    );
    expect(readDockerignoreExcludes(tmp)).toEqual([
      "node_modules",
      ".git",
      "claude-auth",
    ]);
  });

  it("returns empty list when .dockerignore is missing", () => {
    tmp = mkdtempSync(resolve(tmpdir(), "dx-test-"));
    expect(readDockerignoreExcludes(tmp)).toEqual([]);
  });

  it("skips negation patterns (tar can't express them)", () => {
    tmp = mkdtempSync(resolve(tmpdir(), "dx-test-"));
    writeFileSync(
      resolve(tmp, ".dockerignore"),
      "node_modules\n!node_modules/keep\n.env\n",
    );
    expect(readDockerignoreExcludes(tmp)).toEqual(["node_modules", ".env"]);
  });
});

describe("buildTarCommand", () => {
  it("always excludes .git and tarball-temp pattern even if .dockerignore is empty", () => {
    const cmd = buildTarCommand({
      repoRoot: "/repo",
      localTarball: "/tmp/out.tar.gz",
      dockerignoreExcludes: [],
    });
    expect(cmd).toContain("--exclude=.git");
    expect(cmd).toContain("--exclude=danxbot-deploy-*.tar.gz");
  });

  it("always excludes deploy/terraform (mutates during apply) + targets/.cache", () => {
    const cmd = buildTarCommand({
      repoRoot: "/repo",
      localTarball: "/tmp/out.tar.gz",
      dockerignoreExcludes: [],
    });
    expect(cmd).toContain("--exclude=deploy/terraform");
    expect(cmd).toContain("--exclude=deploy/targets/.cache");
  });

  it("tolerates concurrent file edits (--warning suppressors set)", () => {
    const cmd = buildTarCommand({
      repoRoot: "/repo",
      localTarball: "/tmp/out.tar.gz",
      dockerignoreExcludes: [],
    });
    expect(cmd).toContain("--warning=no-file-changed");
    expect(cmd).toContain("--warning=no-file-removed");
  });

  it("forwards every dockerignore exclude to tar", () => {
    const cmd = buildTarCommand({
      repoRoot: "/repo",
      localTarball: "/tmp/out.tar.gz",
      dockerignoreExcludes: ["node_modules", ".env", "claude-auth"],
    });
    expect(cmd).toContain("--exclude=node_modules");
    expect(cmd).toContain("--exclude=.env");
    expect(cmd).toContain("--exclude=claude-auth");
  });

  it("targets the correct tarball path and repo root", () => {
    const cmd = buildTarCommand({
      repoRoot: "/some/repo",
      localTarball: "/tmp/foo.tar.gz",
      dockerignoreExcludes: [],
    });
    expect(cmd).toContain("-czf /tmp/foo.tar.gz");
    expect(cmd).toContain("-C /some/repo .");
  });
});

describe("packDanxbotSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes the tar command and validates the output exists", async () => {
    const fs = await import("node:fs");
    const exec = await import("./exec.js");
    const build = await import("./build.js");
    const target = resolve(
      tmpdir(),
      `danxbot-deploy-test-${Date.now()}-${process.pid}.tar.gz`,
    );
    const spy = vi
      .spyOn(exec, "runStreaming")
      .mockImplementation(() => {
        fs.writeFileSync(target, "");
      });
    try {
      build.packDanxbotSource(target);
      expect(spy).toHaveBeenCalledTimes(1);
      const cmd = spy.mock.calls[0][0];
      expect(cmd).toMatch(/^tar /);
      expect(cmd).toContain("--exclude=.git");
      expect(cmd).toContain(target);
    } finally {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
  });

  it("throws if tar completes but tarball is missing", async () => {
    const exec = await import("./exec.js");
    const build = await import("./build.js");
    vi.spyOn(exec, "runStreaming").mockImplementation(() => {});
    const target = resolve(
      tmpdir(),
      `danxbot-deploy-missing-${Date.now()}-${process.pid}.tar.gz`,
    );
    expect(() => build.packDanxbotSource(target)).toThrow(/does not exist/);
  });
});
