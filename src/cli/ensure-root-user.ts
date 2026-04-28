/**
 * `make ensure-root-user` CLI — provisions / refreshes the dashboard root
 * user from the `DANX_DASHBOARD_ROOT_USER` env var. Format: `username//password`.
 *
 * Idempotent: if the user already exists with the same password, no DB write
 * happens and no token rotation occurs (active sessions stay valid). Only
 * creates / updates / rotates when the password actually differs or the user
 * is new — so it's safe to run on every install + every deploy.
 *
 * Runs INSIDE the dashboard container so it shares the dashboard's DB pool +
 * auth-rules. The Makefile + deploy CLI handle local vs. remote dispatch.
 */

import {
  ensureDashboardUser,
  type EnsureUserAction,
} from "../dashboard/auth-db.js";
import { closePool } from "../db/connection.js";
import { validatePassword, validateUsername } from "../lib/auth-rules.js";

export const ROOT_USER_ENV = "DANX_DASHBOARD_ROOT_USER";
export const ROOT_USER_SEPARATOR = "//";

export interface ParsedRootCredential {
  username: string;
  password: string;
}

export function parseRootCredential(raw: string): ParsedRootCredential {
  const idx = raw.indexOf(ROOT_USER_SEPARATOR);
  if (idx < 0) {
    throw new Error(
      `${ROOT_USER_ENV} must be in the form "username${ROOT_USER_SEPARATOR}password"`,
    );
  }
  const username = raw.slice(0, idx);
  const password = raw.slice(idx + ROOT_USER_SEPARATOR.length);
  if (!username || !password) {
    throw new Error(
      `${ROOT_USER_ENV} must contain both a username and a password separated by "${ROOT_USER_SEPARATOR}"`,
    );
  }
  return { username, password };
}

function actionMessage(
  username: string,
  action: EnsureUserAction,
  rawToken?: string,
): string {
  switch (action) {
    case "created":
      return `Created dashboard user "${username}". API token (shown once, copy now): ${rawToken}`;
    case "rotated":
      return `Updated password for "${username}" and rotated API token (shown once): ${rawToken}`;
    case "unchanged":
      return `Dashboard user "${username}" already up-to-date — no change.`;
  }
}

export async function runCli(
  env: NodeJS.ProcessEnv,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  try {
    const raw = env[ROOT_USER_ENV];
    if (!raw) {
      stdout.write(
        `${ROOT_USER_ENV} not set — skipping root user provisioning.\n`,
      );
      return 0;
    }

    const { username, password } = parseRootCredential(raw);
    validateUsername(username);
    validatePassword(password);

    const { action, rawToken } = await ensureDashboardUser(username, password);
    stdout.write(actionMessage(username, action, rawToken) + "\n");
    return 0;
  } catch (err) {
    stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  } finally {
    await closePool();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.env, process.stdout, process.stderr)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`Fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
