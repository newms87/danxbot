/**
 * Workspace resolver — the single entry point every dispatched agent's
 * configuration flows through.
 *
 * Given `{repo, workspaceName, overlay}`, produce everything the spawner
 * needs to launch a claude process in this workspace:
 *
 *   - `cwd`              — absolute path to the workspace dir (agent's cwd)
 *   - `env`              — env map declared by the workspace's `.claude/settings.json`
 *   - `mcpSettingsPath`  — absolute path to a freshly-written, placeholder-substituted `.mcp.json`
 *   - `promptDelivery`   — literal `"at-file"` — every dispatched agent receives
 *                          its task via `@path/to/prompt.md` on the first message.
 *
 * The workspace's `.mcp.json` is the SINGLE source of truth for the agent's
 * MCP surface. Combined with claude's `--strict-mcp-config`, only servers
 * listed there are visible. There is no per-tool allowlist mechanism — the
 * old `allowed-tools.txt` was retired because claude's `--allowed-tools`
 * is bypassed by `--dangerously-skip-permissions` (which every dispatched
 * agent runs with). For genuine per-tool MCP subsetting (rare), declare a
 * wrapper MCP server that exposes only the desired tools.
 *
 * The resolver throws loud on every failure mode:
 *
 *   - `WorkspaceNotFoundError`       — workspace dir missing
 *   - `WorkspaceFileMissingError`    — a required file inside the workspace dir is absent
 *   - `WorkspaceLegacyFileError`     — a retired file (e.g. `allowed-tools.txt`) is still present
 *   - `WorkspaceManifestError`       — workspace.yml malformed or missing required fields
 *   - `WorkspaceSettingsError`       — .claude/settings.json shape invalid (non-string env value)
 *   - `WorkspaceGateError`           — a known gate failed for the repo
 *   - `WorkspaceGateUnknownError`    — manifest declared a gate this resolver has no evaluator for
 *   - `PlaceholderError`             — required-placeholders not supplied by overlay, or an
 *                                      unknown `${…}` reference found during substitution
 *
 * No silent fallbacks: every file in the workspace directory is required.
 * A typo'd filename (`.mcp.jsn` instead of `.mcp.json`, or `settings.jsn`)
 * must produce a loud error at resolve time, not a zero-tool agent at
 * dispatch time. An empty surface is represented by explicitly-empty
 * files: `.claude/settings.json` may be `{"env":{}}`.
 *
 * Caller (`src/dispatch/core.ts` in Phase 5) is responsible for cleaning
 * up the `mcpSettingsPath` temp dir once the dispatch ends — the
 * `cleanupWorkspaceMcpSettings` helper exported below exists so callers
 * don't re-derive the path-to-dir math.
 *
 * ## Gate registry
 *
 * Gate strings are free-form text in the manifest for readability
 * (`"settings.trelloPoller.enabled ≠ false"`, `"no CRITICAL_FAILURE flag"`). The
 * resolver holds a hardcoded lookup from gate string to predicate and
 * throws `WorkspaceGateUnknownError` for anything not in the table. A
 * new gate == a new entry here + the workspaces that need it. Parsing a
 * DSL or evaluating expressions dynamically is out of scope; every gate
 * is explicit code with explicit tests. Gate strings are compared
 * byte-for-byte — whitespace and punctuation are significant.
 *
 * ## Evaluation order
 *
 * Load-bearing: gates run BEFORE overlay validation. A repo that fails
 * its gates should never surface placeholder errors — the operator
 * needs to see the gate failure first (e.g. "trello disabled" is a
 * deployment choice; "missing TRELLO_API_KEY" is a bug). Swapping the
 * order would mask gate failures behind overlay errors during
 * debugging.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readFlag } from "../critical-failure.js";
import { isFeatureEnabled } from "../settings-file.js";
import type { RepoContext } from "../types.js";
import { parseManifest, type WorkspaceManifest } from "./manifest.js";
import {
  buildSubstitutionMap,
  substitute,
  validateOverlay,
} from "./placeholders.js";

export class WorkspaceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceNotFoundError";
  }
}

export class WorkspaceFileMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceFileMissingError";
  }
}

/**
 * Thrown when a workspace directory contains a file that was retired by a
 * deliberate architecture change. The resolver refuses to proceed so an
 * operator notices the migration miss instead of silently losing whatever
 * the file used to enforce.
 *
 * Today's only member: `allowed-tools.txt`. The allow-tools concept was
 * dropped entirely (the file's claimed gate was never enforceable for MCP
 * tools under `--dangerously-skip-permissions`). A stale file in a
 * workspace dir means somebody copied an old fixture forward — fail loud,
 * make them delete it.
 */
