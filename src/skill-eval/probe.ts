/**
 * Single-probe primitive for the skill-eval harness.
 *
 * One probe = one `claude -p` child_process spawn, one wait for the
 * subprocess to exit, one JSONL discovery + trigger evaluation. Returns
 * a structured `ProbeResult` with the verdict, usage tokens, exit
 * metadata, and the path to the produced JSONL.
 *
 * Transport: direct subprocess spawn — no danxbot worker dependency,
 * no `/api/launch`, no dispatches table row, no Windows Terminal tab.
 * Eval-set runs are entirely transport-free now; a single iterate at
 * `--parallel 8` opens 8 sibling claude subprocesses that all write
 * native JSONL to `~/.claude/projects/<encoded-cwd>/` and exit. The
 * harness reads back the JSONL the same way SessionLogWatcher does for
 * real dispatches.
 *
 * Errors fall into two categories:
 *   - `ProbeError` thrown for spawn / timeout / discovery failures —
 *     the subprocess never produced a usable verdict.
 *   - Returned `ProbeResult` with `verdict.pass: false` for cases where
 *     the dispatch ran but the expected skill didn't trigger — that is
 *     the FAIL outcome the harness measures, not an error.
 *
 * Side effects per call: one subprocess + one filesystem scan. No
 * global state, no HTTP, no global mutable maps.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { deriveSessionDir } from "../agent/session-log-watcher.js";
import {
  evaluateSkillTrigger,
  type SkillTriggerVerdict,
} from "./jsonl-parser.js";

export type ProbeErrorCategory = "spawn-failed" | "timeout" | "jsonl-not-found";

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
  readonly workspaceCwd: string;
  readonly timeoutMs: number;
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
  readonly exitCode: number | null;
  readonly jsonlPath: string | null;
  readonly discovery: JsonlDiscovery;
  readonly verdict: SkillTriggerVerdict;
  readonly usage: ProbeUsage;
  readonly elapsedMs: number;
}

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
 * Coerce a raw JSONL `message.usage` field to a non-negative integer.
 * Claude Code stamps numbers, but a malformed line shouldn't crash a
 * 60-probe sweep mid-run.
 */
function readUsageField(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

/**
 * Sum `message.usage` across every assistant entry in a JSONL body,
 * deduping by `message.id`. Claude Code stamps the same response-level
 * `message.usage` on every JSONL line that holds a content block from
 * the same API response — multi-block turns (text + tool_use + thinking)
 * would otherwise count 2-5× their real cost. The dedup contract is
 * documented in `.claude/rules/agent-dispatch.md` "Usage accumulation
 * MUST dedupe by message.id"; reference impl is
 * `src/dashboard/jsonl-reader.ts#parseJsonlContent` (same Set-per-call
 * shape, identical contract).
 *
 * Entries with no `message.id` are kept (defensive — never seen in
 * real Claude Code output) so a malformed line never silently zeroes
 * billable usage.
 */
export function sumUsageFromJsonl(jsonlText: string): ProbeUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  const seenMessageIds = new Set<string>();
  for (const line of jsonlText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (raw.type !== "assistant") continue;
    const message = raw.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const usage = message.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    const messageId =
      typeof message.id === "string" && message.id.length > 0
        ? message.id
        : null;
    if (messageId) {
      if (seenMessageIds.has(messageId)) continue;
      seenMessageIds.add(messageId);
    }
    inputTokens += readUsageField(usage.input_tokens);
    outputTokens += readUsageField(usage.output_tokens);
    cacheReadTokens += readUsageField(usage.cache_read_input_tokens);
    cacheCreationTokens += readUsageField(usage.cache_creation_input_tokens);
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

/**
 * Spawner type — injected by tests as a stub that produces a synthetic
 * ChildProcess. Real callers leave it as the default `spawn` import.
 * Signature matches `node:child_process#spawn`'s argv-first overload.
 */
export type SpawnFn = typeof spawn;

interface SpawnResult {
  readonly exitCode: number | null;
}

function spawnClaude(
  args: ProbeArgs,
  taggedPrompt: string,
  spawnFn: SpawnFn,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolveSpawn, rejectSpawn) => {
    let child: ChildProcess;
    try {
      child = spawnFn(
        "claude",
        [
          "-p",
          taggedPrompt,
          "--strict-mcp-config",
          "--mcp-config",
          ".mcp.json",
          "--dangerously-skip-permissions",
        ],
        {
          cwd: args.workspaceCwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (err) {
      rejectSpawn(
        new ProbeError(
          `claude spawn failed: ${(err as Error).message}`,
          "spawn-failed",
        ),
      );
      return;
    }

    const timer = setTimeout(() => {
      // SIGTERM the child; the close handler still fires with
      // `code: null, signal: 'SIGTERM'` which we surface as a timeout.
      try {
        child.kill("SIGTERM");
      } catch {
        // best-effort — if kill itself fails, the close handler will
        // resolve eventually or the parent process exits.
      }
      rejectSpawn(
        new ProbeError(
          `claude did not exit within ${args.timeoutMs}ms`,
          "timeout",
        ),
      );
    }, args.timeoutMs);

    child.once("error", (err) => {
      clearTimeout(timer);
      rejectSpawn(
        new ProbeError(
          `claude subprocess error: ${err.message}`,
          "spawn-failed",
        ),
      );
    });

    child.once("close", (code) => {
      clearTimeout(timer);
      resolveSpawn({ exitCode: code });
    });
  });
}

/**
 * Run one probe end-to-end and return the structured result. Caller
 * is responsible for formatting + exit codes; this function neither
 * writes to stdout/stderr nor calls process.exit.
 *
 * On a discovery failure (dir-missing, no-files, tag-not-in-any-file,
 * unreadable-files) the function throws `ProbeError(jsonl-not-found)`
 * carrying the operator-readable message — they are runner errors (the
 * dispatch happened but the JSONL evidence is missing), not skill-load
 * FAILs. On success the returned `ProbeResult.discovery` field carries
 * the `reason: "found"` record for downstream diagnostics.
 */
export async function runProbe(
  args: ProbeArgs,
  resolveSessionDir?: SessionDirResolver,
  spawnFn: SpawnFn = spawn,
): Promise<ProbeResult> {
  const startMs = Date.now();
  const jobId = randomUUID();
  const dispatchTag = dispatchTagFor(jobId);
  const taggedPrompt = `${dispatchTag} ${args.query}`;
  const { exitCode } = await spawnClaude(args, taggedPrompt, spawnFn);
  const discovery = findJsonlByTag(args.workspaceCwd, dispatchTag, resolveSessionDir);
  if (discovery.reason !== "found" || !discovery.path) {
    throw new ProbeError(
      jsonlDiscoveryMessage(discovery, jobId, dispatchTag),
      "jsonl-not-found",
    );
  }
  const jsonl = readFileSync(discovery.path, "utf-8");
  const verdict = evaluateSkillTrigger(jsonl, dispatchTag, args.expectSkill);
  const usage = sumUsageFromJsonl(jsonl);
  return {
    jobId,
    dispatchTag,
    exitCode,
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
