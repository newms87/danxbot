import { describe, expect, it } from "vitest";
import type { Issue } from "../issue-tracker/interface.js";
import type { ListType } from "../lists-types.js";
import {
  cascadeEpicMove,
  type CascadeAction,
  type CascadeMoveInput,
} from "./cascade-move.js";

const NOW = "2026-05-18T20:00:00.000Z";

interface MakeOpts {
  id?: string;
  listName?: string | null;
  // Current ListType the descendant should derive to via deriveStatus +
  // deriveListTypeFromSemanticStatus. The helper sets the appropriate
  // lifecycle trigger / gate field so the derivation lands on `type`.
  type: ListType;
  blockedReason?: string;
  children?: string[];
}

function makeIssue(opts: MakeOpts): Issue {
  const base: Issue = {
    schema_version: 12,
    tracker: "memory",
    id: opts.id ?? "DX-1",
    external_id: "",
    parent_id: null,
    children: opts.children ?? [],
    dispatch: null,
    status: "Review",
    type: "Feature",
    title: "T",
    description: "",
    priority: 3,
    triage: {
      expires_at: "",
      reassess_hint: "",
      last_status: "",
      last_explain: "",
      ice: { total: 0, i: 0, c: 0, e: 0 },
      history: [],
    },
    ac: [],
    comments: [],
    retro: { good: "", bad: "", action_item_ids: [], commits: [] },
    blocked: null,
    requires_human: null,
    assigned_agent: null,
    waiting_on: null,
    conflict_on: [],
    effort_level: null,
    history: [],
    db_updated_at: "",
    archived_at: null,
    ready_at: null,
    completed_at: null,
    cancelled_at: null,
    list_name: opts.listName ?? null,
  };

  switch (opts.type) {
    case "archived":
      base.status = "Backlog";
      base.archived_at = "2026-05-01T00:00:00.000Z";
      return base;
    case "review":
      base.status = "Review";
      return base;
    case "ready":
      base.status = "ToDo";
      base.ready_at = "2026-05-01T00:00:00.000Z";
      return base;
    case "blocked":
      base.status = "Blocked";
      base.blocked = {
        at: "2026-05-01T00:00:00.000Z",
        reason: opts.blockedReason ?? "stuck",
      };
      return base;
    case "in_progress":
      base.status = "In Progress";
      base.dispatch = {
        id: "d1",
        pid: 1,
        host: "h",
        kind: "work",
        started_at: "2026-05-01T00:00:00.000Z",
        ttl_seconds: 0,
      };
      return base;
    case "completed":
      base.status = "Done";
      base.completed_at = "2026-05-01T00:00:00.000Z";
      return base;
    case "cancelled":
      base.status = "Cancelled";
      base.cancelled_at = "2026-05-01T00:00:00.000Z";
      return base;
  }
}

function input(partial: Partial<CascadeMoveInput> & { destListType: ListType }): CascadeMoveInput {
  return {
    parent: makeIssue({ id: "DX-100", type: "review", listName: "Review" }),
    descendants: [],
    destListName: partial.destListName ?? defaultListNameFor(partial.destListType),
    unblockConfirmed: false,
    now: NOW,
    ...partial,
  };
}

function defaultListNameFor(type: ListType): string {
  switch (type) {
    case "archived": return "Backlog";
    case "review": return "Review";
    case "ready": return "To Do";
    case "blocked": return "Blocked";
    case "in_progress": return "In Progress";
    case "completed": return "Done";
    case "cancelled": return "Cancelled";
  }
}

