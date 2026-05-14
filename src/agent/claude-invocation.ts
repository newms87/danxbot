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
 * See `.claude/rules/agent-dispatch.md` — Single Fork Principle + the
 * "Host mode MUST be interactive" section enforce these invariants.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISPATCH_TAG_PREFIX } from "./session-log-watcher.js";

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
   * Optional path to a Claude Code settings JSON file. Adds `--settings <path>`
   * to flags. Used to load workspace-level `.claude/settings.json` (e.g. hook
   * registrations) without relying on Claude Code's project-trust dialog —
   * dispatched workers run untrusted workspace dirs by default, so the
   * project-scope settings file is otherwise ignored. Pass an absolute path.
   */
  settingsPath?: string;
  /** Optional agents map forwarded via `--agents <json>`. Empty object = no flag. */
  agents?: Record<string, Record<string, unknown>>;
  /**
   * Top-level agent name forwarded via `--agent <name>`. When set, claude
   * makes the top-level session BECOME the named agent — its
   * `.claude/agents/<name>.md` frontmatter (notably the `tools:` allowlist)
   * applies, so MCP tools are eager-loaded instead of deferred behind
   * ToolSearch. Empty string omitted to avoid silent fallback.
   */
  topLevelAgent?: string;
  /**
   * Optional Claude model name forwarded as `--model <name>`. When unset,
   * claude resolves the model from its own defaults (env / settings /
   * built-in). Use to pin a specific model on a per-dispatch basis.
   */
  model?: string;
  /**
   * DX-513 — opaque per-model effort knob. When the selected `model` is a
   * thinking-capable family (sonnet, opus), the value is forwarded as
   * `--effort <value>` to claude. For haiku models the flag is omitted
   * (no thinking budget exists). Values outside claude's accepted set
   * (`low|medium|high|xhigh|max`) are silently dropped — the operator's
   * default ladder uses `"minimal"` on the haiku rows which falls into
   * exactly that drop branch (haiku's `model.startsWith("claude-haiku")`
   * gate would skip the flag anyway, but the validation gate covers a
   * future operator who pastes `"minimal"` onto a sonnet row).
   */
  effort?: string;
  /**
   * Claude session UUID to resume via `--resume <id>`. When set, claude loads
   * the prior session's history and appends new turns to the same JSONL file.
   * The dispatch tag is still prepended to the firstMessage, so SessionLogWatcher
   * finds this spawn's slice of the shared JSONL by scanning for the new tag.
   */
  resumeSessionId?: string;
}

/**
 * DX-513 — claude CLI's `--effort` flag accepts exactly these values
 * (per `claude --help`). Any other knob value (e.g. the default
 * ladder's `"minimal"` haiku effort, or an operator typo) is dropped
 * at flag-emission time rather than passed verbatim — passing an
 * unknown value would fail loud inside claude's argv parser and abort
 * the spawn.
 */
const KNOWN_CLAUDE_EFFORT_VALUES: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * DX-513 — decide whether a `--effort` flag should be emitted for the
 * resolved `{model, effort}` pair.
 *
 * Two gates, both must clear:
 *   1. Model is thinking-capable. Haiku models have no thinking
 *      budget; the flag is meaningless and CLI parsing rejects it
 *      depending on the model selection. Skip silently.
 *   2. Effort value is in claude's accepted set. Operator-supplied
 *      values that fall outside the set (the ladder's `"minimal"`,
 *      operator typos, future CLI extensions we haven't caught up
 *      to) are dropped silently — the spawn proceeds without the
 *      flag, claude uses its own default for the model.
 *
 * Exported for unit-test transparency. Production callers consume the
 * flag emission via `buildClaudeInvocation` directly; this helper is
 * not on a hot path.
 */
export function effortFlagFor(
  model: string | undefined,
  effort: string | undefined,
): string[] {
  if (!model || !effort) return [];
  if (model.startsWith("claude-haiku")) return [];
  if (!KNOWN_CLAUDE_EFFORT_VALUES.has(effort)) return [];
  return ["--effort", effort];
}

/**
 * Prompt bodies at or below this length are inlined directly into the
 * firstMessage instead of being written to a temp prompt.md and attached via
 * `@<path>`. Most poller dispatches are tiny (`/danx-next` + a one-line YAML
 * pointer + the danxbot_complete reminder fits comfortably here) and don't
 * need the file-attachment ceremony — the `@<path>` form forces claude to
 * make an extra Read tool call for content that could have been in the first
 * user turn directly. Larger prompts (epic handoffs, multi-section design
 * dumps) still go through the temp file because argv has a 128KB cap and
 * because at that size the file is more readable in debug artifacts than a
 * giant inline blob.
 *
 * The threshold is bytes, not chars — `Buffer.byteLength` would be the strict
 * argv-size measure, but for ASCII-heavy prompts `String#length` is close
 * enough and avoids importing `Buffer`. Keep this conservative.
 */
