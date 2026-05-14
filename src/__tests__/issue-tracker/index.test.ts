import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  createIssueTracker,
  formatTrackerBootLog,
  TrelloTracker,
  _resetForTesting,
} from "../../issue-tracker/index.js";
import type { TrelloConfig } from "../../types.js";

const TRELLO: TrelloConfig = {
  apiKey: "k",
  apiToken: "t",
  boardId: "b",
  reviewListId: "r",
  todoListId: "t",
  inProgressListId: "i",
  needsHelpListId: "n",
  doneListId: "d",
  cancelledListId: "c",
  actionItemsListId: "a",
  bugLabelId: "lb",
  featureLabelId: "lf",
  epicLabelId: "le",
  needsHelpLabelId: "lnh",
  blockedLabelId: "lblk",
  requiresHumanLabelId: "lrh",
};

describe("createIssueTracker", () => {
  const original = process.env.DANXBOT_TRACKER;

  beforeEach(() => {
    delete process.env.DANXBOT_TRACKER;
    _resetForTesting();
  });
  afterEach(() => {
    if (original === undefined) delete process.env.DANXBOT_TRACKER;
    else process.env.DANXBOT_TRACKER = original;
    _resetForTesting();
    vi.restoreAllMocks();
  });

  it("returns TrelloTracker when trello config is provided", () => {
    const tracker = createIssueTracker({ trello: TRELLO });
    expect(tracker).toBeInstanceOf(TrelloTracker);
  });

  // DX-342 — no tracker available is a valid YAML-only-mode boot, not
  // an error. createIssueTracker returns null; callers (boot wiring,
  // cron sweep, worker route, reconcile registry) branch on null and
  // skip their tracker-touching paths.
  it("returns null when no tracker is configured (YAML-only mode)", () => {
    expect(createIssueTracker({ trello: null })).toBeNull();
  });

  it("does not warn when DANXBOT_TRACKER is unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    createIssueTracker({ trello: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn for unrelated DANXBOT_TRACKER values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.DANXBOT_TRACKER = "trello";
    createIssueTracker({ trello: null });
    expect(warn).not.toHaveBeenCalled();
  });

  // DX-343 — the legacy `DANXBOT_TRACKER=memory` env value is retired.
  // The runtime ignores it (treats the worker as if the var were unset)
  // and emits a one-shot warn so an operator with the var still set in
  // a stale `.env` notices and removes it.
  it("ignores legacy DANXBOT_TRACKER=memory and emits a deprecation warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.DANXBOT_TRACKER = "memory";

    const tracker = createIssueTracker({ trello: null });

    expect(tracker).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /DANXBOT_TRACKER=memory is retired \(DX-343\); ignoring/,
    );
  });

  it("legacy DANXBOT_TRACKER=memory does not block TrelloTracker selection", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.DANXBOT_TRACKER = "memory";

    const tracker = createIssueTracker({ trello: TRELLO });

    expect(tracker).toBeInstanceOf(TrelloTracker);
  });

  // The one-shot latch is the load-bearing contract behind the warn:
  // operators with the legacy env still set should see ONE log line
  // per process lifetime, not one per `createIssueTracker` call (the
  // worker boot calls it once per repo, the cron path resolves the
  // tracker every tick on cache miss). Without this assertion, a
  // regression that drops the `!warnedLegacyMemoryEnv` guard goes
  // undetected — every other test is reset between runs.
  it("emits the deprecation warn at most once across repeated calls", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.DANXBOT_TRACKER = "memory";

    createIssueTracker({ trello: null });
    createIssueTracker({ trello: null });
    createIssueTracker({ trello: TRELLO });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  // Pins the `_resetForTesting` contract directly. Without an explicit
  // assertion that resetting re-arms the warn, the helper could become
  // a no-op without any test failing — every other suite still passes
  // because tests are isolated by the `beforeEach` reset, and the
  // warn-once contract holds within one test.
  it("re-warns after _resetForTesting clears the latch", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.DANXBOT_TRACKER = "memory";

    createIssueTracker({ trello: null });
    expect(warn).toHaveBeenCalledTimes(1);

    _resetForTesting();
    createIssueTracker({ trello: null });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

// DX-346 — pins boot log format.
describe("formatTrackerBootLog", () => {
  it("returns the trello-shape line with board id when a TrelloConfig is active", () => {
    expect(formatTrackerBootLog("danxbot", TRELLO)).toBe(
      "[danxbot] Tracker: trello (board b)",
    );
  });

  it("returns the YAML-only-mode line when no tracker is configured", () => {
    expect(formatTrackerBootLog("danxbot", null)).toBe(
      "[danxbot] Tracker: none — YAML-only mode",
    );
  });
});
