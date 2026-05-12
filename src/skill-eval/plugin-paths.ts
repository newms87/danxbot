/**
 * Plugin path resolution.
 *
 * The iteration loop edits two on-disk locations for every iteration:
 *
 *   1. The plugin source repo (default: `~/web/claude-plugins/`) —
 *      where the operator's `git push` propagates.
 *   2. The Claude Code marketplace cache (default:
 *      `~/.claude/plugins/marketplaces/<marketplace-name>/`) — where
 *      every dispatched workspace reads the live SKILL.md from.
 *
 * Without updating BOTH, the next eval-set run reads stale text from the
 * marketplace cache and the iteration loop measures the OLD description.
 *
 * `resolvePluginSkillPaths` is pure modulo `existsSync` — it validates
 * BOTH files exist on disk before the orchestrator commits to a costly
 * eval-set run. The caller injects `sourceRoot` + `cacheRoot` so tests
 * exercise the resolver against a tempdir layout.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export class PluginPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginPathError";
  }
}

export interface PluginSkillRef {
  readonly plugin: string;
  readonly skill: string;
}

export interface ResolvePluginSkillPathsArgs {
  readonly pluginSkill: string;
  readonly sourceRoot: string;
  readonly cacheRoot: string;
}

export interface ResolvedPluginSkillPaths extends PluginSkillRef {
  readonly sourceSkillPath: string;
  readonly cacheSkillPath: string;
}

/**
 * Reject any path-traversal characters in plugin / skill names. The
 * resolver concatenates the segments into filesystem paths under
 * `sourceRoot` / `cacheRoot`, so allowing `..` / `/` / `\` would let
 * the caller escape the plugin layout entirely.
 *
 * The `plugin` segment additionally must NOT contain a colon — the
 * caller's `parsePluginSkill` splits on the first colon, so any colon
 * after position 0 belongs to the skill segment.
 *
 * The `skill` segment MAY contain colons (the canonical split is
 * "first colon only" so a `<plugin>:<skill>` form like
 * `claude-code-guide:claude-code-guide` parses with `skill` =
 * `claude-code-guide`). On disk, no real skill currently uses a colon
 * in its directory name; if the resolved SKILL.md is missing, the
 * existsSync check below surfaces that as a clear error.
 */
function assertSafeSegment(label: "plugin" | "skill", value: string): void {
  if (value.length === 0) {
    throw new PluginPathError(`empty ${label} segment in plugin:skill spec`);
  }
  if (value.includes("..") || value.includes("/") || value.includes("\\")) {
    throw new PluginPathError(
      `invalid ${label} segment '${value}' (path-traversal characters '..' / '/' / '\\\\' are not allowed)`,
    );
  }
  // Reject control characters (0x00-0x1f). `path.join` throws on
  // null bytes anyway, but the generic ENOENT error obscures the
  // root cause; surface it specifically here.
  if (/[\x00-\x1f]/.test(value)) {
    throw new PluginPathError(
      `invalid ${label} segment '${JSON.stringify(value)}' (control characters not allowed)`,
    );
  }
  // Reject leading-dot segments (`.git`, `.cache`, etc.) so a
  // typo'd plugin name cannot land inside the marketplace's git
  // metadata or hidden config dirs. `..` is already blocked above.
  if (value.startsWith(".")) {
    throw new PluginPathError(
      `invalid ${label} segment '${value}' (must not start with '.')`,
    );
  }
  if (label === "plugin" && value.includes(":")) {
    throw new PluginPathError(
      `invalid plugin segment '${value}' (must not contain a colon — the spec splits on the FIRST colon only)`,
    );
  }
}

export function parsePluginSkill(spec: string): PluginSkillRef {
  if (typeof spec !== "string" || spec.length === 0) {
    throw new PluginPathError("plugin:skill spec must be a non-empty string");
  }
  if (spec !== spec.trim()) {
    throw new PluginPathError(
      `plugin:skill spec must not have leading/trailing whitespace: '${spec}'`,
    );
  }
  const colonIdx = spec.indexOf(":");
  if (colonIdx < 0) {
    throw new PluginPathError(
      `plugin:skill spec must contain a colon (got '${spec}')`,
    );
  }
  const plugin = spec.slice(0, colonIdx);
  const skill = spec.slice(colonIdx + 1);
  assertSafeSegment("plugin", plugin);
  assertSafeSegment("skill", skill);
  return { plugin, skill };
}

export function resolvePluginSkillPaths(
  args: ResolvePluginSkillPathsArgs,
): ResolvedPluginSkillPaths {
  const { plugin, skill } = parsePluginSkill(args.pluginSkill);
  const sourceSkillPath = join(
    args.sourceRoot,
    plugin,
    "skills",
    skill,
    "SKILL.md",
  );
  const cacheSkillPath = join(
    args.cacheRoot,
    plugin,
    "skills",
    skill,
    "SKILL.md",
  );
  if (!existsSync(sourceSkillPath)) {
    throw new PluginPathError(
      `source SKILL.md not found at ${sourceSkillPath} (plugin '${plugin}' / skill '${skill}' under sourceRoot '${args.sourceRoot}')`,
    );
  }
  if (!existsSync(cacheSkillPath)) {
    throw new PluginPathError(
      `cache SKILL.md not found at ${cacheSkillPath} — run /reload-plugins to populate the marketplace cache before iterating`,
    );
  }
  return {
    plugin,
    skill,
    sourceSkillPath,
    cacheSkillPath,
  };
}
