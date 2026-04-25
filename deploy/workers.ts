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
  // CLAUDE_PROJECTS_DIR is per-repo (Trello cjAyJpgr). Each worker writes
  // JSONL into its OWN `<repo-checkout>/claude-projects/` so the dashboard's
  // per-repo path resolver finds it under the matching namespace mount. The
  // env var stays as a transitional bridge for connected-repo compose files
  // that still use `${CLAUDE_PROJECTS_DIR:-...}` (e.g. gpt-manager); the
  // danxbot self-host compose uses a static `../../claude-projects` mount
  // and ignores this injection. Once every connected-repo compose switches
  // to the static form, this var can be dropped from the prefix entirely.
  // Note: a connected repo whose compose has NO `claude-projects` mount at
  // all gets neither the bind nor the dashboard view; deploy still chowns
  // the host dir but JSONL would land in the container layer. That's a
  // pre-existing miswire on that repo's compose, not introduced here.
  // The danxbot repo SHA is NOT propagated via this prefix on purpose —
  // it lives in the image's ENV (baked via Dockerfile ARG by deploy/build.ts).
  // Adding it here would require the worker compose to interpolate it back
  // out, which silently overrides the image-baked value with empty when the
  // host shell isn't exporting it. Trello auX4nTRk for the rationale.
  const claudeProjectsDir = `${CONTAINER_REPOS_BASE}/${repo.name}/claude-projects`;
  const prefix = `DANXBOT_WORKER_IMAGE='${env.workerImage}' CLAUDE_AUTH_DIR='${env.claudeAuthDir}' CLAUDE_CONFIG_FILE='${claudeConfigFile}' CLAUDE_CREDS_DIR='${claudeCredsDir}' CLAUDE_PROJECTS_DIR='${claudeProjectsDir}' DANXBOT_WORKER_PORT='${repo.workerPort}' DANXBOT_REPOS_BASE='${CONTAINER_REPOS_BASE}'`;
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
    // Pre-create the per-repo `claude-projects/` host dir owned by UID 1000
    // (the worker container's `danxbot` user). Without this step, Docker
    // would auto-create the bind source as root-owned on first `compose
    // up`, and the worker would silently fail to write JSONL — leaving
    // the dashboard's per-repo timeline empty (Trello cjAyJpgr). Idempotent.
    remote.sshRun(
      `sudo mkdir -p ${CONTAINER_REPOS_BASE}/${repo.name}/claude-projects && sudo chown 1000:1000 ${CONTAINER_REPOS_BASE}/${repo.name}/claude-projects`,
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
