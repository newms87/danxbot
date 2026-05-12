/**
 * OS seam for the orphan-reaper (`src/worker/process-scan.ts`).
 *
 * Isolates every node-side primitive the scan touches — `pgrep`,
 * `/proc/<pid>/cwd` — behind two callable functions so the unit-test
 * file can `vi.mock("./process-scan-os.js")` without booby-trapping the
 * agent / dispatch core / DB layer mocks the rest of the worker test
 * suite shares.
 *
 * Production has exactly one consumer; do not import these helpers
 * elsewhere. If a second consumer appears, the right move is to lift
 * the helper into the consumer's own seam, not to fan out from here.
 */

import { execFile } from "node:child_process";
import { readlinkSync } from "node:fs";

/**
 * Run `pgrep -af '<!-- danxbot-dispatch:'` and return its stdout.
 *
 * `-a` prints the full cmdline (we need the dispatch tag); `-f`
 * matches against the cmdline (the tag is in argv, not the executable
 * name). Two normal exit shapes:
 *
 *   - exit 0 + stdout containing one line per match (parsed by the
 *     caller).
 *   - exit 1 + empty stdout when no matches exist — `pgrep`'s
 *     contract. We return the captured stdout (typically `""`)
 *     instead of throwing so the caller's "no matches" branch is the
 *     same shape as "matches found".
 *
 * Anything else (binary missing, permission denied, oom-killed pgrep)
 * propagates as a thrown error — the caller logs and skips its tick;
 * pgrep being broken is an environment-level failure that wants
 * operator attention, not silent suppression.
 *
 * Implementation note: `child_process.execFile` is wrapped manually
 * instead of `promisify(execFile)` because the latter resolves the
 * `execFile` reference at module-load time. Other test suites
 * (`src/cron/sync-and-audit.test.ts`) `vi.mock("node:child_process", …)` to
 * override `spawn` while implicitly dropping every other export — the
 * top-level `promisify(execFile)` capture surfaced as `undefined` in
 * those suites and crashed import. Calling `execFile` lazily inside
 * the function body (via the captured-at-import reference, which is
 * still hoisted but not invoked until pgrep runs) keeps the module
 * importable in the same suites without losing test isolation.
 */
export function execPgrepDispatchTag(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "pgrep",
      ["-af", "<!-- danxbot-dispatch:"],
      (err, stdout) => {
        if (err) {
          // pgrep exits 1 when no matches are found. `child_process.execFile`
          // surfaces non-zero exit as an Error whose `code` field is the
          // numeric exit code at RUNTIME (Node's type declaration says
          // `string | undefined`, but runtime is a number — see the
          // `ExecFileException` shape that doesn't override
          // `NodeJS.ErrnoException['code']`). Cast through `unknown` to
          // get past tsc; distinguish from `code: "ENOENT"` (binary
          // missing) by accepting either the number 1 or the string "1".
          const code = (err as { code?: unknown }).code;
          if (code === 1 || code === "1") {
            resolve(stdout);
            return;
          }
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Read `/proc/<pid>/cwd` symlink and return its target. Returns `null`
 * on any error (process exited mid-scan, permissions denied, non-Linux
 * /proc layout). Cwd-less processes are conservatively excluded from
 * the repo-isolation filter — see `filterByRepoCwd`.
 */
export function readProcCwd(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}
