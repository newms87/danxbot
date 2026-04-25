/**
 * Per-repo worker compose orchestration on the remote instance.
 * Each repo's worker runs from its own compose file under its own
 * compose project (`worker-<name>`) so workers are independently
 * stop/startable without disturbing others.
 *
 * Note on `.danxbot/settings.json` `display` section:
 * Deploy does NOT write settings.json directly. The worker's
 * `syncSettingsFileOnBoot` runs on every container start and refreshes
 * `display` from the freshly-loaded RepoContext while preserving
 * `overrides` (operator toggles). Since this `launchWorkers` step
 * recreates the worker container on every deploy, display always
 * reflects the latest masked config as soon as the worker comes back
 * up — no separate remote JSON-writing step is required. See
 * `.claude/rules/settings-file.md` for the full contract.
 */

import type { DeployConfig, DeployRepo } from "./config.js";
import type { RemoteHost } from "./remote.js";
import { CONTAINER_REPOS_BASE } from "./constants.js";

export interface LaunchEnv {
  /** Full ECR image URL to run workers against (prod) or empty for local default. */
  workerImage: string;
  /** Absolute path on the instance to the claude-auth dir (read-only mount). */
  claudeAuthDir: string;
}

export function buildLaunchCommand(
  repo: Pick<DeployRepo, "name" | "url" | "workerPort">,
  env: LaunchEnv,
): string {
  // Inline env vars feed docker-compose variable substitution in the repo's
  // compose.yml (image + claude-auth path + worker port + anything else
  // parameterized). --env-file /danxbot/.env provides shared vars
  // (ANTHROPIC_API_KEY, REPOS, DANXBOT_DB_*, etc.) the worker compose
  // references via ${VAR}. DANXBOT_WORKER_PORT comes from the deploy config
  // per-repo so host-mode settings.local.json (gitignored) is never required
  // on the remote instance.
  // DANXBOT_REPOS_BASE tells the worker process to use the container bind-mount
  // path for repos (e.g. /danxbot/repos) rather than the image-baked repos/
  // directory (which may contain stale dev-machine symlinks that resolve to
  // host paths like /home/dev/web/<name>). This ensures the agent spawn cwd
  // matches the path derived by SessionLogWatcher, so JSONL lands under the
  // correct encoded-cwd directory.
  // CLAUDE_CONFIG_FILE (file-bind for `.claude.json`) + CLAUDE_CREDS_DIR
  // (dir-bind for `.claude/`) are the per-mount absolute paths that the
  // danxbot self-referential worker compose substitutes into its volume
  // specs. CLAUDE_AUTH_DIR continues to be injected for the single-dir-
  // mount compose recipes (platform, gpt-manager). All three derive from
  // the same provisioned auth dir — the canonical layout (Trello
  // 0bjFD0a2) is `.claude.json` at the auth-dir root and
  // `.credentials.json` one level down in `.claude/`. The dir-bind on
  // `.claude/` is what makes host rename-over-mount rotation visible
  // inside the container without a worker restart.
  const claudeConfigFile = `${env.claudeAuthDir}/.claude.json`;
  const claudeCredsDir = `${env.claudeAuthDir}/.claude`;
  const prefix = `DANXBOT_WORKER_IMAGE='${env.workerImage}' CLAUDE_AUTH_DIR='${env.claudeAuthDir}' CLAUDE_CONFIG_FILE='${claudeConfigFile}' CLAUDE_CREDS_DIR='${claudeCredsDir}' CLAUDE_PROJECTS_DIR='/danxbot/claude-projects' DANXBOT_WORKER_PORT='${repo.workerPort}' DANXBOT_REPOS_BASE='${CONTAINER_REPOS_BASE}'`;
  return `${prefix} docker compose --env-file /danxbot/.env -f ${CONTAINER_REPOS_BASE}/${repo.name}/.danxbot/config/compose.yml -p worker-${repo.name} up -d --remove-orphans`;
}

export function buildStopCommand(
  repo: Pick<DeployRepo, "name" | "url">,
): string {
  return `docker compose -p worker-${repo.name} down`;
}

export function launchWorkers(
  remote: RemoteHost,
  config: DeployConfig,
  env: LaunchEnv,
): void {
  for (const repo of config.repos) {
    console.log(`\n── Launching worker for ${repo.name} ──`);
    // Pre-create any external networks the worker compose references but
    // that don't exist in production (e.g., gpt-manager's Sail network that
    // only exists when the Sail stack is running). `network create` is
    // idempotent with `|| true` so it's safe when the network already exists.
    remote.sshRun(
      `docker network inspect gpt-manager_sail >/dev/null 2>&1 || docker network create gpt-manager_sail`,
    );
    remote.sshRunStreaming(buildLaunchCommand(repo, env));
  }
}

export function stopWorkers(remote: RemoteHost, config: DeployConfig): void {
  for (const repo of config.repos) {
    console.log(`\n── Stopping worker for ${repo.name} ──`);
    remote.sshRunStreaming(buildStopCommand(repo));
  }
}
