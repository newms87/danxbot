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

  describe("branch finalize is the preferred path for landable work", () => {
    const aheadDirty: DirtyValidation = {
      state: "dirty",
      reason: "branch has unmerged commits",
      details: { porcelain: "", ahead: 1, behind: 0 },
    };

    it("Allowed operations advertises finalize BEFORE graduation", () => {
      const prompt = buildRecoveryPrompt({
        agentName: "phil",
        worktreePath: "/w",
        validation: aheadDirty,
      });
      const finalizeIdx = prompt.indexOf("Land work on `main` via `.danxbot/scripts/agent-finalize.sh`");
      const graduateIdx = prompt.indexOf("Graduate `origin/phil` via `--force-with-lease`");
      expect(finalizeIdx).toBeGreaterThan(0);
      expect(graduateIdx).toBeGreaterThan(finalizeIdx);
    });

    it("renders Branch finalize section with decision tree + finalize call", () => {
      const prompt = buildRecoveryPrompt({
        agentName: "phil",
        worktreePath: "/w",
        validation: aheadDirty,
      });
      expect(prompt).toContain("## Branch finalize");
      expect(prompt).toContain("git cherry origin/main HEAD");
      expect(prompt).toContain("agent-finalize.sh");
      expect(prompt).toContain("FINALIZE");
      expect(prompt).toContain("GRADUATE");
    });

    it("graduation section header marks it as edge case", () => {
      const prompt = buildRecoveryPrompt({
        agentName: "phil",
        worktreePath: "/w",
        validation: aheadDirty,
      });
      expect(prompt).toContain("## Branch graduation (edge case");
    });
  });

  describe("DX-330 — branch graduation via three-lock force-with-lease", () => {
    const aheadDirty: DirtyValidation = {
      state: "dirty",
      reason: "branch has unmerged commits",
      details: { porcelain: "", ahead: 2, behind: 0 },
    };

    it("forbidden list specifies the three distinct push restrictions (no-lease bare force, lease-against-main, lease-against-other-branch)", () => {
      const prompt = buildRecoveryPrompt({
        agentName: "phil",
        worktreePath: "/w",
        validation: aheadDirty,
      });
      // (a) Bare --force is always forbidden, no exceptions.
      expect(prompt).toMatch(
        /`git push --force`.*no-lease.*forbidden/i,
      );
      // (b) --force-with-lease against main is forbidden.
      expect(prompt).toMatch(
        /`git push --force-with-lease` against `main`.*forbidden/,
      );
      // (c) --force-with-lease against ANY branch other than self is forbidden.
      expect(prompt).toMatch(
        /`git push --force-with-lease` against any branch other than your own \(`phil`\)/,
      );
    });

    it("allowed-operations section advertises branch graduation against own branch only", () => {
      const prompt = buildRecoveryPrompt({
        agentName: "phil",
        worktreePath: "/w",
        validation: aheadDirty,
      });
      expect(prompt).toContain("Allowed operations");
      expect(prompt).toMatch(
        /Graduate `origin\/phil` via `--force-with-lease` against YOUR OWN branch ONLY/,
      );
    });

    it("renders all three locks in order: (1) cherry patch-id audit on remote, (2) capture EXPECTED_SHA, (3) backup tag pushed + verified BEFORE the force-push fires", () => {
      const prompt = buildRecoveryPrompt({
        agentName: "phil",
        worktreePath: "/w",
        validation: aheadDirty,
      });

      // Lock 1: patch-id audit
      const lock1 = prompt.indexOf("git cherry origin/main origin/phil");
      expect(lock1).toBeGreaterThan(0);

      // Lock 2: capture expected sha
      const lock2 = prompt.indexOf('EXPECTED_SHA="$(git rev-parse origin/phil)"');
      expect(lock2).toBeGreaterThan(lock1);

      // Lock 3a: tag push
      const tagPush = prompt.indexOf('git push origin "refs/tags/$TAG"');
      expect(tagPush).toBeGreaterThan(lock2);

      // Lock 3b: ls-remote confirmation
      const lsRemote = prompt.indexOf(
        'git ls-remote origin "refs/tags/$TAG" | grep -q .',
      );
      expect(lsRemote).toBeGreaterThan(tagPush);

      // The actual force-push MUST appear AFTER ls-remote confirmation.
      const forcePush = prompt.indexOf(
        'git push --force-with-lease="phil:$EXPECTED_SHA" origin "phil"',
      );
      expect(forcePush).toBeGreaterThan(lsRemote);

      // The backup tag template uses the agent name + ISO timestamp.
      expect(prompt).toContain('TAG="recovery/phil-pre-force-$TS"');
      // Pin the timestamp format spec (DX-330 — drift to unix-epoch or
      // localized format breaks the recovery-tag naming contract).
      expect(prompt).toContain('TS="$(date -u +%Y%m%dT%H%M%SZ)"');
    });

    it("abort path: failed lock → file Needs Help comment + danxbot_complete failed (no force-push, no bare --force fallback)", () => {
      const prompt = buildRecoveryPrompt({
        agentName: "phil",
        worktreePath: "/w",
        validation: aheadDirty,
      });

      expect(prompt).toContain("Abort path");
      expect(prompt).toContain(
        "Branch graduation aborted — operator action required",
      );
      expect(prompt).toContain("Do NOT fall back to bare");
      expect(prompt).toContain("`git push --force`");
      expect(prompt).toContain("Do NOT skip the patch-id audit");
      expect(prompt).toContain(
        'danxbot_complete({status: "failed", summary: "Recovery aborted',
      );
    });

    it("agent name flows into every graduation surface (no hard-coded names; works for any agent)", () => {
      const prompt = buildRecoveryPrompt({
        agentName: "murphy",
        worktreePath: "/w",
        validation: aheadDirty,
      });
      expect(prompt).toContain("git cherry origin/main origin/murphy");
      expect(prompt).toContain('EXPECTED_SHA="$(git rev-parse origin/murphy)"');
      expect(prompt).toContain('TAG="recovery/murphy-pre-force-$TS"');
      expect(prompt).toContain(
        'git push --force-with-lease="murphy:$EXPECTED_SHA" origin "murphy"',
      );
      expect(prompt).toContain("origin/murphy");
      // Sanity: another agent's name does not leak in.
      expect(prompt).not.toContain("origin/phil");
    });
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
