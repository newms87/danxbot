/**
 * Per-repo worker compose orchestration on the remote instance.
 * Each repo's worker runs from its own compose file under its own
 * compose project (`worker-<name>`) so workers are independently
 * stop/startable without disturbing others.
 */

import type { DeployConfig } from "./config.js";
import type { RemoteHost } from "./remote.js";

export interface LaunchEnv {
  /** Full ECR image URL to run workers against (prod) or empty for local default. */
  workerImage: string;
  /** Absolute path on the instance to the claude-auth dir (read-only mount). */
  claudeAuthDir: string;
}

export function buildLaunchCommand(
  repo: { name: string; url: string },
  env: LaunchEnv,
): string {
  // Inline env vars feed docker-compose variable substitution in the repo's
  // compose.yml (image + claude-auth path + anything else parameterized).
  // --env-file /danxbot/.env provides shared vars (ANTHROPIC_API_KEY, REPOS,
  // DANXBOT_DB_*, etc.) the worker compose references via ${VAR}.
  const prefix = `DANXBOT_WORKER_IMAGE='${env.workerImage}' CLAUDE_AUTH_DIR='${env.claudeAuthDir}'`;
  return `${prefix} docker compose --env-file /danxbot/.env -f /danxbot/repos/${repo.name}/.danxbot/config/compose.yml -p worker-${repo.name} up -d --remove-orphans`;
}

export function buildStopCommand(repo: {
  name: string;
  url: string;
}): string {
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
