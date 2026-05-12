/**
 * Single-probe primitive for the skill-eval harness.
 *
 * One probe = one POST to `/api/launch`, one poll loop until terminal,
 * one JSONL discovery + trigger evaluation. Returns a structured
 * `ProbeResult` with the verdict, usage tokens, dispatch metadata, and
 * the path to the produced JSONL.
 *
 * Pure interface: HTTP transport + filesystem reads happen here, but the
 * function returns ALL diagnostic data the caller needs without writing
 * to stdout / stderr / process.exit. Throws `ProbeError` (subclassed
 * by category) on transport failure so the caller can decide how to
 * surface it — single-query CLI exits non-zero; eval-set runner records
 * the failure as a "did-not-trigger" run and keeps going.
 *
 * The reusable orchestration this exposes is what the eval-set runner
 * calls 60+ times in a single sweep (20 queries × 3 runs). Side effects
 * are limited to one fetch + one polling loop + one filesystem scan per
 * call; no global state.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { deriveSessionDir } from "../agent/session-log-watcher.js";
import {
  evaluateSkillTrigger,
  type SkillTriggerVerdict,
} from "./jsonl-parser.js";

export type ProbeErrorCategory =
  | "worker-unreachable"
  | "launch-failed"
  | "status-failed"
  | "timeout"
  | "jsonl-not-found";

export class ProbeError extends Error {
  constructor(
    message: string,
    public readonly category: ProbeErrorCategory,
  ) {
    super(message);
  }
}

export interface ProbeArgs {
  readonly query: string;
  readonly expectSkill: string;
  readonly workspace: string;
  readonly workerPort: number;
  readonly repoName: string;
  readonly workspaceCwd: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export interface ProbeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/**
 * Diagnostic returned by JSONL discovery so the caller can map each
 * failure mode to a distinct operator-readable message. Four failure
 * modes the operator must distinguish: (a) the session dir was never
 * created (claude never attached — usually broken auth, see
 * `agent-dispatch.md` "silent dispatch failures"); (b) the dir exists
 * but is empty; (c) the dir has JSONLs but none contained the tag
 * (wrong workspace cwd, or claude wrote to a different cwd); (d) one or
 * more files were unreadable (permissions).
 */
export interface JsonlDiscovery {
  readonly path: string | null;
  readonly dir: string;
  readonly reason:
    | "found"
    | "dir-missing"
    | "no-files"
    | "tag-not-in-any-file"
    | "unreadable-files";
  readonly scannedFiles: number;
  readonly unreadableFiles: readonly string[];
}

export interface ProbeResult {
  readonly jobId: string;
  readonly dispatchTag: string;
  readonly finalStatus: string;
  readonly jsonlPath: string | null;
  readonly discovery: JsonlDiscovery;
  readonly verdict: SkillTriggerVerdict;
  readonly usage: ProbeUsage;
  readonly elapsedMs: number;
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "canceled",
  "cancelled",
  "timeout",
  "recovered",
  "critical_failure",
  "api_error_recover",
  "api_error_failed",
]);

export function dispatchTagFor(jobId: string): string {
  return `<!-- danxbot-dispatch:${jobId} -->`;
}

/**
 * Resolver for the session-log directory derived from a workspace cwd.
 * Real callers pass `deriveSessionDir` (which reads `homedir()` and
 * encodes the cwd). Tests inject a stub pointing at a tempdir so they
 * never write under the operator's real `~/.claude/projects/`.
 */
export type SessionDirResolver = (workspaceCwd: string) => string;