describe("cascadeEpicMove — spec 5×5 matrix", () => {
  // ── FROM review/ready/archived (passive types, "review" representative) ──
  describe("from review-type child", () => {
    it("→ review (same passive type): same-type lateral if child in parent.list_name", () => {
      const parent = makeIssue({ id: "DX-100", type: "review", listName: "Review" });
      const childInParentList = makeIssue({ id: "DX-1", type: "review", listName: "Review" });
      const childInOther = makeIssue({ id: "DX-2", type: "review", listName: "Stuck Review" });
      const out = cascadeEpicMove(input({
        parent,
        descendants: [childInParentList, childInOther],
        destListType: "review",
        destListName: "Backlog Review",
      }));
      expect(out.childWrites).toHaveLength(1);
      expect(out.childWrites[0]).toMatchObject({
        id: "DX-1",
        write: { list_name: "Backlog Review" },
      });
    });

    it("→ ready: same-type lateral semantics (child in parent.list_name moves)", () => {
      const parent = makeIssue({ id: "DX-100", type: "review", listName: "Review" });
      const child = makeIssue({ id: "DX-1", type: "review", listName: "Review" });
      const out = cascadeEpicMove(input({
        parent,
        descendants: [child],
        destListType: "ready",
        destListName: "To Do",
      }));
      expect(out.childWrites).toEqual([
        { id: "DX-1", write: { ready_at: NOW, archived_at: null, completed_at: null, cancelled_at: null, list_name: "To Do" } },
      ]);
    });

    it("→ archived: same-type lateral (child in parent.list_name moves)", () => {
      const parent = makeIssue({ id: "DX-100", type: "ready", listName: "To Do" });
      const child = makeIssue({ id: "DX-1", type: "ready", listName: "To Do" });
      const out = cascadeEpicMove(input({
        parent,
        descendants: [child],
        destListType: "archived",
        destListName: "Icebox",
      }));
      expect(out.childWrites).toEqual([
        { id: "DX-1", write: { archived_at: NOW, ready_at: null, completed_at: null, cancelled_at: null, list_name: "Icebox" } },
      ]);
    });

    it("→ blocked: no child moves (epic-only block)", () => {
      const child = makeIssue({ id: "DX-1", type: "review", listName: "Review" });
      const out = cascadeEpicMove(input({
        descendants: [child],
        destListType: "blocked",
        destListName: "Blocked",
        blockedReason: "parent stuck",
      }));
      expect(out.childWrites).toEqual([]);
    });

    it("→ in_progress: only the first dispatchable child moves", () => {
      const a = makeIssue({ id: "DX-1", type: "review", listName: "Review" });
      const b = makeIssue({ id: "DX-2", type: "review", listName: "Review" });
      const c = makeIssue({ id: "DX-3", type: "review", listName: "Review" });
      const out = cascadeEpicMove(input({
        descendants: [a, b, c],
        destListType: "in_progress",
        destListName: "In Progress",
        dispatchableByPriority: [b, a, c],
      }));
      expect(out.childWrites).toEqual([
        { id: "DX-2", write: { ready_at: NOW, list_name: "In Progress" } },
      ]);
    });

    it("→ completed: child moves to completed", () => {
      const child = makeIssue({ id: "DX-1", type: "review", listName: "Review" });
      const out = cascadeEpicMove(input({
        descendants: [child],
        destListType: "completed",
        destListName: "Done",
      }));
      expect(out.childWrites).toEqual([
        { id: "DX-1", write: { completed_at: NOW, cancelled_at: null, list_name: "Done" } },
      ]);
    });

    it("→ cancelled: child moves to cancelled", () => {
      const child = makeIssue({ id: "DX-1", type: "review", listName: "Review" });
      const out = cascadeEpicMove(input({
        descendants: [child],
        destListType: "cancelled",
        destListName: "Cancelled",
      }));
      expect(out.childWrites).toEqual([
        { id: "DX-1", write: { cancelled_at: NOW, list_name: "Cancelled" } },
      ]);
    });
  });

  // ── FROM in_progress ──
  describe("from in_progress child", () => {
    it.each<ListType>(["review", "ready", "archived"])(
      "→ %s: stays",
      (destType) => {
        const child = makeIssue({ id: "DX-1", type: "in_progress" });
        const out = cascadeEpicMove(input({
          descendants: [child],
          destListType: destType,
        }));
        expect(out.childWrites).toEqual([]);
      },
    );

    it("→ blocked: stays (no child moves on epic-block)", () => {
      const child = makeIssue({ id: "DX-1", type: "in_progress" });
      const out = cascadeEpicMove(input({
        descendants: [child],
        destListType: "blocked",
        blockedReason: "x",
      }));
      expect(out.childWrites).toEqual([]);
    });

    it("→ in_progress: stays", () => {
      const child = makeIssue({ id: "DX-1", type: "in_progress" });
      const out = cascadeEpicMove(input({
        descendants: [child],
        destListType: "in_progress",
      }));
      expect(out.childWrites).toEqual([]);
    });

    it("→ completed: moves to completed", () => {
      const child = makeIssue({ id: "DX-1", type: "in_progress" });
      const out = cascadeEpicMove(input({
        descendants: [child],
        destListType: "completed",
        destListName: "Done",
      }));
      expect(out.childWrites).toEqual([
        { id: "DX-1", write: { completed_at: NOW, cancelled_at: null, list_name: "Done" } },
      ]);
    });

    it("→ cancelled: moves to cancelled", () => {
      const child = makeIssue({ id: "DX-1", type: "in_progress" });
      const out = cascadeEpicMove(input({
        descendants: [child],
        destListType: "cancelled",
        destListName: "Cancelled",
      }));
      expect(out.childWrites).toEqual([
        { id: "DX-1", write: { cancelled_at: NOW, list_name: "Cancelled" } },
      ]);
    });
  });

  // ── FROM blocked (confirm-clear semantics) ──
  describe("from blocked child", () => {
    it.each<ListType>(["review", "ready", "archived"])(
      "→ %s: stays (no auto-unblock on passive dest)",
      (destType) => {
        const child = makeIssue({ id: "DX-1", type: "blocked" });
        const out = cascadeEpicMove(input({
          descendants: [child],
          destListType: destType,
          unblockConfirmed: true,
        }));
        expect(out.childWrites).toEqual([]);
      },
    );

    it("→ blocked: stays", () => {
      const child = makeIssue({ id: "DX-1", type: "blocked" });
      const out = cascadeEpicMove(input({
        descendants: [child],
        destListType: "blocked",
        blockedReason: "x",
      }));
      expect(out.childWrites).toEqual([]);
    });

    it("→ in_progress with unblockConfirmed: clears block + moves", () => {
      const child = makeIssue({ id: "DX-1", type: "blocked" });
      const out = cascadeEpicMove(input({
        descendants: [child],
        destListType: "in_progress",
        destListName: "In Progress",
        unblockConfirmed: true,
      }));
      expect(out.childWrites).toEqual([
        { id: "DX-1", write: { ready_at: NOW, list_name: "In Progress", blocked: null } },
      ]);
      expect(out.requiresUnblockConfirm).toBe(false);
    });

    it("→ completed with unblockConfirmed: clears block + completes", () => {
      const child = makeIssue({ id: "DX-1", type: "blocked" });
      const out = cascadeEpicMove(input({
        descendants: [child],
        destListType: "completed",
        destListName: "Done",
        unblockConfirmed: true,
      }));
      expect(out.childWrites).toEqual([
        { id: "DX-1", write: { completed_at: NOW, cancelled_at: null, list_name: "Done", blocked: null } },
      ]);
    });

    it("→ cancelled with unblockConfirmed: clears block + cancels", () => {
      const child = makeIssue({ id: "DX-1", type: "blocked" });
      const out = cascadeEpicMove(input({
        descendants: [child],
        destListType: "cancelled",
        destListName: "Cancelled",
        unblockConfirmed: true,
      }));
      expect(out.childWrites).toEqual([
        { id: "DX-1", write: { cancelled_at: NOW, list_name: "Cancelled", blocked: null } },
      ]);
    });
  });

  // ── FROM completed/cancelled (terminal sources never auto-move) ──
  describe("from terminal sources", () => {
    it.each<ListType>(["review", "ready", "archived", "blocked", "in_progress", "completed", "cancelled"])(
      "completed child → %s: stays",
      (destType) => {
        const child = makeIssue({ id: "DX-1", type: "completed" });
        const out = cascadeEpicMove(input({
          descendants: [child],
          destListType: destType,
          blockedReason: "x",
          unblockConfirmed: true,
        }));
        expect(out.childWrites).toEqual([]);
      },
    );

    it.each<ListType>(["review", "ready", "archived", "blocked", "in_progress", "completed", "cancelled"])(
      "cancelled child → %s: stays",
      (destType) => {
        const child = makeIssue({ id: "DX-1", type: "cancelled" });
        const out = cascadeEpicMove(input({
          descendants: [child],
          destListType: destType,
          blockedReason: "x",
          unblockConfirmed: true,
        }));
        expect(out.childWrites).toEqual([]);
      },
    );
  });
});

