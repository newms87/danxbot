import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * DX-639 (Phase 1 of DX-638) — repo-level guard for the "dashboard
 * never reads raw `list_name` for column grouping" rule.
 *
 * `list_name` is a denormalized display cache + tracker round-trip
 * carrier. DX-624 burned the budget proving a single missed
 * `list_name` projection event leaves a Done card rendered in In
 * Progress forever. The fix (Phase 1) projects column membership
 * from `deriveStatus(card)` → `deriveListTypeFromStatus(status)` →
 * the type's default list — see
 * `dashboard/src/composables/derive-status.ts#derivedListName`.
 *
 * This guard sweeps the SPA's Vue components + composables and bans
 * any `.list_name` access outside a small allowlist of legitimate
 * write / display surfaces:
 *
 *   - `composables/useIssues.ts` — optimistic `moveIssueList` mutation
 *     writes the dest list_name into the local row + replays pending
 *     mutations across SSE upserts (read-for-equality on the write
 *     path, not column grouping).
 *   - `components/issues/DrawerHeader.vue` — diagnostic display of the
 *     raw denormalized value + PATCH builder when the operator picks
 *     a destination list from the drawer's list menu.
 * `components/issues/DispatchGatesSection.vue` references `list_name`
 * only as an object key in PATCH bodies (`{list_name: dest}`) — that
 * form does not match `\.list_name\b` and so does NOT need an
 * allowlist entry. Same logic for any other write-only PATCH builder.
 *
 * Any other component / composable that accesses `.list_name` is a
 * regression — column grouping reads MUST go through `derivedListName`.
 *
 * Sibling pattern: `no-poll-imports.test.ts` (DX-227) sweeps the same
 * directory trees for `setInterval` polling regressions.
 */

const SWEEP_ROOT = resolve(__dirname, "..");
const COMPOSABLES_DIR = join(SWEEP_ROOT, "composables");
const COMPONENTS_DIR = join(SWEEP_ROOT, "components");

// Files allowed to mention `.list_name` directly. Every entry is a
// real read- or write-path the projection rule does not apply to;
// adding to this list requires a comment in the SKILL header above
// describing the carve-out.
const LIST_NAME_EXEMPT_FILES = new Set<string>([
  "useIssues.ts",
  "DrawerHeader.vue",
]);

// Matches `.list_name` as a property access on ANY identifier. Trailing
// boundary `\b` keeps it from spuriously matching `.list_name_foo`.
// Comments containing the literal phrase are stripped before scan so
// docstrings explaining the rule do not self-trip.
const LIST_NAME_ACCESS_RE = /\.list_name\b/;

function listSourceFiles(dir: string, exts: readonly string[]): string[] {
  const results: string[] = [];
  function walk(current: string, relPrefix: string): void {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full, relPrefix ? `${relPrefix}/${entry}` : entry);
        continue;
      }
      if (!stat.isFile()) continue;
      if (entry.endsWith(".test.ts")) continue;
      if (!exts.some((ext) => entry.endsWith(ext))) continue;
      results.push(relPrefix ? `${relPrefix}/${entry}` : entry);
    }
  }
  walk(dir, "");
  return results;
}

function basename(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? relPath : relPath.slice(i + 1);
}

