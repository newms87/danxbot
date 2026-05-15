/**
 * Tests for {@link isSelfRepairCard} — DX-564 Phase 4 of DX-560.
 *
 * The detector is the routing key for self-repair dispatches; a
 * regression that mis-classifies a phase card as a repair-attempt
 * (or vice versa) would route the wrong work into the
 * `self-repair` workspace + skill. Tight matcher: literal prefix,
 * no regex tricks, no parent_id involvement.
 */

import { describe, it, expect } from "vitest";
import {
  SELF_REPAIR_TITLE_PREFIX,
  SELF_REPAIR_WORKSPACE,
  isSelfRepairCard,
} from "./is-repair-card.js";

describe("isSelfRepairCard", () => {
  it("returns true for the Phase-3 dispatcher's title shape", () => {
    expect(
      isSelfRepairCard({
        title: "Self-Repair > Attempt 1: worker:TypeError (abc123def456)",
      }),
    ).toBe(true);
  });

  it("returns true for higher attempt numbers", () => {
    expect(
      isSelfRepairCard({
        title: "Self-Repair > Attempt 3: poller:ENOENT (deadbeef)",
      }),
    ).toBe(true);
  });

  it("returns false for the epic's own phase cards", () => {
    // Phase cards under DX-560 share the `Self-Repair > Phase N:`
    // prefix; they must dispatch into `issue-worker`, not
    // `self-repair`.
    expect(
      isSelfRepairCard({
        title: "Self-Repair > Phase 4: self-repair agent skill + workspace",
      }),
    ).toBe(false);
  });

  it("returns false for any other card title", () => {
    expect(isSelfRepairCard({ title: "Feature: add foo" })).toBe(false);
    expect(isSelfRepairCard({ title: "Bug: crash on bar" })).toBe(false);
    expect(isSelfRepairCard({ title: "" })).toBe(false);
  });

  it("is case-sensitive (matches Phase-3 dispatcher's literal output)", () => {
    // `card-factory.ts` emits the prefix verbatim; a case-shifted
    // title is NOT a repair card and we should NOT route it.
    expect(
      isSelfRepairCard({
        title: "self-repair > attempt 1: worker:TypeError (abc)",
      }),
    ).toBe(false);
  });

  it("exports the workspace name string the picker uses", () => {
    expect(SELF_REPAIR_WORKSPACE).toBe("self-repair");
  });

  it("exports the title prefix the producer + consumer must agree on", () => {
    expect(SELF_REPAIR_TITLE_PREFIX).toBe("Self-Repair > Attempt ");
  });
});
