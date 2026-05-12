/**
 * Pure prompt builders for branch-recovery dispatch (DX-161). Split out from
 * `recovery-mode.ts` so tests of the prompt content load no IO + no dispatch
 * core (avoids the `config.ts` env-var trap downstream tests inherit).
 */

import type { ValidationResult } from "../agent/worktree-manager.js";

/** Narrowed validation for the dirty branch. Caller has already proved state. */
export type DirtyValidation = Extract<ValidationResult, { state: "dirty" }>;

/** Marker prepended to recovery-mode dispatch prompts so log readers + dashboards
 *  can distinguish them from normal `work` dispatches at a glance. */
export const RECOVERY_MARKER = "<!-- danxbot-recovery -->";

/**
 * Build the recovery prompt for a dispatched agent.
 *
 * The prompt's structure is intentional:
 *   1. Identity + worktree path so the agent knows where it lives.
 *   2. Branch-state evidence (porcelain, ahead/behind) so the agent can
 *      decide what kind of cleanup to do. Fetch-failures get a special-cased
 *      message — surfacing "ahead 0, behind 0, no porcelain" + reason "git
 *      fetch failed" together would be self-contradictory.
 *   3. **Forbidden ops** stated explicitly + early — the highest-risk
 *      mistake an agent can make on this prompt is `git reset --hard`
 *      "to make the dirty state go away," which would silently lose the
 *      prior dispatch's work.
 *   4. Allowed ops to give the agent a clear menu of safe actions.
 *   5. The job: finish whatever WIP this branch represents, commit it
 *      cleanly, exit. Then call `danxbot_complete`.
 */
