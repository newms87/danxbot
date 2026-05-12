/**
 * Persona prefix builder — DX-162 / multi-worker dispatch epic DX-158.
 *
 * Phase 4 of the epic: every dispatched agent that has a resolved
 * `agent` (operator-defined in `<repo>/.danxbot/settings.json`) gets a
 * persona block prepended as the first paragraph of its prompt. The
 * block carries the agent's name, free-form bio, the absolute path of
 * the agent's persistent worktree, and the branch name (== agent name).
 *
 * Spec: `docs/superpowers/specs/2026-05-08-multi-worker-dispatch-design.md`
 * "Persona injection" section.
 *
 * Why a separate module:
 *   - `claude-invocation.ts` is a generic CLI invocation builder shared
 *     by every dispatch caller; persona is a danxbot-domain concept that
 *     does not belong in the runtime fork.
 *   - `dispatch/core.ts` is the single funnel that knows about both the
 *     `agent` parameter and the prompt body, but the prepend logic is
 *     pure string composition — easier to test in isolation, easier to
 *     reuse if a future caller needs to render a persona block outside
 *     of dispatch (e.g. a dashboard prompt-preview endpoint).
 *
 * Why prepend (not separate flag):
 *   - Claude Code's `claude -p` / first-user-turn shape only takes a
 *     prompt body; there's no first-class "system persona" channel for
 *     the dispatched-agent path. Prepending is the only mechanism that
 *     makes the persona visible to the agent on its very first read.
 *   - Empirically (~200 token overhead per dispatch) is acceptable.
 *
 * The prepend wraps BOTH normal and recovery dispatches automatically
 * because the recovery-mode helper (`src/dispatch/recovery-mode.ts`)
 * routes through the same `dispatch()` entry point — `dispatch()` does
 * the prepend, recovery just supplies a different task body.
 */

/**
 * The slim persona shape — name + bio. The worktree path is supplied
 * separately (by the dispatch layer via `agentWorktreePath()`) so this
 * module never duplicates path construction. A single producer
 * eliminates the class of bug where persona advertised one spelling
 * (via `repo.localPath` symlink) and the task body advertised another
 * (via `manager.worktreePath` / `repo.hostPath`), tripping Claude's
 * read-before-edit gate on identical inodes.
 */
export interface PersonaContext {
  /**
   * Agent name — URL-safe, branch-name-safe, path-safe shape enforced
   * by `AGENT_NAME_SHAPE` in `settings-file.ts`. Used as the branch
   * name AND the worktree directory name AND the `Your branch:`
   * literal in the prefix.
   */
  name: string;
  /**
   * Free-form markdown body. Operator-authored content — surfaced
   * verbatim. The dispatch caller is responsible for not passing
   * untrusted user input here; today the only writers are the
   * dashboard agent CRUD endpoints (operator-authenticated) and
   * settings.json hand-edits (operator-only).
   */
  bio: string;
}

/**
 * Reserved persona-trailer markers. The dispatched-agent SKILL's "Step 7a"
 * routes on the literal `Your worktree:` / `Your branch:` lines being the
 * last two lines of the persona block — an operator-authored bio that
 * embeds those substrings would shift which line the agent reads as its
 * worktree, sending finalize ops to the wrong path or branch.
 *
 * `You are ` is reserved for the same reason on the leading line: a bio
 * that starts with `You are bob.` would confuse a future poller-side
 * regex that hunts for the persona block in JSONL output.
 *
 * Reject at build time so the dashboard CRUD layer surfaces the error to
 * the operator on save (instead of producing a broken dispatch six hours
 * later).
 */
const RESERVED_BIO_SUBSTRINGS = [
  "Your worktree:",
  "Your branch:",
  "You are ",
] as const;

/**
 * Same layout the design spec specifies:
 *
 *   You are <Name>.
 *
 *   <bio markdown>
 *
 *   Your worktree: <absolute worktree path>
 *   Your branch: <name>
 *
 *   IMPORTANT: every absolute path in the task body below — issue YAMLs,
 *   scripts, anything you Edit or Write — is anchored under that exact
 *   worktree string. Use it verbatim. Do not rewrite it through
 *   `repos/<name>` symlinks or any other alias.
 *
 * Returns a string with a trailing blank line so callers can
 * concatenate the task body directly without worrying about spacing.
 *
 * `worktreePath` MUST come from `agentWorktreePath()` in
 * `src/agent/worktree-manager.ts` — the single producer. Drift would
 * let the agent Read at one spelling and fail Edit at another (Claude's
 * read-before-edit gate keys on the literal path string).
 *
 * Throws if `agent.bio` contains a reserved persona-trailer substring
 * (`Your worktree:`, `Your branch:`, `You are `) — see
 * `RESERVED_BIO_SUBSTRINGS` for rationale. The dashboard agent CRUD
 * layer (`src/dashboard/agents-validation.ts` etc.) is the natural
 * place to surface this error to the operator on save; failing here
 * is the defense-in-depth gate.
 */
export function buildPersonaPrefix(opts: {
  worktreePath: string;
  agent: PersonaContext;
}): string {
  for (const reserved of RESERVED_BIO_SUBSTRINGS) {
    if (opts.agent.bio.includes(reserved)) {
      throw new Error(
        `persona bio contains reserved substring '${reserved}' — would corrupt the persona block's leading line / trailer-line invariants the dispatched-agent SKILL routes on (agent='${opts.agent.name}')`,
      );
    }
  }
  // `Your worktree:` + `Your branch:` MUST remain the final two lines
  // of the block — the dispatched-agent SKILL Step 7a routes on them
  // sitting as a trailing pair. The path-aliasing anchor therefore goes
  // BEFORE the trailer pair, after the bio.
  return (
    `You are ${opts.agent.name}.\n\n` +
    `${opts.agent.bio}\n\n` +
    `IMPORTANT — path discipline: every absolute path in the task body ` +
    `below (issue YAMLs, scripts, anything you Edit or Write) is anchored ` +
    `under the \`Your worktree:\` string two lines down. Use that string ` +
    `verbatim. Do not rewrite it through \`repos/<name>\` symlinks or any ` +
    `other alias — Claude's read-before-edit gate keys on the literal path ` +
    `string, so an aliased spelling fails even when both spellings resolve ` +
    `to the same file. The worktree-guard PreToolUse hook rejects writes ` +
    `whose literal prefix is not under \`Your worktree:\` for the same ` +
    `reason.\n\n` +
    `Your worktree: ${opts.worktreePath}\n` +
    `Your branch: ${opts.agent.name}\n\n`
  );
}

/**
 * Pass-through when `agent` is undefined — callers that don't resolve
 * an agent (legacy `/api/launch` without an agent context, ideator
 * dispatches, system-test smoke runs) get the original prompt back
 * byte-identical. No silent fallback to a default agent — the absence
 * of `agent` is a real signal.
 */
export function prependPersona(opts: {
  prompt: string;
  worktreePath: string;
  agent: PersonaContext | undefined;
}): string {
  if (!opts.agent) return opts.prompt;
  return (
    buildPersonaPrefix({ worktreePath: opts.worktreePath, agent: opts.agent }) +
    opts.prompt
  );
}
