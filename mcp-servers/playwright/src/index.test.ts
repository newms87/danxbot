import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TOOLS,
  callTool,
  PLAYWRIGHT_DEFAULT_TIMEOUT_MS,
} from "./index.js";
import type { PlaywrightDeps } from "./index.js";

const PLAYWRIGHT_URL = "http://playwright.test:3000";

function deps(over: Partial<PlaywrightDeps> = {}): PlaywrightDeps {
  return {
    url: PLAYWRIGHT_URL,
    timeoutMs: PLAYWRIGHT_DEFAULT_TIMEOUT_MS,
    ...over,
  };
}

// ── Tool schema ─────────────────────────────────────────────────────────

describe("TOOLS — tool schema", () => {
  it("registers exactly playwright_screenshot and playwright_html", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "playwright_html",
      "playwright_screenshot",
    ]);
  });

  it("playwright_screenshot requires a url string", () => {
    const tool = TOOLS.find((t) => t.name === "playwright_screenshot")!;
    const schema = tool.inputSchema as unknown as {
      properties: { url: { type: string } };
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.properties.url.type).toBe("string");
    expect(schema.required).toEqual(["url"]);
    // Forward-options semantics — do not lock the schema down here.
    expect(schema.additionalProperties).toBe(true);
  });

  it("playwright_html requires a url string", () => {
    const tool = TOOLS.find((t) => t.name === "playwright_html")!;
    const schema = tool.inputSchema as unknown as {
      properties: { url: { type: string } };
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.properties.url.type).toBe("string");
    expect(schema.required).toEqual(["url"]);
    expect(schema.additionalProperties).toBe(true);
  });

  it("playwright_screenshot description tells the agent it returns an inline image", () => {
    const tool = TOOLS.find((t) => t.name === "playwright_screenshot")!;
    expect(tool.description).toMatch(/image/i);
    expect(tool.description).toMatch(/PNG|screenshot/i);
  });

  it("playwright_html description tells the agent it returns rendered HTML text", () => {
    const tool = TOOLS.find((t) => t.name === "playwright_html")!;
    expect(tool.description).toMatch(/HTML/);
    expect(tool.description).toMatch(/text/i);
  });
});

// ── Entrypoint gating ───────────────────────────────────────────────────

describe("entrypoint gating", () => {
  it("does NOT call main()/process.exit when imported from a test (regression lock)", () => {
    // Importing the module in this file has already happened above. If
    // the entrypoint gate were broken, the test process would have
    // already exited with code 1 (no PLAYWRIGHT_URL), and this
    // assertion would never run. The existence of a running test body
    // IS the assertion; the line below is the formal check.
    expect(typeof callTool).toBe("function");
    expect(TOOLS.length).toBe(2);
  });
});

// ── callTool — dispatch + unknown name ──────────────────────────────────

