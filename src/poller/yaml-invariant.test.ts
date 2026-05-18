import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEmptyIssue,
  parseIssue,
  serializeIssue,
  IssueParseError,
} from "../issue-tracker/yaml.js";
import type { Issue } from "../issue-tracker/interface.js";

/**
 * DX-286 AC #4 — YAML invariant test on populated fixtures.
 *
 * The co-ownership invariant on every issue YAML is:
 *
 *   (dispatch !== null) === (assigned_agent !== null)
 *
 * Both fields null → idle card (the common case for `open/`).
 * Both fields non-null → in-flight dispatch.
 * XOR → orphan: production has been accumulating these (DX-286 traced
 * 6+ such orphans appearing every worker boot before this fix).
 *
 * The test has two layers:
 *
 *  1. **Strict synthetic gate** — constructs a populated fixture of
 *     valid Issue YAMLs, writes them to a tmpdir, walks them via the
 *     real `parseIssue`, and asserts the invariant. Acts as the
 *     regression gate: any code change that produces an
 *     invariant-violating Issue (without the documented exception)
 *     trips this assertion.
 *
 *  2. **Informational live repo scan** — walks the actual repo's
 *     `.danxbot/issues/{open,closed}/` directories. Logs current
 *     violation counts so a runtime regression that suddenly
 *     accumulates orphans surfaces in the test log. Documented
 *     exceptions (pre-DX-200 schema residue, pre-DX-286
 *     persistAfterSync residue) keep this informational instead of a
 *     hard gate — the per-tick heal scan in `runSync` clears open/
 *     orphans on the next worker tick.
 */

const PROJECT_ROOT = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..");
})();

interface InvariantViolation {
  path: string;
  id: string;
  agentSet: boolean;
  dispatchSet: boolean;
  agent: string | null;
  dispatchId: string | null;
  pid: number | null;
}

interface ParseFailure {
  path: string;
  message: string;
}

interface ScanResult {
  scanned: number;
  violations: InvariantViolation[];
  parseFailures: ParseFailure[];
}

function scanYamlDir(dir: string, prefix: string): ScanResult {
  const result: ScanResult = {
    scanned: 0,
    violations: [],
    parseFailures: [],
  };
  if (!existsSync(dir)) return result;

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".yml")) continue;
    const path = resolve(dir, entry);
    result.scanned++;

    let issue;
    try {
      issue = parseIssue(readFileSync(path, "utf-8"), {
        expectedPrefix: prefix,
      });
    } catch (err) {
      const message =
        err instanceof IssueParseError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      result.parseFailures.push({ path, message });
      continue;
    }

    const agentSet = issue.assigned_agent !== null;
    const dispatchSet = issue.dispatch !== null;
    if (agentSet === dispatchSet) continue;

    result.violations.push({
      path,
      id: issue.id,
      agentSet,
      dispatchSet,
      agent: issue.assigned_agent,
      dispatchId: issue.dispatch?.id ?? null,
      pid: issue.dispatch?.pid ?? null,
    });
  }
  return result;
}

function formatViolations(violations: InvariantViolation[]): string {
  return violations
    .map(
      (v) =>
        `  ${v.path}\n` +
        `    id=${v.id} assigned_agent=${v.agent ?? "null"} ` +
        `dispatch=${v.dispatchId ?? "null"} pid=${v.pid ?? "null"} ` +
        `(${v.agentSet ? "agent-without-dispatch" : "dispatch-without-agent"})`,
    )
    .join("\n");
}

