import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  COMPLETE_STATUSES,
  TOOLS,
  buildActiveTools,
  callTool,
  isCompleteStatus,
} from "./danxbot-server.js";
import type { DanxbotToolUrls } from "./danxbot-server.js";

const STOP_URL = "http://localhost:5562/api/stop/job-xyz";
const SLACK_REPLY_URL = "http://localhost:5562/api/slack/reply/job-xyz";
const SLACK_UPDATE_URL = "http://localhost:5562/api/slack/update/job-xyz";
const RESTART_URL = "http://localhost:5562/api/restart/job-xyz";

function urls(over: Partial<DanxbotToolUrls> = {}): DanxbotToolUrls {
  return {
    stop: STOP_URL,
    ...over,
  };
}

describe("danxbot_complete tool schema", () => {
  const tool = TOOLS.find((t) => t.name === "danxbot_complete");

  it("is registered in TOOLS", () => {
    expect(tool).toBeDefined();
  });

  it("exposes completed, failed, and critical_failure in the status enum", () => {
    const statusProp = (tool!.inputSchema as unknown as {
      properties: { status: { enum: string[] } };
    }).properties.status;
    expect(statusProp.enum).toEqual([
      "completed",
      "failed",
      "critical_failure",
    ]);
  });

  it("description tells agents when to use critical_failure (env-level only)", () => {
    expect(tool!.description).toMatch(/critical_failure/);
    expect(tool!.description).toMatch(/environment|env/i);
  });

  it("description steers card-specific failures to Needs Help via status=failed", () => {
    expect(tool!.description).toMatch(/Needs Help/);
  });
});

describe("danxbot_slack_reply tool schema", () => {
  const tool = TOOLS.find((t) => t.name === "danxbot_slack_reply");

  it("is registered in TOOLS", () => {
    expect(tool).toBeDefined();
  });

  it("requires a non-empty string text field", () => {
    const schema = tool!.inputSchema as unknown as {
      properties: { text: { type: string } };
      required: string[];
    };
    expect(schema.properties.text.type).toBe("string");
    expect(schema.required).toContain("text");
  });

  it("description tells the agent to call it once as the final reply", () => {
    // The agent must understand: this tool posts the FINAL user-facing reply
    // to the Slack thread. The failure mode we're hedging against is an
    // agent that posts intermediate updates via this tool (noise in-thread)
    // or never calls it (user sees silence).
    expect(tool!.description).toMatch(/final|answer|reply/i);
    expect(tool!.description).toMatch(/slack|thread/i);
  });
});

describe("danxbot_slack_post_update tool schema", () => {
  const tool = TOOLS.find((t) => t.name === "danxbot_slack_post_update");

  it("is registered in TOOLS", () => {
    expect(tool).toBeDefined();
  });

  it("requires a non-empty string text field", () => {
    const schema = tool!.inputSchema as unknown as {
      properties: { text: { type: string } };
      required: string[];
    };
    expect(schema.properties.text.type).toBe("string");
    expect(schema.required).toContain("text");
  });

  it("description tells the agent to use it sparingly for meaningful progress", () => {
    // Hedges against the agent spamming the thread with every file read.
    expect(tool!.description).toMatch(/progress|update|status/i);
  });
});

describe("isCompleteStatus", () => {
  it("returns true for each accepted value", () => {
    for (const s of COMPLETE_STATUSES) {
      expect(isCompleteStatus(s)).toBe(true);
    }
  });

  it("rejects other strings", () => {
    expect(isCompleteStatus("bogus")).toBe(false);
    expect(isCompleteStatus("")).toBe(false);
    expect(isCompleteStatus("COMPLETED")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isCompleteStatus(undefined)).toBe(false);
    expect(isCompleteStatus(null)).toBe(false);
    expect(isCompleteStatus(123)).toBe(false);
    expect(isCompleteStatus({})).toBe(false);
  });
});

