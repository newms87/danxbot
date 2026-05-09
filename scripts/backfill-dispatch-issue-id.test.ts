import { describe, expect, it } from "vitest";
import { resolveIssueIdForRow } from "./backfill-dispatch-issue-id.js";

const INDEX = {
  byExternalId: new Map<string, string>([
    ["ext-card-1", "DX-84"],
    ["ext-card-2", "DX-92"],
  ]),
  ids: new Set(["DX-84", "DX-92", "DX-101"]),
};

describe("resolveIssueIdForRow", () => {
  it("matches a trello row by cardId via external_id", () => {
    expect(
      resolveIssueIdForRow(
        {
          trigger: "trello",
          metadata: {
            cardId: "ext-card-1",
            cardName: "title",
            cardUrl: "url",
            listId: "list",
            listName: "ToDo",
          },
        },
        INDEX,
      ),
    ).toBe("DX-84");
  });

  it("falls back to scanning the trello cardName for a known prefix", () => {
    expect(
      resolveIssueIdForRow(
        {
          trigger: "trello",
          metadata: {
            cardId: "unknown-card",
            cardName: "DX-101 — fix retry storm",
            cardUrl: "",
            listId: "",
            listName: "",
          },
        },
        INDEX,
      ),
    ).toBe("DX-101");
  });

  it("scans api initialPrompt and picks the first id present in the YAML index", () => {
    expect(
      resolveIssueIdForRow(
        {
          trigger: "api",
          metadata: {
            endpoint: "/api/launch",
            callerIp: null,
            statusUrl: null,
            initialPrompt:
              "/danx-next \nEdit /home/.../issues/open/DX-92.yml directly...",
          },
        },
        INDEX,
      ),
    ).toBe("DX-92");
  });

  it("ignores prefixes that don't match this repo's YAML id set", () => {
    expect(
      resolveIssueIdForRow(
        {
          trigger: "api",
          metadata: {
            endpoint: "/api/launch",
            callerIp: null,
            statusUrl: null,
            initialPrompt: "Reference to ABC-7 from another tracker.",
          },
        },
        INDEX,
      ),
    ).toBeNull();
  });

  it("returns null when no candidate matches anywhere", () => {
    expect(
      resolveIssueIdForRow(
        {
          trigger: "trello",
          metadata: {
            cardId: "unknown",
            cardName: "no prefix in title",
            cardUrl: "",
            listId: "",
            listName: "",
          },
        },
        INDEX,
      ),
    ).toBeNull();
  });
});
