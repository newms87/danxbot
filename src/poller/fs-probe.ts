/**
 * Tiny filesystem probes shared between poller modules.
 *
 * `isSymlink` / `isLinkOrFile` were duplicated in `index.ts` and
 * `issue-worker-alias.ts` — the same try/`lstatSync`/catch shape both
 * times. Extracted here so editing one set of semantics edits both
 * call-sites at once.
 *
 * Both helpers swallow `ENOENT` deliberately (returning `false`) — the
 * caller's question is "does the path exist as a link/file/dir right
 * now?" and a missing path is the legitimate negative answer, not an
 * error. Permission and I/O failures are swallowed too; treating them
 * as "absent" is the existing behaviour both call-sites already relied
 * on, and the poller's outer tick handler logs the I/O error if it
 * surfaces elsewhere.
 */

import { lstatSync } from "node:fs";

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function isLinkOrFile(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