describe("cascadeEpicMove — 5×5 matrix: archived + ready source cells", () => {
  // Passive sources collapse to one row in code, but the AC says "one
  // passing test per cell" — pin archived-source and ready-source so a
  // future refactor that diverges the rows fails loud.
  it.each<ListType>(["completed", "cancelled"])(
    "archived child → %s: moves",
    (destType) => {
      const child = makeIssue({ id: "DX-1", type: "archived", listName: "Icebox" });
      const out = cascadeEpicMove(input({
        parent: makeIssue({ id: "DX-100", type: "archived", listName: "Icebox" }),
        descendants: [child],
        destListType: destType,
        destListName: defaultListNameFor(destType),
      }));
      expect(out.childWrites).toHaveLength(1);
      expect(out.childWrites[0].id).toBe("DX-1");
    },
  );

  it.each<ListType>(["completed", "cancelled"])(
    "ready child → %s: moves",
    (destType) => {
      const child = makeIssue({ id: "DX-1", type: "ready", listName: "To Do" });
      const out = cascadeEpicMove(input({
        parent: makeIssue({ id: "DX-100", type: "ready", listName: "To Do" }),
        descendants: [child],
        destListType: destType,
        destListName: defaultListNameFor(destType),
      }));
      expect(out.childWrites).toHaveLength(1);
    },
  );
});

