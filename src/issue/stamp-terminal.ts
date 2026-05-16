/**
 * DX-584 (Phase 4 of DX-575 — Computed card state) — worker-driven
 * terminal stamping for the v10 timestamp fields.
 *
 * Phase 4 contract: every terminal `danxbot_complete` signal from an
 * agent triggers a worker write that stamps the right v10 timestamp
 * onto the candidate YAML, clears the live `dispatch` block, and
 * auto-resolves `list_name` to the matching default list. The agent's
 * own `Edit` / `Write` writes are still source-of-truth for everything
 * the agent owns (status, retro, comments, AC checkmarks) — Phase 5
 * (DX-585) is what stops the agent from writing `status` directly.
 *
 * The three terminal kinds map to:
 *
 *   - `completed` → `completed_at = now`, `list_name = <completed default>`
 *   - `cancelled` → `cancelled_at = now`, `list_name = <cancelled default>`
 *   - `agent_blocked` → `blocked = {reason, at}`, `list_name = <blocked default>`
 *
 * `ready_at` is PRESERVED across every terminal save — it records the
 * moment the card became dispatch-eligible. Same for `archived_at`.
 *
 * Each helper is idempotent: re-running on a card already carrying the
 * terminal timestamp leaves the prior `*_at` value alone (caller's
 * `at` argument is the canonical timestamp for the FIRST call), so
 * duplicate `danxbot_complete` signals (network retry, MCP rebuke) do
 * not slide the timestamp forward.
 */

import { existsSync, readFileSync } from "node:fs";
import { issuePath, writeIssue } from "../poller/yaml-lifecycle.js";
import { parseIssue } from "../issue-tracker/yaml.js";
import {
  deriveListTypeFromSemanticStatus,
  resolveListNameForType,
} from "./list-resolve.js";
import type { Issue, IssueStatus } from "../issue-tracker/interface.js";

export interface StampTerminalInput {
  repoLocalPath: string;
  candidateId: string;
  /** `<PREFIX>` for `parseIssue` validation (e.g. `"DX"`). */
  expectedPrefix: string;
  /**
   * ISO 8601 timestamp string. Caller controls so the same value lands
   * on the dispatch row + the YAML for a single `danxbot_complete` call.
   * Idempotent on the YAML side — pre-existing terminal timestamps are
   * preserved across duplicate signals.
   */
  at: string;
}

export async function stampIssueCompleted(
  input: StampTerminalInput,
): Promise<void> {
  await stampTerminal(input, "Done", (issue, at, listName) => ({
    ...issue,
    // Write raw `status: "Done"` alongside the timestamp so SQL-level
    // readers (`dbListOpenIssues` filters on raw `status NOT IN
    // ('Done', 'Cancelled')`) see the terminal state immediately, not
    // after the next parseIssue→serialize cycle that would carry the
    // derived value back to disk. Deriving still works for legacy
    // pre-Phase-4 cards via rule 7.
    status: "Done",
    completed_at: issue.completed_at ?? at,
    list_name: listName,
    dispatch: null,
  }));
}

export async function stampIssueCancelled(
  input: StampTerminalInput,
): Promise<void> {
  await stampTerminal(input, "Cancelled", (issue, at, listName) => ({
    ...issue,
    // Same SQL-level-consistency rationale as `stampIssueCompleted`.
    status: "Cancelled",
    cancelled_at: issue.cancelled_at ?? at,
    list_name: listName,
    dispatch: null,
  }));
}

async function stampTerminal(
  input: StampTerminalInput,
  semanticStatus: IssueStatus,
  mutate: (issue: Issue, at: string, listName: string) => Issue,
): Promise<void> {
  // The agent's own `Edit`/`Write` to `status: "Done"`/`"Cancelled"`
  // fires the chokidar mirror which may have already triggered
  // `reconcileIssue` → `moveToClosedIfTerminal` before `handleStop`
  // gets here. Check `closed/` as a fallback so the worker still
  // stamps `completed_at` / `cancelled_at` + clears `dispatch` on the
  // moved file. `writeIssue` always writes to `open/`, so for the
  // closed-bucket case we go through the lower-level path that does
  // NOT re-move the file (the agent's prior write already did).
  const openPath = issuePath(input.repoLocalPath, input.candidateId, "open");
  const closedPath = issuePath(
    input.repoLocalPath,
    input.candidateId,
    "closed",
  );
  const inOpen = existsSync(openPath);
  const inClosed = !inOpen && existsSync(closedPath);
  if (!inOpen && !inClosed) {
    // Card YAML genuinely missing — nothing to stamp. The dispatch
    // row's other side effects (auto-sync) will surface any tracker
    // drift via the dashboard error stream.
    return;
  }
  const filePath = inOpen ? openPath : closedPath;
  const issue = parseIssue(readFileSync(filePath, "utf-8"), {
    expectedPrefix: input.expectedPrefix,
  });
  const listType = deriveListTypeFromSemanticStatus(semanticStatus);
  const listName = resolveListNameForType(input.repoLocalPath, listType);
  const next = mutate(issue, input.at, listName);
  if (inOpen) {
    // `writeIssue` writes to `open/` + mirrors to DB. Reconcile's
    // later `moveToClosedIfTerminal` pass will then move the file
    // because deriveStatus now returns `Done` / `Cancelled` via the
    // freshly-stamped timestamp.
    await writeIssue(input.repoLocalPath, next);
    return;
  }
  // Closed bucket: the file is already moved. Re-serialize in-place
  // with the stamped fields. Skip `writeIssue` (which would re-create
  // the open/ copy). Direct write keeps the file move from oscillating.
  const { serializeIssue } = await import("../issue-tracker/yaml.js");
  const { upsertIssueRowNow } = await import("../db/issues-mirror.js");
  const { canonicalize, sha256 } = await import("../db/canonicalize.js");
  const { parse: parseYamlText } = await import("yaml");
  const { repoNameFromPath } = await import("../poller/repo-name.js");
  const { writeFileSync } = await import("node:fs");
  const stamped: Issue = { ...next, db_updated_at: new Date().toISOString() };
  const serialized = serializeIssue(stamped);
  const parsed = parseYamlText(serialized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `stampTerminal: serializeIssue produced non-object YAML for ${stamped.id}`,
    );
  }
  const contentHash = sha256(canonicalize(parsed));
  await upsertIssueRowNow({
    repoName: repoNameFromPath(input.repoLocalPath),
    repoLocalPath: input.repoLocalPath,
    id: stamped.id,
    data: parsed as Record<string, unknown>,
    contentHash,
    source: "writer",
  });
  writeFileSync(closedPath, serialized);
}
