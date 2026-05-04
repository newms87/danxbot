import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTION_ITEMS_COMMENT_MARKER,
  BOOKKEEPING_SEP,
  DANXBOT_COMMENT_MARKER,
  LOCK_COMMENT_MARKER,
  RETRO_COMMENT_MARKER,
  findCommentByMarker,
} from "../../issue-tracker/markers.js";

describe("markers — constant identity", () => {
  it("matches the on-disk literals every other module relies on", () => {
    expect(DANXBOT_COMMENT_MARKER).toBe("<!-- danxbot -->");
    expect(RETRO_COMMENT_MARKER).toBe("<!-- danxbot-retro -->");
    expect(ACTION_ITEMS_COMMENT_MARKER).toBe("<!-- danxbot-action-items -->");
    expect(LOCK_COMMENT_MARKER).toBe("<!-- danxbot-lock -->");
    expect(BOOKKEEPING_SEP).toBe("\t");
  });
});

describe("findCommentByMarker", () => {
  it("returns the matching element verbatim (preserves all fields)", () => {
    const comments = [
      { id: "c1", text: "hello", author: "alice", timestamp: "t1" },
      {
        id: "c2",
        text: `${DANXBOT_COMMENT_MARKER}\n${RETRO_COMMENT_MARKER}\n\nbody`,
        author: "danxbot",
        timestamp: "t2",
      },
    ];
    const got = findCommentByMarker(comments, RETRO_COMMENT_MARKER);
    expect(got).toBe(comments[1]);
    expect(got?.author).toBe("danxbot");
    expect(got?.timestamp).toBe("t2");
  });

  it("returns null when no comment carries the marker", () => {
    const comments = [{ id: "c1", text: "no markers here" }];
    expect(findCommentByMarker(comments, LOCK_COMMENT_MARKER)).toBeNull();
  });

  it("skips comments without a tracker-assigned id (locally-staged)", () => {
    const comments = [
      { id: undefined, text: `${LOCK_COMMENT_MARKER} staged` },
      { id: "c2", text: `${LOCK_COMMENT_MARKER} posted` },
    ];
    const got = findCommentByMarker(comments, LOCK_COMMENT_MARKER);
    expect(got?.id).toBe("c2");
  });

  it("returns the first match in iteration order", () => {
    const comments = [
      { id: "c1", text: `first ${RETRO_COMMENT_MARKER}` },
      { id: "c2", text: `second ${RETRO_COMMENT_MARKER}` },
    ];
    expect(findCommentByMarker(comments, RETRO_COMMENT_MARKER)?.id).toBe("c1");
  });

  it("works with raw tracker-shape comments (id required, no IssueComment dependency)", () => {
    const tracker = [
      {
        id: "c1",
        author: "danxbot",
        timestamp: "t1",
        text: `${LOCK_COMMENT_MARKER}\nfields`,
      },
    ];
    const got = findCommentByMarker(tracker, LOCK_COMMENT_MARKER);
    expect(got?.author).toBe("danxbot");
  });

  it("returns null for an empty input array", () => {
    expect(findCommentByMarker([], DANXBOT_COMMENT_MARKER)).toBeNull();
  });

  it("treats empty-string id the same as undefined (locally-staged)", () => {
    // Trackers may produce id="" for not-yet-synced comments. The helper
    // uses a falsy check, so both shapes are filtered identically.
    const comments = [
      { id: "", text: `${LOCK_COMMENT_MARKER} empty-id` },
      { id: "real", text: `${LOCK_COMMENT_MARKER} synced` },
    ];
    expect(findCommentByMarker(comments, LOCK_COMMENT_MARKER)?.id).toBe("real");
  });

  it("matches a marker as a substring (non-anchored String.includes contract)", () => {
    const comments = [
      { id: "c1", text: `prose mentioning ${RETRO_COMMENT_MARKER} mid-sentence` },
    ];
    expect(findCommentByMarker(comments, RETRO_COMMENT_MARKER)?.id).toBe("c1");
  });

  it("does not false-positive across the four marker constants (lexical distinctness)", () => {
    // Each specialized marker is its own literal — none is a substring of
    // another. The shared `<!-- danxbot -->` base is co-included on every
    // managed comment so the poller's `isUserResponse` filter still skips
    // them; that pairing is deliberate and tested via the consumers.
    const justRetro = [{ id: "c", text: RETRO_COMMENT_MARKER }];
    const justActionItems = [{ id: "c", text: ACTION_ITEMS_COMMENT_MARKER }];
    const justLock = [{ id: "c", text: LOCK_COMMENT_MARKER }];
    expect(findCommentByMarker(justRetro, DANXBOT_COMMENT_MARKER)).toBeNull();
    expect(findCommentByMarker(justRetro, ACTION_ITEMS_COMMENT_MARKER)).toBeNull();
    expect(findCommentByMarker(justRetro, LOCK_COMMENT_MARKER)).toBeNull();
    expect(findCommentByMarker(justActionItems, RETRO_COMMENT_MARKER)).toBeNull();
    expect(findCommentByMarker(justActionItems, LOCK_COMMENT_MARKER)).toBeNull();
    expect(findCommentByMarker(justLock, RETRO_COMMENT_MARKER)).toBeNull();
    expect(findCommentByMarker(justLock, ACTION_ITEMS_COMMENT_MARKER)).toBeNull();
  });
});

describe("markers — single source of truth (grep guard)", () => {
  // The whole point of ISS-33 is that marker LITERALS live in markers.ts
  // alone — every consumer imports the constant. A future agent must not
  // be able to silently re-inline a literal somewhere else; this test
  // walks src/ and fails if any file other than markers.ts exports a
  // marker constant or assigns a marker literal to a const/variable.
  it("no source file outside markers.ts defines a tracker-comment marker constant", () => {
    const projectRoot = resolve(__dirname, "../../..");
    const srcRoot = resolve(projectRoot, "src");
    const markerLiterals = [
      "<!-- danxbot -->",
      "<!-- danxbot-retro -->",
      "<!-- danxbot-action-items -->",
      "<!-- danxbot-lock -->",
    ];

    function* walk(dir: string): Generator<string> {
      for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          if (entry === "node_modules" || entry === "dist") continue;
          yield* walk(full);
        } else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) {
          yield full;
        }
      }
    }

    const offenses: string[] = [];
    for (const file of walk(srcRoot)) {
      // Skip the canonical home and tests/fixtures that legitimately
      // assert on the literals.
      if (file.endsWith("/issue-tracker/markers.ts")) continue;
      const text = readFileSync(file, "utf8");
      for (const literal of markerLiterals) {
        // Catch `export const X = "<!-- ... -->"` and bare
        // `const Y = "<!-- ... -->"` style redeclarations. Test files
        // and fixture assertions remain free to use the literal in
        // string concatenation, expectations, etc.
        const re = new RegExp(
          `(?:export\\s+)?const\\s+\\w+\\s*=\\s*["\`']${literal.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}["\`']`,
        );
        if (re.test(text)) {
          offenses.push(`${file}: redefines ${literal}`);
        }
      }
    }
    expect(offenses).toEqual([]);
  });
});