export const INLINE_PROMPT_THRESHOLD = 2000;

export interface ClaudeInvocation {
  /**
   * Absolute path to the freshly-created temp dir containing prompt.md when
   * the prompt was over `INLINE_PROMPT_THRESHOLD`. `null` when the prompt was
   * inlined directly into firstMessage (no temp dir was created).
   *
   * Callers must guard cleanup: `if (promptDir) rmSync(promptDir, …)`.
   */
  promptDir: string | null;
  /** First user turn for the dispatched claude — contains the dispatch tag,
   *  either the inlined prompt body OR the `@<path-to-prompt.md>` file
   *  attachment, and the optional tracking line. */
  firstMessage: string;
  /** Shared CLI flags. Docker appends `-p firstMessage`; host passes
   *  firstMessage as a positional argument inside the bash script. */
  flags: string[];
}

export function buildClaudeInvocation(
  options: BuildClaudeInvocationOptions,
): ClaudeInvocation {
  const tracking = options.title ? ` Tracking: ${options.title}` : "";

  // Short prompts inline directly into the first user turn — no temp file,
  // no `@<path>` attachment, one fewer claude tool round-trip.
  let promptDir: string | null = null;
  let body: string;
  if (options.prompt.length <= INLINE_PROMPT_THRESHOLD) {
    body = options.prompt;
  } else {
    // Larger prompts: write to a temp prompt.md and attach via Claude Code's
    // native `@<path>` positional syntax. Small files inline into the turn as
    // text; very large files (>128KB MAX_ARG_STRLEN territory) fall back to a
    // Read-tool call when `--dangerously-skip-permissions` is set (which it
    // always is for dispatched agents — see the flags block below). Keep a
    // space before `@` so tokenizers treat `@<path>` as a standalone file
    // reference.
    promptDir = mkdtempSync(join(tmpdir(), "danxbot-prompt-"));
    const promptFile = join(promptDir, "prompt.md");
    writeFileSync(promptFile, options.prompt, "utf-8");
    body = `@${promptFile}`;
  }

  const firstMessage = `${DISPATCH_TAG_PREFIX}${options.jobId} --> ${body}${tracking}`;

  // `--strict-mcp-config` is load-bearing for agent isolation. With this
  // flag, claude IGNORES every project-scope and user-scope `.mcp.json` —
  // only servers listed in `--mcp-config` are visible to the dispatched
  // agent. This is the contract that lets use case #1 (the developer's
  // interactive `claude` at the repo root) keep its own MCP config
  // independently from every danxbot-dispatched agent. Changing or
  // removing this flag re-introduces the cross-contamination bug that
  // the agent-isolation epic (Trello 7ha2CSpc) was created to fix.
  // `--setting-sources project,local` excludes the `user` settings tier
  // from the dispatched session. Without this, claude merges the host
  // user's `~/.claude/settings.json` (hooks, CAVEMAN-style additionalContext
  // injectors, sound-playing Stop hooks, custom PreToolUse permission
  // gates) into every dispatched workspace. That cross-contamination
  // breaks the workspace-isolation contract: a developer's personal
  // hooks have no business firing in an autonomous schema-builder
  // dispatch, and slow user-global Stop hooks (e.g. powershell.exe
  // SoundPlayer.PlaySync stalls in WSL→Windows interop) can hang the
  // dispatch indefinitely. The workspace's own `--settings <path>` is
  // still loaded explicitly below; only the user tier is skipped.
  const flags: string[] = [
    "--dangerously-skip-permissions",
    "--strict-mcp-config",
    "--verbose",
    "--setting-sources",
    "project,local",
  ];

  if (options.resumeSessionId) {
    flags.push("--resume", options.resumeSessionId);
  }

  if (options.topLevelAgent) {
    flags.push("--agent", options.topLevelAgent);
  }

  if (options.model) {
    flags.push("--model", options.model);
  }

  flags.push(...effortFlagFor(options.model, options.effort));

  if (options.mcpConfigPath) {
    flags.push("--mcp-config", options.mcpConfigPath);
  }

  if (options.settingsPath) {
    flags.push("--settings", options.settingsPath);
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