export class WorkspaceLegacyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceLegacyFileError";
  }
}

export class WorkspaceSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSettingsError";
  }
}

export class WorkspaceGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceGateError";
  }
}

export class WorkspaceGateUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceGateUnknownError";
  }
}

export type PromptDelivery = "at-file";

export interface ResolveWorkspaceOptions {
  repo: RepoContext;
  workspaceName: string;
  overlay: Readonly<Record<string, string>>;
}

export interface ResolvedWorkspace {
  cwd: string;
  env: Record<string, string>;
  mcpSettingsPath: string;
  promptDelivery: PromptDelivery;
  /**
   * Allowlist roots for `staged_files[]` writes — manifest's
   * `staging-paths`, with `${KEY}` placeholders substituted from the
   * dispatch overlay. Empty when the workspace declares none. The
   * dispatch core uses this to validate every staged-file path against
   * the allowlist before writing.
   */
  stagingPaths: readonly string[];
  /**
   * Top-level agent name forwarded as `--agent <name>` to claude. Set
   * when the workspace's `workspace.yml` declares `top_level_agent: X`
   * AND `.claude/agents/X.md` exists. Undefined otherwise. The dispatch
   * core threads this through to `spawnAgent` so the top-level session
   * BECOMES that agent — eager-loads its `tools:` frontmatter,
   * eliminating the ~4s ToolSearch tax MCP tools otherwise pay.
   */
  topLevelAgent?: string;
}

/** Files whose presence in a workspace dir is a hard error — see WorkspaceLegacyFileError. */
const LEGACY_WORKSPACE_FILES: readonly string[] = ["allowed-tools.txt"];

type GateEvaluator = (repo: RepoContext) => boolean;

const GATE_REGISTRY: Readonly<Record<string, GateEvaluator>> = Object.freeze({
  "no CRITICAL_FAILURE flag": (repo) => readFlag(repo.localPath) === null,
  // Three-valued settings toggle: `overrides.<feature>.enabled === false`
  // FAILS the gate; `true` passes; `null` defers to the env default. Both
  // toggles route through `isFeatureEnabled` (see `src/settings-file.ts`)
  // so the gate matches the same evaluation the Slack listener, poller
  // tick, and `/api/launch` use at runtime — operator overrides are
  // honored uniformly across enforcement paths.
  "settings.slack.enabled ≠ false": (repo) => isFeatureEnabled(repo, "slack"),
  "settings.trelloPoller.enabled ≠ false": (repo) =>
    isFeatureEnabled(repo, "trelloPoller"),
});

function workspaceRoot(repo: RepoContext, name: string): string {
  return resolve(repo.localPath, ".danxbot", "workspaces", name);
}

function evaluateGates(manifest: WorkspaceManifest, repo: RepoContext): void {
  for (const gate of manifest.requiredGates) {
    const evaluator = GATE_REGISTRY[gate];
    if (!evaluator) {
      throw new WorkspaceGateUnknownError(
        `workspace "${manifest.name}" declares unknown gate: "${gate}" (registered: ${Object.keys(GATE_REGISTRY).join(", ")})`,
      );
    }
    if (!evaluator(repo)) {
      throw new WorkspaceGateError(
        `workspace "${manifest.name}" gate failed: "${gate}"`,
      );
    }
  }
}

function requireWorkspaceFile(path: string, label: string): string {
  if (!existsSync(path)) {
    throw new WorkspaceFileMissingError(
      `workspace is missing required file ${label} at ${path}`,
    );
  }
  return readFileSync(path, "utf-8");
}

function rejectLegacyFiles(workspaceDir: string): void {
  for (const name of LEGACY_WORKSPACE_FILES) {
    const path = resolve(workspaceDir, name);
    if (existsSync(path)) {
      throw new WorkspaceLegacyFileError(
        `workspace at ${workspaceDir} contains retired file "${name}" — delete it (see the workspace resolver header in src/workspace/resolve.ts for why allow-tools was dropped: claude's --allowed-tools is bypassed by --dangerously-skip-permissions)`,
      );
    }
  }
}

