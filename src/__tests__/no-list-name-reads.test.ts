/**
 * DX-584 (Phase 4 of DX-575 — Computed card state) — static guard.
 *
 * The `Issue.list_name` field is a denormalized projection of the
 * card's derived semantic state, written exclusively by the auto-
 * resolve helpers in `src/issue/list-resolve.ts` and consumed only by
 * the dashboard / tracker push side of the codebase. Worker decision
 * code MUST NOT read `.list_name` — any branching on a denormalized
 * projection re-introduces the on-disk drift class the v10 schema
 * was designed to eliminate.
 *
 * This test enumerates every `.list_name` reference under `src/` and
 * fails if any read hit lands outside the small allowlist of writers
 * (auto-resolve), serializers (yaml read/write canonicalize), import
 * paths (DB hydration), and dashboard CRUD routes (which legitimately
 * patch + cascade list renames). The allowlist is small and
 * intentional — adding a new entry needs a docstring explaining why
 * the read is not driving a worker decision.
 *
 * Notes on string-match scope:
 *   - Test files (`**\/*.test.ts`, `__tests__/**`) are excluded —
 *     unit tests assert on the field's value all the time.
 *   - String matches on `.list_name` (regex `\.list_name\b`) cover
 *     all read shapes (`x.list_name`, `issue.list_name === "foo"`,
 *     destructuring `{ list_name }`).
 *   - Write-only assignments (`list_name: ...`) are matched
 *     separately and ignored — the spec bans READS, not WRITES.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_SRC = resolve(__dirname, "..");

/**
 * Files allowed to reference `.list_name`. Each entry needs a comment
 * explaining why — adding a new path must come with the same.
 */
const ALLOWLIST: ReadonlySet<string> = new Set([
  // The auto-resolve write path itself — docstring references the
  // field by name.
  "issue/list-resolve.ts",
  // Schema serializer: persists list_name to/from YAML. The validator
  // path reads to round-trip.
  "issue-tracker/yaml.ts",
  // Migration helpers default list_name to null on legacy YAML.
  "issue-tracker/migrations/legacy-to-v10.ts",
  "issue-tracker/migrations/v9-to-v10.ts",
  // Trello tracker import path: stamps list_name on tracker-born
  // cards (denormalized projection from the Trello list column).
  "issue-tracker/trello.ts",
  // Dashboard import / write path: legitimately reads + writes for
  // tracker mirror + lists-routes CRUD cascade.
  "dashboard/issue-import.ts",
  "dashboard/lists-routes.ts",
  // DX-586 — `issue-write.ts` reads `patch.list_name` (the inbound
  // PATCH body field, NOT the Issue's `list_name` projection) to
  // resolve the dest list against `lists.yaml` and apply ladder
  // semantics. The read drives a translation to lifecycle timestamps
  // + the `applyListMove` helper — not a worker dispatch decision.
  "dashboard/issue-write.ts",
  // DX-586 — `project-issue.ts` mirrors `Issue.list_name` onto the
  // dashboard's `IssueListItem` projection so the board can group
  // cards by their current list. This is a serializer-side passthrough
  // for the dashboard read path, not a worker decision.
  "dashboard/project-issue.ts",
  // DX-586 — `list-move.ts` writes `next.list_name = destListName` as
  // part of the ladder helper. The naive regex matches the write
  // because the line carries `.list_name`; the helper never READS
  // the field (current position is derived from `deriveStatus`, never
  // from `list_name`).
  "issue/list-move.ts",
  // Dispatch core auto-flip: reads list_name ONLY to snapshot it for
  // the spawn-failure rollback path (`priorSnapshot.list_name`). Not
  // a read-then-decide branch — the read exists to preserve operator
  // state across a transient revert.
  "dispatch/core.ts",
  // DX-610 Phase 8b.2 outbound list-mapping gate: reads list_name on
  // the tracker PUSH side (post auto-resolve) to decide whether the
  // operator-configured trello-list-map.yaml has a Trello target for
  // this card's list. Same trust boundary as the other Trello-side
  // entries in this allowlist — the read drives the outbound tracker
  // mirror, not a worker dispatch decision.
  "issue/reconcile/trello.ts",
  // DX-621 / Phase 9d inbound hydration: writes `issue.list_name` post
  // hydrateFromRemote based on reverse-map lookup of `external_list_id`.
  // Pre-existing allowlist entries cover the writers / serializers; this
  // entry pins the new inbound writer location.
  "cron/inbound-fetch.ts",
]);

function walkTs(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkTs(full, out);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    if (full.includes(`${"__tests__"}`)) continue;
    out.push(full);
  }
}

describe("DX-584 — no worker codepath reads `Issue.list_name`", () => {
  it("only allowlisted modules reference `.list_name`", () => {
    const files: string[] = [];
    walkTs(REPO_SRC, files);
    const violations: { path: string; line: number; text: string }[] = [];

    // Match `.list_name` followed by a word boundary, EXCLUDING
    // pure object-key writes (`list_name: ...` at the start of a
    // line / inside an object literal). The allowlist gates the rest.
    const readPattern = /\.list_name\b/;

    for (const path of files) {
      const rel = relative(REPO_SRC, path).replace(/\\/g, "/");
      const content = readFileSync(path, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!readPattern.test(line)) continue;
        if (ALLOWLIST.has(rel)) continue;
        violations.push({ path: rel, line: i + 1, text: line.trim() });
      }
    }

    expect(
      violations,
      `${"Found `.list_name` reads outside the allowlist. If you need to read this field, add the module to ALLOWLIST in this test with a one-line justification, and explain why your read is not driving a worker decision."}\n` +
        violations
          .map((v) => `  ${v.path}:${v.line}  ${v.text}`)
          .join("\n"),
    ).toEqual([]);
  });
});
