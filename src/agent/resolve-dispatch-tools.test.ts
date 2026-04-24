import { describe, it, expect } from "vitest";
import {
  resolveDispatchTools,
  McpResolveError,
  type ResolveDispatchToolsOptions,
} from "./resolve-dispatch-tools.js";
import { defaultMcpRegistry, type McpRegistry } from "./mcp-registry.js";
import { DISPATCH_PROFILES } from "../dispatch/profiles.js";

const DANXBOT_TOOL = "mcp__danxbot__danxbot_complete";
const STOP_URL = "http://localhost:5562/api/stop/job-1";

function baseOptions(
  over: Partial<ResolveDispatchToolsOptions> = {},
): ResolveDispatchToolsOptions {
  return {
    allowTools: [],
    danxbotStopUrl: STOP_URL,
    ...over,
  };
}

describe("resolveDispatchTools", () => {
  describe("infrastructure — danxbot always injected", () => {
    it("returns only the danxbot server and danxbot_complete when allowTools is empty", () => {
      const r = resolveDispatchTools(baseOptions({ allowTools: [] }));
      expect(Object.keys(r.mcpServers)).toEqual(["danxbot"]);
      expect(r.allowedTools).toEqual([DANXBOT_TOOL]);
    });

    it("passes built-in tool names through and keeps danxbot always present", () => {
      const r = resolveDispatchTools(
        baseOptions({ allowTools: ["Read", "Bash"] }),
      );
      expect(Object.keys(r.mcpServers)).toEqual(["danxbot"]);
      expect(r.allowedTools.sort()).toEqual(
        ["Bash", "Read", DANXBOT_TOOL].sort(),
      );
    });

    it("always adds danxbot even when no caller mentions it", () => {
      const r = resolveDispatchTools(
        baseOptions({ allowTools: ["Read", "Glob"] }),
      );
      expect(r.mcpServers["danxbot"]).toBeDefined();
      expect(r.mcpServers["danxbot"].env.DANXBOT_STOP_URL).toBe(STOP_URL);
      expect(r.allowedTools).toContain(DANXBOT_TOOL);
    });

    it("danxbot_complete appears exactly once even when caller also asks for it explicitly", () => {
      const r = resolveDispatchTools(
        baseOptions({ allowTools: [DANXBOT_TOOL] }),
      );
      expect(r.allowedTools.filter((t) => t === DANXBOT_TOOL)).toHaveLength(1);
    });

    it("danxbot_complete appears exactly once when caller passes mcp__danxbot__*", () => {
      const r = resolveDispatchTools(
        baseOptions({ allowTools: ["mcp__danxbot__*"] }),
      );
      expect(r.allowedTools.filter((t) => t === DANXBOT_TOOL)).toHaveLength(1);
    });

    it("danxbotStopUrl: '' (empty string) is rejected at entry", () => {
      expect(() =>
        resolveDispatchTools({
          allowTools: ["Read"],
          danxbotStopUrl: "",
        }),
      ).toThrow(/non-empty/i);
    });

    // The static type is `string`, but the resolver is a boundary — HTTP
    // callers can still pass JSON that resolves to null/undefined at runtime.
    // The runtime guard at the entry keeps the failure shape consistent with
    // the empty-string case above.
    it("danxbotStopUrl: null is rejected at entry even though the type says string", () => {
      expect(() =>
        resolveDispatchTools({
          allowTools: ["Read"],
          danxbotStopUrl: null as unknown as string,
        }),
      ).toThrow(/non-empty/i);
    });

    it("danxbotStopUrl: undefined is rejected at entry even though the type says string", () => {
      expect(() =>
        resolveDispatchTools({
          allowTools: ["Read"],
          danxbotStopUrl: undefined as unknown as string,
        }),
      ).toThrow(/non-empty/i);
    });
  });

  describe("MCP server resolution from allowTools", () => {
    it("rejects mcp__trello__* — the trello server is no longer in the registry (workspace-only since P3)", () => {
      expect(() =>
        resolveDispatchTools(
          baseOptions({ allowTools: ["mcp__trello__get_card"] }),
        ),
      ).toThrow(/unknown MCP server "trello"/);
    });

    it("enables the schema server when mcp__schema__ tools are requested", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__schema__schema_get"],
          schema: {
            apiUrl: "https://api.example.com",
            apiToken: "tok",
            definitionId: "42",
          },
        }),
      );
      expect(Object.keys(r.mcpServers).sort()).toEqual(["danxbot", "schema"]);
      const env = r.mcpServers["schema"].env;
      expect(env.SCHEMA_API_URL).toBe("https://api.example.com");
      expect(env.SCHEMA_API_TOKEN).toBe("tok");
      expect(env.SCHEMA_DEFINITION_ID).toBe("42");
    });

    it("includes schemaRole env when provided", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__schema__schema_get"],
          schema: {
            apiUrl: "https://api",
            apiToken: "t",
            definitionId: "7",
            role: "reviewer",
          },
        }),
      );
      expect(r.mcpServers["schema"].env.SCHEMA_ROLE).toBe("reviewer");
    });

    it("omits SCHEMA_ROLE from env when role is undefined", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__schema__schema_get"],
          schema: {
            apiUrl: "https://api",
            apiToken: "t",
            definitionId: "7",
          },
        }),
      );
      expect(r.mcpServers["schema"].env.SCHEMA_ROLE).toBeUndefined();
    });
  });

  describe("wildcard expansion", () => {
    it("mcp__schema__* expands to every schema tool the registry declares", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__schema__*"],
          schema: {
            apiUrl: "https://api",
            apiToken: "t",
            definitionId: "9",
          },
        }),
      );
      for (const tool of defaultMcpRegistry["schema"].tools) {
        expect(r.allowedTools).toContain(`mcp__schema__${tool}`);
      }
    });
  });

  describe("validation errors", () => {
    it("throws McpResolveError when allowTools references an unregistered server; message contains the server name", () => {
      expect(() =>
        resolveDispatchTools(
          baseOptions({ allowTools: ["mcp__foo__bar"] }),
        ),
      ).toThrow(/foo/);
    });

    it("throws when mcp__schema__* is requested but schema options are missing", () => {
      expect(() =>
        resolveDispatchTools(
          baseOptions({ allowTools: ["mcp__schema__schema_get"] }),
        ),
      ).toThrow(/schema/i);
    });

    it("throws when mcp__schema__* is requested but definitionId is missing; message mentions the missing field", () => {
      expect(() =>
        resolveDispatchTools(
          baseOptions({
            allowTools: ["mcp__schema__schema_get"],
            schema: {
              apiUrl: "https://api",
              apiToken: "t",
              // definitionId intentionally missing
            } as unknown as ResolveDispatchToolsOptions["schema"],
          }),
        ),
      ).toThrow(/definitionId|SCHEMA_DEFINITION_ID/);
    });

    it("throws when schema.apiUrl is missing; message mentions the missing field", () => {
      expect(() =>
        resolveDispatchTools(
          baseOptions({
            allowTools: ["mcp__schema__schema_get"],
            schema: {
              apiToken: "t",
              definitionId: "1",
            } as unknown as ResolveDispatchToolsOptions["schema"],
          }),
        ),
      ).toThrow(/apiUrl|SCHEMA_API_URL/);
    });

    it("throws when schema.apiToken is missing; message mentions the missing field", () => {
      expect(() =>
        resolveDispatchTools(
          baseOptions({
            allowTools: ["mcp__schema__schema_get"],
            schema: {
              apiUrl: "https://api",
              definitionId: "1",
            } as unknown as ResolveDispatchToolsOptions["schema"],
          }),
        ),
      ).toThrow(/apiToken|SCHEMA_API_TOKEN/);
    });

    it("throws when allowTools contains a non-string entry", () => {
      expect(() =>
        resolveDispatchTools(
          baseOptions({
            allowTools: [
              "Read",
              42 as unknown as string,
            ],
          }),
        ),
      ).toThrow(McpResolveError);
    });

    it("throws when an MCP tool name does not match the mcp__<server>__<tool> shape", () => {
      expect(() =>
        resolveDispatchTools(
          baseOptions({ allowTools: ["mcp__trello"] }),
        ),
      ).toThrow(/mcp__/);
    });

    it("throws on empty-string entries — fail loud rather than silently treating as a built-in", () => {
      expect(() =>
        resolveDispatchTools(baseOptions({ allowTools: [""] })),
      ).toThrow(McpResolveError);
    });

    it("throws on whitespace-only entries — fail loud rather than silently treating as a built-in", () => {
      expect(() =>
        resolveDispatchTools(baseOptions({ allowTools: ["   "] })),
      ).toThrow(McpResolveError);
    });
  });

  describe("multi-server composition and overlap", () => {
    it("wildcard plus an explicit tool for the same server produces the server's full tool set with no duplicates and no extras", () => {
      const schemaTools = defaultMcpRegistry["schema"].tools;
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__schema__*", "mcp__schema__schema_get"],
          schema: { apiUrl: "https://api", apiToken: "t", definitionId: "1" },
        }),
      );
      const emitted = r.allowedTools.filter((t) =>
        t.startsWith("mcp__schema__"),
      );
      expect(emitted.length).toBe(schemaTools.length);
      // No duplicates even with the redundant explicit entry.
      expect(new Set(emitted).size).toBe(emitted.length);
    });

    it("resolves multiple servers in one call; all declared servers appear with correct envs", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["Read", "mcp__schema__schema_get"],
          schema: {
            apiUrl: "https://api",
            apiToken: "sk",
            definitionId: "42",
          },
        }),
      );
      expect(Object.keys(r.mcpServers).sort()).toEqual(["danxbot", "schema"]);
      expect(r.mcpServers["schema"].env.SCHEMA_DEFINITION_ID).toBe("42");
      expect(r.allowedTools).toContain("Read");
      expect(r.allowedTools).toContain("mcp__schema__schema_get");
      expect(r.allowedTools).toContain(DANXBOT_TOOL);
    });
  });

  describe("danxbot infrastructure contract", () => {
    it("a registered tool name unknown to danxbot's declared tool list still passes through (claude is the runtime gate for explicit names)", () => {
      const r = resolveDispatchTools(
        baseOptions({ allowTools: ["mcp__danxbot__nonexistent"] }),
      );
      expect(r.allowedTools).toContain("mcp__danxbot__nonexistent");
      // And the infra tool is still present.
      expect(r.allowedTools).toContain(DANXBOT_TOOL);
    });

    it("a caller-supplied registry that overrides the danxbot entry wins — the resolver does not force the production factory on top", () => {
      const customRegistry: McpRegistry = {
        ...defaultMcpRegistry,
        danxbot: {
          tools: ["danxbot_complete"],
          build: () => ({
            command: "custom",
            args: ["danxbot"],
            env: { CUSTOM: "1" },
          }),
        },
      };
      const r = resolveDispatchTools(
        baseOptions({ registry: customRegistry }),
      );
      expect(r.mcpServers["danxbot"]).toEqual({
        command: "custom",
        args: ["danxbot"],
        env: { CUSTOM: "1" },
      });
    });
  });

  describe("registry extensibility", () => {
    it("accepts a custom registry; adding a test-only server exercises the registry without touching production factories", () => {
      const testRegistry: McpRegistry = {
        ...defaultMcpRegistry,
        fakeserver: {
          tools: ["hello", "world"],
          build: () => ({
            command: "echo",
            args: ["fake"],
            env: { FAKE: "1" },
          }),
        },
      };
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__fakeserver__hello"],
          registry: testRegistry,
        }),
      );
      expect(r.mcpServers["fakeserver"]).toEqual({
        command: "echo",
        args: ["fake"],
        env: { FAKE: "1" },
      });
      expect(r.allowedTools).toContain("mcp__fakeserver__hello");
    });

    it("wildcard on a custom registry server expands to that server's declared tools", () => {
      const testRegistry: McpRegistry = {
        ...defaultMcpRegistry,
        fake: {
          tools: ["a", "b", "c"],
          build: () => ({ command: "x", args: [], env: {} }),
        },
      };
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__fake__*"],
          registry: testRegistry,
        }),
      );
      expect(
        r.allowedTools.filter((t) => t.startsWith("mcp__fake__")).sort(),
      ).toEqual(["mcp__fake__a", "mcp__fake__b", "mcp__fake__c"]);
    });

    it("custom registry with build() that throws surfaces the server name and the build error", () => {
      const testRegistry: McpRegistry = {
        ...defaultMcpRegistry,
        broken: {
          tools: ["t"],
          build: () => {
            throw new Error("deliberately bad");
          },
        },
      };
      expect(() =>
        resolveDispatchTools(
          baseOptions({
            allowTools: ["mcp__broken__t"],
            registry: testRegistry,
          }),
        ),
      ).toThrow(/broken|deliberately bad/);
    });
  });

  describe("mcpServers config shape", () => {
    it("each mcpServers entry has command, args array, and env object — matching McpSettingsFile shape", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__schema__schema_get"],
          schema: { apiUrl: "https://api", apiToken: "t", definitionId: "1" },
        }),
      );
      for (const [, cfg] of Object.entries(r.mcpServers)) {
        expect(typeof cfg.command).toBe("string");
        expect(Array.isArray(cfg.args)).toBe(true);
        expect(typeof cfg.env).toBe("object");
        expect(cfg.env).not.toBeNull();
      }
    });

    it("schema server uses npx -y to bootstrap lazily", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__schema__schema_get"],
          schema: {
            apiUrl: "https://api",
            apiToken: "t",
            definitionId: "1",
          },
        }),
      );
      const schema = r.mcpServers["schema"];
      expect(schema.command).toBe("npx");
      expect(schema.args[0]).toBe("-y");
    });

    it("playwright server is reachable via mcp__playwright__*; spawns tsx against the in-tree script with PLAYWRIGHT_URL env set", () => {
      // The wiring test for Card 2 (Internal Playwright MCP server):
      // requesting `mcp__playwright__*` must produce an mcpServers.playwright
      // entry that invokes the in-tree Playwright server via `npx tsx <path>`
      // (mirrors danxbot-server.ts's spawn shape — not `npx -y <package>`
      // until the package is published to npm). PLAYWRIGHT_URL must be
      // injected; absent explicit env, the factory defaults to the
      // danxbot-net container hostname so worker-local dispatches Just
      // Work.
      const r = resolveDispatchTools(
        baseOptions({ allowTools: ["mcp__playwright__*"] }),
      );
      const playwright = r.mcpServers["playwright"];
      expect(playwright).toBeDefined();
      expect(playwright.command).toBe("npx");
      expect(playwright.args[0]).toBe("tsx");
      // The second arg is the absolute path to the in-tree server entry.
      expect(playwright.args[1]).toMatch(
        /mcp-servers\/playwright\/src\/index\.ts$/,
      );
      expect(playwright.env.PLAYWRIGHT_URL).toBeTruthy();
    });

    it("playwright wildcard expands to both declared tools (screenshot + html)", () => {
      const r = resolveDispatchTools(
        baseOptions({ allowTools: ["mcp__playwright__*"] }),
      );
      // The resolver expands the wildcard using the registry's declared
      // tool list — kept in sync with the MCP server's TOOLS array.
      expect(r.allowedTools).toContain("mcp__playwright__playwright_screenshot");
      expect(r.allowedTools).toContain("mcp__playwright__playwright_html");
    });

    it("playwright PLAYWRIGHT_URL honors process.env override when set", () => {
      const original = process.env.PLAYWRIGHT_URL;
      process.env.PLAYWRIGHT_URL = "http://override.playwright:9999";
      try {
        const r = resolveDispatchTools(
          baseOptions({ allowTools: ["mcp__playwright__*"] }),
        );
        expect(r.mcpServers["playwright"].env.PLAYWRIGHT_URL).toBe(
          "http://override.playwright:9999",
        );
      } finally {
        if (original === undefined) delete process.env.PLAYWRIGHT_URL;
        else process.env.PLAYWRIGHT_URL = original;
      }
    });

    it("playwright PLAYWRIGHT_TIMEOUT_MS is forwarded only when an operator sets it (keeps default in one place)", () => {
      const originalUrl = process.env.PLAYWRIGHT_URL;
      const originalTimeout = process.env.PLAYWRIGHT_TIMEOUT_MS;
      delete process.env.PLAYWRIGHT_TIMEOUT_MS;
      process.env.PLAYWRIGHT_URL = "http://test:3000";
      try {
        const r = resolveDispatchTools(
          baseOptions({ allowTools: ["mcp__playwright__*"] }),
        );
        expect(r.mcpServers["playwright"].env.PLAYWRIGHT_TIMEOUT_MS).toBeUndefined();

        process.env.PLAYWRIGHT_TIMEOUT_MS = "5000";
        const r2 = resolveDispatchTools(
          baseOptions({ allowTools: ["mcp__playwright__*"] }),
        );
        expect(r2.mcpServers["playwright"].env.PLAYWRIGHT_TIMEOUT_MS).toBe(
          "5000",
        );
      } finally {
        if (originalUrl === undefined) delete process.env.PLAYWRIGHT_URL;
        else process.env.PLAYWRIGHT_URL = originalUrl;
        if (originalTimeout === undefined)
          delete process.env.PLAYWRIGHT_TIMEOUT_MS;
        else process.env.PLAYWRIGHT_TIMEOUT_MS = originalTimeout;
      }
    });

    it("playwright is NOT baked into any dispatch profile baseline — callers opt in explicitly", () => {
      // This test is the counter-balance to the plan's original assumption
      // that Playwright should ride along on every dispatch. MCP servers
      // spawn subprocesses at session init, so baking the Playwright
      // wildcard into POLLER or HTTP_LAUNCH baselines would spin up the
      // server on every dispatch regardless of whether the agent calls
      // it. Callers that need Playwright pass `mcp__playwright__*` in
      // `body.allow_tools` (http-launch) or add it to their skill
      // prompt (poller). A regression here would spawn hundreds of
      // unused Playwright subprocesses in production.
      //
      // Relies on DISPATCH_PROFILES imported at the top of this file.
      expect(DISPATCH_PROFILES.poller.allowTools).not.toContain(
        "mcp__playwright__*",
      );
      expect(DISPATCH_PROFILES["http-launch"].allowTools).not.toContain(
        "mcp__playwright__*",
      );
      expect(DISPATCH_PROFILES.slack.allowTools).not.toContain(
        "mcp__playwright__*",
      );
    });

    it("allowedTools has no duplicates", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: [
            "Read",
            "Read",
            "mcp__schema__schema_get",
            "mcp__schema__schema_get",
          ],
          schema: { apiUrl: "https://api", apiToken: "t", definitionId: "1" },
        }),
      );
      const seen = new Set<string>();
      for (const t of r.allowedTools) {
        expect(seen.has(t)).toBe(false);
        seen.add(t);
      }
    });
  });

  describe("slack URL injection (Phase 1 of the Slack unified dispatch epic)", () => {
    // The Slack-specific MCP tools (`danxbot_slack_reply`,
    // `danxbot_slack_post_update`) live on the danxbot MCP server but are
    // ONLY active when a Slack dispatch injects their callback URLs.
    // Non-Slack dispatches produce no Slack env vars and no Slack tools
    // in `allowedTools` — the agent doesn't even know the tools exist.
    //
    // This is the enforcement boundary for "don't let a Trello agent
    // accidentally post to Slack." Belt (callTool throws if URL missing)
    // and suspenders (resolver doesn't even advertise the tools).
    const SLACK_REPLY_URL = "http://localhost:5562/api/slack/reply/job-1";
    const SLACK_UPDATE_URL = "http://localhost:5562/api/slack/update/job-1";

    it("injects DANXBOT_SLACK_REPLY_URL and DANXBOT_SLACK_UPDATE_URL into the danxbot server env when opts.slack is present", () => {
      const r = resolveDispatchTools(
        baseOptions({
          slack: {
            replyUrl: SLACK_REPLY_URL,
            updateUrl: SLACK_UPDATE_URL,
          },
        }),
      );
      const env = r.mcpServers["danxbot"].env;
      expect(env.DANXBOT_STOP_URL).toBe(STOP_URL);
      expect(env.DANXBOT_SLACK_REPLY_URL).toBe(SLACK_REPLY_URL);
      expect(env.DANXBOT_SLACK_UPDATE_URL).toBe(SLACK_UPDATE_URL);
    });

    it("adds mcp__danxbot__danxbot_slack_reply and mcp__danxbot__danxbot_slack_post_update to allowedTools when opts.slack is present", () => {
      const r = resolveDispatchTools(
        baseOptions({
          slack: {
            replyUrl: SLACK_REPLY_URL,
            updateUrl: SLACK_UPDATE_URL,
          },
        }),
      );
      expect(r.allowedTools).toContain("mcp__danxbot__danxbot_slack_reply");
      expect(r.allowedTools).toContain(
        "mcp__danxbot__danxbot_slack_post_update",
      );
    });

    it("does NOT set DANXBOT_SLACK_* env vars when opts.slack is absent (non-Slack dispatch)", () => {
      const r = resolveDispatchTools(baseOptions());
      const env = r.mcpServers["danxbot"].env;
      expect(env.DANXBOT_SLACK_REPLY_URL).toBeUndefined();
      expect(env.DANXBOT_SLACK_UPDATE_URL).toBeUndefined();
    });

    it("does NOT add Slack tools to allowedTools when opts.slack is absent", () => {
      const r = resolveDispatchTools(baseOptions());
      expect(r.allowedTools).not.toContain(
        "mcp__danxbot__danxbot_slack_reply",
      );
      expect(r.allowedTools).not.toContain(
        "mcp__danxbot__danxbot_slack_post_update",
      );
    });

    it("opts.slack is additive — coexists with other MCP servers (e.g. schema)", () => {
      // Slack dispatches aren't tool-restricted away from any other MCP
      // server; the slack opt-in is additive. This guards against a
      // regression where adding slack opts accidentally prunes or
      // reorders the rest of the tool surface.
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["Read", "mcp__schema__schema_get"],
          slack: {
            replyUrl: SLACK_REPLY_URL,
            updateUrl: SLACK_UPDATE_URL,
          },
          schema: { apiUrl: "https://api", apiToken: "t", definitionId: "1" },
        }),
      );
      expect(r.allowedTools).toContain("Read");
      expect(r.allowedTools).toContain("mcp__schema__schema_get");
      expect(r.allowedTools).toContain("mcp__danxbot__danxbot_slack_reply");
      expect(r.allowedTools).toContain(DANXBOT_TOOL);
      expect(Object.keys(r.mcpServers).sort()).toEqual(["danxbot", "schema"]);
    });

    it("slack tools each appear exactly once in allowedTools (no duplication)", () => {
      const r = resolveDispatchTools(
        baseOptions({
          slack: {
            replyUrl: SLACK_REPLY_URL,
            updateUrl: SLACK_UPDATE_URL,
          },
        }),
      );
      const replyCount = r.allowedTools.filter(
        (t) => t === "mcp__danxbot__danxbot_slack_reply",
      ).length;
      const updateCount = r.allowedTools.filter(
        (t) => t === "mcp__danxbot__danxbot_slack_post_update",
      ).length;
      expect(replyCount).toBe(1);
      expect(updateCount).toBe(1);
    });

    it("rejects opts.slack missing replyUrl — both slack URLs are required together", () => {
      expect(() =>
        resolveDispatchTools(
          baseOptions({
            slack: {
              updateUrl: SLACK_UPDATE_URL,
            } as unknown as ResolveDispatchToolsOptions["slack"],
          }),
        ),
      ).toThrow(/replyUrl|slack/i);
    });

    it("rejects opts.slack missing updateUrl", () => {
      expect(() =>
        resolveDispatchTools(
          baseOptions({
            slack: {
              replyUrl: SLACK_REPLY_URL,
            } as unknown as ResolveDispatchToolsOptions["slack"],
          }),
        ),
      ).toThrow(/updateUrl|slack/i);
    });

    it("rejects opts.slack.replyUrl = '' (empty string, parity with danxbotStopUrl: '' guard)", () => {
      // Mirrors the existing `danxbotStopUrl: ''` regression-lock at
      // line ~82: without the explicit `=== ""` guard someone could
      // delete the empty-string check and the suite would stay green
      // even though an empty env var is a realistic failure mode.
      expect(() =>
        resolveDispatchTools(
          baseOptions({
            slack: {
              replyUrl: "",
              updateUrl: SLACK_UPDATE_URL,
            },
          }),
        ),
      ).toThrow(/replyUrl|non-empty|slack/i);
    });

    it("rejects opts.slack.updateUrl = '' (empty string)", () => {
      expect(() =>
        resolveDispatchTools(
          baseOptions({
            slack: {
              replyUrl: SLACK_REPLY_URL,
              updateUrl: "",
            },
          }),
        ),
      ).toThrow(/updateUrl|non-empty|slack/i);
    });
  });
});
