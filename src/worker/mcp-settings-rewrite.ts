/**
 * Atomic rewrite of a per-dispatch MCP settings file when the worker's
 * listening port changes across a restart.
 *
 * Each dispatch is launched with a settings file at
 * `/tmp/danxbot-mcp-XXXX/settings.json` whose `mcpServers.danxbot.env`
 * embeds `DANXBOT_STOP_URL = http://localhost:<old_port>/api/stop/<id>`
 * (plus a constellation of sibling URLs derived from the same port —
 * Slack reply/update, issue create, restart). When the worker dies and
 * a new incarnation comes up on a DIFFERENT port (rare in production —
 * the port is pinned per-repo via `worker_port:` — but happens during
 * local dev / failover testing), the agent's MCP server still has the
 * OLD URLs cached; if we don't fix the file on disk, even a restart of
 * the MCP server would re-read the stale port.
 *
 * Same-port restart is the common case → no-op (return rewritten=false
 * after detecting the port matches). The function only mutates the
 * file when a mismatch is detected.
 *
 * Atomicity: write to `<path>.tmp` then `rename` over the original.
 * Rename is atomic at the inode level on the same filesystem; readers
 * either see the old complete document or the new complete document,
 * never a half-written JSON.
 *
 * Caller contract (DX-209 reattach):
 *   - On every reattach attempt, call this function with the row's
 *     `mcp_settings_path` and the new worker's listening port.
 *   - ENOENT on the path is treated as a no-op (the file was already
 *     cleaned up — likely the original dispatch finalized cleanly
 *     between probe and reattach). Return rewritten=false; the caller
 *     proceeds with reattach since same-port behavior is unaffected.
 *   - Corrupt JSON throws — the operator should see the failure rather
 *     than silently leak a half-written file across the restart.
 *   - Missing DANXBOT_STOP_URL returns rewritten=false: without the
 *     canonical port reference we cannot safely diff old vs new, so
 *     the safer move is to leave the file alone.
 */

import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { createLogger } from "../logger.js";

const log = createLogger("mcp-settings-rewrite");

export interface RewriteResult {
  /** True iff the file on disk was mutated. */
  rewritten: boolean;
  /** Old port parsed from DANXBOT_STOP_URL, or undefined when not present. */
  oldPort?: number;
  /** The port the caller asked us to write — echoed back for callsite logging. */
  newPort: number;
}

interface McpSettingsShape {
  mcpServers?: Record<
    string,
    {
      env?: Record<string, string>;
      [k: string]: unknown;
    }
  >;
}

const LOCALHOST_PORT_RE = /^http:\/\/localhost:(\d+)(\/.*)?$/;

function extractDanxbotStopPort(content: McpSettingsShape): number | undefined {
  const url = content.mcpServers?.danxbot?.env?.DANXBOT_STOP_URL;
  if (!url) return undefined;
  const match = LOCALHOST_PORT_RE.exec(url);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function rewriteLocalhostUrls(
  env: Record<string, string>,
  oldPort: number,
  newPort: number,
): void {
  const oldHost = `http://localhost:${oldPort}`;
  const newHost = `http://localhost:${newPort}`;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (value.startsWith(oldHost)) {
      env[key] = newHost + value.slice(oldHost.length);
    }
  }
}

export async function rewriteMcpSettingsIfPortChanged(
  mcpSettingsPath: string,
  newPort: number,
): Promise<RewriteResult> {
  let raw: string;
  try {
    // `stat` first so a missing file is distinguishable from a parse
    // error (the latter MUST throw — a corrupt settings file across a
    // restart would otherwise become a silent agent breakage).
    await stat(mcpSettingsPath);
    raw = await readFile(mcpSettingsPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { rewritten: false, newPort };
    }
    throw err;
  }

  const parsed = JSON.parse(raw) as McpSettingsShape;
  const oldPort = extractDanxbotStopPort(parsed);
  if (oldPort === undefined) {
    return { rewritten: false, newPort };
  }
  if (oldPort === newPort) {
    return { rewritten: false, oldPort, newPort };
  }

  // Walk every server's env and swap any localhost URL pointing at the
  // old port. Other URLs (different host, https, etc.) are preserved.
  const servers = parsed.mcpServers ?? {};
  for (const server of Object.values(servers)) {
    if (server && typeof server === "object" && server.env) {
      rewriteLocalhostUrls(server.env, oldPort, newPort);
    }
  }

  const updated = JSON.stringify(parsed, null, 2);
  // Sibling tmp file on the same filesystem so `rename` is an atomic
  // inode swap. `.tmp` suffix is intentionally simple — this temp file
  // is short-lived and crash-safe (a partial write that never reaches
  // rename leaves the original settings.json untouched).
  const tmpPath = `${mcpSettingsPath}.tmp`;
  await writeFile(tmpPath, updated, "utf-8");
  await rename(tmpPath, mcpSettingsPath);

  log.info(
    `Rewrote ${mcpSettingsPath}: localhost port ${oldPort} → ${newPort}`,
  );

  return { rewritten: true, oldPort, newPort };
}
