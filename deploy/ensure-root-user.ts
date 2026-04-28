/**
 * Remote operator command: provision / refresh the dashboard root user on a
 * deployed target. Reads DANX_DASHBOARD_ROOT_USER from the dashboard
 * container's already-materialized environment (no password ever leaves the
 * operator's host or transits over SSH).
 *
 * Idempotent — safe to call on every deploy. The remote CLI returns 0 with
 * a "no change" message when the password already matches.
 */

import { execSync } from "node:child_process";
import type { DeployConfig } from "./config.js";
import { resolveKeyPath } from "./remote.js";
import { getTerraformOutputs } from "./provision.js";
import { DASHBOARD_CONTAINER } from "./constants.js";

export function buildSshCommand(
  keyPath: string,
  ip: string,
): string {
  return [
    "ssh",
    "-i",
    keyPath,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    `ubuntu@${ip}`,
    "docker",
    "exec",
    "-i",
    DASHBOARD_CONTAINER,
    "npx",
    "tsx",
    "src/cli/ensure-root-user.ts",
  ].join(" ");
}

export interface EnsureRootUserDeps {
  resolveIp(): string;
  exec(cmd: string): void;
}

export function defaultEnsureRootUserDeps(): EnsureRootUserDeps {
  return {
    resolveIp: () => getTerraformOutputs().publicIp,
    exec: (cmd) => {
      execSync(cmd, { stdio: "inherit" });
    },
  };
}

export async function ensureRootUser(
  config: DeployConfig,
  deps: EnsureRootUserDeps = defaultEnsureRootUserDeps(),
): Promise<void> {
  const ip = deps.resolveIp();
  const keyPath = resolveKeyPath(config);
  console.log(
    `\n── Ensuring dashboard root user on ${config.name} (${ip}) ──`,
  );
  deps.exec(buildSshCommand(keyPath, ip));
}
