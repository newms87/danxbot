import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeTrelloConfigRule } from "./trello-config-rule.js";
import type { TrelloConfig } from "../types.js";

function baseTrello(): TrelloConfig {
  return {
    apiKey: "k",
    apiToken: "t",
    boardId: "board-id",
    reviewListId: "review-id",
    todoListId: "todo-id",
    inProgressListId: "ip-id",
    needsHelpListId: "nh-list-id",
    doneListId: "done-id",
    cancelledListId: "cancel-id",
    actionItemsListId: "ai-id",
    bugLabelId: "bug-id",
    featureLabelId: "feat-id",
    epicLabelId: "epic-id",
    needsHelpLabelId: "nh-label-id",
  };
}

describe("writeTrelloConfigRule", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), "danxbot-trello-rule-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function renderedContent(trello: TrelloConfig): string {
    writeTrelloConfigRule(trello, tempDir);
    return readFileSync(resolve(tempDir, "danx-trello-config.md"), "utf-8");
  }

  it("renders board ID + all list IDs + required labels", () => {
    const content = renderedContent(baseTrello());
    expect(content).toContain("Board ID: `board-id`");
    expect(content).toContain("| Review | `review-id` |");
    expect(content).toContain("| ToDo | `todo-id` |");
    expect(content).toContain("| In Progress | `ip-id` |");
    expect(content).toContain("| Done | `done-id` |");
    expect(content).toContain("| Bug | `bug-id` |");
    expect(content).toContain("| Feature | `feat-id` |");
    expect(content).toContain("| Epic | `epic-id` |");
    expect(content).toContain("| Needs Help | `nh-label-id` |");
  });

  it("renders a Triaged row when triagedLabelId is set", () => {
    const trello = { ...baseTrello(), triagedLabelId: "tri-id" };
    const content = renderedContent(trello);
    expect(content).toContain("| Triaged | `tri-id` |");
  });

  it("omits the Triaged row when triagedLabelId is undefined", () => {
    const content = renderedContent(baseTrello());
    expect(content).not.toContain("Triaged");
  });

  it("omits the Triaged row when triagedLabelId is an empty string", () => {
    const trello = { ...baseTrello(), triagedLabelId: "" };
    const content = renderedContent(trello);
    expect(content).not.toContain("Triaged");
  });
});
