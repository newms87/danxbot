import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DANXBOT_COMMENT_MARKER,
  LOCK_COMMENT_MARKER,
  RETRO_COMMENT_MARKER,
  findCommentByMarker,
} from "../../issue-tracker/markers.js";

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
      {
        id: "c1",
        text: `prose mentioning ${RETRO_COMMENT_MARKER} mid-sentence`,
      },
    ];
    expect(findCommentByMarker(comments, RETRO_COMMENT_MARKER)?.id).toBe("c1");
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