describe("cascadeEpicMove — confirmation gates", () => {
  it("requiresUnblockConfirm: true when any descendant blocked + non-blocked dest + !unblockConfirmed", () => {
    const blocked = makeIssue({ id: "DX-1", type: "blocked" });
    const out = cascadeEpicMove(input({
      descendants: [blocked],
      destListType: "completed",
      unblockConfirmed: false,
    }));
    expect(out.requiresUnblockConfirm).toBe(true);
  });

  it("requiresUnblockConfirm: false when dest is blocked itself", () => {
    const blocked = makeIssue({ id: "DX-1", type: "blocked" });
    const out = cascadeEpicMove(input({
      descendants: [blocked],
      destListType: "blocked",
      blockedReason: "x",
      unblockConfirmed: false,
    }));
    expect(out.requiresUnblockConfirm).toBe(false);
  });

  it("skips blocked-source childWrites when !unblockConfirmed (non-blocked dest)", () => {
    const blocked = makeIssue({ id: "DX-1", type: "blocked" });
    const normal = makeIssue({ id: "DX-2", type: "in_progress" });
    const out = cascadeEpicMove(input({
      descendants: [blocked, normal],
      destListType: "completed",
      destListName: "Done",
      unblockConfirmed: false,
    }));
    expect(out.childWrites.map((w) => w.id)).toEqual(["DX-2"]);
    expect(out.requiresUnblockConfirm).toBe(true);
  });

  it("blockedReasonRequired: true when destType=blocked AND blockedReason empty", () => {
    const out = cascadeEpicMove(input({
      destListType: "blocked",
      destListName: "Blocked",
      blockedReason: "",
    }));
    expect(out.blockedReasonRequired).toBe(true);
    expect(out.parentWrite).toEqual({});
    expect(out.childWrites).toEqual([]);
  });

  it("blockedReasonRequired: true when blockedReason missing entirely", () => {
    const out = cascadeEpicMove(input({
      destListType: "blocked",
      destListName: "Blocked",
    }));
    expect(out.blockedReasonRequired).toBe(true);
  });

  it("blockedReasonRequired: false when destType=blocked AND blockedReason populated", () => {
    const out = cascadeEpicMove(input({
      destListType: "blocked",
      destListName: "Blocked",
      blockedReason: "stuck waiting on review",
    }));
    expect(out.blockedReasonRequired).toBe(false);
    expect(out.parentWrite).toEqual({
      blocked: { at: NOW, reason: "stuck waiting on review" },
      list_name: "Blocked",
    });
  });
});

