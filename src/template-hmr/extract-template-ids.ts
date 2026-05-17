/**
 * SG-189 — derive the `(templateId, sourceDir)` list a dispatch references
 * by parsing its `stagedFilePaths`.
 *
 * SG-187 pre-stages every linked template's SFC source under
 * `/tmp/schemas/{sid}/templates/{tid}/source/<file>` BEFORE the agent
 * spawns. We sniff the templateId + source-dir out of those paths here
 * rather than threading a parallel `template_ids[]` payload field — one
 * source of truth (the staged paths the agent will actually read), zero
 * new wire-shape obligations on every caller of `dispatch()`.
 *
 * Output is deduplicated + stable-ordered by `templateId` so the lifecycle
 * caller has deterministic acquire-then-release semantics across multiple
 * source files for the same template.
 */

export interface ExtractedTemplate {
  templateId: string;
  /** Absolute path to `/tmp/schemas/{sid}/templates/{tid}/source/` (no trailing sep). */
  sourceDir: string;
}

// Captures the templateId AND everything up to and including the `source`
// segment. We don't anchor the leading `/tmp/schemas/` because a future
// staging-root change (operator override) shouldn't silently disable HMR
// for an otherwise-recognizable template path. The `(\d+)` templateId
// shape matches gpt-manager's `TemplateDefinition` model.
const TEMPLATE_SOURCE_RE = /^(.*\/templates\/(\d+)\/source)(?:\/|$)/;

/**
 * Parse the staged paths once; emit one entry per distinct templateId.
 * Stable-sorted on templateId so downstream lifecycle calls are
 * deterministic — important for tests that compare port-assignment order
 * across dispatches.
 */
export function extractTemplateIds(
  stagedFilePaths: readonly string[],
): ExtractedTemplate[] {
  const byId = new Map<string, string>();
  for (const path of stagedFilePaths) {
    const match = TEMPLATE_SOURCE_RE.exec(path);
    if (!match) continue;
    const sourceDir = match[1];
    const templateId = match[2];
    if (!byId.has(templateId)) {
      byId.set(templateId, sourceDir);
    }
  }
  return [...byId.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([templateId, sourceDir]) => ({ templateId, sourceDir }));
}
