/**
 * Workspace manifest — the `workspace.yml` parser.
 *
 * Phase 1 of the workspace-dispatch epic (Trello `jAdeJgi5`, phase card
 * `xgqXKLXW`). A workspace manifest declares the static surface every
 * dispatched agent needs: which placeholders the resolver must fill at
 * dispatch time, which are optional, and which repo-state gates must
 * hold before a spawn is allowed. The manifest schema is frozen here —
 * every workspace declares the same shape, so the resolver can treat
 * workspaces uniformly without per-workspace branching.
 *
 * Design choices:
 *   - We use the `yaml` npm package (already a dep via `deploy/`) rather
 *     than `parseSimpleYaml` from `src/poller/parse-yaml.ts`. The simple
 *     parser handles flat scalars only; a manifest needs top-level string
 *     arrays for placeholders and gates. A thin wrapper that re-implements
 *     array support would duplicate `yaml`'s well-tested parsing.
 *   - `name` and `description` are the only required fields. `required-
 *     placeholders`, `optional-placeholders`, and `required-gates` default
 *     to `[]` when absent — a workspace with zero placeholders or zero
 *     gates is legitimate (e.g. `http-launch-default` has no gates). A
 *     missing field defaulting to empty is NOT a silent fallback: the
 *     shape is documented, and "absent" unambiguously means "zero entries."
 *   - Unknown top-level fields are ignored so the schema can evolve
 *     additively. If a future field becomes required, that's a breaking
 *     change expressed by this parser throwing loud on its absence.
 */

import { parse as parseYaml, YAMLParseError } from "yaml";

export class WorkspaceManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceManifestError";
  }
}

export interface WorkspaceManifest {
  readonly name: string;
  readonly description: string;
  readonly requiredPlaceholders: readonly string[];
  readonly optionalPlaceholders: readonly string[];
  readonly requiredGates: readonly string[];
  /**
   * Allowlist of root paths under which `/api/launch` may stage files via
   * its `staged_files[]` body field. Each entry may contain `${KEY}`
   * placeholders that are substituted against the dispatch overlay at
   * resolve time. A workspace with no `staging-paths` rejects any non-
   * empty `staged_files` payload (fail closed).
   */
  readonly stagingPaths: readonly string[];
  /**
   * Optional top-level agent name. When set, the resolver validates that
   * `<workspace>/.claude/agents/<topLevelAgent>.md` exists, and the
   * spawner forwards `--agent <name>` to claude so the top-level session
   * BECOMES that agent (eager-loads its `tools:` frontmatter, eliminating
   * the ~4s ToolSearch tax MCP tools otherwise pay). Undefined when the
   * workspace omits the field — claude runs without the flag.
   */
  readonly topLevelAgent?: string;
}

export interface ParseManifestOptions {
  /**
   * Optional label (typically the source filename or absolute path)
   * included in error messages so callers can trace parse failures to a
   * specific manifest on disk. Purely diagnostic.
   */
  source?: string;
}

function locator(options?: ParseManifestOptions): string {
  return options?.source ? ` (in ${options.source})` : "";
}

function requireString(
  raw: Record<string, unknown>,
  key: string,
  options?: ParseManifestOptions,
): string {
  const value = raw[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceManifestError(
      `workspace manifest missing required string field "${key}"${locator(options)}`,
    );
  }
  return value;
}

function readOptionalString(
  raw: Record<string, unknown>,
  key: string,
  options?: ParseManifestOptions,
): string | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceManifestError(
      `workspace manifest field "${key}" must be a non-empty string when present${locator(options)}`,
    );
  }
  return value;
}

function readStringArray(
  raw: Record<string, unknown>,
  key: string,
  options?: ParseManifestOptions,
): readonly string[] {
  const value = raw[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new WorkspaceManifestError(
      `workspace manifest field "${key}" must be an array of strings${locator(options)}`,
    );
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new WorkspaceManifestError(
        `workspace manifest field "${key}" contains a non-string entry${locator(options)}`,
      );
    }
  }
  // Return a fresh copy so callers can't alias the raw parsed structure
  // (yaml may reuse it) and so `readonly string[]` reflects reality.
  return [...(value as string[])];
}

export function parseManifest(
  yamlContent: string,
  options?: ParseManifestOptions,
): WorkspaceManifest {
  let raw: unknown;
  try {
    raw = parseYaml(yamlContent);
  } catch (err) {
    const detail = err instanceof YAMLParseError ? err.message : String(err);
    throw new WorkspaceManifestError(
      `failed to parse workspace manifest${locator(options)}: ${detail}`,
    );
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkspaceManifestError(
      `workspace manifest must be a YAML mapping at the root${locator(options)}`,
    );
  }

  const obj = raw as Record<string, unknown>;

  return {
    name: requireString(obj, "name", options),
    description: requireString(obj, "description", options),
    requiredPlaceholders: readStringArray(
      obj,
      "required-placeholders",
      options,
    ),
    optionalPlaceholders: readStringArray(
      obj,
      "optional-placeholders",
      options,
    ),
    requiredGates: readStringArray(obj, "required-gates", options),
    stagingPaths: readStringArray(obj, "staging-paths", options),
    topLevelAgent: readOptionalString(obj, "top_level_agent", options),
  };
}