export function buildRecoveryPrompt(opts: {
  agentName: string;
  worktreePath: string;
  validation: DirtyValidation;
}): string {
  const { agentName, worktreePath, validation } = opts;
  const { porcelain, ahead, behind } = validation.details;
  const isFetchFailure = /git fetch origin failed/i.test(validation.reason);

  const stateBlock = isFetchFailure
    ? [
        `**Reason:** ${validation.reason}`,
        ``,
        `_The worker could not contact \`origin\` to measure branch state._`,
        `_Re-run \`git fetch origin\` from inside the worktree, then act on_`,
        `_the porcelain + ahead/behind output yourself._`,
      ].join("\n")
    : [
        `**Reason:** ${validation.reason}`,
        ``,
        `**Branch:** \`${agentName}\`  ·  **Ahead of origin/main:** ${ahead}  ·  **Behind:** ${behind}`,
        ``,
        `**\`git status --porcelain\`:**`,
        ``,
        porcelain
          ? `\`\`\`\n${porcelain}\n\`\`\``
          : "_(no uncommitted changes — the dirty state is from unmerged commits)_",
      ].join("\n");

  return [
    RECOVERY_MARKER,
    ``,
    `# Branch Recovery — ${agentName}`,
    ``,
    `Your worktree at \`${worktreePath}\` is in a state the worker cannot`,
    `safely reset before dispatching the next card. You have been spawned in`,
    `**recovery mode**: finish the in-flight work the branch represents,`,
    `commit it cleanly, and exit. The next dispatch will pick up a fresh card`,
    `against a freshly-validated worktree.`,
    ``,
    `## Why we're here`,
    ``,
    stateBlock,
    ``,
    `## STRICTLY FORBIDDEN`,
    ``,
    `You MUST NOT run any of the following — they would silently destroy work:`,
    ``,
    `- \`git reset --hard\` (any ref)`,
    `- \`git clean -fd\` / \`git clean -fdx\``,
    `- \`git checkout -- .\` / \`git checkout -- <path>\``,
    `- \`git restore --source=HEAD --staged --worktree\``,
    `- \`git push --force\` in the **no-lease** form against ANY ref (always forbidden, no exceptions)`,
    `- \`git push --force-with-lease\` against \`main\` (always forbidden)`,
    `- \`git push --force-with-lease\` against any branch other than your own (\`${agentName}\`) — never touch another agent's or operator's branch`,
    `- \`git rebase --abort\` followed by exit (the worker treats this as failure)`,
    `- \`rm\` against any tracked file as a way to "make conflicts go away"`,
    ``,
    `## Allowed operations`,
    ``,
    `- Read every file in the worktree (\`Read\`, \`Grep\`, \`Glob\`)`,
    `- Run tests / type-checks / linters`,
    `- Edit files (\`Edit\`, \`Write\`)`,
    `- Stage + commit (\`git add\`, \`git commit\`)`,
    `- Rebase onto \`origin/main\` (\`git pull --rebase origin main\`,`,
    `  \`git rebase origin/main\`) — resolve conflicts file-by-file`,
    `- Push the agent branch (\`git push origin ${agentName}\`)`,
    `- **Land work on \`main\` via \`.danxbot/scripts/agent-finalize.sh\`** — PREFERRED PATH for any clean rebased branch carrying landable card work. See "Branch finalize" below.`,
    `- **Graduate \`origin/${agentName}\` via \`--force-with-lease\` against YOUR OWN branch ONLY** — RESERVED for the edge case where local ahead-commits are patch-id-equivalent to commits already on \`main\` (origin/${agentName} carries stale pre-rebase shas). See "Branch graduation" below. Three independent locks.`,
    ``,
    `## Branch finalize (preferred — land card work on \`main\`)`,
    ``,
    `When your local \`${agentName}\` branch carries committed card work that is NOT yet on \`origin/main\` (the normal case for a recovery firing on "branch has unmerged commits"), the right move is to **land that work on main**, not to graduate \`origin/${agentName}\`. Danxbot has no PR flow — agents land work directly on \`origin/main\` via the existing \`.danxbot/scripts/agent-finalize.sh\` helper.`,
    ``,
    `**Decision tree.** Before doing anything destructive, run:`,
    ``,
    "```bash",
    `git fetch origin --quiet`,
    `git cherry origin/main HEAD     # ahead commits not patch-id on main`,
    `git status --porcelain          # uncommitted changes`,
    "```",
    ``,
    `- \`cherry\` shows any \`+\` line AND porcelain is empty AND tests + \`tsc --noEmit\` pass → **FINALIZE**. The ahead-commits are genuine landable work; land them on \`main\`.`,
    `- \`cherry\` shows only \`-\` lines (or empty) AND porcelain is empty → **GRADUATE** via the three-lock flow below. Local is patch-id-equivalent to main; you only need to graduate \`origin/${agentName}\`.`,
    `- porcelain non-empty → finish the WIP first (stage + commit + verify tests), then re-evaluate.`,
    ``,
    `**Finalize call.**`,
    ``,
    "```bash",
    `# 1. Identify the card. Scan <repo>/.danxbot/issues/open/*.yml for one whose`,
    `#    assigned_agent matches "${agentName}". If multiple match, pick the one`,
    `#    whose YAML or commit log most clearly describes the work in the ahead-`,
    `#    commits (read commit subjects via 'git log origin/main..HEAD').`,
    `CARD="DX-N"                                   # e.g. DX-310`,
    `TITLE="feat(${'$'}CARD): one-line summary"      # mirror your top commit's subject`,
    ``,
    `# 2. Run the existing helper. It squashes your branch onto origin/main, pushes`,
    `#    HEAD:main (fast-forward unless someone else pushed first — the script`,
    `#    retries on race), and resets your branch to a clean origin/main for the`,
    `#    next dispatch. No PR. No graduation needed.`,
    `bash .danxbot/scripts/agent-finalize.sh "${agentName}" "${'$'}CARD" "${'$'}TITLE" \\`,
    `  "first bullet describing what shipped" \\`,
    `  "second bullet — verification done, files touched, etc."`,
    "```",
    ``,
    `**Finalize exit codes** (already documented at the top of \`agent-finalize.sh\`):`,
    ``,
    `| Code | Meaning | Recovery |`,
    `|---|---|---|`,
    `| \`0\` | Success — squash pushed to \`main\`, branch reset to \`origin/main\` | call \`danxbot_complete({status: "completed", ...})\` |`,
    `| \`1\` | Rebase conflict during retry | resolve in \`<worktree>\`, \`git rebase --continue\`, re-invoke script |`,
    `| \`2\` | Push race exhausted (5 NFF rejects) | call \`danxbot_complete({status: "failed", ...})\` with the race summary |`,
    `| \`64\` | Usage error (bad \`<CARD-ID>\`, newline in title) | fix your invocation, re-run |`,
    `| \`65\` | Wrong branch | investigate the worktree state (you're not on \`${agentName}\`) |`,
    ``,
    `**Why finalize over graduation here.** Graduation pushes \`origin/${agentName}\` to your local rebased HEAD, but \`origin/${agentName}\` is a disposable per-agent branch — landing the work on \`main\` (which finalize does) accomplishes the same goal with the established flow + zero force-push surface. Reserve graduation for the case where the work IS already on \`main\` under different shas and only \`origin/${agentName}\` is stale.`,
    ``,
    `## Branch graduation (edge case — patch-id-equivalent commits already on \`main\`)`,
    ``,
    `_Use the finalize flow above first. This section ONLY applies when \`git cherry origin/main HEAD\` shows zero \`+\` lines (every ahead-commit is patch-id-matched on \`main\`) and the only remaining wedge is \`origin/${agentName}\` still pointing at pre-rebase shas._`,
    ``,
    `### Three-lock force-with-lease on \`origin/${agentName}\` (DX-330)`,
    ``,
    `When your rebased local branch's ahead-commits are patch-id-equivalent to`,
    `commits already on \`origin/main\` (the standard rebase-and-merge tail),`,
    `\`origin/${agentName}\` may still point at pre-rebase shas. A plain`,
    `\`git push origin ${agentName}\` is rejected non-fast-forward in that case.`,
    `You may graduate \`origin/${agentName}\` to the rebased local HEAD via`,
    `\`--force-with-lease\` **ONLY against your own branch** and **ONLY after`,
    `running ALL THREE locks below in order**. If ANY lock fails, ABORT,`,
    `leave the branch alone, and follow the abort path at the bottom of`,
    `this section.`,
    ``,
    `**Lock 1 — patch-id audit on remote.** Every commit on`,
    `\`origin/${agentName}\` must already be patch-id-matched on \`origin/main\`:`,
    ``,
    "```bash",
    `git fetch origin --quiet`,
    `git cherry origin/main origin/${agentName}`,
    "```",
    ``,
    `Expected: empty stdout, or only \`-\`-prefixed lines. ANY \`+\` line means`,
    `\`origin/${agentName}\` carries unique work that has not reached`,
    `\`origin/main\` yet. ABORT — do NOT force-push.`,
    ``,
    `**Lock 2 — capture the expected remote sha for \`--force-with-lease\`.**`,
    ``,
    "```bash",
    `EXPECTED_SHA="$(git rev-parse origin/${agentName})"`,
    "```",
    ``,
    `This sha pins the lease: if anyone (another agent, operator, CI)`,
    `pushes to \`origin/${agentName}\` between this read and your force-push,`,
    `the lease rejects and ABORTS the push.`,
    ``,
    `**Lock 3 — push a pre-force backup tag UNCONDITIONALLY first.** The`,
    `tag preserves the OLD \`origin/${agentName}\` tip as a durable named`,
    `ref on the remote, so a buggy patch-id audit (whitespace, signed-only`,
    `diff) is still recoverable:`,
    ``,
    "```bash",
    `TS="$(date -u +%Y%m%dT%H%M%SZ)"`,
    `TAG="recovery/${agentName}-pre-force-$TS"`,
    `git tag "$TAG" "$EXPECTED_SHA"`,
    `git push origin "refs/tags/$TAG"`,
    `git ls-remote origin "refs/tags/$TAG" | grep -q .   # MUST exit 0 before the force-push fires`,
    "```",
    ``,
    `**ONLY** after \`git ls-remote\` confirms the tag landed do you run the`,
    `force-push:`,
    ``,
    "```bash",
    `git push --force-with-lease="${agentName}:$EXPECTED_SHA" origin "${agentName}"`,
    "```",
    ``,
    `**Abort path** (any lock fails — patch-id audit non-empty, tag push`,
    `fails, \`ls-remote\` confirmation fails, or \`--force-with-lease\` rejects):`,
    ``,
    `1. Do NOT retry without the locks. Do NOT fall back to bare`,
    `   \`git push --force\`. Do NOT skip the patch-id audit.`,
    `2. Find the most-recently-modified open card under`,
    `   \`<repo>/.danxbot/issues/open/\` (newest \`mtime\`).`,
    `3. Append a comment to its \`comments[]\` titled`,
    `   \`## Branch graduation aborted — operator action required\` naming`,
    `   the specific lock that failed, the agent name, the worktree path,`,
    `   and the verbatim stderr of the failing command.`,
    `4. Call \`danxbot_complete({status: "failed", summary: "Recovery aborted: <lock-name> failed for origin/${agentName}"})\`.`,
    ``,
    `## Your task`,
    ``,
    `1. \`cd ${worktreePath}\` (or use absolute paths against this dir).`,
    `2. Identify the in-progress card: scan \`<repo>/.danxbot/issues/open/*.yml\``,
    `   for any card whose \`assigned_agent\` field matches \`${agentName}\`. If`,
    `   no card matches (the \`assigned_agent\` schema is filled by Phase 5 /`,
    `   DX-200 — until then no card will match), the branch carries pure WIP —`,
    `   your job is to commit it with a descriptive message and exit clean.`,
    `3. If a card matches: read it, understand the AC scope, finish whatever`,
    `   work the porcelain + commits represent. Stage + commit. Verify tests.`,
    `4. Once the working tree is clean and the branch is ready, call`,
    `   \`danxbot_complete({status: "completed", summary: "<one-line outcome>"})\`.`,
    `5. If you cannot finish the recovery (genuinely lost state, conflicting`,
    `   intent), call \`danxbot_complete({status: "failed", summary: "<reason>"})\`.`,
    `   The worker will re-validate the worktree and file a Needs Help`,
    `   comment on the most-recently-modified card so an operator can step in.`,
    ``,
    `Do not pause for confirmation. Do not ask the operator a question. Do not`,
    `dispatch a sub-agent for the cleanup itself — the worktree state is your`,
    `responsibility, in this session.`,
  ].join("\n");
}

