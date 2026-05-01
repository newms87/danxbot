/**
 * Remote operator command: create / rotate a dashboard user on a deployed target.
 *
 * Flow: read password locally (env var or TTY echo-off prompt) → SSH to the
 * EC2 instance → `docker exec -i <dashboard> npx tsx src/cli/create-user.ts
 * --username <user>` with the password piped over stdin. The remote CLI's
 * stdout (the "Created/updated user ... API token: ..." banner) streams back
 * to the local terminal so the operator sees the token exactly once.
 *
 * The password NEVER lands on the remote filesystem, in process args, or in
 * shell history anywhere. Only in memory on both hosts for the brief duration
 * of the SSH pipe.
 *
 * Validation runs in TWO layers (defense in depth, both backed by the SAME
 * shared rules in src/lib/auth-rules.ts — no drift):
 *   - Local: rejects bad usernames before any SSH/spawn happens.
 *   - Remote: the worker CLI re-validates inside the dashboard container.
 *
 * IP resolution is the caller's responsibility — pass `ip` explicitly. The
 * caller (cli.ts) goes through `resolveOutputs(target, config)` which owns
 * the cache-vs-Terraform decision; this module never sees a target name.
 */

import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import type { DeployConfig } from "./config.js";
import { resolveKeyPath } from "./remote.js";
import { DASHBOARD_CONTAINER } from "./constants.js";
import {
  validatePassword,
  validateUsername,
} from "../src/lib/auth-rules.js";
import { resolvePassword } from "../src/lib/tty-password.js";

export { DASHBOARD_CONTAINER };

export interface SshInvocation {
  cmd: string;
  args: string[];
}

/**
 * Compose the full argv for `spawnSync` that runs the remote CLI over SSH with
 * the password piped in on stdin. Exported for unit tests.
 *
 * Shape:
 *   ssh -i <key> -o ... ubuntu@<ip>
 *     docker exec -i <dashboard-container> npx tsx src/cli/create-user.ts --username <name>
 *
 * The username has already been validated by `validateUsername` before reaching
 * this function — the regex allows only `[a-zA-Z0-9_-]`, none of which have
 * shell meaning, so it is safe to pass unquoted.
 */
export function buildSshInvocation(
  keyPath: string,
  ip: string,
  username: string,
): SshInvocation {
  // Defensive re-check: never let a caller skip validateUsername and slip a
  // shell-injection payload into spawnSync's argv list.
  validateUsername(username);
  return {
    cmd: "ssh",
    args: [
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
      "src/cli/create-user.ts",
      "--username",
      username,
    ],
  };
}

export interface CreateUserDeps {
  /** Read password locally (defaults to env/TTY prompt). */
  readPassword(): Promise<string>;
  /** Execute SSH with stdin+stdout inherit — defaults to spawnSync. */
  execSsh(inv: SshInvocation, password: string): SpawnSyncReturns<Buffer>;
}

export function defaultCreateUserDeps(): CreateUserDeps {
  return {
    readPassword: () => resolvePassword(process.env, process.stdin, process.stderr),
    execSsh: (inv, password) =>
      spawnSync(inv.cmd, inv.args, {
        input: password + "\n",
        stdio: ["pipe", "inherit", "inherit"],
      }),
  };
}

/**
 * Orchestrate: validate username → read password → validate password → SSH
 * + docker exec with password piped on stdin. Validation runs BEFORE the
 * password prompt so an interactive operator isn't typing a password the
 * system already knows it will reject.
 *
 * `ip` is supplied by the caller (cli.ts goes through `resolveOutputs`). This
 * function never reaches into Terraform or the output cache — pure SSH.
 */
export async function createUser(
  config: DeployConfig,
  username: string,
  ip: string,
  deps: CreateUserDeps = defaultCreateUserDeps(),
): Promise<void> {
  validateUsername(username);

  const keyPath = resolveKeyPath(config);
  const inv = buildSshInvocation(keyPath, ip, username);

  console.log(
    `\n── Creating / rotating user "${username}" on ${config.name} (${ip}) ──`,
  );
  const password = await deps.readPassword();
  validatePassword(password);

  const result = deps.execSsh(inv, password);
  if (result.status !== 0) {
    throw new Error(
      `Remote create-user failed (exit ${result.status ?? "n/a"}, signal ${result.signal ?? "none"})`,
    );
  }
}