describe("cascadeEpicMove — parent writes", () => {
  it("parent → completed: stamps completed_at and clears cancelled_at", () => {
    const out = cascadeEpicMove(input({
      destListType: "completed",
      destListName: "Done",
    }));
    expect(out.parentWrite).toEqual({
      completed_at: NOW,
      cancelled_at: null,
      list_name: "Done",
    });
  });

  it("parent → ready: stamps ready_at and clears terminal triggers", () => {
    const out = cascadeEpicMove(input({
      destListType: "ready",
      destListName: "To Do",
    }));
    expect(out.parentWrite).toEqual({
      ready_at: NOW,
      archived_at: null,
      completed_at: null,
      cancelled_at: null,
      list_name: "To Do",
    });
  });

  it("parent → blocked: stamps blocked record only, no descendant writes", () => {
    const child = makeIssue({ id: "DX-1", type: "in_progress" });
    const out = cascadeEpicMove(input({
      descendants: [child],
      destListType: "blocked",
      destListName: "Blocked",
      blockedReason: "epic stuck",
    }));
    expect(out.parentWrite).toEqual({
      blocked: { at: NOW, reason: "epic stuck" },
      list_name: "Blocked",
    });
    expect(out.childWrites).toEqual([]);
  });
});

describe("cascadeEpicMove — overrides", () => {
  it("override kind:stay beats spec move", () => {
    const child = makeIssue({ id: "DX-1", type: "in_progress" });
    const overrides: Record<string, CascadeAction> = {
      "DX-1": { kind: "stay" },
    };
    const out = cascadeEpicMove(input({
      descendants: [child],
      destListType: "completed",
      destListName: "Done",
      overrides,
    }));
    expect(out.childWrites).toEqual([]);
  });

  it("override kind:move_to to a different list_name lands trigger writes for that listType", () => {
    const child = makeIssue({ id: "DX-1", type: "review", listName: "Review" });
    const overrides: Record<string, CascadeAction> = {
      "DX-1": { kind: "move_to", listType: "archived", listName: "Icebox" },
    };
    const out = cascadeEpicMove(input({
      parent: makeIssue({ id: "DX-100", type: "review", listName: "Review" }),
      descendants: [child],
      destListType: "completed",
      destListName: "Done",
      overrides,
    }));
    expect(out.childWrites).toEqual([
      { id: "DX-1", write: { archived_at: NOW, ready_at: null, completed_at: null, cancelled_at: null, list_name: "Icebox" } },
    ]);
  });

  it("override kind:move_same_type lands trigger writes for parent dest", () => {
    const child = makeIssue({ id: "DX-1", type: "in_progress" });
    const overrides: Record<string, CascadeAction> = {
      "DX-1": { kind: "move_same_type" },
    };
    const out = cascadeEpicMove(input({
      descendants: [child],
      destListType: "cancelled",
      destListName: "Cancelled",
      overrides,
    }));
    expect(out.childWrites).toEqual([
      { id: "DX-1", write: { cancelled_at: NOW, list_name: "Cancelled" } },
    ]);
  });
});

