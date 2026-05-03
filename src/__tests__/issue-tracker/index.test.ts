import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  createIssueTracker,
  MEMORY_TRACKER_ENV_VALUE,
  MemoryTracker,
  TrelloTracker,
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
};

describe("createIssueTracker", () => {
  const original = process.env.DANXBOT_TRACKER;

  beforeEach(() => {
    delete process.env.DANXBOT_TRACKER;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.DANXBOT_TRACKER;
    else process.env.DANXBOT_TRACKER = original;
  });

  it("returns MemoryTracker when DANXBOT_TRACKER === MEMORY_TRACKER_ENV_VALUE", () => {
    process.env.DANXBOT_TRACKER = MEMORY_TRACKER_ENV_VALUE;
    const tracker = createIssueTracker({ trello: TRELLO });
    expect(tracker).toBeInstanceOf(MemoryTracker);
  });

  it("MEMORY_TRACKER_ENV_VALUE is the literal 'memory'", () => {
    expect(MEMORY_TRACKER_ENV_VALUE).toBe("memory");
  });

  it("returns TrelloTracker when env override is absent and trello is provided", () => {
    const tracker = createIssueTracker({ trello: TRELLO });
    expect(tracker).toBeInstanceOf(TrelloTracker);
  });

  it("throws when no tracker is configured", () => {
    expect(() => createIssueTracker({ trello: null })).toThrow(
      /no tracker available/,
    );
  });
});
