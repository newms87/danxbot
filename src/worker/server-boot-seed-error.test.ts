import { describe, it, expect, vi } from "vitest";
import http from "http";
import { makeRepoContext } from "../__tests__/helpers/fixtures.js";

vi.mock("./health.js", () => ({ getHealthStatus: vi.fn() }));
vi.mock("./dispatch.js", () => ({
  handleLaunch: vi.fn(),
  handleCancel: vi.fn(),
  handleStatus: vi.fn(),
  handleStop: vi.fn(),
  handleResume: vi.fn(),
  handleListJobs: vi.fn(),
  handleSlackReply: vi.fn(),
  handleSlackUpdate: vi.fn(),
}));
vi.mock("./critical-failure-route.js", () => ({
  handleClearCriticalFailure: vi.fn(),
}));
vi.mock("./issue-route.js", () => ({
  handleIssueCreate: vi.fn(),
  handleIssueSave: vi.fn(),
}));
vi.mock("./restart-route.js", () => ({ handleRestart: vi.fn() }));

const mockSeedCooldown = vi
  .fn()
  .mockRejectedValue(new Error("worker_restarts table missing"));
vi.mock("./restart.js", () => ({
  seedCooldownFromDb: (...args: unknown[]) => mockSeedCooldown(...args),
}));

vi.mock("../logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockServer = {
  listen: vi.fn((_port: number, cb: () => void) => cb()),
  close: vi.fn((cb?: () => void) => cb?.()),
};
vi.mock("http", async () => {
  const actual = await vi.importActual<typeof import("http")>("http");
  return {
    ...actual,
    createServer: () => mockServer,
  };
});

import { startWorkerServer } from "./server.js";

describe("worker server boot — seed cooldown error tolerance", () => {
  it("does not throw when seedCooldownFromDb rejects (pre-migration boot)", async () => {
    const repo = makeRepoContext();
    await expect(startWorkerServer(repo)).resolves.toBeDefined();
    expect(mockSeedCooldown).toHaveBeenCalledWith(repo.name);
  });
});
