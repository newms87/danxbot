import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { KNOWN_SCHEMA_MAX } from "../../issue-tracker/schema-versions.js";

/**
 * DX-597 Phase 6 — doc lint for the "no schema legacy tolerance"
 * invariant. Locks the CLAUDE.md Core Principle claim: the forbidden
 * tokens (`back-compat`, `backward-compat`, `forward-compat`,
 * `auto-migrate-on-read`, `migrate-issues-`, the retired
 * `"Needs Approval"` status, non-canonical `schema_version: N`
 * literals) appear in docs ONLY inside the two quoted
 * "forbidden patterns" surfaces.
 *
 * Scope deliberately limited to documentation surfaces — the
 * CLAUDE.md Core Principle text describes a DOC-level claim:
 *   "appear in this codebase ONLY in this section ... and in
 *    .claude/rules/agent-dispatch.md 'Forbidden Patterns' table".
 *
 * `src/**` is intentionally NOT scanned for token-level matches: the
 * runtime invariant (no legacy reader branches, no version-conditional
 * read paths) is enforced by `migrations/registry.test.ts` +
 * `yaml.test.ts` + `boot-migration-sweep.test.ts`; word-grep would
 * flag 200+ legitimate historical-context comments ("the legacy X was
 * removed in DX-N") that DO NOT reintroduce legacy behaviour.
 *
 * A separate src-scan covers non-canonical `schema_version: N`
 * literals — that pattern is mechanically distinct from prose.
 */

const FORBIDDEN_DOC_TOKENS: { token: string; regex: RegExp }[] = [
  { token: "back-compat", regex: /back-compat/i },
  { token: "backward-compat", regex: /backward-compat/i },
  { token: "forward-compat", regex: /forward-compat/i },
  { token: "auto-migrate-on-read", regex: /auto-migrate-on-read/i },
  { token: "auto-migrate on read", regex: /auto-migrate on read/i },
  { token: "migrate-issues-", regex: /migrate-issues-/i },
  { token: '"Needs Approval"', regex: /"Needs Approval"/ },
];

const SCHEMA_LITERAL = /schema_version:\s*(\d+)/g;

interface Violation {
  path: string;
  line: number;
  token: string;
  excerpt: string;
}

function repoRoot(): string {
  // Test file lives at <repo>/src/__tests__/repo/no-legacy-tokens.test.ts.
  return resolve(__dirname, "..", "..", "..");
}

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...walkMarkdown(p));
    } else if (st.isFile() && name.endsWith(".md")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Allowlist: forbidden-token mentions are exempt when they sit
 * inside a markdown section whose header matches one of the
 * canonical "forbidden patterns" anchors below, OR when a row in a
 * markdown table whose header / leading column matches the anchor.
 *
 * We allowlist by walking backwards from the offending line until
 * we hit (a) a header line `^#+ ...` whose text matches an anchor
 * (section-level exemption), or (b) a table row / lead-in line
 * matching the anchor within ±6 lines (table-cell-level exemption).
 */
const ALLOWLIST_ANCHOR_PATTERNS: RegExp[] = [
  /Core Principle: Single Canonical Schema/i,
  /forbidden tokens/i,
  /Forbidden Patterns/i,
  /Schema legacy-tolerance patterns/i,
  /forbidden patterns table/i,
  /forbidden-patterns table/i,
];

function lineMatchesAnyAnchor(line: string): boolean {
  for (const anchor of ALLOWLIST_ANCHOR_PATTERNS) {
    if (anchor.test(line)) return true;
  }
  return false;
}

function isAllowedLine(lines: string[], idx: number): boolean {
  // Anchor only on (a) the markdown-header walk-back and (b) a
  // markdown table row sentinel. Free-text "forbidden tokens"
  // mentions in arbitrary prose do NOT exempt — otherwise a future
  // edit can defeat the gate by sprinkling the phrase in a comment.
  // Walk back to the most recent `#+ ...` header — if its text
  // matches an anchor, the section is allowlisted.
  for (let i = idx; i >= 0; i--) {
    const line = lines[i]!;
    if (/^#+\s/.test(line)) {
      return lineMatchesAnyAnchor(line);
    }
  }
  // No section header found (top-of-file prose) — check ±2 lines
  // for a table-row anchor line (rows that include both `|` AND an
  // anchor phrase). This is the narrow exemption that lets a
  // pipe-delimited "Forbidden Patterns" table cell quote the
  // tokens without false-positive flagging.
  const lo = Math.max(0, idx - 2);
  const hi = Math.min(lines.length - 1, idx + 2);
  for (let i = lo; i <= hi; i++) {
    const line = lines[i]!;
    if (line.includes("|") && lineMatchesAnyAnchor(line)) return true;
  }
  return false;
}

function scanDocFile(path: string, root: string): Violation[] {
  const text = readFileSync(path, "utf-8");
  const lines = text.split("\n");
  const out: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const { token, regex } of FORBIDDEN_DOC_TOKENS) {
      if (regex.test(line) && !isAllowedLine(lines, i)) {
        out.push({
          path: relative(root, path),
          line: i + 1,
          token,
          excerpt: line.trim().slice(0, 160),
        });
      }
    }
  }
  return out;
}

