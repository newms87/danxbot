/**
 * Single source of truth for how a dispatched claude process is invoked.
 *
 * Produces three things used identically by both runtime paths (docker headless
 * + host interactive):
 *   - `promptDir`  — a fresh temp dir whose `prompt.md` holds the original prompt
 *   - `firstMessage` — the exact string claude sees as its first user turn
 *   - `flags`      — the shared CLI flag list (no prompt delivery mechanism)
 *
 * Docker adds `-p firstMessage` to flags. Host passes firstMessage as a
 * positional arg inside the bash dispatch script. The claude-facing shape
 * matches byte-for-byte in both modes (modulo the temp dir path) — the only
 * divergence is the spawn envelope (direct child_process vs wt.exe + script).
 *
 * See `.claude/rules/agent-dispatch.md` (Single Fork Principle) and
 * `.claude/rules/host-mode-interactive.md` for the invariants this enforces.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISPATCH_TAG_PREFIX } from "./session-log-watcher.js";

/** Shape of the Read directive claude sees as its first user turn.
 *  `${path}` is the absolute path to prompt.md. Any change to this template
 *  is observable in every dispatched session's JSONL — keep it stable. */
function readDirective(promptFile: string): string {
  return `Read ${promptFile} and execute the task described in it.`;
}

export interface BuildClaudeInvocationOptions {
  /** Full original prompt body. Written verbatim to prompt.md — never inlined
   *  on the command line, so no shell quoting concerns apply. */
  prompt: string;
  /** Dispatch job ID — embedded in the firstMessage so SessionLogWatcher can
   *  locate the JSONL session file for this spawn. */
  jobId: string;
  /** Optional short tracking label appended to firstMessage as a user-visible
   *  suffix (e.g. "Tracking: AgentDispatch #AGD-359"). Empty/undefined = no suffix. */
  title?: string;
  /** Optional path to MCP settings JSON. Adds `--mcp-config <path>` to flags. */
  mcpConfigPath?: string;
  /**
   * Optional explicit allowlist for the dispatched agent's tool surface. When
   * provided, emits `--allowed-tools <t1>,<t2>,...` so claude's deny-by-default
   * gate limits the agent to exactly these names. Produced by
   * `resolveDispatchTools()`; includes built-ins (`Read`, `Bash`, ...) and
   * MCP tools in the claude-surfaced `mcp__<server>__<tool>` form.
   *
   * Contract: each entry MUST NOT contain a comma — the CSV serialization
   * below has no escape form. `resolveDispatchTools` enforces this on its
   * inputs, so production callers are safe by construction.
   */
  allowedTools?: readonly string[];
  /** Optional agents map forwarded via `--agents <json>`. Empty object = no flag. */
  agents?: Record<string, Record<string, unknown>>;
  /**
   * Claude session UUID to resume via `--resume <id>`. When set, claude loads
   * the prior session's history and appends new turns to the same JSONL file.
   * The dispatch tag is still prepended to the firstMessage, so SessionLogWatcher
   * finds this spawn's slice of the shared JSONL by scanning for the new tag.
   */
  resumeSessionId?: string;
}

export interface ClaudeInvocation {
  /** Absolute path to the freshly-created temp dir containing prompt.md.
   *  Caller is responsible for rmSync-ing this directory once the agent exits. */
  promptDir: string;
  /** First user turn for the dispatched claude — contains the dispatch tag,
   *  the Read directive pointing at prompt.md, and the optional tracking line. */
  firstMessage: string;
  /** Shared CLI flags. Docker appends `-p firstMessage`; host passes
   *  firstMessage as a positional argument inside the bash script. */
  flags: string[];
}

export function buildClaudeInvocation(
  options: BuildClaudeInvocationOptions,
): ClaudeInvocation {
  const promptDir = mkdtempSync(join(tmpdir(), "danxbot-prompt-"));
  const promptFile = join(promptDir, "prompt.md");
  writeFileSync(promptFile, options.prompt, "utf-8");

  const tracking = options.title ? ` Tracking: ${options.title}` : "";
  const firstMessage =
    `${DISPATCH_TAG_PREFIX}${options.jobId} --> ` +
    readDirective(promptFile) +
    tracking;

  // `--strict-mcp-config` is load-bearing for agent isolation. With this
  // flag, claude IGNORES every project-scope and user-scope `.mcp.json` —
  // only servers listed in `--mcp-config` are visible to the dispatched
  // agent. This is the contract that lets use case #1 (the developer's
  // interactive `claude` at the repo root) keep its own MCP config
  // independently from every danxbot-dispatched agent. Changing or
  // removing this flag re-introduces the cross-contamination bug that
  // the agent-isolation epic (Trello 7ha2CSpc) was created to fix.
  const flags: string[] = [
    "--dangerously-skip-permissions",
    "--strict-mcp-config",
    "--verbose",
  ];

  if (options.resumeSessionId) {
    flags.push("--resume", options.resumeSessionId);
  }

  if (options.mcpConfigPath) {
    flags.push("--mcp-config", options.mcpConfigPath);
  }

  if (options.allowedTools && options.allowedTools.length > 0) {
    flags.push("--allowed-tools", options.allowedTools.join(","));
  }

  if (options.agents && Object.keys(options.agents).length > 0) {
    flags.push("--agents", JSON.stringify(options.agents));
  }

  return { promptDir, firstMessage, flags };
}

/**
 * Escape an arbitrary string for safe embedding inside a bash single-quoted
 * literal. The `'\''` idiom closes the current quote, emits a literal quote,
 * and reopens. Used by the host-mode dispatch script to pass firstMessage and
 * flag values to claude without shell-injection risk.
 */
export function bashSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
