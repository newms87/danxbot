import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  COMPLETE_STATUSES,
  TOOLS,
  callTool,
  isCompleteStatus,
} from "./danxbot-server.js";

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
    // If the `import.meta.url === entryUrl` gate at the bottom of
    // danxbot-server.ts was broken, importing this module with
    // DANXBOT_STOP_URL unset would have hit `process.exit(1)` before
    // this test could run. The fact that `callTool` is imported as a
    // live function means module initialization completed cleanly
    // without entering the bootstrap branch.
    expect(typeof callTool).toBe("function");
    expect(TOOLS.length).toBeGreaterThan(0);
  });
});

describe("callTool", () => {
  const STOP_URL = "http://localhost:5562/api/stop/job-xyz";
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
      callTool("not_a_real_tool", { status: "completed", summary: "x" }, STOP_URL),
    ).rejects.toThrow(/Unknown tool/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when args is not an object", async () => {
    await expect(callTool("danxbot_complete", null, STOP_URL)).rejects.toThrow(
      /expected an object/,
    );
    await expect(
      callTool("danxbot_complete", "not an object", STOP_URL),
    ).rejects.toThrow(/expected an object/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws when status is invalid — before POSTing", async () => {
    await expect(
      callTool(
        "danxbot_complete",
        { status: "bogus", summary: "x" },
        STOP_URL,
      ),
    ).rejects.toThrow(/Invalid status "bogus"/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts critical_failure and POSTs the body to the stop URL", async () => {
    const result = await callTool(
      "danxbot_complete",
      { status: "critical_failure", summary: "MCP Trello tools failed" },
      STOP_URL,
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
        STOP_URL,
      ),
    ).rejects.toThrow(/HTTP 502/);
  });

  it("defaults summary to empty string when caller omits it (status already validated)", async () => {
    await callTool(
      "danxbot_complete",
      { status: "completed" },
      STOP_URL,
    );
    const body = JSON.parse(
      fetchMock.mock.calls[0][1].body as string,
    );
    expect(body.summary).toBe("");
  });
});