describe("entrypoint gating", () => {
  it("does NOT call main()/process.exit when imported from a test (regression lock)", () => {
    expect(typeof callTool).toBe("function");
    expect(TOOLS.length).toBeGreaterThan(0);
  });
});

describe("callTool — danxbot_complete", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws on an unknown tool name", async () => {
    await expect(
      callTool("not_a_real_tool", { status: "completed", summary: "x" }, urls()),
    ).rejects.toThrow(/Unknown tool/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when args is not an object", async () => {
    await expect(callTool("danxbot_complete", null, urls())).rejects.toThrow(
      /expected an object/,
    );
    await expect(
      callTool("danxbot_complete", "not an object", urls()),
    ).rejects.toThrow(/expected an object/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when status is invalid — before POSTing", async () => {
    await expect(
      callTool(
        "danxbot_complete",
        { status: "bogus", summary: "x" },
        urls(),
      ),
    ).rejects.toThrow(/Invalid status "bogus"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts critical_failure and POSTs the body to the stop URL", async () => {
    const result = await callTool(
      "danxbot_complete",
      { status: "critical_failure", summary: "MCP Trello tools failed" },
      urls(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(STOP_URL);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      status: "critical_failure",
      summary: "MCP Trello tools failed",
    });
    expect(result).toMatch(/Agent signaled critical_failure/);
  });

  it("surfaces non-2xx responses from the stop URL", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 }));
    await expect(
      callTool(
        "danxbot_complete",
        { status: "failed", summary: "x" },
        urls(),
      ),
    ).rejects.toThrow(/HTTP 502/);
  });

  it("defaults summary to empty string when caller omits it (status already validated)", async () => {
    await callTool(
      "danxbot_complete",
      { status: "completed" },
      urls(),
    );
    const body = JSON.parse(
      fetchMock.mock.calls[0][1].body as string,
    );
    expect(body.summary).toBe("");
  });
});

