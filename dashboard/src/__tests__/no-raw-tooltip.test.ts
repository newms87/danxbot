import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Repo-level guard for the "DanxUI everywhere" rule
 * (`.claude/rules/dashboard.md` § Component Library Mandate). The
 * native `title=` HTML attribute renders a browser default tooltip
 * that ignores theme, ignores reduced-motion, ignores keyboard focus,
 * and disagrees with the rest of the dashboard's hover-popover UX.
 * Every tooltip in the SPA MUST be a `DanxTooltip` from
 * `@thehammer/danx-ui` — uniform styling, accessibility, dark-mode.
 *
 * Allowed `title=` shapes (explicitly NOT tooltips):
 *
 *   1. Dialog-flavored component props — `<DanxDialog title="...">`,
 *      `<AgentConfirmModal title="...">`, etc. The attribute is the
 *      dialog HEADER, not a hover tooltip.
 *   2. `<title>` SVG child element (none in current tree, but valid).
 *
 * Detection heuristic: walk every `*.vue` template, find `title=` /
 * `:title=` attributes, and reject any that sit on a tag whose name
 * starts with a lowercase letter (raw HTML element). Component tags
 * start uppercase (PascalCase) and are exempt — their `title` is a
 * component prop the component owns. If a future component wires a
 * raw `title=` through `$attrs` into a `<button>`, fix the component;
 * don't widen this guard.
 */

const SWEEP_ROOT = resolve(__dirname, "..");
const COMPONENTS_DIR = join(SWEEP_ROOT, "components");

function listVueFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(current: string, prefix: string): void {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full, prefix ? `${prefix}/${entry}` : entry);
        continue;
      }
      if (!entry.endsWith(".vue")) continue;
      out.push(prefix ? `${prefix}/${entry}` : entry);
    }
  }
  walk(dir, "");
  return out;
}

// Matches an opening tag and captures (1) the tag name and (2) the
// attribute block up to the closing `>` (single-line OR multi-line).
// We then scan the attribute block for a stray `title=` / `:title=`.
//
// Why not a single `<lowercase ... :?title=` regex: HTML attributes
// commonly span multiple lines (`:title="..."` on its own indented
// row, with other attrs above/below). A flat regex either misses the
// multi-line case or false-positives on `title=` deep inside an
// already-converted DanxTooltip slot. Capturing the full tag header
// keeps the check tag-scoped.
const TAG_RE = /<([A-Za-z][A-Za-z0-9-]*)\b([^>]*?)\/?>/g;
const TITLE_ATTR_RE = /(?:^|\s):?title\s*=/;

interface Violation {
  file: string;
  tag: string;
  line: number;
  snippet: string;
}

function findRawTitleAttrs(source: string): Violation[] {
  // Only inspect the `<template>` block — `<script>` may legitimately
  // mention `title` as a string literal or identifier.
  const tmplMatch = source.match(/<template[\s\S]*?<\/template>/);
  if (!tmplMatch) return [];
  const template = tmplMatch[0];
  const templateStart = source.indexOf(template);

  const violations: Violation[] = [];
  for (const m of template.matchAll(TAG_RE)) {
    const [whole, tagName, attrBlock] = m;
    if (!tagName || !attrBlock) continue;
    // Components start with an uppercase letter; their `title=` is a
    // component prop, not an HTML attribute.
    if (/^[A-Z]/.test(tagName)) continue;
    if (!TITLE_ATTR_RE.test(attrBlock)) continue;
    const idx = (m.index ?? 0) + templateStart;
    const lineNo = source.slice(0, idx).split("\n").length;
    violations.push({
      file: "",
      tag: tagName,
      line: lineNo,
      snippet: whole.replace(/\s+/g, " ").slice(0, 120),
    });
  }
  return violations;
}

describe("regex self-test (meta — load-bearing patterns)", () => {
  it("flags raw HTML title attribute", () => {
    const v = findRawTitleAttrs(
      `<template><span title="hi">x</span></template>`,
    );
    expect(v).toHaveLength(1);
    expect(v[0].tag).toBe("span");
  });
  it("flags bound :title on raw HTML element", () => {
    const v = findRawTitleAttrs(
      `<template><button :title="foo">x</button></template>`,
    );
    expect(v).toHaveLength(1);
    expect(v[0].tag).toBe("button");
  });
  it("flags multi-line attribute block", () => {
    const v = findRawTitleAttrs(
      `<template>\n  <span\n    class="x"\n    :title="foo"\n  >y</span>\n</template>`,
    );
    expect(v).toHaveLength(1);
  });
  it("ignores title= on a PascalCase component (DanxDialog, etc.)", () => {
    expect(
      findRawTitleAttrs(`<template><DanxDialog title="Reset?" /></template>`),
    ).toHaveLength(0);
    expect(
      findRawTitleAttrs(
        '<template><AgentConfirmModal :title="`Delete ${n}`" /></template>',
      ),
    ).toHaveLength(0);
  });
  it("ignores title= mentioned only inside <script>", () => {
    expect(
      findRawTitleAttrs(
        `<script setup>\nconst x = { title: "hi" };\n</script>\n<template><span>x</span></template>`,
      ),
    ).toHaveLength(0);
  });
});

const componentFiles = listVueFiles(COMPONENTS_DIR);

describe("dashboard/src/components — DanxTooltip mandate", () => {
  it("the sweep inspects more than zero components (smoke check)", () => {
    expect(componentFiles.length).toBeGreaterThan(0);
  });

  it.each(componentFiles)(
    "%s: no raw HTML title attribute (use DanxTooltip)",
    (relPath) => {
      const source = readFileSync(join(COMPONENTS_DIR, relPath), "utf-8");
      const violations = findRawTitleAttrs(source);
      const formatted = violations
        .map((v) => `  line ${v.line}: <${v.tag}> ${v.snippet}`)
        .join("\n");
      expect(
        violations.length,
        violations.length === 0
          ? ""
          : `${relPath} has raw HTML \`title=\` tooltips — wrap with <DanxTooltip :tooltip="…"><template #trigger>…</template></DanxTooltip> instead. Native browser tooltips ignore theme, focus, and reduced-motion. See .claude/rules/dashboard.md § Component Library Mandate.\n${formatted}`,
      ).toBe(0);
    },
  );
});
