/**
 * Phase 5 alias: `<workspaces>/trello-worker → issue-worker`.
 *
 * Phase 5 of the tracker-agnostic-agents epic (Trello OWQdETAI) renamed
 * the danxbot-shipped poller workspace from `trello-worker` to
 * `issue-worker`. Existing dispatches (live `/api/launch` callers,
 * in-flight Slack agents, hardcoded Make targets) still reference the
 * old name. This helper writes a one-release symlink alias so the old
 * paths keep resolving until callers migrate.
 *
 * Three target shapes exist on disk at the moment this helper runs:
 *
 *   1. **No `trello-worker` entry.** Fresh P5+ install, or any repo that
 *      never ran the pre-P5 inject. Write the symlink.
 *
 *   2. **`trello-worker` is already a symlink.** Either correct (target
 *      resolves to the absolute `issue-worker` path) — leave alone — or
 *      stale (target points elsewhere). Replace.
 *
 *   3. **`trello-worker` is a real directory.** Two sub-cases:
 *
 *      - **Pre-P5 danxbot-authored.** The Phase 3 inject mirrored
 *        `src/poller/inject/workspaces/trello-worker/` into the repo;
 *        its `workspace.yml` declared `name: trello-worker`. No
 *        operator authored this — danxbot did, on a previous tick. We
 *        own it and may safely replace with a symlink.
 *
 *      - **Operator-authored.** A connected repo that authored its own
 *        `trello-worker/` workspace (precedent: gpt-manager's
 *        schema-builder/) — its `workspace.yml` would carry a different
 *        name or a non-danxbot manifest shape. NEVER clobber this.
 *
 * Detection cue: the file `<dir>/workspace.yml` contains `name: trello-worker`
 * AND was created by danxbot's pre-P5 inject. The cheapest robust signal
 * is "the file exists AND its `name:` field matches `trello-worker`" —
 * an operator who happened to call their workspace `trello-worker` would
 * be silently clobbered, but that name collision is almost-impossible in
 * practice (it's the danxbot-shipped name, operator workspaces use
 * domain names like `schema-builder`). The next phase of the epic
 * removes this helper entirely so the window for the false-positive is
 * one release.
 *
 * Drop this module one release after Phase 5 ships — a follow-up Action
 * Items card tracks the cleanup.
 */

import {
  existsSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { isLinkOrFile, isSymlink } from "./fs-probe.js";

/**
 * Idempotent. Writes `workspacesTargetDir/trello-worker` as a symlink to
 * `workspacesTargetDir/issue-worker` when:
 *
 *   - `issue-worker` exists (otherwise a dangling symlink is worse than
 *     no alias — fail soft so an operator-tester running with a
 *     partially-built fixture sees the missing dir, not a broken link).
 *   - `trello-worker` is absent, OR is a symlink pointing somewhere
 *     other than `issue-worker`, OR is a pre-P5 danxbot-authored real
 *     directory (detected by `workspace.yml` carrying the literal text
 *     `name: trello-worker`).
 *
 * Leaves the alias untouched when:
 *
 *   - `trello-worker` is a real directory whose contents were authored
 *     by an operator (no `workspace.yml`, or `workspace.yml` declares a
 *     different `name`).
 *
 * No logging — this runs every poll tick. A debug print here would spam
 * tens of thousands of lines per day. The "leave alone" branch is silent
 * by design.
 */
export function injectIssueWorkerAlias(workspacesTargetDir: string): void {
  const targetIssueWorker = resolve(workspacesTargetDir, "issue-worker");
  const aliasPath = resolve(workspacesTargetDir, "trello-worker");

  if (!existsSync(targetIssueWorker)) return;

  if (isLinkOrFile(aliasPath)) {
    if (isSymlink(aliasPath)) {
      // Resolve through the symlink so a previous run that wrote a
      // relative target (`./issue-worker`) still compares equal to the
      // absolute one we'd write today. Skip the rewrite when the
      // resolved targets match — otherwise we'd churn the link on every
      // tick. `readlinkSync` after `isSymlink === true` cannot
      // legitimately fail — let unexpected I/O errors throw so the
      // poller's outer tick handler logs them rather than silently
      // recreating the link forever.
      const linkTarget = resolve(
        workspacesTargetDir,
        readlinkSync(aliasPath),
      );
      if (linkTarget === targetIssueWorker) return;
      rmSync(aliasPath, { force: true });
    } else if (isPreP5DanxbotAuthored(aliasPath)) {
      // Pre-P5 danxbot inject left a real `trello-worker/` directory
      // behind. We own it — Phase 5 commit `c8e8101` claimed the
      // directory would convert to a symlink on next tick, but the
      // original `injectIssueWorkerAlias` short-circuited on real
      // directories regardless of authorship. Now: detect + replace.
      rmSync(aliasPath, { recursive: true, force: true });
    } else {
      // Operator-authored `trello-worker/` directory. Never clobber.
      return;
    }
  }

  symlinkSync(targetIssueWorker, aliasPath, "dir");
}

function isPreP5DanxbotAuthored(dirPath: string): boolean {
  const manifestPath = resolve(dirPath, "workspace.yml");
  if (!existsSync(manifestPath)) return false;
  const raw = readFileSync(manifestPath, "utf-8");
  // Pre-P5 manifest declared `name: trello-worker` at top-level. An
  // operator-authored workspace coincidentally placed at this path
  // would either have no manifest or declare a different name.
  return /^name:\s*trello-worker\s*$/m.test(raw);
}