describe("callTool — dispatch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws on an unknown tool name without making any HTTP call", async () => {
    await expect(
      callTool("not_a_real_tool", { url: "https://x" }, deps()),
    ).rejects.toThrow(/Unknown tool/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-object arguments for playwright_screenshot", async () => {
    await expect(
      callTool("playwright_screenshot", null, deps()),
    ).rejects.toThrow(/expected an object/);
    await expect(
      callTool("playwright_screenshot", "string", deps()),
    ).rejects.toThrow(/expected an object/);
    await expect(
      callTool("playwright_screenshot", ["array"], deps()),
    ).rejects.toThrow(/expected an object/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── playwright_screenshot ───────────────────────────────────────────────

describe("callTool — playwright_screenshot", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an MCP image content block with base64 PNG bytes", async () => {
    // Non-UTF-8 bytes in the PNG to ensure the base64 path isn't
    // accidentally coerced through a UTF-8 string — same regression
    // guard as the dashboard proxy's binary-passthrough test.
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0xc2, 0x00,
    ]);
    fetchMock.mockResolvedValueOnce(
      new Response(pngBytes, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );

    const content = await callTool(
      "playwright_screenshot",
      { url: "https://example.com" },
      deps(),
    );

    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("image");
    if (content[0].type !== "image") throw new Error("type narrow");
    expect(content[0].mimeType).toBe("image/png");
    // base64-decode and compare bytes.
    const decoded = Buffer.from(content[0].data, "base64");
    expect(decoded.equals(Buffer.from(pngBytes))).toBe(true);
  });

  it("POSTs to ${PLAYWRIGHT_URL}/screenshot with the url and options forwarded verbatim", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([0x89]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
    await callTool(
      "playwright_screenshot",
      {
        url: "https://example.com",
        waitForSelector: "h1",
        fullPage: true,
        viewport: { width: 1920, height: 1080 },
      },
      deps(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(`${PLAYWRIGHT_URL}/screenshot`);
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toEqual({
      "Content-Type": "application/json",
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      url: "https://example.com",
      waitForSelector: "h1",
      fullPage: true,
      viewport: { width: 1920, height: 1080 },
    });
  });

  it("surfaces upstream 4xx as a tool error whose message includes the upstream body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("invalid url format", {
        status: 422,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    await expect(
      callTool("playwright_screenshot", { url: "junk" }, deps()),
    ).rejects.toThrow(/422.*invalid url format/);
  });

  it("reports upstream Content-Type as the MCP block's mimeType when it is an image/* type", async () => {
    // Forward-verbatim contract: a caller-supplied `type: "jpeg"`
    // option makes Playwright return JPEG bytes with Content-Type
    // image/jpeg. The MCP block's mimeType must reflect the actual
    // upstream bytes, not a hardcoded PNG. Strips any `;charset=…`
    // suffix (regression-test included in the suffix handling).
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    fetchMock.mockResolvedValueOnce(
      new Response(jpegBytes, {
        status: 200,
        headers: { "Content-Type": "image/jpeg; charset=binary" },
      }),
    );
    const content = await callTool(
      "playwright_screenshot",
      { url: "https://example.com", type: "jpeg" },
      deps(),
    );
    if (content[0].type !== "image") throw new Error("type narrow");
    expect(content[0].mimeType).toBe("image/jpeg");
  });

  it("defaults to image/png when the upstream omits Content-Type or returns a non-image type", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50]);
    fetchMock.mockResolvedValueOnce(
      new Response(pngBytes, { status: 200 }),
    );
    const content = await callTool(
      "playwright_screenshot",
      { url: "https://example.com" },
      deps(),
    );
    if (content[0].type !== "image") throw new Error("type narrow");
    expect(content[0].mimeType).toBe("image/png");
  });

  it("surfaces upstream 5xx as a tool error whose message includes the status", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("", { status: 500 }),
    );
    await expect(
      callTool("playwright_screenshot", { url: "https://x" }, deps()),
    ).rejects.toThrow(/500/);
  });

  it("rejects a missing url with a validation error — before making an HTTP call", async () => {
    await expect(
      callTool("playwright_screenshot", {}, deps()),
    ).rejects.toThrow(/url/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-string url", async () => {
    await expect(
      callTool("playwright_screenshot", { url: 42 }, deps()),
    ).rejects.toThrow(/url/);
    await expect(
      callTool("playwright_screenshot", { url: "" }, deps()),
    ).rejects.toThrow(/url/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a timeout as a clear error naming the timeout value", async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          // Simulate AbortController firing — the real `fetch` rejects
          // with an AbortError whose name is stable across Node versions.
          const signal = init.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              const err = new Error("The user aborted a request.");
              (err as Error & { name: string }).name = "AbortError";
              reject(err);
            });
          }
        }),
    );
    await expect(
      callTool(
        "playwright_screenshot",
        { url: "https://slow.example" },
        deps({ timeoutMs: 50 }),
      ),
    ).rejects.toThrow(/timed out after 50ms/);
  });
});

// ── playwright_html ─────────────────────────────────────────────────────

describe("callTool — playwright_html", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an MCP text content block with the upstream body", async () => {
    const rendered = "<html><body><h1>Hello</h1></body></html>";
    fetchMock.mockResolvedValueOnce(
      new Response(rendered, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const content = await callTool(
      "playwright_html",
      { url: "https://example.com" },
      deps(),
    );
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    if (content[0].type !== "text") throw new Error("type narrow");
    expect(content[0].text).toBe(rendered);
  });

  it("POSTs to ${PLAYWRIGHT_URL}/html with url and options forwarded verbatim", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html/>", { status: 200 }));
    await callTool(
      "playwright_html",
      { url: "https://example.com", waitForSelector: ".app-ready" },
      deps(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(`${PLAYWRIGHT_URL}/html`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      url: "https://example.com",
      waitForSelector: ".app-ready",
    });
  });

  it("surfaces upstream 4xx as a tool error whose message includes the upstream body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("bad selector", {
        status: 400,
        headers: { "Content-Type": "text/plain" },
      }),
    );
    await expect(
      callTool("playwright_html", { url: "https://x" }, deps()),
    ).rejects.toThrow(/400.*bad selector/);
  });

  it("surfaces a timeout as a clear error naming the timeout value", async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              (err as Error & { name: string }).name = "AbortError";
              reject(err);
            });
          }
        }),
    );
    await expect(
      callTool(
        "playwright_html",
        { url: "https://slow.example" },
        deps({ timeoutMs: 25 }),
      ),
    ).rejects.toThrow(/timed out after 25ms/);
  });

  it("rejects a missing url with a validation error", async () => {
    await expect(
      callTool("playwright_html", {}, deps()),
    ).rejects.toThrow(/url/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("PLAYWRIGHT_DEFAULT_TIMEOUT_MS", () => {
  it("is a positive integer default — callers that omit the env var get a sane bound", () => {
    expect(PLAYWRIGHT_DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isInteger(PLAYWRIGHT_DEFAULT_TIMEOUT_MS)).toBe(true);
  });
});
