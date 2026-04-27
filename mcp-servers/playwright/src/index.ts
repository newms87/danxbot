#!/usr/bin/env node
/**
 * MCP server exposing Playwright as first-class tools to Claude Code
 * agents dispatched by danxbot. Two tools, both stateless, both wrap
 * the danxbot-net `playwright` container:
 *
 * - `playwright_screenshot` — POST `/screenshot` → returns an MCP
 *   `image` content block (base64-encoded PNG, `mimeType: image/png`).
 *   The screenshot appears inline in the agent's conversation; no
 *   file-system step is required, which matters because sub-agents
 *   often have `Read` restricted by their `.claude/agents/*.md`
 *   frontmatter.
 *
 * - `playwright_html` — POST `/html` → returns an MCP `text` content
 *   block with the rendered HTML string.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON). Handles:
 * `initialize`, `ping`, `tools/list`, `tools/call`.
 *
 * Configuration:
 * - `PLAYWRIGHT_URL` — REQUIRED. Base URL of the Playwright service
 *   (no trailing slash), e.g. `http://playwright:3000`. Startup fails
 *   loud with exit 1 if unset, matching the fail-loud contract — the
 *   registry factory defaults it to the danxbot-net hostname, so
 *   reaching this process without a value means either the registry
 *   regressed OR someone is running the server by hand.
 * - `PLAYWRIGHT_TIMEOUT_MS` — optional. Per-request timeout, defaults
 *   to `PLAYWRIGHT_DEFAULT_TIMEOUT_MS` (30s).
 *
 * Tool schemas take a required `url` string. ALL other fields in the
 * arguments object are forwarded to Playwright verbatim — we
 * deliberately do NOT mirror Playwright's request schema here, because
 * drift between "our schema of their schema" and "their actual
 * schema" would silently drop caller options. Let Playwright validate
 * what it cares about.
 */

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

/** Default per-request overall timeout. */
export const PLAYWRIGHT_DEFAULT_TIMEOUT_MS = 30_000;

export interface PlaywrightDeps {
  /** Base URL of the Playwright service. No trailing slash. */
  url: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
}

/**
 * MCP content block shapes emitted by `tools/call`. `text` carries a
 * UTF-8 string (used by `playwright_html` and by every error path).
 * `image` carries base64-encoded binary bytes plus a MIME type (used
 * by `playwright_screenshot` so the model sees the PNG inline).
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export const TOOLS = [
  {
    name: "playwright_screenshot",
    description:
      "Render a URL in a headless browser and return the PNG screenshot as " +
      "an inline image. Required: url (string). Optional fields (waitForSelector, " +
      "fullPage, viewport, timeout, and any future Playwright options) are " +
      "forwarded verbatim to the Playwright service — do not re-validate them " +
      "locally. Returns a single MCP image content block; no file-system " +
      "step required, which matters when the agent's tool surface blocks Read.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to screenshot.",
        },
      },
      required: ["url"],
      additionalProperties: true,
    },
  },
  {
    name: "playwright_html",
    description:
      "Fetch and render a URL in a headless browser and return its final " +
      "HTML as text. Required: url (string). Optional fields (waitForSelector, " +
      "timeout, and any future Playwright options) are forwarded verbatim. " +
      "Returns a single MCP text content block with the rendered HTML.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL whose rendered HTML should be returned.",
        },
      },
      required: ["url"],
      additionalProperties: true,
    },
  },
];

function requireObjectArgs(name: string, args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`Invalid arguments: expected an object for ${name}`);
  }
  return args as Record<string, unknown>;
}

function requireNonBlankString(
  toolName: string,
  field: string,
  value: unknown,
): string {
  if (typeof value !== "string") {
    throw new Error(
      `${toolName}: field "${field}" is required and must be a string (got ${typeof value})`,
    );
  }
  if (value.trim() === "") {
    throw new Error(
      `${toolName}: field "${field}" must be a non-empty string`,
    );
  }
  return value;
}

/**
 * `fetch` with a hard per-request timeout. AbortController is the only
 * portable way to bound a Node `fetch`; the `timeout` option on the
 * low-level http module is socket-idle, not overall-request, so it's
 * the wrong fit here.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(err: unknown): boolean {
  // Node's AbortController aborts surface as `DOMException` with name
  // "AbortError" under `undici`'s `fetch`. Check by name — different
  // Node versions have different error constructors but the name is
  // stable.
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: unknown }).name === "AbortError"
  );
}

async function callPlaywrightScreenshot(
  args: Record<string, unknown>,
  deps: PlaywrightDeps,
): Promise<ContentBlock[]> {
  const url = requireNonBlankString("playwright_screenshot", "url", args.url);
  // Forward every field the caller sent. The `url` field is
  // re-set from the validated string so the outbound body carries a
  // canonical value even if the caller passed weird types we coerced
  // earlier (we didn't — but the intent is: validate once, forward
  // the validated form).
  const body = { ...args, url };

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${deps.url}/screenshot`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      deps.timeoutMs,
    );
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error(
        `playwright_screenshot: upstream timed out after ${deps.timeoutMs}ms`,
      );
    }
    throw err;
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `playwright_screenshot: upstream HTTP ${response.status}${
        errText ? ` — ${errText}` : ""
      }`,
    );
  }

  const arrayBuf = await response.arrayBuffer();
  const bytes = arrayBuf.byteLength;
  const base64 = Buffer.from(arrayBuf).toString("base64");
  // Read the upstream's declared Content-Type. Playwright currently
  // always returns PNG, but the forward-verbatim contract on
  // `options` means a caller could pass a `type: "jpeg"` option that
  // makes the upstream return JPEG — hardcoding `image/png` would
  // then mis-report the mime in the MCP content block. Default to
  // `image/png` when the header is absent or not an `image/*` type.
  const upstreamCt = response.headers.get("content-type") ?? "";
  const mimeType = upstreamCt.toLowerCase().startsWith("image/")
    ? upstreamCt.split(";")[0].trim()
    : "image/png";
  // Two-block response: a text summary the model can quote back
  // verbatim (byte count, mime type) and the image bytes themselves.
  // The image content block is rendered visually by Claude Code but
  // its `data` field is NOT surfaced to the model's text context, so
  // an agent that only sees the image cannot report the size. The
  // text block closes that gap so callers can verify the round-trip
  // and operators can audit screenshot sizes from session logs.
  return [
    {
      type: "text",
      text: `playwright_screenshot OK: ${bytes} bytes, mimeType=${mimeType}`,
    },
    { type: "image", data: base64, mimeType },
  ];
}

async function callPlaywrightHtml(
  args: Record<string, unknown>,
  deps: PlaywrightDeps,
): Promise<ContentBlock[]> {
  const url = requireNonBlankString("playwright_html", "url", args.url);
  const body = { ...args, url };

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${deps.url}/html`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      deps.timeoutMs,
    );
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error(
        `playwright_html: upstream timed out after ${deps.timeoutMs}ms`,
      );
    }
    throw err;
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `playwright_html: upstream HTTP ${response.status}${
        errText ? ` — ${errText}` : ""
      }`,
    );
  }

  const text = await response.text();
  return [{ type: "text", text }];
}

/**
 * Exported so unit tests can exercise the validation + HTTP contract
 * directly. Production callers go through this same function via the
 * JSON-RPC `tools/call` dispatcher in `main`.
 */