function scanSrcSchemaLiterals(srcDir: string, root: string): Violation[] {
  const out: Violation[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        // Excluded subtrees.
        if (
          name === "migrations" &&
          p.endsWith(join("issue-tracker", "migrations"))
        ) {
          continue;
        }
        if (name === "__tests__") continue;
        if (name === "node_modules" || name === "dist") continue;
        walk(p);
      } else if (st.isFile() && (name.endsWith(".ts") || name.endsWith(".tsx"))) {
        // Skip *.test.ts colocated with source.
        if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) continue;
        const text = readFileSync(p, "utf-8");
        SCHEMA_LITERAL.lastIndex = 0;
        let m: RegExpExecArray | null;
        const lines = text.split("\n");
        while ((m = SCHEMA_LITERAL.exec(text)) !== null) {
          const version = Number(m[1]);
          if (version === KNOWN_SCHEMA_MAX) continue;
          // Line number for excerpt.
          const offset = m.index;
          const lineNo = text.slice(0, offset).split("\n").length;
          const excerpt = (lines[lineNo - 1] ?? "").trim().slice(0, 160);
          out.push({
            path: relative(root, p),
            line: lineNo,
            token: `schema_version: ${version}`,
            excerpt,
          });
        }
      }
    }
  };
  walk(srcDir);
  return out;
}

function formatViolations(vs: Violation[]): string {
  return vs
    .map((v) => `  ${v.path}:${v.line} — ${v.token}\n      ${v.excerpt}`)
    .join("\n");
}

describe("no-legacy-tokens doc lint (DX-597)", () => {
  const root = repoRoot();

  it("CLAUDE.md contains forbidden tokens only inside the Core Principle allowlist", () => {
    const path = resolve(root, "CLAUDE.md");
    if (!existsSync(path)) {
      throw new Error(`CLAUDE.md not found at ${path}`);
    }
    const violations = scanDocFile(path, root);
    if (violations.length > 0) {
      throw new Error(
        `${violations.length} forbidden-token violation(s) in CLAUDE.md:\n${formatViolations(violations)}`,
      );
    }
    expect(violations).toEqual([]);
  });

  it(".claude/rules/*.md contain forbidden tokens only inside Forbidden Patterns blocks", () => {
    const rulesDir = resolve(root, ".claude", "rules");
    const files = walkMarkdown(rulesDir);
    const violations: Violation[] = [];
    for (const f of files) {
      violations.push(...scanDocFile(f, root));
    }
    if (violations.length > 0) {
      throw new Error(
        `${violations.length} forbidden-token violation(s) in .claude/rules/:\n${formatViolations(violations)}`,
      );
    }
    expect(violations).toEqual([]);
  });

  const pluginRoot = resolve(homedir(), "web", "claude-plugins", "danxbot", "skills");
  it.skipIf(!existsSync(pluginRoot))(
    "danxbot plugin skills are free of forbidden tokens",
    () => {
      const files = walkMarkdown(pluginRoot).filter((p) =>
        p.endsWith("SKILL.md"),
      );
      // Vacuous-pass guard: directory existed at probe time, so the
      // plugin must ship at least one SKILL.md.
      expect(files.length).toBeGreaterThan(0);
      const violations: Violation[] = [];
      for (const f of files) {
        for (const v of scanDocFile(f, pluginRoot)) {
          violations.push(v);
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `${violations.length} forbidden-token violation(s) in danxbot plugin skills:\n${formatViolations(violations)}`,
        );
      }
      expect(violations).toEqual([]);
    },
  );

  it("allowlist meta-test — anchor exemption is section-scoped, not free-text", () => {
    // Lock the load-bearing scan logic. Synthetic doc carries two
    // hits: one inside an anchored section header (must be
    // exempted) and one outside (must be flagged). Without this
    // direct test, an over-broad anchor regex silently disables
    // every other case in this file.
    const synthetic = [
      "# Top",
      "back-compat outside any anchor — must be flagged",
      "",
      "## Forbidden Patterns",
      "back-compat inside anchor section — must be exempted",
      "",
      "## Unrelated section",
      "forward-compat outside anchor — must be flagged",
      "",
    ].join("\n");
    const lines = synthetic.split("\n");
    const flagged: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      for (const { regex } of FORBIDDEN_DOC_TOKENS) {
        if (regex.test(lines[i]!) && !isAllowedLine(lines, i)) {
          flagged.push(i + 1);
          break;
        }
      }
    }
    expect(flagged).toEqual([2, 8]);
  });

  it("src/**/*.ts production code contains no non-canonical schema_version: N literals", () => {
    const srcDir = resolve(root, "src");
    const violations = scanSrcSchemaLiterals(srcDir, root);
    if (violations.length > 0) {
      throw new Error(
        `${violations.length} non-canonical schema_version literal(s) in src/ (canonical=${KNOWN_SCHEMA_MAX}):\n${formatViolations(violations)}`,
      );
    }
    expect(violations).toEqual([]);
  });
});
