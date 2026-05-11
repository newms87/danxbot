/**
 * DX-242 + DX-244: ensure every existing agent worktree has its
 * provisioning symlinks (`<worktree>/node_modules`,
 * `<worktree>/.env`) at worker boot.
 *
 * This is the self-healing half of the bootstrap fix: worktrees that
 * pre-date a provisioning step lack the corresponding symlink.
 * Running the bootstrap-time fix on a fresh boot pulls existing
 * worktrees into the new contract automatically — no operator action
 * required (AC #2).
 *
 * Per-agent failures are logged AND recorded as system errors so the
 * dashboard surfaces them on the agent card (AC #8 — "silent breakage
 * is impossible"). Boot does NOT abort on a per-agent failure: the
 * worker still serves repos whose worktrees are healthy, and the failed
 * agent surfaces in the dashboard for the operator to inspect.
 *
 * Boot-time consumer: `startWorkerMode` in `src/index.ts`. The function
 * is small and free of side effects beyond logging + system-error
 * recording, so unit tests cover it directly without booting the
 * worker.
 */

import { readSettings } from "../settings-file.js";
import { recordSystemError } from "../dashboard/system-errors.js";
import { createLogger } from "../logger.js";
import type { WorktreeManager, WorktreeRepo } from "./worktree-manager.js";

const log = createLogger("ensure-worktrees");

export interface EnsureWorktreesContext extends WorktreeRepo {
  /** Repo name — recorded on system-error events. */
  name: string;
}

export interface EnsureWorktreesResult {
  /** Number of agent names read from settings. */
  scanned: number;
  /** Agents whose worktree provision is now valid. */
  provisioned: string[];
  /** Agents whose provision failed; each surfaces in the dashboard. */
  failed: Array<{ agent: string; error: string }>;
}

/**
 * Read `settings.agents` and call `ensureProvisioned` for each. Failures
 * are recorded but never thrown — boot continues so healthy agents stay
 * dispatchable.
 */
export async function ensureWorktreesProvisioned(
  ctx: EnsureWorktreesContext,
  manager: WorktreeManager,
): Promise<EnsureWorktreesResult> {
  const settings = readSettings(ctx.localPath);
  const agentNames = Object.keys(settings.agents ?? {});

  const result: EnsureWorktreesResult = {
    scanned: agentNames.length,
    provisioned: [],
    failed: [],
  };

  for (const name of agentNames) {
    try {
      await manager.ensureProvisioned(ctx, name);
      result.provisioned.push(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        `[${ctx.name}] ensureProvisioned(${name}) failed: ${message}`,
      );
      recordSystemError({
        source: "worktree",
        severity: "error",
        repo: ctx.name,
        message:
          `Agent worktree '${name}' is missing required artifacts (node_modules / .env) and could not ` +
          `be self-healed: ${message}`,
        details: { agent: name },
      });
      result.failed.push({ agent: name, error: message });
    }
  }

  if (agentNames.length > 0) {
    log.info(
      `[${ctx.name}] ensureWorktreesProvisioned: ${result.provisioned.length} ok, ${result.failed.length} failed (of ${agentNames.length})`,
    );
  }

  return result;
}