/**
 * Build the body of the "Branch recovery still dirty" comment that
 * `dispatchInRecoveryMode` appends to the most-recently-modified open
 * card when a recovery dispatch finishes but the worktree is still dirty.
 */
export function buildStillDirtyComment(
  agentName: string,
  post: DirtyValidation,
): string {
  const { porcelain, ahead, behind } = post.details;
  const porcelainBlock = porcelain
    ? `\`\`\`\n${porcelain}\n\`\`\``
    : "_(no uncommitted changes — dirty state is from unmerged commits)_";
  return [
    `## Branch recovery still dirty — operator action required`,
    ``,
    `Agent **${agentName}**'s recovery dispatch finished but the worktree is`,
    `still in a state the worker cannot safely reset.`,
    ``,
    `- **Reason:** ${post.reason}`,
    `- **Ahead of \`origin/main\`:** ${ahead}`,
    `- **Behind:** ${behind}`,
    ``,
    `**\`git status --porcelain\`:**`,
    ``,
    porcelainBlock,
    ``,
    `**Operator next steps:**`,
    ``,
    `1. \`ssh\` to the worker host and \`cd\` into the worktree at`,
    `   \`<repo>/.danxbot/worktrees/${agentName}/\`.`,
    `2. Inspect the changes manually (\`git diff\`, \`git log origin/main..HEAD\`).`,
    `3. Either complete the work yourself + commit, or rescue the diff and`,
    `   \`git reset --hard origin/main\`.`,
    `4. The next poller tick will pick this card up automatically once the`,
    `   worktree validates clean.`,
  ].join("\n");
}
