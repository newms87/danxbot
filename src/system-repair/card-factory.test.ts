/**
 * Tests for {@link buildRepairCardDraft} — DX-563 Phase 3 of DX-560.
 * Pure renderer; no DB or filesystem state.
 */

import { describe, it, expect } from "vitest";
import { buildRepairCardDraft } from "./card-factory.js";
import {
  SELF_REPAIR_TITLE_PREFIX,
  isSelfRepairCard,
} from "./is-repair-card.js";
import type { SystemErrorRow, SystemErrorRepairRow } from "./types.js";

function row(overrides: Partial<SystemErrorRow> = {}): SystemErrorRow {
  return {
    id: 7,
    signature_hash: "abc123def456",
    category_key: "worker:TypeError",
    component: "worker",
    err_class: "TypeError",
    normalized_msg: "Cannot read property 'foo' of undefined",
    sample_payload: { raw_msg: "Cannot read property 'foo' of undefined", path: "src/x.ts" },
    count: 5,
    first_seen: new Date("2026-05-14T10:00:00Z"),
    last_seen: new Date("2026-05-15T22:00:00Z"),
    status: "open",
    repo: "danxbot",
    recurrence_count: 0,
    ...overrides,
  };
}

describe("buildRepairCardDraft", () => {
  it("renders title with component:category and attempt number", () => {
    const draft = buildRepairCardDraft({ errorRow: row(), priorAttempts: [], attemptN: 1, epicId: "DX-560" });
    expect(draft.title).toBe("Self-Repair > Attempt 1: worker:TypeError (abc123def456)");
  });

  it("renders description with Repair Target / Sample Payload / Instructions sections", () => {
    const draft = buildRepairCardDraft({ errorRow: row(), priorAttempts: [], attemptN: 1, epicId: "DX-560" });
    expect(draft.description).toContain("## Repair Target");
    expect(draft.description).toContain("Component: worker");
    expect(draft.description).toContain("Category:  worker:TypeError");
    expect(draft.description).toContain("Count:     5");
    expect(draft.description).toContain("Signature: abc123def456");
    expect(draft.description).toContain("## Sample Payload");
    expect(draft.description).toContain("```json");
    expect(draft.description).toContain('"raw_msg"');
    expect(draft.description).toContain("## Prior Repair Attempts");
    expect(draft.description).toContain("(none)");
    expect(draft.description).toContain("## Instructions");
    expect(draft.description).toContain("danxbot:self-repair");
    expect(draft.description).toContain("`abc123def456`");
  });

  it("renders prior attempts when present, truncating report excerpt to 200 chars", () => {
    const longReport = "x".repeat(500);
    const priors: SystemErrorRepairRow[] = [
      {
        id: 1, error_id: 7, attempt_n: 1,
        card_id: "DX-700", dispatch_id: "d1",
        started_at: new Date(), ended_at: new Date(),
        verdict: "failed", report_md: longReport,
      },
      {
        id: 2, error_id: 7, attempt_n: 2,
        card_id: "DX-701", dispatch_id: "d2",
        started_at: new Date(), ended_at: new Date(),
        verdict: "unfixable", report_md: "short",
      },
    ];
    const draft = buildRepairCardDraft({ errorRow: row(), priorAttempts: priors, attemptN: 3, epicId: "DX-560" });
    expect(draft.description).toContain("Attempt 1 (DX-700): verdict=failed");
    expect(draft.description).toContain("x".repeat(200));
    expect(draft.description).not.toContain("x".repeat(201));
    expect(draft.description).toContain("Attempt 2 (DX-701): verdict=unfixable, report excerpt: short");
    expect(draft.title).toBe("Self-Repair > Attempt 3: worker:TypeError (abc123def456)");
  });

  it("handles prior attempts with null verdict/report (mid-flight)", () => {
    const priors: SystemErrorRepairRow[] = [
      {
        id: 1, error_id: 7, attempt_n: 1,
        card_id: "DX-700", dispatch_id: "d1",
        started_at: new Date(), ended_at: null,
        verdict: null, report_md: null,
      },
    ];
    const draft = buildRepairCardDraft({ errorRow: row(), priorAttempts: priors, attemptN: 2, epicId: "DX-560" });
    expect(draft.description).toContain("Attempt 1 (DX-700): verdict=pending");
  });

  it("title uses the shared SELF_REPAIR_TITLE_PREFIX constant (producer/consumer drift guard, DX-564)", () => {
    // Producer-side anchor for the picker's title-prefix routing
    // (`isSelfRepairCard`). If the producer drifts from the consumer
    // — e.g. a refactor introduces a different prefix in
    // `card-factory.ts` — every repair card silently routes to
    // `issue-worker` instead of `self-repair` and the agent loads
    // `/danx-next` instead of `/self-repair`. The constant import +
    // these two asserts make that class of bug a one-line test
    // failure instead of a multi-error production silent miss.
    const draft = buildRepairCardDraft({
      errorRow: row(),
      priorAttempts: [],
      attemptN: 1,
      epicId: "DX-560",
    });
    expect(draft.title.startsWith(SELF_REPAIR_TITLE_PREFIX)).toBe(true);
    expect(isSelfRepairCard({ title: draft.title })).toBe(true);
  });

  it("pretty-prints sample_payload as JSON", () => {
    const draft = buildRepairCardDraft({ errorRow: row({ sample_payload: { raw_msg: "boom", stack: "at x" } }), priorAttempts: [], attemptN: 1, epicId: "DX-560" });
    // 2-space indent
    expect(draft.description).toContain('  "raw_msg": "boom"');
    expect(draft.description).toContain('  "stack": "at x"');
  });
});
