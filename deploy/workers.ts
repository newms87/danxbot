/**
 * Per-repo worker compose orchestration on the remote instance.
 * Each repo's worker runs from its own compose file under its own
 * compose project (`worker-<name>`) so workers are independently
 * stop/startable without disturbing others.
 */

import type { DeployConfig } from "./config.js";
import type { RemoteHost } from "./remote.js";

export function buildLaunchCommand(repo: {
  name: string;
  url: string;
}): string {
  return `docker compose -f /danxbot/repos/${repo.name}/.danxbot/config/compose.yml -p worker-${repo.name} up -d --remove-orphans`;
}

export function buildStopCommand(repo: {
  name: string;
  url: string;
}): string {
  return `docker compose -p worker-${repo.name} down`;
}

export function launchWorkers(remote: RemoteHost, config: DeployConfig): void {
  for (const repo of config.repos) {
    console.log(`\n── Launching worker for ${repo.name} ──`);
    remote.sshRunStreaming(buildLaunchCommand(repo));
  }
}

export function stopWorkers(remote: RemoteHost, config: DeployConfig): void {
  for (const repo of config.repos) {
    console.log(`\n── Stopping worker for ${repo.name} ──`);
    remote.sshRunStreaming(buildStopCommand(repo));
  }
}
