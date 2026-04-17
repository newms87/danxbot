import { describe, it, expect } from "vitest";
import { buildImageTags } from "./build.js";

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
