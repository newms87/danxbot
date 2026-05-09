import { afterEach, describe, expect, it } from "vitest";
import {
  clearAllRepoNames,
  clearRepoName,
  repoNameFromPath,
  setRepoName,
} from "./repo-name.js";

describe("repo-name", () => {
  afterEach(() => {
    clearAllRepoNames();
  });

  it("returns basename when no registration exists", () => {
    expect(repoNameFromPath("/some/path/danxbot")).toBe("danxbot");
    expect(repoNameFromPath("/var/lib/foo")).toBe("foo");
  });

  it("returns the registered name when one is set", () => {
    setRepoName("/srv/repos/symlinked-dir", "danxbot");
    expect(repoNameFromPath("/srv/repos/symlinked-dir")).toBe("danxbot");
  });

  it("resolves relative paths the same as absolute paths", () => {
    setRepoName("/srv/repos/abc", "abc");
    // resolve() canonicalizes both inputs to the same key
    expect(repoNameFromPath("/srv/repos/abc/")).toBe("abc");
  });

  it("clearRepoName removes a single registration", () => {
    setRepoName("/srv/a", "a-name");
    setRepoName("/srv/b", "b-name");
    clearRepoName("/srv/a");
    expect(repoNameFromPath("/srv/a")).toBe("a"); // basename fallback
    expect(repoNameFromPath("/srv/b")).toBe("b-name");
  });

  it("clearAllRepoNames removes every registration", () => {
    setRepoName("/srv/a", "a-name");
    setRepoName("/srv/b", "b-name");
    clearAllRepoNames();
    expect(repoNameFromPath("/srv/a")).toBe("a");
    expect(repoNameFromPath("/srv/b")).toBe("b");
  });

  it("setRepoName twice with the same name is idempotent", () => {
    setRepoName("/srv/a", "a-name");
    setRepoName("/srv/a", "a-name");
    expect(repoNameFromPath("/srv/a")).toBe("a-name");
  });

  it("setRepoName twice with different names overwrites", () => {
    setRepoName("/srv/a", "old");
    setRepoName("/srv/a", "new");
    expect(repoNameFromPath("/srv/a")).toBe("new");
  });
});