export function findJsonlByTag(
  workspaceCwd: string,
  dispatchTag: string,
  resolveSessionDir: SessionDirResolver = deriveSessionDir,
): JsonlDiscovery {
  const dir = resolveSessionDir(workspaceCwd);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return {
      path: null,
      dir,
      reason: "dir-missing",
      scannedFiles: 0,
      unreadableFiles: [],
    };
  }
  const candidates = entries
    .filter((e) => e.endsWith(".jsonl"))
    .map((name) => {
      const path = resolve(dir, name);
      try {
        return { path, mtime: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((e): e is { path: string; mtime: number } => e !== null)
    .sort((a, b) => b.mtime - a.mtime);

  if (candidates.length === 0) {
    return {
      path: null,
      dir,
      reason: "no-files",
      scannedFiles: 0,
      unreadableFiles: [],
    };
  }

  const unreadable: string[] = [];
  let scanned = 0;
  for (const { path } of candidates) {
    scanned++;
    let contents: string;
    try {
      contents = readFileSync(path, "utf-8");
    } catch {
      unreadable.push(path);
      continue;
    }
    if (contents.includes(dispatchTag)) {
      return {
        path,
        dir,
        reason: "found",
        scannedFiles: scanned,
        unreadableFiles: unreadable,
      };
    }
  }
  return {
    path: null,
    dir,
    reason: unreadable.length > 0 ? "unreadable-files" : "tag-not-in-any-file",
    scannedFiles: scanned,
    unreadableFiles: unreadable,
  };
}

/**
 * Coerce a raw `/api/status` body field to a non-negative integer. The
 * launcher always populates `input_tokens` / `output_tokens` / etc. as
 * numbers (zero when no usage has been seen yet), but defensive coercion
 * here means a status payload with `null` or a string number doesn't
 * crash the eval-set sweep mid-run.
 */
function readUsageField(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

async function postLaunch(args: ProbeArgs): Promise<string> {
  const url = `http://localhost:${args.workerPort}/api/launch`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo: args.repoName,
        workspace: args.workspace,
        task: args.query,
        title: `skill-eval ${args.expectSkill}`,
      }),
    });
  } catch (err) {
    throw new ProbeError(
      `worker unreachable at ${url}: ${(err as Error).message}`,
      "worker-unreachable",
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new ProbeError(
      `launch returned ${response.status}: ${text}`,
      "launch-failed",
    );
  }
  let body: { job_id?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new ProbeError(
      `launch returned non-JSON body: ${text}`,
      "launch-failed",
    );
  }
  if (!body.job_id) {
    throw new ProbeError(
      `launch response missing job_id: ${text}`,
      "launch-failed",
    );
  }
  return body.job_id;
}

interface PollResult {
  readonly finalStatus: string;
  readonly usage: ProbeUsage;
}

async function pollUntilTerminal(
  args: ProbeArgs,
  jobId: string,
): Promise<PollResult> {
  const url = `http://localhost:${args.workerPort}/api/status/${jobId}`;
  const deadline = Date.now() + args.timeoutMs;
  // Hold the most recent successful usage so a late-evict 404 (job rolled
  // out of the 1-hour grace window between two polls) doesn't lose us
  // the cost data we already observed.
  let lastUsage: ProbeUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  while (Date.now() < deadline) {
    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      throw new ProbeError(
        `status poll failed: ${(err as Error).message}`,
        "status-failed",
      );
    }
    if (response.status === 404) {
      // job evicted from activeJobs after grace TTL — treat as terminal
      // but tag with a distinct `"evicted"` status so the caller's report
      // does NOT lie that the dispatch reached an explicit
      // success/failure terminal. We may have already captured usage on
      // an earlier 200; if not, lastUsage stays at zero. The JSONL on
      // disk still carries the real outcome — discovery + parsing
      // proceeds normally — but the report's status column tells the
      // truth about what `/api/status` reported.
      return { finalStatus: "evicted", usage: lastUsage };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "<unreadable>");
      throw new ProbeError(
        `status returned ${response.status}: ${text}`,
        "status-failed",
      );
    }
    const body = (await response.json()) as Record<string, unknown>;
    const status = typeof body.status === "string" ? body.status : "";
    // Capture usage on every 200 so we always have the freshest snapshot.
    lastUsage = {
      inputTokens: readUsageField(body.input_tokens),
      outputTokens: readUsageField(body.output_tokens),
      cacheReadTokens: readUsageField(body.cache_read_input_tokens),
      cacheCreationTokens: readUsageField(body.cache_creation_input_tokens),
    };
    if (status && TERMINAL_STATUSES.has(status)) {
      return { finalStatus: status, usage: lastUsage };
    }
    await new Promise((r) => setTimeout(r, args.pollIntervalMs));
  }
  throw new ProbeError(
    `dispatch did not reach terminal status within ${args.timeoutMs}ms — jobId=${jobId}`,
    "timeout",
  );
}