describe("callTool — danxbot_slack_reply", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the text body to the slack reply URL when present", async () => {
    const result = await callTool(
      "danxbot_slack_reply",
      { text: "Here's the answer: 42." },
      urls({ slackReply: SLACK_REPLY_URL }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SLACK_REPLY_URL);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toEqual({
      "Content-Type": "application/json",
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      text: "Here's the answer: 42.",
    });
    // The tool returns a short confirmation so the agent sees the call succeeded.
    expect(result).toMatch(/reply|posted/i);
  });

  it("throws when slackReply URL is absent — fail loud, no silent no-op", async () => {
    // Non-Slack dispatches don't inject DANXBOT_SLACK_REPLY_URL, so the
    // env var is undefined and the URL bag's slackReply is undefined.
    // Calling the tool anyway must throw — silent no-ops hide the bug that
    // a non-Slack agent is trying to post to Slack.
    await expect(
      callTool(
        "danxbot_slack_reply",
        { text: "whatever" },
        urls(), // No slackReply set
      ),
    ).rejects.toThrow(/slack.*reply|not configured|outside/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when text is missing", async () => {
    await expect(
      callTool(
        "danxbot_slack_reply",
        {},
        urls({ slackReply: SLACK_REPLY_URL }),
      ),
    ).rejects.toThrow(/text/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when text is not a string", async () => {
    await expect(
      callTool(
        "danxbot_slack_reply",
        { text: 42 },
        urls({ slackReply: SLACK_REPLY_URL }),
      ),
    ).rejects.toThrow(/text/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when args is not an object", async () => {
    await expect(
      callTool(
        "danxbot_slack_reply",
        null,
        urls({ slackReply: SLACK_REPLY_URL }),
      ),
    ).rejects.toThrow(/expected an object/);
  });

  it("surfaces non-2xx responses from the reply URL", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(
      callTool(
        "danxbot_slack_reply",
        { text: "x" },
        urls({ slackReply: SLACK_REPLY_URL }),
      ),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("callTool — danxbot_slack_post_update", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the text body to the slack update URL when present", async () => {
    const result = await callTool(
      "danxbot_slack_post_update",
      { text: "Reading the campaign schema now..." },
      urls({ slackUpdate: SLACK_UPDATE_URL }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SLACK_UPDATE_URL);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      text: "Reading the campaign schema now...",
    });
    expect(result).toMatch(/update|posted/i);
  });

  it("throws when slackUpdate URL is absent — fail loud", async () => {
    await expect(
      callTool(
        "danxbot_slack_post_update",
        { text: "whatever" },
        urls(),
      ),
    ).rejects.toThrow(/slack.*update|not configured|outside/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when text is missing", async () => {
    await expect(
      callTool(
        "danxbot_slack_post_update",
        {},
        urls({ slackUpdate: SLACK_UPDATE_URL }),
      ),
    ).rejects.toThrow(/text/i);
  });

  it("surfaces non-2xx responses from the update URL", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(
      callTool(
        "danxbot_slack_post_update",
        { text: "x" },
        urls({ slackUpdate: SLACK_UPDATE_URL }),
      ),
    ).rejects.toThrow(/HTTP 503/);
  });
});

describe("danxbot_restart_worker tool schema", () => {
  const tool = TOOLS.find((t) => t.name === "danxbot_restart_worker");

  it("is registered in TOOLS", () => {
    expect(tool).toBeDefined();
  });

  it("requires repo and reason; drain_in_flight + timeout_ms optional", () => {
    const schema = tool!.inputSchema as unknown as {
      properties: Record<string, { type: string }>;
      required: string[];
    };
    expect(schema.properties.repo.type).toBe("string");
    expect(schema.properties.reason.type).toBe("string");
    expect(schema.properties.drain_in_flight.type).toBe("boolean");
    expect(schema.properties.timeout_ms.type).toBe("number");
    expect(schema.required.sort()).toEqual(["reason", "repo"]);
  });
});

describe("callTool — danxbot_restart_worker", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          started: true,
          oldPid: 123,
          restartId: 7,
          outcome: "started",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs camelCase body to the restart URL on happy path and returns response verbatim", async () => {
    const result = await callTool(
      "danxbot_restart_worker",
      {
        repo: "danxbot",
        reason: "poller stuck mid-tick",
        drain_in_flight: true,
        timeout_ms: 30000,
      },
      urls({ restartWorker: RESTART_URL }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(RESTART_URL);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toEqual({
      "Content-Type": "application/json",
    });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      repo: "danxbot",
      reason: "poller stuck mid-tick",
      drainInFlight: true,
      timeoutMs: 30000,
    });
    expect(JSON.parse(result)).toEqual({
      started: true,
      oldPid: 123,
      restartId: 7,
      outcome: "started",
    });
  });

  it("omits optional fields when caller doesn't supply them — worker defaults apply", async () => {
    await callTool(
      "danxbot_restart_worker",
      { repo: "danxbot", reason: "fresh process needed" },
      urls({ restartWorker: RESTART_URL }),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({ repo: "danxbot", reason: "fresh process needed" });
    expect(body).not.toHaveProperty("drainInFlight");
    expect(body).not.toHaveProperty("timeoutMs");
  });

  it("throws when restartWorker URL is absent — fail loud, no silent no-op", async () => {
    await expect(
      callTool(
        "danxbot_restart_worker",
        { repo: "danxbot", reason: "x" },
        urls(),
      ),
    ).rejects.toThrow(/DANXBOT_RESTART_WORKER_URL|not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when repo is missing", async () => {
    await expect(
      callTool(
        "danxbot_restart_worker",
        { reason: "x" },
        urls({ restartWorker: RESTART_URL }),
      ),
    ).rejects.toThrow(/repo/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when reason is missing or blank", async () => {
    await expect(
      callTool(
        "danxbot_restart_worker",
        { repo: "danxbot" },
        urls({ restartWorker: RESTART_URL }),
      ),
    ).rejects.toThrow(/reason/);
    await expect(
      callTool(
        "danxbot_restart_worker",
        { repo: "danxbot", reason: "   " },
        urls({ restartWorker: RESTART_URL }),
      ),
    ).rejects.toThrow(/reason/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces non-2xx responses from the restart URL", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("worker error", { status: 500 }),
    );
    await expect(
      callTool(
        "danxbot_restart_worker",
        { repo: "danxbot", reason: "x" },
        urls({ restartWorker: RESTART_URL }),
      ),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("buildActiveTools — advertise-filter", () => {
  // The advertise-filter is the SOLE enforcement seam for Slack-tool
  // exposure (the CLI-side `--allowed-tools` belt was retired entirely
  // — see `src/workspace/resolve.ts` header). A non-Slack MCP process
  // must never advertise the Slack tools in tools/list. A drift here
  // gives a non-Slack agent a callable Slack tool and `callTool` becomes
  // the safety net.
  it("advertises only danxbot_complete when no slack URLs are configured", () => {
    const tools = buildActiveTools({ stop: STOP_URL });
    expect(tools.map((t) => t.name)).toEqual(["danxbot_complete"]);
  });

  it("advertises danxbot_restart_worker iff restartWorker URL is set", () => {
    expect(
      buildActiveTools({ stop: STOP_URL }).map((t) => t.name),
    ).not.toContain("danxbot_restart_worker");
    expect(
      buildActiveTools({ stop: STOP_URL, restartWorker: RESTART_URL }).map(
        (t) => t.name,
      ),
    ).toContain("danxbot_restart_worker");
    // Empty string env-var failure mode — same `!!` guard as the slack pair.
    expect(
      buildActiveTools({ stop: STOP_URL, restartWorker: "" }).map(
        (t) => t.name,
      ),
    ).not.toContain("danxbot_restart_worker");
  });

  it("advertises danxbot_slack_reply alongside danxbot_complete when slackReply is set (but not slackUpdate)", () => {
    const tools = buildActiveTools({
      stop: STOP_URL,
      slackReply: SLACK_REPLY_URL,
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("danxbot_complete");
    expect(names).toContain("danxbot_slack_reply");
    expect(names).not.toContain("danxbot_slack_post_update");
  });

  it("advertises both Slack tools alongside danxbot_complete when both URLs are set", () => {
    const tools = buildActiveTools({
      stop: STOP_URL,
      slackReply: SLACK_REPLY_URL,
      slackUpdate: SLACK_UPDATE_URL,
    });
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "danxbot_complete",
        "danxbot_slack_post_update",
        "danxbot_slack_reply",
      ].sort(),
    );
  });

  it("never advertises a tool whose URL env is an empty string (guards against env-vs-unset drift)", () => {
    // Empty-string env vars are a realistic failure mode when the
    // parent process exports `DANXBOT_SLACK_REPLY_URL=` (no value).
    // The filter's `!!` check rejects empty strings the same as
    // undefined — this test pins that invariant.
    const tools = buildActiveTools({
      stop: STOP_URL,
      slackReply: "",
      slackUpdate: "",
    });
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["danxbot_complete"]);
  });
});

describe("tool isolation", () => {
  // A Slack-URL bag MUST NOT let an agent call danxbot_slack_reply by pointing
  // at the stop URL. Each tool resolves ONLY its own URL slot — no fallback
  // from stop to slackReply or vice versa. Silent fallbacks between URL slots
  // would make the system appear to work while routing messages to the wrong
  // endpoint (e.g. posting a "completion" to the Slack thread).
  it("danxbot_slack_reply does NOT fall back to the stop URL when slackReply is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        callTool("danxbot_slack_reply", { text: "x" }, { stop: STOP_URL }),
      ).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalledWith(STOP_URL, expect.anything());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