export async function callTool(
  name: string,
  args: unknown,
  deps: PlaywrightDeps,
): Promise<ContentBlock[]> {
  switch (name) {
    case "playwright_screenshot":
      return callPlaywrightScreenshot(
        requireObjectArgs("playwright_screenshot", args),
        deps,
      );
    case "playwright_html":
      return callPlaywrightHtml(
        requireObjectArgs("playwright_html", args),
        deps,
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function respond(id: number | string, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(
  id: number | string,
  code: number,
  message: string,
): void {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n",
  );
}

export function main(deps: PlaywrightDeps): void {
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line: string) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Ignore non-JSON lines.
    }

    const id = msg["id"] as number | string | undefined;
    const method = msg["method"] as string;
    const params = msg["params"] as Record<string, unknown> | undefined;

    // Notifications have no id — acknowledge and drop.
    if (id === undefined) return;

    (async () => {
      try {
        if (method === "initialize") {
          respond(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "danxbot-playwright", version: "0.1.0" },
          });
        } else if (method === "ping") {
          respond(id, {});
        } else if (method === "tools/list") {
          respond(id, { tools: TOOLS });
        } else if (method === "tools/call") {
          const p = (params ?? {}) as Record<string, unknown>;
          const content = await callTool(p.name as string, p.arguments, deps);
          respond(id, { content });
        } else {
          respondError(id, -32601, `Method not found: ${method}`);
        }
      } catch (err) {
        respondError(
          id,
          -32000,
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
  });
}

/**
 * Entrypoint gating matches `src/mcp/danxbot-server.ts`: importing this
 * module from a unit test must not attach a stdin listener or call
 * `process.exit`. Direct invocation (`tsx src/index.ts` or the
 * published bin) fires `main()` with env-derived deps.
 */
const entryUrl =
  typeof process.argv[1] === "string"
    ? pathToFileURL(process.argv[1]).href
    : "";
if (import.meta.url === entryUrl) {
  const url = process.env.PLAYWRIGHT_URL;
  if (!url) {
    process.stderr.write(
      "PLAYWRIGHT_URL environment variable is required (e.g. http://playwright:3000)\n",
    );
    process.exit(1);
  }
  const timeoutOverride = process.env.PLAYWRIGHT_TIMEOUT_MS;
  const timeoutMs = timeoutOverride
    ? parseInt(timeoutOverride, 10)
    : PLAYWRIGHT_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    process.stderr.write(
      `PLAYWRIGHT_TIMEOUT_MS must be a positive integer (got ${timeoutOverride})\n`,
    );
    process.exit(1);
  }
  main({ url, timeoutMs });
}