describe("cascadeEpicMove — override interactions", () => {
  it("override beats the !unblockConfirmed skip on a blocked-source descendant", () => {
    // Caller-supplied override is the operator's per-row decision —
    // it bypasses the default-path skip that protects blocked
    // descendants from auto-clear without confirmation. The dialog
    // surfaces the per-row dropdown for exactly this case.
    const blocked = makeIssue({ id: "DX-1", type: "blocked" });
    const overrides: Record<string, CascadeAction> = {
      "DX-1": { kind: "move_same_type" },
    };
    const out = cascadeEpicMove(input({
      descendants: [blocked],
      destListType: "completed",
      destListName: "Done",
      unblockConfirmed: false,
      overrides,
    }));
    expect(out.childWrites).toEqual([
      { id: "DX-1", write: { completed_at: NOW, cancelled_at: null, list_name: "Done", blocked: null } },
    ]);
  });
});

describe("cascadeEpicMove — parent writes (in_progress dest)", () => {
  it("parent → in_progress: stamps ready_at + list_name (picker auto-flips on next tick)", () => {
    // The card body gotcha: cascade does NOT write `dispatch` on the
    // parent — the picker auto-flips on the next tick. Phase 4 only
    // stamps the ready_at trigger so the parent becomes dispatchable.
    const out = cascadeEpicMove(input({
      destListType: "in_progress",
      destListName: "In Progress",
    }));
    expect(out.parentWrite).toEqual({ ready_at: NOW, list_name: "In Progress" });
  });
});

describe("cascadeEpicMove — same-type lateral edge cases", () => {
  it("parent.list_name === null: no children move on passive dest (same-type lateral requires a source list)", () => {
    // A parent created with no list_name (pre-DX-584 legacy / fresh
    // card never moved) has no source list-name to match descendants
    // against. The same-type lateral filter falls through to stay.
    const parent = makeIssue({ id: "DX-100", type: "review", listName: null });
    const child = makeIssue({ id: "DX-1", type: "review", listName: "Review" });
    const out = cascadeEpicMove(input({
      parent,
      descendants: [child],
      destListType: "ready",
      destListName: "To Do",
    }));
    expect(out.childWrites).toEqual([]);
  });
});

describe("cascadeEpicMove — BFS order + nesting", () => {
  it("preserves descendant input order in childWrites", () => {
    const a = makeIssue({ id: "DX-1", type: "review", listName: "Review" });
    const b = makeIssue({ id: "DX-2", type: "review", listName: "Review" });
    const c = makeIssue({ id: "DX-3", type: "review", listName: "Review" });
    const out = cascadeEpicMove(input({
      descendants: [c, a, b],
      destListType: "completed",
      destListName: "Done",
    }));
    expect(out.childWrites.map((w) => w.id)).toEqual(["DX-3", "DX-1", "DX-2"]);
  });

  it("handles 3-level deep BFS-flattened descendants", () => {
    // Epic DX-100 → epic DX-200 → leaf DX-300; epic DX-100 → leaf DX-400.
    // Caller is responsible for the BFS walk; helper just iterates.
    const lvl1a = makeIssue({ id: "DX-200", type: "review", listName: "Review", children: ["DX-300"] });
    const lvl1b = makeIssue({ id: "DX-400", type: "review", listName: "Review" });
    const lvl2 = makeIssue({ id: "DX-300", type: "review", listName: "Review" });
    const out = cascadeEpicMove(input({
      parent: makeIssue({ id: "DX-100", type: "review", listName: "Review", children: ["DX-200", "DX-400"] }),
      descendants: [lvl1a, lvl1b, lvl2],
      destListType: "completed",
      destListName: "Done",
    }));
    expect(out.childWrites.map((w) => w.id)).toEqual(["DX-200", "DX-400", "DX-300"]);
    for (const cw of out.childWrites) {
      expect(cw.write).toEqual({ completed_at: NOW, cancelled_at: null, list_name: "Done" });
    }
  });
});

