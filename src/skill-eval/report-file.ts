/**
 * On-disk REPORT.md writer for the skill-eval harness.
 *
 * Auto-regenerated next to each eval-set on every `/skill-eval` run
 * (Mode 2 single-sweep, Mode 3 iterate, Mode 4 --all sweep). The
 * markdown body comes pre-rendered from `report.ts` (Mode 2) or
 * `formatIterateReport` in `run-iterate.ts` (Mode 3). This module
 * appends a `_Last run: <iso>_` footer so the file is self-dated and
 * writes atomically via temp+rename so a crash mid-write cannot leave
 * a torn REPORT.md on disk.
 *
 * Pure of business logic — accepts the already-rendered markdown
 * instead of recomputing it. Tests against the filesystem helper
 * directly; the orchestrators call this from their `main()` only.
 */

import { renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WriteEvalSetReportFileArgs {
  readonly evalSetDir: string;
  readonly markdown: string;
  readonly runAt: Date;
}

export interface WriteEvalSetReportFileResult {
  readonly path: string;
  readonly bytesWritten: number;
}

/**
 * Write `<evalSetDir>/REPORT.md` atomically. The eval-set directory
 * MUST exist already — the caller (`run-eval-set.ts` / `run-iterate.ts`
 * / `run-all-sweep.ts`) only invokes this after loading the eval-set,
 * so a missing dir here is a bug; we surface it loudly rather than
 * silently `mkdir -p` something the operator never authored.
 */
export function writeEvalSetReportFile(
  args: WriteEvalSetReportFileArgs,
): WriteEvalSetReportFileResult {
  const dirStat = statSync(args.evalSetDir);
  if (!dirStat.isDirectory()) {
    throw new Error(
      `writeEvalSetReportFile: ${args.evalSetDir} is not a directory`,
    );
  }
  const path = join(args.evalSetDir, "REPORT.md");
  // PID-suffix the temp path so two concurrent writers (e.g. Mode 4 sweep
  // racing a Mode 2 single-sweep against the same eval-set) cannot collide
  // mid-rename. The try/finally guarantees a partial write from a crashed
  // `writeFileSync` (ENOSPC, EACCES) does not orphan a `.tmp` on disk.
  const tempPath = `${path}.${process.pid}.tmp`;
  const trimmed = args.markdown.replace(/\s+$/, "");
  const content = `${trimmed}\n\n_Last run: ${args.runAt.toISOString()}_\n`;
  try {
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, path);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup; the original error is what the caller needs.
    }
    throw err;
  }
  return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
}

export interface PersistEvalSetReportArgs {
  readonly evalSetPath: string;
  readonly markdown: string;
  readonly runAt: Date;
}

/**
 * CLI-friendly convenience: derive the eval-set directory from
 * `evalSetPath` (always `<dir>/eval-set.json`) and write REPORT.md
 * next to it. Saves every caller from importing `node:path` for the
 * dirname plumbing.
 */
export function persistEvalSetReport(
  args: PersistEvalSetReportArgs,
): WriteEvalSetReportFileResult {
  return writeEvalSetReportFile({
    evalSetDir: dirname(args.evalSetPath),
    markdown: args.markdown,
    runAt: args.runAt,
  });
}

export interface StderrLike {
  write(chunk: string): unknown;
}

/**
 * Persist + announce. The three CLI entry points (`run-eval-set.ts`,
 * `run-iterate.ts`, `run-all-sweep.ts`) all want the same shape: write
 * REPORT.md, then log the absolute path to stderr so the operator
 * sees where the report landed. Extracting the pair here keeps the
 * stderr line under one definition — a future cosmetics change (emoji
 * prefix, color, suppress when quiet) lands in one file.
 *
 * The `stderr` param is injectable for tests so they can capture the
 * announcement without touching the real `process.stderr`.
 */
export function persistEvalSetReportWithLog(
  args: PersistEvalSetReportArgs,
  stderr: StderrLike = process.stderr,
): WriteEvalSetReportFileResult {
  const result = persistEvalSetReport(args);
  stderr.write(`REPORT.md written: ${result.path}\n`);
  return result;
}
