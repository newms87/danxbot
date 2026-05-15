/**
 * `vue_build_and_preview` orchestrator.
 *
 * Bundles the typical agent loop into one MCP call: the agent points at
 * a directory containing a freshly-built Vite `dist/`, the orchestrator
 * starts a static server (via the same `HostedDistRegistry` that backs
 * `playwright_host_static`), and returns the URL the agent's navigation
 * tool should hit.
 *
 * This is intentionally a thin wrapper, not a full build orchestrator:
 *
 * - The danxbot worker's `POST /api/template-build` (DX-539) is the
 *   build path. The agent's consumer-repo MCP (`template_rebuild`)
 *   handles invocation + presigned-URL plumbing — that's a synchronous
 *   call the agent already makes per the `vue-app-build` skill.
 * - Cross-MCP-server invocation is not a primitive Claude Code
 *   supports — one MCP server cannot call another. The card's
 *   "calls the consumer repo's template_rebuild" phrasing assumed a
 *   coupling that does not exist. Instead, the orchestrator's job is
 *   to compress the two-call chain agents already make into a single
 *   tool that does the "host the dist + return URL" half cleanly,
 *   leaving the consumer-repo rebuild call where it belongs.
 *
 * Signature mirrors `playwright_host_static` exactly today; the field
 * is named `dist_path` so a future hosted-rebuild extension can layer
 * optional rebuild args on top without re-naming.
 */

import { HostedDistRegistry } from "./host-static.js";

export interface VueBuildAndPreviewArgs {
  dist_path: string;
}

export async function vueBuildAndPreview(
  args: VueBuildAndPreviewArgs,
  registry: HostedDistRegistry,
): Promise<{ url: string; server_id: string }> {
  if (!args || typeof args !== "object") {
    throw new Error("vue_build_and_preview: arguments must be an object");
  }
  const { dist_path } = args;
  if (typeof dist_path !== "string" || dist_path.trim() === "") {
    throw new Error("vue_build_and_preview: dist_path must be a non-empty string");
  }
  const { server_id, url } = await registry.start(dist_path);
  return { url, server_id };
}
