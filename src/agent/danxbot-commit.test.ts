import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import { _resetDanxbotCommitCache, getDanxbotCommit } from "./danxbot-commit.js";

describe("getDanxbotCommit", () => {
  const originalEnv = process.env.DANXBOT_COMMIT;

  beforeEach(() => {
    _resetDanxbotCommitCache();
    mockExecSync.mockReset();
    delete process.env.DANXBOT_COMMIT;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DANXBOT_COMMIT;
    } else {
      process.env.DANXBOT_COMMIT = originalEnv;
    }
  });

  it("returns process.env.DANXBOT_COMMIT when set, never invoking git", () => {
    process.env.DANXBOT_COMMIT = "abc1234";
    mockExecSync.mockImplementation(() => {
      throw new Error("git should not be called when env is present");
    });

    expect(getDanxbotCommit()).toBe("abc1234");
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("ignores empty/whitespace env var and falls back to git", () => {
    process.env.DANXBOT_COMMIT = "   ";
    mockExecSync.mockReturnValue("deadbee\n");

    expect(getDanxbotCommit()).toBe("deadbee");
    expect(mockExecSync).toHaveBeenCalledOnce();
  });

  it("falls back to git rev-parse when env is absent", () => {
    mockExecSync.mockReturnValue("feedface\n");

    expect(getDanxbotCommit()).toBe("feedface");
    expect(mockExecSync).toHaveBeenCalledWith(
      "git rev-parse --short HEAD",
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("returns null when env is absent and git fails, without throwing", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    expect(() => getDanxbotCommit()).not.toThrow();
    expect(getDanxbotCommit()).toBeNull();
  });

  it("caches the resolved value across calls", () => {
    process.env.DANXBOT_COMMIT = "cached1";
    expect(getDanxbotCommit()).toBe("cached1");

    delete process.env.DANXBOT_COMMIT;
    mockExecSync.mockReturnValue("differs\n");
    expect(getDanxbotCommit()).toBe("cached1");
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});
