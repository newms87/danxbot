/**
 * DX-559 — Pre-finalize gate on `danxbot_complete({status: "completed"})`.
 *
 * Reads the candidate YAML at `<repo>/.danxbot/issues/open/<id>.yml`,
 * pulls `retro.commits[]`, and verifies every sha is an ancestor of
 * `origin/main`. When any sha is missing — agent committed locally
 * without pushing the branch (or pushed only to a feature ref, never to
 * `main`) — returns a `Violation` carrying the missing-sha list. The
 * worker stop handlers (`handleStop`, `handleStopFromDb`) flip status
 * from `completed` → `agent_blocked` on a Violation and reuse the
 * existing self-block path to stamp `status: Blocked` on the YAML.
 *
 * Empty `retro.commits[]` is the documented "docs-only — no commit"
 * branch (see `pipeline:pipe-finish` / `danx-next/SKILL.md` Step 11) —
 * verification short-circuits to `null` (no enforcement).
 *
 * Errors reading the YAML (missing file, malformed YAML, schema-version
 * mismatch) ARE swallowed and surface as `null`: enforcement is a
 * forcing-function, not a stall gate, and an unparseable YAML is a
 * separate problem class the auto-sync will surface on its own. Logged
 * at warn so a recurring read failure does not vanish silently.
 */
import { existsSync, readFileSync } from "node:fs";

import { issuePath } from "../poller/yaml-lifecycle.js";
import { parseIssue } from "../issue-tracker/yaml.js";
import { createLogger } from "../logger.js";
import {
  fetchOriginQuiet,
  verifyCommitsShipped,
} from "./verify-commits-shipped.js";

const log = createLogger("enforce-commits-shipped");

export interface EnforceCommitsShippedInput {
  repoLocalPath: string;
  candidateId: string;
  /** `<PREFIX>` for `parseIssue` validation (e.g. `"DX"`). */
  expectedPrefix: string;
  /**
   * Best-effort `git fetch origin --quiet` before verification. Default
   * `true` in production; tests that work against a local repo with no
   * remote pass `false` so a missing-remote error doesn't drown the test
   * output. Fetch failures are logged + swallowed regardless — stale
   * `refs/remotes/origin/main` still gives a useful answer (it ages
   * toward "more permissive over time," which is fine for a forcing
   * function).
   */
  fetchOrigin?: boolean;
}

export interface CommitsShippedViolation {
  /** Shas listed in retro.commits[] that are NOT on origin/main. */
  missingShas: string[];
  /** Subset of missingShas that git could not resolve at all (typo / never landed locally). */
  unresolvedShas: string[];
  /** Human-readable reason to embed into `blocked.reason`. */
  reason: string;
}

export async function enforceCommitsShipped(
  input: EnforceCommitsShippedInput,
): Promise<CommitsShippedViolation | null> {
  const filePath = issuePath(input.repoLocalPath, input.candidateId, "open");
  if (!existsSync(filePath)) {
    // No open YAML to read — the agent may already have moved the card
    // (rare; the move normally happens AFTER danxbot_complete). Either
    // way, verification cannot proceed. Skip enforcement and let
    // auto-sync handle whatever state is there.
    return null;
  }

  let shas: string[];
  try {
    const issue = parseIssue(readFileSync(filePath, "utf-8"), {
      expectedPrefix: input.expectedPrefix,
    });
    shas = issue.retro.commits.filter((s) => typeof s === "string" && s.length > 0);
  } catch (err) {
    log.warn(
      `[${input.candidateId}] could not read retro.commits[] — skipping enforcement`,
      err,
    );
    return null;
  }

  if (shas.length === 0) {
    // Docs-only / no-commit path — explicitly allowed by the skill.
    return null;
  }

  if (input.fetchOrigin ?? true) {
    const fetched = await fetchOriginQuiet(input.repoLocalPath);
    if (!fetched.ok) {
      log.warn(
        `[${input.candidateId}] git fetch origin failed — verifying against stale ref: ${fetched.error}`,
      );
    }
  }

  const result = await verifyCommitsShipped({
    repoLocalPath: input.repoLocalPath,
    shas,
  });
  if (result.ok) return null;

  const missing = result.missing.join(", ");
  const reason =
    `DX-559 enforcement: commits in retro.commits[] are not on origin/main — ` +
    `agent branch needs push + merge before this card can close. ` +
    `Missing shas: ${missing}.`;

  return {
    missingShas: result.missing,
    unresolvedShas: result.unresolved,
    reason,
  };
}