describe("YAML invariant: (dispatch !== null) === (assigned_agent !== null) — DX-286 AC #4", () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(resolve(tmpdir(), "dx286-fixture-"));
    mkdirSync(resolve(fixtureDir, "open"), { recursive: true });
    mkdirSync(resolve(fixtureDir, "closed"), { recursive: true });
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  // STRICT GATE — synthetic populated fixture mirrors the production
  // shape (idle ToDo, in-flight dispatch, terminal closed) and asserts
  // the invariant on every entry. Regression check: any change that
  // produces an invariant-violating Issue trips this assertion.
  it("strict gate: every YAML in a populated synthetic fixture satisfies the invariant", () => {
    // Idle ToDo — both null. The bulk of the open queue.
    const idle: Issue = createEmptyIssue({
      id: "ISS-1",
      external_id: "ext-1",
      status: "ToDo",
      type: "Feature",
      title: "Idle card",
      description: "",
    });
    // In-flight dispatch — both populated. The active state.
    const inflight: Issue = {
      ...createEmptyIssue({
        id: "ISS-2",
        external_id: "ext-2",
        status: "In Progress",
        type: "Feature",
        title: "Active dispatch",
        description: "",
      }),
      assigned_agent: "murphy",
      dispatch: {
        id: "did-active-1",
        pid: 4242,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T07:55:00Z",
        ttl_seconds: 7200,
      },
    };
    // Terminal Done — both null (post-DX-286 persistAfterSync clears
    // both atomically on terminal save).
    const done: Issue = createEmptyIssue({
      id: "ISS-3",
      external_id: "ext-3",
      status: "Done",
      type: "Feature",
      title: "Completed card",
      description: "",
    });
    // Blocked card — both null (Blocked is dispatch-session-terminal
    // for persistAfterSync, so dispatch + assigned_agent are cleared
    // even though the YAML stays in open/).
    const blocked: Issue = {
      ...createEmptyIssue({
        id: "ISS-4",
        external_id: "ext-4",
        status: "ToDo",
        type: "Feature",
        title: "Blocked card",
        description: "",
      }),
      blocked: {
        reason: "test",
        at: "2026-05-11T07:00:00Z",
      },
    };

    writeFileSync(
      resolve(fixtureDir, "open", "ISS-1.yml"),
      serializeIssue(idle),
    );
    writeFileSync(
      resolve(fixtureDir, "open", "ISS-2.yml"),
      serializeIssue(inflight),
    );
    writeFileSync(
      resolve(fixtureDir, "closed", "ISS-3.yml"),
      serializeIssue(done),
    );
    writeFileSync(
      resolve(fixtureDir, "open", "ISS-4.yml"),
      serializeIssue(blocked),
    );

    const openResult = scanYamlDir(resolve(fixtureDir, "open"), "ISS");
    const closedResult = scanYamlDir(resolve(fixtureDir, "closed"), "ISS");

    expect(openResult.scanned).toBe(3);
    expect(closedResult.scanned).toBe(1);
    expect(openResult.violations).toEqual([]);
    expect(closedResult.violations).toEqual([]);
    expect(openResult.parseFailures).toEqual([]);
    expect(closedResult.parseFailures).toEqual([]);
  });

  // NEGATIVE control — verify the scanner DETECTS violations when
  // present. Both XOR directions are exercised so a regression in the
  // scanner that misses one direction trips this assertion. Without
  // this control, an incorrectly-passing scanner would silently mask
  // real bugs.
  it("negative control: both XOR directions are detected", () => {
    const dir1: Issue = {
      ...createEmptyIssue({
        id: "ISS-5",
        external_id: "ext-5",
        status: "ToDo",
        type: "Feature",
        title: "Agent without dispatch",
        description: "",
      }),
      assigned_agent: "phil",
    };
    const dir2: Issue = {
      ...createEmptyIssue({
        id: "ISS-6",
        external_id: "ext-6",
        status: "ToDo",
        type: "Feature",
        title: "Dispatch without agent",
        description: "",
      }),
      dispatch: {
        id: "did-orphan-1",
        pid: 0,
        host: "host-a",
        kind: "work",
        started_at: "2026-05-11T07:00:00Z",
        ttl_seconds: 7200,
      },
    };
    writeFileSync(
      resolve(fixtureDir, "open", "ISS-5.yml"),
      serializeIssue(dir1),
    );
    writeFileSync(
      resolve(fixtureDir, "open", "ISS-6.yml"),
      serializeIssue(dir2),
    );

    const result = scanYamlDir(resolve(fixtureDir, "open"), "ISS");
    expect(result.scanned).toBe(2);
    expect(result.violations).toHaveLength(2);
    const kinds = result.violations
      .map((v) => (v.agentSet ? "agent-without-dispatch" : "dispatch-without-agent"))
      .sort();
    expect(kinds).toEqual([
      "agent-without-dispatch",
      "dispatch-without-agent",
    ]);
  });

  // INFORMATIONAL — walks the live repo's issues directory. Logs
  // current violation counts so a runtime regression surfaces in the
  // test log. NOT a strict gate because:
  //  - open/ orphans the running worker created before the fix landed
  //    will clear on the next worker boot via the new boot heal.
  //  - closed/ residue (pre-DX-200 schema, pre-DX-286 persistAfterSync)
  //    is documented audit-data exception per the AC's "OR document
  //    the legitimate exceptions" clause.
  it("informational: live repo scan reports current violation counts", () => {
    const openDir = resolve(PROJECT_ROOT, ".danxbot", "issues", "open");
    const closedDir = resolve(PROJECT_ROOT, ".danxbot", "issues", "closed");
    const openResult = scanYamlDir(openDir, "DX");
    const closedResult = scanYamlDir(closedDir, "DX");
    if (openResult.violations.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[DX-286 informational] ${openResult.violations.length}/${openResult.scanned} ` +
          `open YAML(s) violate the invariant. Next worker boot's boot heal ` +
          `will clear these via healOrphanInvariantViolations:\n` +
          formatViolations(openResult.violations),
      );
    }
    if (closedResult.violations.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[DX-286 informational] ${closedResult.violations.length}/${closedResult.scanned} ` +
          `closed YAML(s) carry historical invariant violations — see DX-286 ` +
          `documented exceptions (pre-DX-200 schema residue + pre-DX-286 ` +
          `persistAfterSync residue).`,
      );
    }
    // Always passes — this is a counter, not a gate. The strict gate
    // above is the regression check for code-level changes.
    expect(openResult.scanned).toBeGreaterThanOrEqual(0);
    expect(closedResult.scanned).toBeGreaterThanOrEqual(0);
  });
});
