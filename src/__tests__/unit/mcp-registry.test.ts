/**
 * Unit tests for the danxbot infrastructure MCP server registry
 * (`src/agent/mcp-registry.ts`).
 *
 * `defaultMcpRegistry[DANXBOT_SERVER_NAME].build(opts)` is the SOLE seam
 * that turns dispatch-time URL options into the env block of the danxbot
 * MCP subprocess. Phase 3 of tracker-agnostic-agents (Trello wsb4TVNT)
 * extended `McpFactoryOptions` with `issue?: {saveUrl, createUrl}`; this
 * suite pins the env-mapping contract so a regression that drops one URL
 * (or wires it under the wrong name) fails loudly at unit level instead
 * of silently disabling Phase 3 in production.
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
    expect(cfg.env?.DANXBOT_ISSUE_SAVE_URL).toBeUndefined();
    expect(cfg.env?.DANXBOT_ISSUE_CREATE_URL).toBeUndefined();
  });

  it("adds DANXBOT_ISSUE_*_URL when opts.issue is supplied (Phase 3)", () => {
    const cfg = build({
      danxbotStopUrl: STOP_URL,
      issue: {
        saveUrl: "http://localhost:9999/api/issue-save/job-1",
        createUrl: "http://localhost:9999/api/issue-create/job-1",
      },
    });
    expect(cfg.env?.DANXBOT_ISSUE_SAVE_URL).toBe(
      "http://localhost:9999/api/issue-save/job-1",
    );
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
        saveUrl: "issueSave",
        createUrl: "issueCreate",
      },
    });
    expect(cfg.env).toMatchObject({
      DANXBOT_STOP_URL: STOP_URL,
      DANXBOT_SLACK_REPLY_URL: "slackReply",
      DANXBOT_SLACK_UPDATE_URL: "slackUpdate",
      DANXBOT_ISSUE_SAVE_URL: "issueSave",
      DANXBOT_ISSUE_CREATE_URL: "issueCreate",
    });
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
});
