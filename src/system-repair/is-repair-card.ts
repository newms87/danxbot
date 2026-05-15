/**
 * DX-564 (Phase 4 of DX-560 — Self-Repair): card-shape detector the
 * picker uses to route a repair-attempt card to the `self-repair`
 * workspace instead of the generic `issue-worker` workspace.
 *
 * Routing key:
 *
 *   The Phase-3 dispatcher (`src/cron/jobs/self-repair-dispatch.ts`)
 *   creates every repair-attempt card with the title
 *   `Self-Repair > Attempt N: <category_key> (<signature_hash>)` — the
 *   format hard-coded in `src/system-repair/card-factory.ts#buildRepairCardDraft`.
 *   The title prefix is the routing marker. We do NOT use `parent_id`
 *   (every phase card under epic DX-560 has the same `parent_id` but
 *   should dispatch to `issue-worker`, not `self-repair`) and we do NOT
 *   add a `labels: string[]` field to the issue YAML schema (the
 *   schema bump would force a `@thehammer/danx-issue-mcp` republish,
 *   widening the blast radius of this change for zero functional gain).
 *
 *   The detector is purposely tight — it matches ONLY the literal
 *   `Self-Repair > Attempt ` prefix. Phase cards under the epic
 *   (`Self-Repair > Phase N:`) fall through to the issue-worker
 *   workspace as expected.
 *
 * Workspace name:
 *
 *   `SELF_REPAIR_WORKSPACE` is the single source of truth string for
 *   `<repo>/.danxbot/workspaces/self-repair/`. Importing it in the
 *   picker (`src/poller/multi-agent-pick.ts`) keeps the picker's
 *   workspace decision colocated with the detector contract.
 */

import type { Issue } from "../issue-tracker/interface.js";

/** Name of the workspace the self-repair plugin skill runs in. */
export const SELF_REPAIR_WORKSPACE = "self-repair";

/**
 * Slash-command name the picker dispatches as the work-pass for
 * self-repair cards (replaces `/danx-next` in the task body). Matches
 * the plugin skill's `name:` frontmatter at
 * `~/web/claude-plugins/danxbot/skills/self-repair/SKILL.md` — Claude
 * Code resolves `/<name>` to the plugin skill, so this constant IS
 * the contract surface between the picker and the skill.
 */
export const SELF_REPAIR_SLASH_COMMAND = "self-repair";

/**
 * Title prefix the Phase-3 dispatcher stamps on every repair-attempt
 * card. The producer (`buildRepairCardDraft` in
 * `src/system-repair/card-factory.ts`) imports and uses this constant
 * directly when building the title, so producer + consumer cannot
 * drift — a single edit here renames every repair card going forward.
 */
export const SELF_REPAIR_TITLE_PREFIX = "Self-Repair > Attempt ";

/**
 * Returns `true` when the candidate card is a Phase-3 repair-attempt
 * card and therefore should dispatch into the `self-repair` workspace
 * instead of the default `issue-worker` workspace.
 *
 * Pure function — no DB, no FS. The picker calls it on every
 * `attemptDispatch` candidate. False for any card that does not match
 * the literal title prefix, including the epic's own phase cards
 * (`Self-Repair > Phase N:`).
 */
export function isSelfRepairCard(issue: Pick<Issue, "title">): boolean {
  return issue.title.startsWith(SELF_REPAIR_TITLE_PREFIX);
}
