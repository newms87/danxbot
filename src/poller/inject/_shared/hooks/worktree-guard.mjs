#!/usr/bin/env node
// DX-309: PreToolUse worktree-guard hook.
//
// Mechanical enforcement that agent-bound dispatches stay inside their
// own worktree. Reads the Claude Code PreToolUse JSON envelope from
// stdin, inspects the tool name + input, and either passes through
// (exit 0) or rejects (exit 2 with a stderr reason — Claude Code
// surfaces the reason back to the agent and aborts the tool call).
//
// Trust boundary:
//   - Activates ONLY when `DANX_AGENT_WORKTREE` is set in the env. The
//     dispatch layer (`src/dispatch/core.ts`) auto-injects this when
//     `input.agent` is resolved; non-agent dispatches leave it unset
//     and the hook passes everything through.
//   - Boundary check is BOTH literal-string prefix AND realpath, with
//     OK if either passes. Literal prefix accepts paths under the
//     `<worktree>/.danxbot/issues/` symlinked subtree (issues are
//     intentionally shared with main — see `provisionIssuesSymlink`);
//     realpath catches paths whose lexical form is suspicious but
//     resolves inside the worktree.
//
// Rejection surface:
//   Edit / Write / MultiEdit / NotebookEdit — file_path must be inside
//     the worktree (one of the two prefix checks above).
//   Bash — best-effort scan for write-flavored ops with absolute paths
//     outside the worktree. Catches obvious cases (`> /main/...`,
//     `git checkout`, `rm /main/...`, `mv x /main/...`, `sed -i ...
//     /main/...`); does not pretend to be a sandbox.
//
// Failure mode: any unexpected error in the hook prints a diagnostic
// to stderr and exits 0 (allow). A loud-fail on hook crashes would
// brick every dispatch on a transient parse glitch; surface the
// diagnostic instead but don't gate.

