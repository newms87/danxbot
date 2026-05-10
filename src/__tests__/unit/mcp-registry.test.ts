/**
 * Unit tests for the danxbot infrastructure MCP server registry
 * (`src/agent/mcp-registry.ts`).
 *
 * `defaultMcpRegistry[DANXBOT_SERVER_NAME].build(opts)` is the SOLE seam
 * that turns dispatch-time URL options into the env block of the danxbot
 * MCP subprocess. Phase 3 of tracker-agnostic-agents (Trello wsb4TVNT)
 * extended `McpFactoryOptions` with the issue options group; DX-157
 * pruned the legacy save URL so the surface is now `issue?: {createUrl}`
 * only. This suite pins the env-mapping contract so a regression that
 * drops a URL (or wires it under the wrong name) fails loudly at unit
 * level instead of silently disabling agent issue-create flows in
 * production.
 */

import { describe, expect, it } from "vitest";
import {
  DANXBOT_SERVER_NAME,
  defaultMcpRegistry,
} from "../../agent/mcp-registry.js";
import { McpResolveError } from "../../agent/mcp-types.js";

const STOP_URL = "http://localhost:9999/api/stop/job-1";

function build(opts: Parameters<typeof defaultMcpRegistry[typeof DANXBOT_SERVER_NAME]["build"]>[0]) {
  return defaultMcpRegistry[DANXBOT_SERVER_NAME].build(opts);
}

