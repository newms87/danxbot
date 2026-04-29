import { describe, it, expect, afterEach } from "vitest";
import {
  buildDockerBuildCommand,
  buildImageTags,
  getDanxbotShaForBuild,
} from "./build.js";
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

  // Pure builder remains tolerant of empty input — `getDanxbotShaForBuild()`
  // is the gate that throws upstream, not this builder. Test documents the
  // builder's contract.
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
    // In dry-run, `tryRun` itself short-circuits and returns null — without
    // the early return, this function would throw "cannot resolve danxbot
    // commit SHA" and refuse to walk the rest of the dry-run pipeline.
    setDryRun(true);
    expect(getDanxbotShaForBuild()).toBe(DRY_RUN_SHA);
  });
});
