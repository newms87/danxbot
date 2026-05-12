/**
 * DX-201 / DX-203: inject `danx-issue` MCP server into a connected repo's
 * root `.mcp.json` so a host-session `claude` invocation at the repo root
 * sees the danx-issue tool surface (atomic id allocation via
 * `danx_issue_create`, etc).
 *
 * Contract (re-read before editing):
 *
 * - ADD `danx-issue` to `mcpServers` when missing.
 * - NEVER touch any other key under `mcpServers` (operator's own MCPs,
 *   playwright, context7, ...). Operator overrides of `danx-issue`
 *   itself also win — if the key exists already we leave it alone.
 * - NEVER touch top-level keys outside `mcpServers`.
 * - Malformed JSON in an existing file → log error and bail. NEVER
 *   overwrite a file we cannot parse — that is the user's data.
 * - Atomic write: write to `<path>.tmp` then `renameSync` so a
 *   poller crash mid-write leaves the original file intact.
 * - Idempotent — re-running is a no-op when the key already exists.
 *
 * The injected env block contains exactly `DANX_REPO_ROOT` (DX-203). The
 * danx-issue MCP server is purely a YAML manipulator — it does NOT call
 * any tracker, so the `DANX_TRACKER` / `TRELLO_API_KEY` /
 * `TRELLO_API_TOKEN` triple that older versions injected is gone. The
 * worker's poll loop owns the YAML → Trello mirror asynchronously
 * (`src/poller/orphan-push.ts` + `.trello-retry/` queue); a broken or
 * absent Trello has zero effect on dev MCP operations.
 *
 * `DANX_REPO_ROOT` is baked as a literal because the `.mcp.json` is
 * consumed by a host-session `claude` whose shell may not export it.
 * (Workspace `.mcp.json` files use `${...}` placeholders because the
 * danxbot worker injects those vars at spawn time — host `claude` has
 * no such injection.)
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("inject-root-mcp");

export interface InjectRootMcpOptions {
  repoRoot: string;
  /** @internal — see InjectRootMcpFsHooks. */
  _fsHooks?: InjectRootMcpFsHooks;
}

export interface InjectRootMcpResult {
  changed: boolean;
  path: string;
}

/**
 * Build the canonical `danx-issue` server entry for a given repo.
 *
 * `DANX_REPO_ROOT` is baked as a literal because the host `claude` shell
 * may not export it. The server has no other env-var contract (DX-203):
 * `DANX_TRACKER` / `TRELLO_API_KEY` / `TRELLO_API_TOKEN` are no longer
 * read by the MCP server, so they're absent from the entry.
 */
export function buildDanxIssueEntry(repoRoot: string) {
  return {
    type: "stdio" as const,
    command: "npx",
    args: ["-y", "@thehammer/danx-issue-mcp"],
    env: {
      DANX_REPO_ROOT: repoRoot,
    },
  };
}

/**
 * Test seam for atomic-write rollback. Production code must not pass
 * `_fsHooks`; the rollback branch (write `.tmp` succeeds, `renameSync`
 * fails) is observable only when `renameSync` is replaced by a thrower,
 * because real filesystems generally do not expose a deterministic way
 * to fail rename mid-flight without also blocking the prior writeFileSync.
 */
export interface InjectRootMcpFsHooks {
  renameSync?: (from: string, to: string) => void;
}

export function injectDanxIssueMcp(
  opts: InjectRootMcpOptions,
): InjectRootMcpResult {
  const path = resolve(opts.repoRoot, ".mcp.json");

  let existing: Record<string, unknown> = { mcpServers: {} };
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf-8");
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        log.error(
          `[inject-root-mcp] ${path} is not a JSON object — leaving untouched`,
        );
        return { changed: false, path };
      }
      existing = parsed as Record<string, unknown>;
    } catch (err) {
      log.error(
        `[inject-root-mcp] failed to parse ${path} as JSON — leaving untouched: ${(err as Error).message}`,
      );
      return { changed: false, path };
    }
  }

  const rawMcpServers = existing.mcpServers;
  const hasMcpServersKey = Object.prototype.hasOwnProperty.call(
    existing,
    "mcpServers",
  );
  const mcpServersIsObject =
    rawMcpServers !== null &&
    typeof rawMcpServers === "object" &&
    !Array.isArray(rawMcpServers);

  if (hasMcpServersKey && !mcpServersIsObject) {
    log.error(
      `[inject-root-mcp] ${path} has malformed mcpServers (${Array.isArray(rawMcpServers) ? "array" : typeof rawMcpServers}) — leaving untouched`,
    );
    return { changed: false, path };
  }

  const mcpServers = mcpServersIsObject
    ? (rawMcpServers as Record<string, unknown>)
    : {};

  if (Object.prototype.hasOwnProperty.call(mcpServers, "danx-issue")) {
    return { changed: false, path };
  }

  const next = {
    ...existing,
    mcpServers: {
      ...mcpServers,
      "danx-issue": buildDanxIssueEntry(opts.repoRoot),
    },
  };

  const tmpPath = path + ".tmp";
  const serialized = JSON.stringify(next, null, 2) + "\n";
  const rename = opts._fsHooks?.renameSync ?? renameSync;
  try {
    writeFileSync(tmpPath, serialized);
    rename(tmpPath, path);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
    throw err;
  }

  return { changed: true, path };
}
