/**
 * DX-615 (Phase 5d of DX-585 / DX-575 — Computed card state) — static
 * guard.
 *
 * Under the computed-card-state contract, agent code MUST NOT write
 * `status: "ToDo" | "In Progress" | "Done" | "Cancelled" | "Blocked"`
 * literals into issue YAMLs. Agents signal state transitions via
 * timestamp fields (`completed_at`, `cancelled_at`, ...) and via the
 * `danxbot_complete` MCP tool; the worker stamps the denormalized
 * `status` projection on disk. Direct `status: "..."` literal writes
 * from a new code path re-introduce the on-disk drift class the
 * timestamp-driven contract eliminates.
 *
 * This test enumerates every literal `status: "<terminal>"` write
 * under `src/` and fails if any hit lands outside the file-path
 * allowlist below. Allowlist entries are auditable — adding a new
 * entry requires a one-line rationale comment naming WHY the file
 * legitimately writes status literals.
 *
 * Scope notes:
 *   - Test files (`*.test.ts`, `__tests__/**`) are excluded — tests
 *     legitimately stamp status on fixtures.
 *   - The regex matches the literal write shape
 *     `status: "<one of the 5 terminals>"`, covering both serializer
 *     defaults and worker stamping. Comments containing the pattern
 *     (e.g. `// status: "Blocked"` in a docstring) ALSO match by
 *     design — auditable allowlisting is stable across whether a
 *     line is code or comment.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_SRC = resolve(__dirname, "..");

/**
 * Files allowed to reference `status: "<terminal>"`. Each entry needs
 * a rationale comment — adding a new path must come with the same.
 */
const ALLOWLIST: ReadonlySet<string> = new Set([
  // Schema serializer + parser — the writer literal for fresh YAML
  // and the default for legacy hydration round-trip both reference
  // status terminals as data.
  "issue-tracker/yaml.ts",
  // Type / interface definitions + docstring references to the
  // canonical status values.
  "issue-tracker/interface.ts",
  // Trello tracker mapping — status enum ↔ list-id table.
  "issue-tracker/trello.ts",
  // Migration registry / migrations — legacy YAML normalization
  // stamps status terminals on cards being canonicalized.
  "issue-tracker/migrations/legacy-to-v10.ts",
  "issue-tracker/migrations/v9-to-v10.ts",
  "issue-tracker/migrations/registry.ts",
  // Worker stamp helpers — write `status: "Blocked"` alongside the
  // `blocked` timestamp for SQL-readability (DX-584 contract).
  "issue/stamp-blocked.ts",
  // Worker stamp helpers — write `status: "Done"` / "Cancelled"
  // alongside the terminal timestamps for SQL-readability.
  "issue/stamp-terminal.ts",
  // Parent-derive function — the derivation that computes a parent
  // epic's status from children's effective statuses; values are
  // returned, not written through here.
  "issue/reconcile/parent.ts",
  // Heal sweep — stamps `status: "ToDo"` on cards with stale
  // assignments + carries comments documenting the heal rules.
  "poller/heal.ts",
  // Multi-agent picker — re-stamps `status: "ToDo"` when releasing a
  // claim on a card the prep verdict flagged conflict_on / waiting_on.
  "poller/multi-agent-pick.ts",
  // Dispatch auto-flip — stamps `status: "In Progress"` on the
  // candidate YAML before spawning the agent (rollback on spawn
  // failure restores prior state).
  "dispatch/core.ts",
  // Prep-verdict worker route — stamps `status: "Blocked"` on the
  // candidate YAML when the agent emits verdict "blocked".
  "worker/prep-verdict-route.ts",
  // Boot replay of prep-verdict filesystem queue — replays the same
  // stamp the worker route would have applied at runtime.
  "worker/replay-prep-verdict-queue.ts",
  // Dashboard write API — operator-driven PATCH endpoint flips
  // status across the manual state machine; comments reference the
  // status↔blocked invariant.
  "dashboard/issue-write.ts",
  // Dashboard projection reader — defaults derived/projected status
  // to "ToDo" when reading orphan rows + carries the comment for the
  // Blocked record field.
  "dashboard/issues-reader.ts",
  // MCP server docstring references status: "Blocked" in the agent-
  // self-block contract description.
  "mcp/danxbot-server.ts",
  // Agent-locks docstring references status: "In Progress" in the
  // claim-staleness rationale.
  "agent/agent-locks.ts",
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

describe("DX-615 — no worker codepath writes literal `status: \"<terminal>\"`", () => {
  it("only allowlisted modules contain `status: \"<terminal>\"` literals", () => {
    const files: string[] = [];
    walkTs(REPO_SRC, files);
    const violations: { path: string; line: number; text: string }[] = [];

    const writePattern =
      /status:\s*["'](ToDo|In Progress|Done|Cancelled|Blocked)["']/;

    for (const path of files) {
      const rel = relative(REPO_SRC, path).replace(/\\/g, "/");
      const content = readFileSync(path, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!writePattern.test(line)) continue;
        if (ALLOWLIST.has(rel)) continue;
        violations.push({ path: rel, line: i + 1, text: line.trim() });
      }
    }

    expect(
      violations,
      `${"Found `status: \"<terminal>\"` literal writes outside the allowlist. Under the computed-card-state contract, agents signal state via timestamps + `danxbot_complete`; only the worker stamps `status` on disk. If your code legitimately needs to stamp status (worker-side derivation, serializer, migration), add the module to ALLOWLIST in this test with a one-line rationale."}\n` +
        violations
          .map((v) => `  ${v.path}:${v.line}  ${v.text}`)
          .join("\n"),
    ).toEqual([]);
  });
});
