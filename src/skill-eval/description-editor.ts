/**
 * SKILL.md description editor — pure module.
 *
 * The iteration loop in `iterate.ts` proposes a new description string for
 * a plugin skill, then mutates the on-disk SKILL.md. This module is the
 * SOLE place those mutations happen — restricting the edit surface to the
 * frontmatter `description:` field and rejecting any other kind of diff.
 *
 * The validation is intentionally double-sided:
 *   1. `replaceDescription` PRODUCES diffs that only touch `description:`.
 *   2. `validateDiff` POLICES that any pair of (old, new) SKILL.md texts
 *      differ in nothing else — the iteration orchestrator runs this
 *      against any text it is about to commit so a future bug in the
 *      writer cannot silently rename / reformat / delete other content.
 *
 * Length cap defends against runaway-growth in the proposer loop. The
 * cap is generous (longer than any current real-world description) — it
 * is an anti-runaway guard, not a quality threshold.
 */

import { parse as yamlParse, stringify as yamlStringify } from "yaml";

export type DescriptionEditCategory =
  | "no-frontmatter"
  | "no-description"
  | "invalid-yaml"
  | "description-empty"
  | "description-too-long"
  | "body-changed"
  | "frontmatter-keys-changed";

export class DescriptionEditError extends Error {
  constructor(
    message: string,
    public readonly category: DescriptionEditCategory,
  ) {
    super(message);
    this.name = "DescriptionEditError";
  }
}

/**
 * Hard cap on a proposed description's length. Set well above any
 * existing SKILL.md description so legitimate edits do not need to
 * shrink real skills. The cap exists to bound runaway growth in the
 * propose-fix-retest loop where the proposer might otherwise append
 * disambiguation clauses indefinitely.
 */
export const MAX_DESCRIPTION_LENGTH = 5000;

export interface SkillFile {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/;

export function parseSkillFile(content: string): SkillFile {
  const m = content.match(FRONTMATTER_RE);
  if (!m) {
    throw new DescriptionEditError(
      "no YAML frontmatter found (file must start with `---` and contain a closing `---` line)",
      "no-frontmatter",
    );
  }
  const fmText = m[1];
  const body = m[2];
  let parsed: unknown;
  try {
    parsed = yamlParse(fmText);
  } catch (e) {
    throw new DescriptionEditError(
      `frontmatter YAML parse failed: ${(e as Error).message}`,
      "invalid-yaml",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DescriptionEditError(
      `frontmatter must be a YAML mapping, got ${
        Array.isArray(parsed) ? "array" : typeof parsed
      }`,
      "invalid-yaml",
    );
  }
  return { frontmatter: parsed as Record<string, unknown>, body };
}

export function getDescription(content: string): string {
  const { frontmatter } = parseSkillFile(content);
  const d = frontmatter.description;
  if (d === undefined) {
    throw new DescriptionEditError(
      "frontmatter.description is missing",
      "no-description",
    );
  }
  if (typeof d !== "string") {
    throw new DescriptionEditError(
      `frontmatter.description is non-string (got ${typeof d})`,
      "no-description",
    );
  }
  return d;
}

export function replaceDescription(
  content: string,
  newDescription: string,
): string {
  if (newDescription.trim().length === 0) {
    throw new DescriptionEditError(
      "new description is empty (after trimming whitespace)",
      "description-empty",
    );
  }
  if (newDescription.length > MAX_DESCRIPTION_LENGTH) {
    throw new DescriptionEditError(
      `new description length ${newDescription.length} exceeds cap ${MAX_DESCRIPTION_LENGTH}`,
      "description-too-long",
    );
  }
  const parsed = parseSkillFile(content);
  if (typeof parsed.frontmatter.description !== "string") {
    throw new DescriptionEditError(
      "cannot replace: source frontmatter.description is missing or non-string",
      "no-description",
    );
  }

  // Rebuild the frontmatter object preserving original key order — yaml
  // stringify renders keys in the order they were inserted into the
  // object, so iterating the original keys gives us deterministic output
  // that matches the source's key sequence.
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(parsed.frontmatter)) {
    ordered[k] = k === "description" ? newDescription : parsed.frontmatter[k];
  }

  const fmText = yamlStringify(ordered, {
    lineWidth: 0,            // never auto-wrap long strings
    minContentWidth: 0,      // emit block-scalars only when needed
  }).trimEnd();

  // Body bytes are preserved VERBATIM. parseSkillFile's regex consumes
  // exactly one separator newline after the closing `---`, so whatever
  // additional whitespace the source had between the closing fence and
  // body content is captured INSIDE `parsed.body`. Re-emit `---\n<body>`
  // with no extra newline of our own.
  return `---\n${fmText}\n---\n${parsed.body}`;
}

/**
 * Throw if the new SKILL.md text differs from the old in anything other
 * than the frontmatter `description:` field.
 *
 * Run by the iteration orchestrator immediately before committing the
 * pushed file to the plugin repo. Defense-in-depth against any future
 * regression where `replaceDescription` (or some other writer) mutates
 * unintended bytes.
 */
export function validateDiff(oldContent: string, newContent: string): void {
  const a = parseSkillFile(oldContent);
  const b = parseSkillFile(newContent);

  if (a.body !== b.body) {
    throw new DescriptionEditError(
      "body changed (only frontmatter `description:` may change)",
      "body-changed",
    );
  }

  const aKeys = Object.keys(a.frontmatter).sort();
  const bKeys = Object.keys(b.frontmatter).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) {
    throw new DescriptionEditError(
      `frontmatter keys changed: ${JSON.stringify(aKeys)} -> ${JSON.stringify(bKeys)}`,
      "frontmatter-keys-changed",
    );
  }

  for (const k of aKeys) {
    if (k === "description") continue;
    const av = JSON.stringify(a.frontmatter[k]);
    const bv = JSON.stringify(b.frontmatter[k]);
    if (av !== bv) {
      throw new DescriptionEditError(
        `frontmatter key '${k}' changed (only description may change): ${av} -> ${bv}`,
        "frontmatter-keys-changed",
      );
    }
  }
}
