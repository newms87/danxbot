import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockPublishAgentSnapshot = vi.fn();
vi.mock("./agents-list.js", () => ({
  publishAgentSnapshot: (...args: unknown[]) =>
    mockPublishAgentSnapshot(...args),
}));

import { startAgentsWatcher } from "./agents-watcher.js";

const repos = [
  {
    name: "danxbot",
    localPath: "/repos/danxbot",
    hostPath: "/repos/danxbot",
    url: "u1",
    workerPort: 5562,
  },
  {
    name: "platform",
    localPath: "/repos/platform",
    hostPath: "/repos/platform",
    url: "u2",
    workerPort: 5563,
  },
];

const resolveHost = (n: string) => `host-${n}`;

describe("startAgentsWatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes the affected repo's snapshot on a settings.json change", async () => {
    const handle = await startAgentsWatcher(repos, { resolveHost }, {
      disableWatcher: true,
      debounceMs: 0,
    });
    await handle.simulate("danxbot");
    expect(mockPublishAgentSnapshot).toHaveBeenCalledTimes(1);
    const [repo, resolver] = mockPublishAgentSnapshot.mock.calls[0];
    expect(repo).toMatchObject({ name: "danxbot", localPath: "/repos/danxbot" });
    expect(typeof resolver).toBe("function");
    await handle.stop();
  });

  it("coalesces multiple changes inside the debounce window into ONE publish", async () => {
    const handle = await startAgentsWatcher(repos, { resolveHost }, {
      disableWatcher: true,
      debounceMs: 50,
    });
    await handle.simulate("danxbot");
    await handle.simulate("danxbot");
    await handle.simulate("danxbot");
    // Wait past the debounce window.
    await new Promise((res) => setTimeout(res, 80));
    expect(mockPublishAgentSnapshot).toHaveBeenCalledTimes(1);
    await handle.stop();
  });

  it("publishes per-repo independently — a change in repo A does not fire for repo B", async () => {
    const handle = await startAgentsWatcher(repos, { resolveHost }, {
      disableWatcher: true,
      debounceMs: 0,
    });
    await handle.simulate("platform");
    expect(mockPublishAgentSnapshot).toHaveBeenCalledTimes(1);
    expect(mockPublishAgentSnapshot.mock.calls[0][0].name).toBe("platform");
    await handle.stop();
  });

  it("stops cleanly — pending debounce timers do not publish after stop", async () => {
    const handle = await startAgentsWatcher(repos, { resolveHost }, {
      disableWatcher: true,
      debounceMs: 50,
    });
    await handle.simulate("danxbot");
    await handle.stop();
    await new Promise((res) => setTimeout(res, 80));
    expect(mockPublishAgentSnapshot).not.toHaveBeenCalled();
  });

  it("throws for an unknown repo in simulate (test-only safety net)", async () => {
    const handle = await startAgentsWatcher(repos, { resolveHost }, {
      disableWatcher: true,
    });
    await expect(handle.simulate("ghost")).rejects.toThrow(/ghost/);
    await handle.stop();
  });

  it("swallows publishAgentSnapshot rejections — a failing publish must not crash the dashboard process", async () => {
    mockPublishAgentSnapshot.mockRejectedValueOnce(new Error("snapshot exploded"));
    const handle = await startAgentsWatcher(repos, { resolveHost }, {
      disableWatcher: true,
      debounceMs: 0,
    });
    // simulate() does NOT itself await the publish — fire + drain the
    // microtask queue so any unhandled rejection would have surfaced.
    await handle.simulate("danxbot");
    await new Promise((res) => setImmediate(res));
    // Test passes if no unhandled rejection escaped (vitest fails on
    // unhandled rejections by default). The mock was called; the
    // rejection was caught.
    expect(mockPublishAgentSnapshot).toHaveBeenCalledTimes(1);
    await handle.stop();
  });
});
