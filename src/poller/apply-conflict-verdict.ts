/**
 * Apply a `ConflictVerdict` to the candidate's on-disk YAML.
 *
 * v7 — conflict-check verdicts persist on the candidate so the next
 * tick reads them from the DB-mirrored YAML and skips dispatch
 * cheaply (no Sonnet call). The picker invokes this helper
 * immediately after a non-`ok` verdict; the chokidar mirror picks up
 * the YAML change and updates the `issues` projection so
 * `listDispatchableYamls` filters the card out on the next tick.
 *
 * Three branches:
 *   - `kind: "ok"` — handled by caller (no call into here).
 *   - `kind: "conflict"` with non-empty `partners[]` → append each
 *     `{id, reason}` to `candidate.conflict_on[]` (deduplicating).
 *     Status / waiting_on / blocked NOT touched.
 *   - `kind: "wait_for"` with non-empty `wait_for[]` AND a valid
 *     `consumed_artifact` AND a defensive cycle re-check that passes
 *     → set `candidate.waiting_on = {reason, timestamp, by}` (DURABLE
 *     audit-trail record). Status normalized to ToDo by the existing
 *     `forceWaitingOnToToDo` write-path invariant.
 *
 * **Defensive cycle re-check (wait_for):** before stamping, this
 * helper re-walks the candidate's `wait_for` partners through the
 * supplied `liveInProgress` set's `waiting_on.by[]` chains. If the
 * candidate's id appears in any transitive chain → demote to
 * `conflict` (using the wait_for partner ids as `conflict_on`
 * entries) and log the demotion. Belt-and-suspenders alongside the
 * LLM's own `cycle_audit.walked` declaration.
 *
 * **Empty partner / wait_for lists** (the conservative-on-failure
 * verdict from `runConflictCheck`) → return "transient" without
 * touching the YAML. Same semantics as the pre-v7 transient skip.
 *
 * Return values:
 *   - `"transient"` — no YAML write happened (empty partners /
 *     conservative-on-failure verdict). Picker logs + skips this
 *     tick only.
 *   - `"conflict_on"` — stamped `candidate.conflict_on[]`. Durable
 *     until partners reach terminal (effective-clear).
 *   - `"waiting_on"` — stamped `candidate.waiting_on`. Durable; the
 *     agent on the candidate's next pickup may clear it.
 *   - `"waiting_on_demoted_to_conflict"` — cycle detected on
 *     defensive re-check; demoted to conflict_on stamping.
 */

import { createLogger } from "../logger.js";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  parseIssue,
  serializeIssue,
} from "../issue-tracker/yaml.js";
import type {
  ConflictVerdict,
  ConflictPartner,
} from "../dispatch/conflict-check.js";
import type {
  ConflictOnEntry,
  Issue,
  WaitingOn,
} from "../issue-tracker/interface.js";
import type { RepoContext } from "../types.js";

const log = createLogger("apply-conflict-verdict");

export type StampOutcome =
  | "transient"
  | "conflict_on"
  | "waiting_on"
  | "waiting_on_demoted_to_conflict";

export async function applyConflictVerdict(
  repo: RepoContext,
  candidate: Issue,
  verdict: ConflictVerdict,
  liveInProgress: readonly Issue[],
): Promise<StampOutcome> {
  if (verdict.kind === "ok") return "transient";

  if (verdict.kind === "conflict") {
    if (verdict.partners.length === 0) return "transient";
    stampConflictOn(repo, candidate, verdict.partners);
    return "conflict_on";
  }

  // wait_for path.
  if (verdict.wait_for.length === 0) return "transient";

  // Defensive cycle re-check. Walk each partner's `waiting_on.by[]`
  // chain transitively through the liveInProgress set; if the
  // candidate's id appears anywhere → cycle → demote.
  const cycleDetected = detectWaitForCycle(
    candidate.id,
    verdict.wait_for,
    liveInProgress,
  );
  if (cycleDetected) {
    log.warn(
      `[${repo.name}] wait_for verdict for ${candidate.id} → cycle detected on defensive walk (LLM claimed cycle_audit.walked=[${verdict.cycle_audit.walked.join(", ")}]); demoting to conflict_on stamp on partners=[${verdict.wait_for.join(", ")}]`,
    );
    const partners: ConflictPartner[] = verdict.wait_for.map((id) => ({
      id,
      reason: `Auto-demoted from wait_for due to cycle: ${verdict.reason}`,
    }));
    stampConflictOn(repo, candidate, partners);
    return "waiting_on_demoted_to_conflict";
  }

  stampWaitingOn(repo, candidate, verdict);
  return "waiting_on";
}

function detectWaitForCycle(
  candidateId: string,
  waitFor: readonly string[],
  liveInProgress: readonly Issue[],
): boolean {
  const byId = new Map<string, Issue>();
  for (const i of liveInProgress) byId.set(i.id, i);

  const seen = new Set<string>();
  const stack: string[] = [...waitFor];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === candidateId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue; // not in live set — can't extend walk
    if (node.waiting_on === null) continue;
    for (const dep of node.waiting_on.by) {
      if (!seen.has(dep)) stack.push(dep);
    }
  }
  return false;
}

function stampConflictOn(
  repo: RepoContext,
  candidate: Issue,
  partners: readonly ConflictPartner[],
): void {
  const path = candidateYamlPath(repo.localPath, candidate.id);
  const fresh = reloadFromDisk(path, repo.issuePrefix) ?? candidate;
  const existing = new Map<string, ConflictOnEntry>();
  for (const e of fresh.conflict_on) existing.set(e.id, e);
  for (const p of partners) {
    if (p.id === candidate.id) continue; // self-ref guard
    existing.set(p.id, { id: p.id, reason: p.reason });
  }
  const updated: Issue = {
    ...fresh,
    conflict_on: [...existing.values()],
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeIssue(updated), "utf-8");
}

function stampWaitingOn(
  repo: RepoContext,
  candidate: Issue,
  verdict: Extract<ConflictVerdict, { kind: "wait_for" }>,
): void {
  const path = candidateYamlPath(repo.localPath, candidate.id);
  const fresh = reloadFromDisk(path, repo.issuePrefix) ?? candidate;
  const waitingOn: WaitingOn = {
    reason: `Auto-set by conflict-check — consumes ${verdict.consumed_artifact}. ${verdict.reason}`,
    timestamp: new Date().toISOString(),
    by: [...verdict.wait_for],
  };
  // status normalized to ToDo by forceWaitingOnToToDo on save —
  // the yaml-lifecycle write path handles that invariant. We set
  // status here defensively to keep the stamped YAML self-consistent
  // when the path doesn't route through forceWaitingOnToToDo.
  const updated: Issue = {
    ...fresh,
    status: "ToDo",
    waiting_on: waitingOn,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeIssue(updated), "utf-8");
}

function candidateYamlPath(repoLocalPath: string, issueId: string): string {
  // Source of truth: <repo>/.danxbot/issues/open/<id>.yml. The poller
  // only ever picks ToDo cards (status: "ToDo") so the YAML is always
  // under open/, not closed/.
  return join(repoLocalPath, ".danxbot", "issues", "open", `${issueId}.yml`);
}

function reloadFromDisk(path: string, prefix: string): Issue | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf-8");
    return parseIssue(text, { expectedPrefix: prefix });
  } catch (err) {
    log.warn(`reloadFromDisk failed for ${path}: ${err}`);
    return null;
  }
}
