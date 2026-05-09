/**
 * Generic FS helpers for per-agent assets under
 * `<repo.localPath>/.danxbot/agents/<name>/`. Avatar MIME / extension
 * tables live in `agents-avatar.ts` (their only consumer).
 *
 *   1. `agentDir` — canonical path resolver. Pair with
 *      `assertWithinAgentsRoot` before any mutation.
 *   2. `assertWithinAgentsRoot` — defense-in-depth path-traversal guard.
 *      Names passing `AGENT_NAME_SHAPE` already preclude traversal;
 *      this guard fails loudly if a future regression slips through.
 *   3. `readBoundedBody` — strict-cap body reader for raw-binary uploads.
 */

import type { IncomingMessage } from "http";
import { resolve as resolvePath } from "node:path";
import type { RepoConfig } from "../types.js";

/**
 * Per-agent on-disk asset directory:
 * `<repo.localPath>/.danxbot/agents/<name>/`. The `<name>` segment must
 * already have passed `AGENT_NAME_SHAPE` validation upstream
 * (URL/branch/path-safe).
 */
export function agentDir(repo: RepoConfig, name: string): string {
  return resolvePath(repo.localPath, ".danxbot", "agents", name);
}

/**
 * Defense-in-depth: prove a candidate path resolves WITHIN the repo's
 * `.danxbot/agents/` subtree before any filesystem mutation. Returns
 * `null` when safe; an error message string otherwise.
 */
export function assertWithinAgentsRoot(
  repo: RepoConfig,
  candidate: string,
): string | null {
  const root = resolvePath(repo.localPath, ".danxbot", "agents");
  const abs = resolvePath(candidate);
  if (abs !== root && !abs.startsWith(`${root}/`)) {
    return `path "${candidate}" escapes .danxbot/agents/ root`;
  }
  return null;
}

/**
 * Read an `IncomingMessage` body into a Buffer with a strict byte cap.
 * Aborts as soon as the running total exceeds the cap so an attacker
 * can't DOS the worker by streaming an oversized body. Returns one of
 * three shapes the caller pattern-matches on:
 *
 *   {buffer}         — body fits within the cap
 *   {tooLarge: true} — body exceeded the cap; request was destroyed
 *   {error}          — underlying socket error / parse failure
 */
export function readBoundedBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ buffer: Buffer } | { tooLarge: true } | { error: string }> {
  return new Promise((resolveRead) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (
      result: { buffer: Buffer } | { tooLarge: true } | { error: string },
    ) => {
      if (settled) return;
      settled = true;
      resolveRead(result);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        req.destroy();
        finish({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish({ buffer: Buffer.concat(chunks) }));
    req.on("error", (err) =>
      finish({ error: err instanceof Error ? err.message : String(err) }),
    );
  });
}
