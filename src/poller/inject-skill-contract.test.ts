/**
 * Inject SKILL.md contract tests (ISS-136 / Phase 6 of ISS-130).
 *
 * The May-7 incident (ISS-135) showed an orphan-resumed agent re-firing a
 * `ScheduleWakeup` armed by the prior session and re-running `/danx-next`
 * from scratch. ISS-136 introduces a narrow `/loop + ScheduleWakeup`
 * contract into every dispatched-agent skill. Two invariants need pinning:
 *
 *   1. The contract section text actually exists in each dispatched-agent
 *      SKILL.md — `ALLOWED`, `FORBIDDEN`, and the load-bearing phrase
 *      `Loop owns completion timing`. The inject pipeline mirrors these
 *      files verbatim into `<repo>/.danxbot/workspaces/issue-worker/`, so
 *      asserting on the source is sufficient.
 *
 *   2. No file under `src/poller/inject/` recommends `/loop` or
 *      `ScheduleWakeup` as a way to wait on something. A regression that
 *      tells an agent to "use /loop to wait for ..." would re-introduce
 *      the May-7 failure mode.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const INJECT_ROOT = resolve(__dirname, "inject");
const DISPATCHED_AGENT_SKILLS = [
  "workspaces/issue-worker/.claude/skills/danx-next/SKILL.md",
  "workspaces/issue-worker/.claude/skills/danx-start/SKILL.md",
  "workspaces/issue-worker/.claude/skills/danx-triage-card/SKILL.md",
  "workspaces/issue-worker/.claude/skills/danx-ideate/SKILL.md",
];

function walkMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkMarkdownFiles(full));
    } else if (entry.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

describe("inject skill /loop + ScheduleWakeup contract (ISS-136)", () => {
  it.each(DISPATCHED_AGENT_SKILLS)(
    "%s carries the ALLOWED / FORBIDDEN / Loop-owns-completion-timing contract",
    (relPath) => {
      const body = readFileSync(join(INJECT_ROOT, relPath), "utf-8");
      expect(body).toContain("/loop and ScheduleWakeup");
      expect(body).toContain("ALLOWED");
      expect(body).toContain("FORBIDDEN");
      expect(body).toContain("Loop owns completion timing");
    },
  );

  // Pin each of the three FORBIDDEN bullets that name the May-7 failure
  // mode. Card AC #2: "ALLOWED/FORBIDDEN list explicitly covers the
  // May-7 failure mode (waiting on human, waiting on next card,
  // complete-while-loop-active)." Without these per-bullet assertions, a
  // regression that deletes (e.g.) the "Waiting for a human" bullet but
  // leaves the "Loop owns completion timing" sentence in place would
  // pass the broader contract test above.
  it.each(DISPATCHED_AGENT_SKILLS)(
    "%s names every May-7 failure mode in its FORBIDDEN list",
    (relPath) => {
      const body = readFileSync(join(INJECT_ROOT, relPath), "utf-8");
      expect(body).toMatch(/Waiting for a human to reply/i);
      expect(body).toMatch(/Waiting for the next card to land/i);
      expect(body).toMatch(
        /Arming `?\/loop`? and then calling `?danxbot_complete`?/i,
      );
    },
  );

  it("no inject skill or rule file contradicts the contract — every /loop or ScheduleWakeup mention sits inside a file that explains the rule", () => {
    const files = walkMarkdownFiles(INJECT_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const offenders: { file: string; reason: string }[] = [];
    const slashLoopRe = /(?<![A-Za-z])\/loop(?![A-Za-z])/;
    const wakeupRe = /ScheduleWakeup/;

    for (const file of files) {
      const body = readFileSync(file, "utf-8");
      const mentionsContractToken =
        slashLoopRe.test(body) || wakeupRe.test(body);
      if (!mentionsContractToken) continue;

      if (!body.includes("Loop owns completion timing")) {
        offenders.push({
          file,
          reason:
            "mentions /loop or ScheduleWakeup but does NOT carry the contract phrase 'Loop owns completion timing'",
        });
      }
    }

    expect(offenders).toEqual([]);
  });

  it("no inject file recommends /loop or ScheduleWakeup as a way to wait on something", () => {
    const files = walkMarkdownFiles(INJECT_ROOT);
    const forbiddenRecommendations = [
      /use\s+\/loop\s+to\s+wait/i,
      /use\s+ScheduleWakeup\s+to\s+wait/i,
      /use\s+\/loop\s+to\s+defer/i,
      /use\s+ScheduleWakeup\s+to\s+defer/i,
      /\/loop\s+(?:until|while)\s+(?:the\s+)?(?:human|operator|user)/i,
    ];

    const offenders: { file: string; matched: string }[] = [];
    for (const file of files) {
      const body = readFileSync(file, "utf-8");
      for (const re of forbiddenRecommendations) {
        const m = body.match(re);
        if (m) offenders.push({ file, matched: m[0] });
      }
    }

    expect(offenders).toEqual([]);
  });
});