describe("cascadeEpicMove — lateral within same ListType", () => {
  it("only descendants in parent.list_name move on same-type lateral", () => {
    const parent = makeIssue({ id: "DX-100", type: "review", listName: "Review" });
    const inParent = makeIssue({ id: "DX-1", type: "review", listName: "Review" });
    const inOther = makeIssue({ id: "DX-2", type: "review", listName: "Backlog Review" });
    const out = cascadeEpicMove(input({
      parent,
      descendants: [inParent, inOther],
      destListType: "review",
      destListName: "Stuck Review",
    }));
    expect(out.childWrites).toEqual([
      { id: "DX-1", write: { ready_at: null, archived_at: null, completed_at: null, cancelled_at: null, list_name: "Stuck Review" } },
    ]);
  });
});

describe("cascadeEpicMove — first dispatchable rule (consumes input list)", () => {
  it("does NOT compute the dispatchable list itself — only consumes the input list", () => {
    // Two review-state descendants, but `dispatchableByPriority` only names the second.
    // The first one stays even though sort would normally pick it.
    const a = makeIssue({ id: "DX-1", type: "review", listName: "Review" });
    const b = makeIssue({ id: "DX-2", type: "review", listName: "Review" });
    const out = cascadeEpicMove(input({
      descendants: [a, b],
      destListType: "in_progress",
      destListName: "In Progress",
      dispatchableByPriority: [b],
    }));
    expect(out.childWrites).toEqual([
      { id: "DX-2", write: { ready_at: NOW, list_name: "In Progress" } },
    ]);
  });

  it("empty dispatchableByPriority + dest=in_progress: no children move", () => {
    const a = makeIssue({ id: "DX-1", type: "review", listName: "Review" });
    const out = cascadeEpicMove(input({
      descendants: [a],
      destListType: "in_progress",
      destListName: "In Progress",
      dispatchableByPriority: [],
    }));
    expect(out.childWrites).toEqual([]);
  });

  it("first-dispatchable skips already-in_progress children in the list", () => {
    const live = makeIssue({ id: "DX-1", type: "in_progress" });
    const candidate = makeIssue({ id: "DX-2", type: "review", listName: "Review" });
    const out = cascadeEpicMove(input({
      descendants: [live, candidate],
      destListType: "in_progress",
      destListName: "In Progress",
      dispatchableByPriority: [live, candidate],
    }));
    expect(out.childWrites).toEqual([
      { id: "DX-2", write: { ready_at: NOW, list_name: "In Progress" } },
    ]);
  });
});

describe("cascadeEpicMove — purity", () => {
  it("accepts `now` parameter — same input + pinned now yields identical output", () => {
    const child = makeIssue({ id: "DX-1", type: "review", listName: "Review" });
    const a = cascadeEpicMove(input({ descendants: [child], destListType: "completed", destListName: "Done" }));
    const b = cascadeEpicMove(input({ descendants: [child], destListType: "completed", destListName: "Done" }));
    expect(a).toEqual(b);
  });

  it("does not mutate the parent or descendants", () => {
    const parent = makeIssue({ id: "DX-100", type: "review", listName: "Review" });
    const child = makeIssue({ id: "DX-1", type: "review", listName: "Review" });
    const parentSnap = JSON.parse(JSON.stringify(parent));
    const childSnap = JSON.parse(JSON.stringify(child));
    cascadeEpicMove(input({
      parent,
      descendants: [child],
      destListType: "completed",
      destListName: "Done",
    }));
    expect(parent).toEqual(parentSnap);
    expect(child).toEqual(childSnap);
  });
});
