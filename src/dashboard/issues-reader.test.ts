/**
 * Regression pin for the DX-575 "Status is Derived" contract on the
 * dashboard read path. `toRawIssue` mirrors what `parseIssue` does for
 * the worker read path — apply `deriveStatus` so every downstream
 * consumer (board column grouping, child-assignment rollup, isClosed
 * slicing, SSE wire shape) sees the derived semantic status, not the
 * round-trip-stability raw field.
 *
 * Before the fix, the DB JSONB `data.status` leaked verbatim to the
 * wire: a card with `ready_at` stamped + raw `status: "Review"` showed
 * as Review on the dashboard while the worker correctly treated it as
 * ToDo (picker derives, dispatches). Operator-visible drift.
 */

import { describe, it, expect } from "vitest";
import type { DbIssueRow } from "../poller/issues-db.js";
import { createEmptyIssue } from "../issue-tracker/yaml.js";
import { toRawIssue } from "./issues-reader.js";

function row(seed: Parameters<typeof createEmptyIssue>[0] & {
  ready_at?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
}): DbIssueRow {
  const issue = createEmptyIssue({
    id: "DX-1",
    type: "Feature",
    title: "t",
    status: seed.status,
  });
  if (seed.ready_at !== undefined) issue.ready_at = seed.ready_at;
  if (seed.completed_at !== undefined) issue.completed_at = seed.completed_at;
  if (seed.cancelled_at !== undefined) issue.cancelled_at = seed.cancelled_at;
  return { issue, mirrorUpdatedAtMs: 0 };
}

describe("toRawIssue applies deriveStatus (DX-575 contract on dashboard read path)", () => {
  it("ready_at populated + raw status Review → derived ToDo (rule 5)", () => {
    const r = toRawIssue(row({ status: "Review", ready_at: "2026-05-18T23:25:00.000Z" }));
    expect(r.issue.status).toBe("ToDo");
  });

  it("completed_at populated + raw status Review → derived Done (rule 2)", () => {
    const r = toRawIssue(row({ status: "Review", completed_at: "2026-05-18T22:13:22.725Z" }));
    expect(r.issue.status).toBe("Done");
  });

  it("cancelled_at populated → derived Cancelled (rule 1, highest precedence)", () => {
    const r = toRawIssue(
      row({ status: "ToDo", cancelled_at: "2026-05-18T22:00:00.000Z", ready_at: "2026-05-18T21:00:00.000Z" }),
    );
    expect(r.issue.status).toBe("Cancelled");
  });

  it("no triggers populated → raw status passes through (rule 6 fallthrough)", () => {
    const r = toRawIssue(row({ status: "Review" }));
    expect(r.issue.status).toBe("Review");
  });

  it("returns same object reference when derived equals raw (no needless clone)", () => {
    const input = row({ status: "Review" });
    const r = toRawIssue(input);
    expect(r.issue).toBe(input.issue);
  });
});
