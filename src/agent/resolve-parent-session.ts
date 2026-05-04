import { stat } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import {
  deriveSessionDir,
  findSessionFileByDispatchId,
} from "./session-log-watcher.js";
import { getReposBase } from "../poller/constants.js";

/** Result of resolving a parent dispatch's Claude session UUID on disk. */
export type ResolveParentResult =
  | { kind: "found"; sessionId: string }
  | { kind: "not-found" } // Directory exists, no JSONL contains the tag
  | { kind: "no-session-dir" }; // `~/.claude/projects/<cwd>/` does not exist

/**
 * Resolve a prior dispatch's Claude session UUID by scanning the JSONL
 * directory for its dispatch tag. Works after worker restarts because the
 * tag lives in the file content, not in `activeJobs` memory.
 *
 * Distinguishes three outcomes so the caller can map them to the right
 * action. A missing session dir is an infrastructure problem (claude never
 * ran in this cwd); a missing tag means the parent's JSONL was rotated
 * away or never existed. Per `.claude/rules/code-quality.md` "fallbacks are
 * bugs" — don't collapse these two failure modes into a single result.
 *
 * Shared between:
 *   - `src/worker/dispatch.ts` `handleResume` — maps to HTTP status codes.
 *   - `src/poller/index.ts` orphan-resume check — maps to dispatch vs reset.
 */
export async function resolveParentSessionId(
  repoName: string,
  parentJobId: string,
): Promise<ResolveParentResult> {
  // Dispatched agents cwd into `<repo>/.danxbot/workspaces/<name>/` (the
  // resolved plural workspace), so claude writes JSONL under the
  // workspace-encoded projects dir. The parent dispatch could have used
  // any of the workspaces under `<repo>/.danxbot/workspaces/` — we
  // don't know which without scanning. Enumerate every workspace and
  // search each session dir for the parent's dispatch tag.
  const workspacesDir = resolvePath(
    getReposBase(),
    repoName,
    ".danxbot",
    "workspaces",
  );
  if (!existsSync(workspacesDir)) {
    return { kind: "no-session-dir" };
  }
  const workspaceNames = readdirSync(workspacesDir).filter((entry) => {
    try {
      return statSync(resolvePath(workspacesDir, entry)).isDirectory();
    } catch {
      return false;
    }
  });

  let anySessionDirFound = false;
  for (const name of workspaceNames) {
    const sessionDir = deriveSessionDir(resolvePath(workspacesDir, name));
    try {
      const s = await stat(sessionDir);
      if (!s.isDirectory()) continue;
      anySessionDirFound = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const filePath = await findSessionFileByDispatchId(sessionDir, parentJobId);
    if (filePath) {
      return { kind: "found", sessionId: basename(filePath, ".jsonl") };
    }
  }
  return anySessionDirFound ? { kind: "not-found" } : { kind: "no-session-dir" };
}
