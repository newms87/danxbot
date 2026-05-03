/**
 * Phase 5 cleanup (Trello 69f76e8d069eb71dd315d363).
 *
 * The poller previously wrote a one-release symlink at
 * `<workspaces>/trello-worker` pointing at the renamed
 * `<workspaces>/issue-worker` workspace so external callers
 * (`/api/launch` bodies, hardcoded Slack workflows, Make targets)
 * had a window to migrate. That window has now closed; this scrub
 * removes the leftover symlink so the workspace listing reflects only
 * the current canonical name.
 *
 * Operator safety: a real directory at the legacy path is left
 * untouched. A connected repo (precedent: gpt-manager's
 * schema-builder/) may have authored its own workspace under the same
 * name. We never clobber operator-authored content.
 *
 * Detection cue: the entry must be (a) a symlink, AND (b) resolve to
 * the sibling `issue-worker` path. Anything else — real directory,
 * symlink targeting elsewhere — is preserved. Idempotent.
 *
 * No logging — runs every poll tick. The "leave alone" branch is
 * silent by design (same convention as the sibling
 * `scrubRepoRootDanxArtifacts` and `scrubLegacySingularWorkspace`
 * helpers in `index.ts`).
 */

import { readlinkSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { isLinkOrFile, isSymlink } from "./fs-probe.js";

const LEGACY_NAME = "trello-worker";
const CURRENT_NAME = "issue-worker";

export function scrubLegacyTrelloWorkerSymlink(
  workspacesTargetDir: string,
): void {
  const legacyPath = resolve(workspacesTargetDir, LEGACY_NAME);
  if (!isLinkOrFile(legacyPath)) return;
  if (!isSymlink(legacyPath)) return;

  const linkTarget = resolve(workspacesTargetDir, readlinkSync(legacyPath));
  const currentPath = resolve(workspacesTargetDir, CURRENT_NAME);
  if (linkTarget !== currentPath) return;

  rmSync(legacyPath, { force: true });
}