function resolveEnv(
  workspaceDir: string,
  subs: Readonly<Record<string, string>>,
): Record<string, string> {
  const settingsPath = resolve(workspaceDir, ".claude", "settings.json");
  const raw = requireWorkspaceFile(settingsPath, ".claude/settings.json");
  const substituted = substitute(raw, subs);
  const parsed = JSON.parse(substituted) as { env?: unknown };
  if (parsed.env === undefined) return {};
  if (
    !parsed.env ||
    typeof parsed.env !== "object" ||
    Array.isArray(parsed.env)
  ) {
    throw new WorkspaceSettingsError(
      `${settingsPath}: "env" must be an object mapping string → string`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.env)) {
    if (typeof value !== "string") {
      throw new WorkspaceSettingsError(
        `${settingsPath}: env.${key} must be a string (got ${typeof value})`,
      );
    }
    out[key] = value;
  }
  return out;
}

function writeMcpSettings(
  workspaceDir: string,
  subs: Readonly<Record<string, string>>,
): string {
  const sourcePath = resolve(workspaceDir, ".mcp.json");
  const raw = requireWorkspaceFile(sourcePath, ".mcp.json");
  const substituted = substitute(raw, subs);
  // Parse-then-stringify so a malformed .mcp.json throws here (at
  // resolve time) rather than at claude-spawn time, where the error
  // would surface as an opaque MCP startup failure. Overlay values are
  // inserted verbatim — a value containing `"` or `\` will corrupt the
  // JSON and JSON.parse throws a SyntaxError. That's the right failure
  // mode today; Phase 5 will decide whether to escape or continue to
  // fail loud.
  const parsed = JSON.parse(substituted);
  const dir = mkdtempSync(join(tmpdir(), "danxbot-workspace-mcp-"));
  const outPath = join(dir, ".mcp.json");
  writeFileSync(outPath, JSON.stringify(parsed, null, 2));
  return outPath;
}

/**
 * Remove the temp directory created by a prior `resolveWorkspace` call.
 * Idempotent — safe to call after the dir has already been removed or
 * if the caller never actually spawned. Phase 5 will wire this into
 * the dispatch `onComplete` cleanup chain.
 */
export function cleanupWorkspaceMcpSettings(mcpSettingsPath: string): void {
  const dir = dirname(mcpSettingsPath);
  rmSync(dir, { recursive: true, force: true });
}

export function resolveWorkspace(
  options: ResolveWorkspaceOptions,
): ResolvedWorkspace {
  const { repo, workspaceName, overlay } = options;
  const cwd = workspaceRoot(repo, workspaceName);

  if (!existsSync(cwd)) {
    throw new WorkspaceNotFoundError(
      `workspace "${workspaceName}" not found at ${cwd} for repo "${repo.name}"`,
    );
  }

  const manifestRaw = requireWorkspaceFile(
    resolve(cwd, "workspace.yml"),
    "workspace.yml",
  );
  const manifest = parseManifest(manifestRaw, {
    source: resolve(cwd, "workspace.yml"),
  });

  // Gate check FIRST — see header "Evaluation order" section.
  evaluateGates(manifest, repo);
  validateOverlay(manifest, overlay);

  // Build the substitution map from overlay + manifest defaults. This
  // is the layer that implements optional-placeholder semantics (an
  // absent optional placeholder substitutes to ""); callers only see
  // their own overlay contents.
  const subs = buildSubstitutionMap(manifest, overlay);

  rejectLegacyFiles(cwd);

  const mcpSettingsPath = writeMcpSettings(cwd, subs);
  const env = resolveEnv(cwd, subs);
  const stagingPaths = manifest.stagingPaths.map((p) => substitute(p, subs));

  // top_level_agent: validate the referenced agent file exists. The flag
  // is forwarded as `--agent <name>` at spawn time, and claude resolves it
  // against `<cwd>/.claude/agents/<name>.md`. Failing here keeps every
  // bad-config failure mode loud at resolve time, before a process spawns.
  let topLevelAgent: string | undefined;
  if (manifest.topLevelAgent) {
    const agentPath = resolve(
      cwd,
      ".claude",
      "agents",
      `${manifest.topLevelAgent}.md`,
    );
    if (!existsSync(agentPath)) {
      throw new WorkspaceFileMissingError(
        `workspace "${manifest.name}" declares top_level_agent="${manifest.topLevelAgent}" but agent file is missing at ${agentPath}`,
      );
    }
    topLevelAgent = manifest.topLevelAgent;
  }

  return {
    cwd,
    env,
    mcpSettingsPath,
    promptDelivery: "at-file",
    stagingPaths,
    topLevelAgent,
  };
}