describe("danxbot MCP registry — build()", () => {
  it("requires danxbotStopUrl (fail-loud)", () => {
    expect(() => build({ danxbotStopUrl: "" })).toThrow(McpResolveError);
  });

  it("emits only DANXBOT_STOP_URL when no optional URL groups supplied", () => {
    const cfg = build({ danxbotStopUrl: STOP_URL });
    expect(cfg.env).toEqual({ DANXBOT_STOP_URL: STOP_URL });
  });

  it("adds DANXBOT_SLACK_*_URL when opts.slack is supplied", () => {
    const cfg = build({
      danxbotStopUrl: STOP_URL,
      slack: {
        replyUrl: "http://localhost:9999/api/slack/reply/job-1",
        updateUrl: "http://localhost:9999/api/slack/update/job-1",
      },
    });
    expect(cfg.env?.DANXBOT_SLACK_REPLY_URL).toBe(
      "http://localhost:9999/api/slack/reply/job-1",
    );
    expect(cfg.env?.DANXBOT_SLACK_UPDATE_URL).toBe(
      "http://localhost:9999/api/slack/update/job-1",
    );
    expect(cfg.env?.DANXBOT_ISSUE_CREATE_URL).toBeUndefined();
  });

  it("adds DANXBOT_ISSUE_CREATE_URL when opts.issue is supplied", () => {
    const cfg = build({
      danxbotStopUrl: STOP_URL,
      issue: {
        createUrl: "http://localhost:9999/api/issue-create/job-1",
      },
    });
    expect(cfg.env?.DANXBOT_ISSUE_CREATE_URL).toBe(
      "http://localhost:9999/api/issue-create/job-1",
    );
    expect(cfg.env?.DANXBOT_SLACK_REPLY_URL).toBeUndefined();
    expect(cfg.env?.DANXBOT_SLACK_UPDATE_URL).toBeUndefined();
  });

  it("emits both Slack and Issue URLs when both option groups supplied", () => {
    const cfg = build({
      danxbotStopUrl: STOP_URL,
      slack: {
        replyUrl: "slackReply",
        updateUrl: "slackUpdate",
      },
      issue: {
        createUrl: "issueCreate",
      },
    });
    expect(cfg.env).toMatchObject({
      DANXBOT_STOP_URL: STOP_URL,
      DANXBOT_SLACK_REPLY_URL: "slackReply",
      DANXBOT_SLACK_UPDATE_URL: "slackUpdate",
      DANXBOT_ISSUE_CREATE_URL: "issueCreate",
    });
  });

  it("adds DANXBOT_RESTART_WORKER_URL when opts.restartWorkerUrl is supplied (ISS-72)", () => {
    const cfg = build({
      danxbotStopUrl: STOP_URL,
      restartWorkerUrl: "http://localhost:9999/api/restart/job-1",
    });
    expect(cfg.env?.DANXBOT_RESTART_WORKER_URL).toBe(
      "http://localhost:9999/api/restart/job-1",
    );
    expect(cfg.env?.DANXBOT_SLACK_REPLY_URL).toBeUndefined();
    expect(cfg.env?.DANXBOT_ISSUE_CREATE_URL).toBeUndefined();
  });

  it("omits DANXBOT_RESTART_WORKER_URL when opts.restartWorkerUrl is absent", () => {
    const cfg = build({ danxbotStopUrl: STOP_URL });
    expect(cfg.env?.DANXBOT_RESTART_WORKER_URL).toBeUndefined();
  });

  it("returns the absolute path to the danxbot MCP server script", () => {
    const cfg = build({ danxbotStopUrl: STOP_URL });
    expect(cfg.command).toBe("npx");
    expect(cfg.args).toContain("tsx");
    // The args[1] is the absolute path to src/mcp/danxbot-server.ts.
    const scriptPath = cfg.args?.[1];
    expect(scriptPath).toBeDefined();
    expect(scriptPath).toMatch(/danxbot-server\.ts$/);
  });

  // ============================================================
  // DX-242 — fallback env injection
  // ============================================================

  it("DX-242: emits DANXBOT_DISPATCH_ID + DANX_REPO_ROOT when fallback is supplied without db", () => {
    const cfg = build({
      danxbotStopUrl: STOP_URL,
      fallback: {
        repoRoot: "/repo/danxbot",
        dispatchId: "abc-123",
      },
    });
    expect(cfg.env?.DANXBOT_DISPATCH_ID).toBe("abc-123");
    expect(cfg.env?.DANX_REPO_ROOT).toBe("/repo/danxbot");
    // No DB creds were supplied → none of the DB env vars surface.
    expect(cfg.env?.DANXBOT_DB_HOST).toBeUndefined();
    expect(cfg.env?.DANXBOT_DB_USER).toBeUndefined();
    expect(cfg.env?.DANXBOT_DB_PASSWORD).toBeUndefined();
    expect(cfg.env?.DANXBOT_DB_PORT).toBeUndefined();
    expect(cfg.env?.DANXBOT_DB_NAME).toBeUndefined();
  });

  it("DX-242: emits all DANXBOT_DB_* vars when fallback.db is fully supplied", () => {
    const cfg = build({
      danxbotStopUrl: STOP_URL,
      fallback: {
        repoRoot: "/repo/danxbot",
        dispatchId: "abc-123",
        db: {
          host: "127.0.0.1",
          port: 5433,
          user: "danxbot",
          password: "secret",
          database: "danxbot_chat",
        },
      },
    });
    expect(cfg.env).toMatchObject({
      DANXBOT_DISPATCH_ID: "abc-123",
      DANX_REPO_ROOT: "/repo/danxbot",
      DANXBOT_DB_HOST: "127.0.0.1",
      DANXBOT_DB_PORT: "5433",
      DANXBOT_DB_USER: "danxbot",
      DANXBOT_DB_PASSWORD: "secret",
      DANXBOT_DB_NAME: "danxbot_chat",
    });
  });

  it("DX-242: omits DANXBOT_DB_PORT and DANXBOT_DB_NAME when those optionals are absent", () => {
    const cfg = build({
      danxbotStopUrl: STOP_URL,
      fallback: {
        repoRoot: "/repo/danxbot",
        dispatchId: "abc-123",
        db: {
          host: "127.0.0.1",
          user: "danxbot",
          password: "secret",
        },
      },
    });
    expect(cfg.env?.DANXBOT_DB_HOST).toBe("127.0.0.1");
    expect(cfg.env?.DANXBOT_DB_USER).toBe("danxbot");
    expect(cfg.env?.DANXBOT_DB_PASSWORD).toBe("secret");
    expect(cfg.env?.DANXBOT_DB_PORT).toBeUndefined();
    expect(cfg.env?.DANXBOT_DB_NAME).toBeUndefined();
  });

  it("DX-242: emits no fallback env vars when fallback option is absent", () => {
    const cfg = build({ danxbotStopUrl: STOP_URL });
    expect(cfg.env?.DANXBOT_DISPATCH_ID).toBeUndefined();
    expect(cfg.env?.DANX_REPO_ROOT).toBeUndefined();
    expect(cfg.env?.DANXBOT_DB_HOST).toBeUndefined();
  });
});