/**
 * Strip line + block comments so explanatory prose mentioning
 * `issue.list_name` does not false-positive. Conservative — keeps
 * string literals intact (a `"list_name"` PATCH key would still
 * register, but no banned files contain one — the allowlist covers
 * the genuine PATCH-key sites).
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const composableSources = listSourceFiles(COMPOSABLES_DIR, [".ts"]);
const componentSources = listSourceFiles(COMPONENTS_DIR, [".vue", ".ts"]);

describe("no-raw-list-name regex self-test (meta — load-bearing pattern)", () => {
  it("matches a raw property access", () => {
    expect("issue.list_name").toMatch(LIST_NAME_ACCESS_RE);
    expect("i.list_name").toMatch(LIST_NAME_ACCESS_RE);
    expect("props.issue.list_name").toMatch(LIST_NAME_ACCESS_RE);
  });
  it("does not match unrelated identifiers", () => {
    expect("listName").not.toMatch(LIST_NAME_ACCESS_RE);
    expect("trello_list_name").not.toMatch(LIST_NAME_ACCESS_RE);
    expect(".list_name_foo").not.toMatch(LIST_NAME_ACCESS_RE);
  });
  it("strips line + block comments before scanning", () => {
    const src = `// reads issue.list_name in a doc
const x = 1;`;
    expect(stripComments(src)).not.toMatch(LIST_NAME_ACCESS_RE);
    const block = `/* mentions .list_name */ const y = 2;`;
    expect(stripComments(block)).not.toMatch(LIST_NAME_ACCESS_RE);
  });
});

describe("dashboard/src/composables — no raw list_name reads outside allowlist", () => {
  it("the sweep inspects more than zero composables (smoke check)", () => {
    expect(composableSources.length).toBeGreaterThan(0);
  });

  it.each(composableSources)(
    "%s: no `.list_name` access (use derivedListName for grouping)",
    (relPath) => {
      const raw = readFileSync(join(COMPOSABLES_DIR, relPath), "utf-8");
      const source = stripComments(raw);
      if (LIST_NAME_EXEMPT_FILES.has(basename(relPath))) return;
      expect(
        source,
        `${relPath} reads .list_name — column grouping MUST go through derivedListName(card, lists). ` +
          `If this is a legitimate write-path / PATCH builder / diagnostic display, add the file to LIST_NAME_EXEMPT_FILES + a justification comment.`,
      ).not.toMatch(LIST_NAME_ACCESS_RE);
    },
  );
});

describe("allowlist-rot guard — every exempt file must still contain `.list_name`", () => {
  // If a file is renamed / cleaned up but its basename stays on the
  // allowlist, the next file with the same basename silently inherits
  // the exemption. Assert every allowlist entry actually has a
  // legitimate `.list_name` access somewhere in the swept trees.
  it("every LIST_NAME_EXEMPT_FILES entry resolves to a real swept file with a .list_name access", () => {
    const allSwept: Array<{ root: string; rel: string }> = [
      ...composableSources.map((rel) => ({ root: COMPOSABLES_DIR, rel })),
      ...componentSources.map((rel) => ({ root: COMPONENTS_DIR, rel })),
    ];
    for (const exempt of LIST_NAME_EXEMPT_FILES) {
      const match = allSwept.find(({ rel }) => basename(rel) === exempt);
      expect(
        match,
        `Allowlist entry "${exempt}" does not match any swept file — rename or removal? ` +
          `Drop the entry from LIST_NAME_EXEMPT_FILES.`,
      ).toBeTruthy();
      if (!match) continue;
      const raw = readFileSync(join(match.root, match.rel), "utf-8");
      // Do NOT strip comments here — the exempt file may justify its
      // entry with a code reference; we want the live code access,
      // not just a docstring. Strip then assert the residual still
      // matches; if it only matched inside comments, the file has no
      // live use and should leave the allowlist.
      const stripped = stripComments(raw);
      expect(
        stripped,
        `Allowlist entry "${exempt}" (at ${match.rel}) has no live .list_name access ` +
          `outside comments — the exemption may be stale. Drop the entry from LIST_NAME_EXEMPT_FILES.`,
      ).toMatch(LIST_NAME_ACCESS_RE);
    }
  });
});

describe("dashboard/src/components — no raw list_name reads outside allowlist", () => {
  it("the sweep inspects more than zero components (smoke check)", () => {
    expect(componentSources.length).toBeGreaterThan(0);
  });

  it.each(componentSources)(
    "%s: no `.list_name` access (use derivedListName for grouping)",
    (relPath) => {
      const raw = readFileSync(join(COMPONENTS_DIR, relPath), "utf-8");
      const source = stripComments(raw);
      if (LIST_NAME_EXEMPT_FILES.has(basename(relPath))) return;
      expect(
        source,
        `${relPath} reads .list_name — column grouping MUST go through derivedListName(card, lists). ` +
          `If this is a legitimate write-path / PATCH builder / diagnostic display, add the file to LIST_NAME_EXEMPT_FILES + a justification comment.`,
      ).not.toMatch(LIST_NAME_ACCESS_RE);
    },
  );
});
