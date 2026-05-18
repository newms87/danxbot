/**
 * DX-651 — pin the repair task body shape. The dispatcher inlines this
 * into the spawned agent's prompt; the worker-repair workspace's
 * `CLAUDE.md` references the verdict prefixes named here. A drift
 * between these two surfaces silently breaks the dispatcher's outcome
 * categorization at finalize time (Phase 3).
 */
import { describe, expect, it } from "vitest";
import { buildRepairTaskBody } from "./repair-task-body.js";
import type { SystemErrorRow } from "./types.js";
import { REPAIR_CAP } from "./types.js";

function makeError(over: Partial<SystemErrorRow> = {}): SystemErrorRow {
  return {
    id: 42,
    signature_hash: "abc123def456ghi7",
    category_key: "worker-boot:DispatchSpawnError",
    component: "worker-boot",
    err_class: "DispatchSpawnError",
    normalized_msg: "spawnAgent threw before claude PID landed",
    sample_payload: {
      raw_msg: "ENOENT: no such file or directory, open '/missing/path'",
      stack: "Error: ENOENT\n    at Object.openSync (node:fs:585:3)",
    },
    count: 5,
    first_seen: new Date("2026-05-18T08:00:00Z"),
    last_seen: new Date("2026-05-18T09:00:00Z"),
    status: "open",
    repo: "danxbot",
    recurrence_count: 0,
    ...over,
  };
}

describe("buildRepairTaskBody", () => {
  it("includes the agent header naming DX-651 + DX-580", () => {
    const body = buildRepairTaskBody({ error: makeError(), attemptN: 1 });
    expect(body).toContain("You are the worker-repair agent");
    expect(body).toContain("DX-651");
    expect(body).toContain("DX-580");
  });

  it("emits signature hash + category + component in the target block", () => {
    const body = buildRepairTaskBody({ error: makeError(), attemptN: 1 });
    expect(body).toContain("Signature hash: `abc123def456ghi7`");
    expect(body).toContain("Category key: `worker-boot:DispatchSpawnError`");
    expect(body).toContain("Component: `worker-boot`");
    expect(body).toContain("Error class: `DispatchSpawnError`");
    expect(body).toContain(
      "Normalized message: `spawnAgent threw before claude PID landed`",
    );
  });

  it("includes the recurrence count + attempt number with REPAIR_CAP", () => {
    const body = buildRepairTaskBody({
      error: makeError({ count: 7 }),
      attemptN: 2,
    });
    expect(body).toContain("Recurrence count: `7`");
    expect(body).toContain(`Attempt: \`2\` of \`${REPAIR_CAP}\``);
  });

  it("renders the sample payload inside a JSON fenced block", () => {
    const body = buildRepairTaskBody({ error: makeError(), attemptN: 1 });
    expect(body).toContain("## Sample payload");
    expect(body).toContain("```json");
    // JSON.stringify with 2-space indent preserves the raw_msg field.
    expect(body).toContain('"raw_msg": "ENOENT: no such file or directory');
  });

  it("documents all three verdict prefixes (fixed / unfixable / failed)", () => {
    const body = buildRepairTaskBody({ error: makeError(), attemptN: 1 });
    expect(body).toMatch(/fixed: <one-sentence change summary> @ <commit-sha>/);
    expect(body).toMatch(/unfixable: <one-sentence reason>/);
    expect(body).toMatch(/failed: <one-sentence reason>/);
  });

  it("pins forbidden patterns (no YAML edits, no recursion, no fallbacks)", () => {
    const body = buildRepairTaskBody({ error: makeError(), attemptN: 1 });
    expect(body).toContain("No YAML edits");
    expect(body).toContain("No re-entry into `dispatch()`");
    expect(body).toContain("No silent fallbacks");
  });

  it("references $DANX_REPO_ROOT for the source tree path", () => {
    const body = buildRepairTaskBody({ error: makeError(), attemptN: 1 });
    expect(body).toContain("$DANX_REPO_ROOT");
  });

  it("uses a longer fence when the payload contains triple backticks", () => {
    // A stack trace mentioning markdown ``` inside would break a
    // 3-backtick fence; the builder counts the longest run and emits
    // one more so the fence cannot be closed prematurely.
    const body = buildRepairTaskBody({
      error: makeError({
        sample_payload: {
          raw_msg: "agent emitted ```js sample``` in its output",
        },
      }),
      attemptN: 1,
    });
    // Find the json fence opener.
    const opener = body.match(/(`{4,})json/);
    expect(opener).not.toBeNull();
    // The same-length fence appears as a closer below the JSON body.
    const fence = opener![1];
    expect(body.split(fence).length).toBeGreaterThanOrEqual(3); // open + close + outer body matches
  });
});