import { readFileSync, realpathSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Bash subcommand patterns that mutate a target path. Patterns extract
// an absolute-path argument; the surrounding flow then checks each one
// against the worktree boundary.
const BASH_WRITE_PATTERNS = [
  // Redirections — `cmd > /path`, `cmd >> /path`, `cmd | tee /path`.
  /(?:^|[\s;|&])(?:>>?|tee\s+(?:-a\s+)?)\s*(\/[^\s;|&<>"']+)/g,
  // File-manipulation utilities operating on absolute paths.
  /(?:^|[\s;|&])(?:rm|mv|cp|ln|chmod|chown|touch|mkdir|rmdir|sed\s+-i[^\s]*|truncate)(?:\s+-[a-zA-Z]+)*\s+(\/[^\s;|&<>"']+)/g,
];

// git ops that mutate the working tree — flagged regardless of args
// because `git checkout`, `git switch`, `git reset --hard` etc. operate
// on the repo's CWD and would silently corrupt the branch the agent is
// supposed to stay on. Allowed: `git status`, `git diff`, `git log`,
// `git show` — anything that mutates the index or worktree is denied.
const BASH_DENIED_GIT_SUBCOMMANDS = new Set([
  "checkout",
  "switch",
  "restore",
  "reset",
  "clean",
  "stash",
  "rebase",
  "merge",
  "pull",
  "cherry-pick",
  "apply",
  "worktree",
]);

const TOOL_INPUT_FILE_FIELDS = ["file_path", "notebook_path", "path"];

main();

function main() {
  let raw;
  try {
    raw = readFileSync(0, "utf-8");
  } catch (err) {
    diag(`stdin read failed: ${err?.message ?? err}`);
    process.exit(0);
  }

  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (err) {
    diag(`envelope parse failed: ${err?.message ?? err}`);
    process.exit(0);
  }

  const worktree = process.env.DANX_AGENT_WORKTREE;
  if (!worktree) {
    // Non-agent dispatch — no boundary to enforce.
    process.exit(0);
  }

  let worktreeReal;
  try {
    worktreeReal = realpathSync(worktree);
  } catch {
    diag(`DANX_AGENT_WORKTREE missing on disk: ${worktree}`);
    process.exit(0);
  }

  const toolName = envelope.tool_name ?? "";
  const toolInput = envelope.tool_input ?? {};

  let denial = null;
  if (WRITE_TOOLS.has(toolName)) {
    denial = checkWritePath(toolInput, worktree, worktreeReal);
  } else if (toolName === "Bash") {
    denial = checkBashCommand(toolInput, worktree, worktreeReal);
  }

  if (denial) {
    process.stderr.write(denial + "\n");
    process.exit(2);
  }
  process.exit(0);
}

function checkWritePath(toolInput, worktreeLiteral, worktreeReal) {
  for (const field of TOOL_INPUT_FILE_FIELDS) {
    const value = toolInput[field];
    if (typeof value !== "string" || value.length === 0) continue;
    const verdict = isPathInsideWorktree(value, worktreeLiteral, worktreeReal);
    if (!verdict.ok) {
      return (
        `worktree-guard: ${field}=${value} is outside DANX_AGENT_WORKTREE=${worktreeLiteral} ` +
        `(${verdict.reason}). Edit files inside <worktree>/ or, for shared issue YAMLs, ` +
        `under <worktree>/.danxbot/issues/.`
      );
    }
  }
  return null;
}

function checkBashCommand(toolInput, worktreeLiteral, worktreeReal) {
  const cmd = toolInput.command;
  if (typeof cmd !== "string") return null;

  // Mutating git subcommands — block outright (regardless of path).
  const gitDenial = findDeniedGitSubcommand(cmd);
  if (gitDenial) {
    return (
      `worktree-guard: bash command runs \`git ${gitDenial}\` which mutates the worktree. ` +
      `Agent dispatches must not run destructive git ops — branch finalization is the ` +
      `worker's responsibility (see WorktreeManager).`
    );
  }

  for (const pattern of BASH_WRITE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(cmd)) !== null) {
      const path = match[1];
      if (!path || !isAbsolute(path)) continue;
      const verdict = isPathInsideWorktree(path, worktreeLiteral, worktreeReal);
      if (!verdict.ok) {
        return (
          `worktree-guard: bash command writes to ${path} which is outside ` +
          `DANX_AGENT_WORKTREE=${worktreeLiteral} (${verdict.reason}). Operate inside ` +
          `<worktree>/ or under <worktree>/.danxbot/issues/.`
        );
      }
    }
  }
  return null;
}

function findDeniedGitSubcommand(cmd) {
  const re = /(?:^|[\s;|&(])git\s+([a-z-]+)/g;
  let match;
  while ((match = re.exec(cmd)) !== null) {
    const sub = match[1];
    if (BASH_DENIED_GIT_SUBCOMMANDS.has(sub)) return sub;
  }
  return null;
}

function isPathInsideWorktree(target, worktreeLiteral, worktreeReal) {
  // 1. Literal-string prefix match against the worktree path the
  //    dispatch layer advertised. Accepts paths under the
  //    `<worktree>/.danxbot/issues/` symlinked subtree even though
  //    they realpath into main — that subtree is intentionally shared
  //    (single canonical issue YAML store).
  const abs = isAbsolute(target) ? target : resolve(target);
  const wtNorm = worktreeLiteral.replace(/\/+$/, "");
  if (abs === wtNorm || abs.startsWith(wtNorm + "/")) return { ok: true };

  // 2. realpath comparison — handles paths with symlinks that
  //    ultimately resolve inside the worktree.
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    return { ok: false, reason: "literal-prefix miss + realpath unavailable" };
  }
  const wtRealNorm = worktreeReal.replace(/\/+$/, "");
  if (real === wtRealNorm || real.startsWith(wtRealNorm + "/")) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `realpath=${real} not under worktree=${wtRealNorm}`,
  };
}

function diag(msg) {
  try {
    process.stderr.write(`worktree-guard: ${msg}\n`);
  } catch {
    // best-effort
  }
}
