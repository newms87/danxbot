/**
 * Pure unit tests for `buildRecoveryPrompt` + `buildStillDirtyComment`.
 * Loads no IO + no dispatch core — keeps the test footprint tiny and
 * the prompt content easy to pin against drift.
 */

import { describe, it, expect } from "vitest";
import {
  buildRecoveryPrompt,
  buildStillDirtyComment,
  type DirtyValidation,
  RECOVERY_MARKER,
} from "./recovery-prompt.js";

describe("buildRecoveryPrompt", () => {
  const dirty: DirtyValidation = {
    state: "dirty",
    reason: "uncommitted changes",
    details: { porcelain: " M src/foo.ts\n?? newfile.txt", ahead: 0, behind: 0 },
  };

  it("includes agent name, branch state, porcelain block, and forbidden-ops list", () => {
    const prompt = buildRecoveryPrompt({
      agentName: "alice",
      worktreePath: "/repo/x/.danxbot/worktrees/alice",
      validation: dirty,
    });

    expect(prompt).toContain(RECOVERY_MARKER);
    expect(prompt).toContain("alice");
    expect(prompt).toContain("/repo/x/.danxbot/worktrees/alice");
    expect(prompt).toContain("uncommitted changes");
    expect(prompt).toContain(" M src/foo.ts");
    expect(prompt).toContain("?? newfile.txt");
    expect(prompt).toMatch(/STRICTLY FORBIDDEN/);
    expect(prompt).toContain("git reset --hard");
    expect(prompt).toContain("git clean -fd");
    expect(prompt).toContain("git checkout -- .");
    expect(prompt).toContain("git push --force");
    expect(prompt).toContain("Allowed operations");
    expect(prompt).toContain("danxbot_complete");
    expect(prompt).toContain("assigned_agent");
  });

  it("emits a sentinel block when porcelain is empty (ahead-only dirty state)", () => {
    const prompt = buildRecoveryPrompt({
      agentName: "bob",
      worktreePath: "/p",
      validation: {
        state: "dirty",
        reason: "branch has unmerged commits",
        details: { porcelain: "", ahead: 3, behind: 1 },
      },
    });
    expect(prompt).toContain("Ahead of origin/main:** 3");
    expect(prompt).toContain("Behind:** 1");
    expect(prompt).toContain("(no uncommitted changes");
  });

  it("special-cases fetch-failure reasons (L2 fix) — no contradictory ahead/behind block", () => {
    const prompt = buildRecoveryPrompt({
      agentName: "alice",
      worktreePath: "/p",
      validation: {
        state: "dirty",
        reason: "git fetch origin failed: fatal: network unreachable",
        details: { porcelain: "", ahead: 0, behind: 0 },
      },
    });
    expect(prompt).toContain("git fetch origin failed");
    // Critical: the misleading "Ahead 0 / Behind 0" block must NOT render
    // when fetch fails — those numbers are unreliable when origin is
    // unreachable.
    expect(prompt).not.toContain("Ahead of origin/main:** 0");
    expect(prompt).toContain("Re-run `git fetch origin`");
  });

  it("preserves a very long porcelain block intact (no truncation)", () => {
    const lines = Array.from({ length: 200 }, (_, i) => ` M file${i}.ts`).join("\n");
    const prompt = buildRecoveryPrompt({
      agentName: "alice",
      worktreePath: "/p",
      validation: {
        state: "dirty",
        reason: "uncommitted changes",
        details: { porcelain: lines, ahead: 0, behind: 0 },
      },
    });
    expect(prompt).toContain(" M file0.ts");
    expect(prompt).toContain(" M file199.ts");
  });
});

describe("buildStillDirtyComment", () => {
  it("contains operator instructions + worktree path + git status block", () => {
    const body = buildStillDirtyComment("alice", {
      state: "dirty",
      reason: "uncommitted changes",
      details: { porcelain: " M src/foo.ts", ahead: 2, behind: 1 },
    });

    expect(body).toContain("Branch recovery still dirty");
    expect(body).toContain("**alice**");
    expect(body).toContain("uncommitted changes");
    expect(body).toContain("Ahead of `origin/main`:** 2");
    expect(body).toContain("Behind:** 1");
    expect(body).toContain(" M src/foo.ts");
    expect(body).toContain("Operator next steps");
    expect(body).toContain("ssh");
  });

  it("emits sentinel when porcelain is empty (ahead-only)", () => {
    const body = buildStillDirtyComment("bob", {
      state: "dirty",
      reason: "branch has unmerged commits",
      details: { porcelain: "", ahead: 5, behind: 0 },
    });
    expect(body).toContain("(no uncommitted changes");
  });
});
