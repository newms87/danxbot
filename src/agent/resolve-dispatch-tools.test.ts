import { describe, it, expect } from "vitest";
import {
  resolveDispatchTools,
  McpResolveError,
  type ResolveDispatchToolsOptions,
} from "./resolve-dispatch-tools.js";
import { defaultMcpRegistry, type McpRegistry } from "./mcp-registry.js";

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
    it("enables the trello server when explicit trello tools are requested", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: [
            "mcp__trello__get_card",
            "mcp__trello__move_card",
          ],
          trello: {
            apiKey: "k",
            apiToken: "t",
            boardId: "b",
          },
        }),
      );
      expect(Object.keys(r.mcpServers).sort()).toEqual(["danxbot", "trello"]);
      expect(r.allowedTools).toContain("mcp__trello__get_card");
      expect(r.allowedTools).toContain("mcp__trello__move_card");
      expect(r.allowedTools).toContain(DANXBOT_TOOL);
      // No extra trello tools leaked in.
      const trelloCount = r.allowedTools.filter((t) =>
        t.startsWith("mcp__trello__"),
      ).length;
      expect(trelloCount).toBe(2);
    });

    it("populates the trello server env from the trello options block", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__trello__get_card"],
          trello: {
            apiKey: "KEY",
            apiToken: "TOK",
            boardId: "BID",
          },
        }),
      );
      const env = r.mcpServers["trello"].env;
      expect(env.TRELLO_API_KEY).toBe("KEY");
      expect(env.TRELLO_TOKEN).toBe("TOK");
      expect(env.TRELLO_BOARD_ID).toBe("BID");
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
    it("mcp__trello__* expands to every tool the server declares; no leakage to other servers", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__trello__*"],
          trello: { apiKey: "k", apiToken: "t", boardId: "b" },
        }),
      );
      expect(r.mcpServers["trello"]).toBeDefined();
      const trelloTools = r.allowedTools.filter((t) =>
        t.startsWith("mcp__trello__"),
      );
      expect(trelloTools.length).toBe(
        defaultMcpRegistry["trello"].tools.length,
      );
      for (const tool of defaultMcpRegistry["trello"].tools) {
        expect(trelloTools).toContain(`mcp__trello__${tool}`);
      }
      // No schema tools should appear.
      expect(
        r.allowedTools.filter((t) => t.startsWith("mcp__schema__")),
      ).toHaveLength(0);
    });

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

    it("throws when mcp__trello__* is requested but trello options are missing", () => {
      expect(() =>
        resolveDispatchTools(
          baseOptions({ allowTools: ["mcp__trello__get_card"] }),
        ),
      ).toThrow(/trello/i);
    });

    it("throws when trello.apiKey is missing; message mentions the missing field", () => {
      expect(() =>
        resolveDispatchTools(
          baseOptions({
            allowTools: ["mcp__trello__get_card"],
            trello: {
              apiToken: "t",
              boardId: "b",
            } as unknown as ResolveDispatchToolsOptions["trello"],
          }),
        ),
      ).toThrow(/apiKey|TRELLO_API_KEY/);
    });

    it("throws when trello.apiToken is missing; message mentions the missing field", () => {
      expect(() =>
        resolveDispatchTools(
          baseOptions({
            allowTools: ["mcp__trello__get_card"],
            trello: {
              apiKey: "k",
              boardId: "b",
            } as unknown as ResolveDispatchToolsOptions["trello"],
          }),
        ),
      ).toThrow(/apiToken|TRELLO_TOKEN/);
    });

    it("throws when trello.boardId is missing; message mentions the missing field", () => {
      expect(() =>
        resolveDispatchTools(
          baseOptions({
            allowTools: ["mcp__trello__get_card"],
            trello: {
              apiKey: "k",
              apiToken: "t",
            } as unknown as ResolveDispatchToolsOptions["trello"],
          }),
        ),
      ).toThrow(/boardId|TRELLO_BOARD_ID/);
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
      const trelloTools = defaultMcpRegistry["trello"].tools;
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__trello__*", "mcp__trello__get_card"],
          trello: { apiKey: "k", apiToken: "t", boardId: "b" },
        }),
      );
      const emitted = r.allowedTools.filter((t) =>
        t.startsWith("mcp__trello__"),
      );
      expect(emitted.length).toBe(trelloTools.length);
      // No duplicates even with the redundant explicit entry.
      expect(new Set(emitted).size).toBe(emitted.length);
    });

    it("resolves multiple servers in one call; all declared servers appear with correct envs", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: [
            "Read",
            "mcp__trello__get_card",
            "mcp__schema__schema_get",
          ],
          trello: { apiKey: "tk", apiToken: "tt", boardId: "tb" },
          schema: {
            apiUrl: "https://api",
            apiToken: "sk",
            definitionId: "42",
          },
        }),
      );
      expect(Object.keys(r.mcpServers).sort()).toEqual([
        "danxbot",
        "schema",
        "trello",
      ]);
      expect(r.mcpServers["trello"].env.TRELLO_BOARD_ID).toBe("tb");
      expect(r.mcpServers["schema"].env.SCHEMA_DEFINITION_ID).toBe("42");
      expect(r.allowedTools).toContain("Read");
      expect(r.allowedTools).toContain("mcp__trello__get_card");
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

  describe("MCP server-side tool gating — TRELLO_ENABLED_TOOLS derived from allow_tools", () => {
    // The resolver is responsible for ensuring the spawned Trello MCP server
    // exposes ONLY the tools the caller actually requested. The server's
    // `TRELLO_ENABLED_TOOLS` env var patches its internal `registerTool` so
    // unlisted tools are never registered — Claude literally cannot see them.
    // This is the enforcement boundary; `--allowed-tools` on claude is
    // defense-in-depth only and is known to be leaky when paired with
    // `--dangerously-skip-permissions` for MCP calls.

    it("names in allow_tools flow through as TRELLO_ENABLED_TOOLS (single tool)", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__trello__get_lists"],
          trello: { apiKey: "k", apiToken: "t", boardId: "b" },
        }),
      );
      expect(r.mcpServers["trello"].env.TRELLO_ENABLED_TOOLS).toBe("get_lists");
    });

    it("multiple tools join as a comma-separated list (caller-declared order)", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__trello__get_lists", "mcp__trello__get_card"],
          trello: { apiKey: "k", apiToken: "t", boardId: "b" },
        }),
      );
      expect(r.mcpServers["trello"].env.TRELLO_ENABLED_TOOLS).toBe(
        "get_lists,get_card",
      );
    });

    it("wildcard (mcp__trello__*) leaves TRELLO_ENABLED_TOOLS absent — all tools exposed", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__trello__*"],
          trello: { apiKey: "k", apiToken: "t", boardId: "b" },
        }),
      );
      expect(r.mcpServers["trello"].env.TRELLO_ENABLED_TOOLS).toBeUndefined();
    });

    it("wildcard wins when mixed with specific tools (no narrower filter than the caller asked for)", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__trello__*", "mcp__trello__get_lists"],
          trello: { apiKey: "k", apiToken: "t", boardId: "b" },
        }),
      );
      expect(r.mcpServers["trello"].env.TRELLO_ENABLED_TOOLS).toBeUndefined();
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
          allowTools: ["mcp__trello__get_card"],
          trello: { apiKey: "k", apiToken: "t", boardId: "b" },
        }),
      );
      for (const [, cfg] of Object.entries(r.mcpServers)) {
        expect(typeof cfg.command).toBe("string");
        expect(Array.isArray(cfg.args)).toBe(true);
        expect(typeof cfg.env).toBe("object");
        expect(cfg.env).not.toBeNull();
      }
    });

    it("trello server uses npx -y to bootstrap lazily", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["mcp__trello__get_card"],
          trello: { apiKey: "k", apiToken: "t", boardId: "b" },
        }),
      );
      const trello = r.mcpServers["trello"];
      expect(trello.command).toBe("npx");
      expect(trello.args[0]).toBe("-y");
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

    it("allowedTools has no duplicates", () => {
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: [
            "Read",
            "Read",
            "mcp__trello__get_card",
            "mcp__trello__get_card",
          ],
          trello: { apiKey: "k", apiToken: "t", boardId: "b" },
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

    it("opts.slack coexists with opts.trello — a Slack dispatch can still use trello tools", () => {
      // Slack dispatches aren't tool-restricted away from trello or any
      // other MCP server; the slack opt-in is additive. This guards
      // against a regression where adding slack opts accidentally prunes
      // or reorders the rest of the tool surface.
      const r = resolveDispatchTools(
        baseOptions({
          allowTools: ["Read", "mcp__trello__get_card"],
          slack: {
            replyUrl: SLACK_REPLY_URL,
            updateUrl: SLACK_UPDATE_URL,
          },
          trello: { apiKey: "k", apiToken: "t", boardId: "b" },
        }),
      );
      expect(r.allowedTools).toContain("Read");
      expect(r.allowedTools).toContain("mcp__trello__get_card");
      expect(r.allowedTools).toContain("mcp__danxbot__danxbot_slack_reply");
      expect(r.allowedTools).toContain(DANXBOT_TOOL);
      expect(Object.keys(r.mcpServers).sort()).toEqual(["danxbot", "trello"]);
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
