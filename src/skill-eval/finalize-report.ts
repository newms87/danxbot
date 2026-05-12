/**
 * Shared "write markdown to stdout + persist REPORT.md" seam for the
 * skill-eval CLI entry points.
 *
 * Both `run-eval-set.ts#main` and `run-iterate.ts#main` ended their
 * lifecycle the same way: write the rendered markdown to stdout, then
 * call `persistEvalSetReportWithLog` so the operator sees the report
 * on disk after the run ends. Inlining the pair drifted between the
 * two callers — DX-332 extracts the helper so a unit test can pin
 * "the persistence call happens exactly once after rendering" without
 * having to spawn a real eval-set.
 *
 * Both `stdout` + `persistReport` are injectable so the unit test can
 * capture each call without touching the real `process.stdout` or
 * filesystem. Production callers fall through to defaults.
 */

import {
  persistEvalSetReportWithLog,
  type PersistEvalSetReportArgs,
  type WriteEvalSetReportFileResult,
} from "./report-file.js";

export interface FinalizeReportStdoutLike {
  write(chunk: string): unknown;
}

export type FinalizeReportPersistFn = (
  args: PersistEvalSetReportArgs,
) => WriteEvalSetReportFileResult;

export interface FinalizeReportDeps {
  readonly persistReport: FinalizeReportPersistFn;
  readonly stdout: FinalizeReportStdoutLike;
}

export interface FinalizeReportArgs {
  readonly markdown: string;
  readonly evalSetPath: string;
  readonly runAt: Date;
}

/**
 * Write `markdown` + a trailing newline to `deps.stdout`, then persist
 * REPORT.md next to the eval-set via `deps.persistReport`. Returns the
 * persistence result so the caller can read the on-disk path if it
 * wants to log it elsewhere.
 *
 * Order matters: stdout write happens BEFORE persistence so an
 * operator scrolling stdout reads the report content even if the
 * persistence step throws (ENOSPC, EACCES). Persistence comes second
 * because failure there is operator-visible separately via the
 * stderr line `persistEvalSetReportWithLog` emits.
 */
export function finalizeReportWriteoutAndPersist(
  args: FinalizeReportArgs,
  deps: FinalizeReportDeps = {
    persistReport: persistEvalSetReportWithLog,
    stdout: process.stdout,
  },
): WriteEvalSetReportFileResult {
  deps.stdout.write(args.markdown);
  deps.stdout.write("\n");
  return deps.persistReport({
    evalSetPath: args.evalSetPath,
    markdown: args.markdown,
    runAt: args.runAt,
  });
}