/**
 * Run one probe end-to-end and return the structured result. Caller
 * is responsible for formatting + exit codes; this function neither
 * writes to stdout/stderr nor calls process.exit.
 *
 * Errors fall into two categories:
 *   - `ProbeError` thrown for transport + dispatch + timeout failures —
 *     the dispatch never produced a usable verdict.
 *   - Returned ProbeResult with `verdict.pass: false` for cases where
 *     the dispatch ran but the expected skill didn't trigger — that is
 *     the FAIL outcome the harness measures, not an error.
 *
 * The discovery-reason failure modes (dir-missing, no-files,
 * tag-not-in-any-file, unreadable-files) are returned via `discovery`
 * AND throw a `ProbeError` of category `jsonl-not-found` — they are
 * runner errors (the dispatch happened but the JSONL evidence is
 * missing), not skill-load FAILs.
 */
export async function runProbe(
  args: ProbeArgs,
  resolveSessionDir?: SessionDirResolver,
): Promise<ProbeResult> {
  const startMs = Date.now();
  const jobId = await postLaunch(args);
  const dispatchTag = dispatchTagFor(jobId);
  const { finalStatus, usage } = await pollUntilTerminal(args, jobId);
  const discovery = findJsonlByTag(args.workspaceCwd, dispatchTag, resolveSessionDir);
  if (discovery.reason !== "found" || !discovery.path) {
    // The dispatch completed but we cannot evaluate the verdict — that
    // is a runner error, not a skill-load FAIL. Surface category so the
    // caller can decide whether to retry / continue / abort the sweep.
    throw new ProbeError(
      jsonlDiscoveryMessage(discovery, jobId, dispatchTag),
      "jsonl-not-found",
    );
  }
  const jsonl = readFileSync(discovery.path, "utf-8");
  const verdict = evaluateSkillTrigger(jsonl, dispatchTag, args.expectSkill);
  return {
    jobId,
    dispatchTag,
    finalStatus,
    jsonlPath: discovery.path,
    discovery,
    verdict,
    usage,
    elapsedMs: Date.now() - startMs,
  };
}

/**
 * Human-readable message for each JSONL-discovery failure mode. Exposed
 * (not module-private) so the single-query CLI can reuse the same text
 * after catching a `ProbeError`.
 */
export function jsonlDiscoveryMessage(
  disc: JsonlDiscovery,
  jobId: string,
  dispatchTag: string,
): string {
  switch (disc.reason) {
    case "dir-missing":
      return `session dir does not exist — claude never attached. Usually means broken claude-auth or wrong workspace cwd. Expected ${disc.dir}`;
    case "no-files":
      return `session dir is empty (${disc.dir}) — dispatch ${jobId} may have failed before writing any JSONL`;
    case "tag-not-in-any-file":
      return `scanned ${disc.scannedFiles} JSONL file(s) in ${disc.dir}; none contained dispatch tag ${dispatchTag}`;
    case "unreadable-files":
      return `scanned ${disc.scannedFiles} JSONL file(s); ${disc.unreadableFiles.length} unreadable (permissions?). No file contained dispatch tag ${dispatchTag}. Unreadable: ${disc.unreadableFiles.join(", ")}`;
    case "found":
      // Caller guarantee — but fall back to a useful message rather
      // than throwing again from inside the message-builder.
      return `JSONL discovery succeeded but path was null — runner bug; dir=${disc.dir}`;
  }
}
