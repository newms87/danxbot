/**
 * `make create-user` CLI — wraps upsertDashboardUser for operator user
 * creation + token rotation. Runs INSIDE the dashboard container (the
 * Makefile + deploy CLI handle local vs. remote dispatch).
 *
 * Password sourcing (in order): DANXBOT_CREATE_USER_PASSWORD env var, then
 * TTY echo-off prompt when stdin is a TTY, else piped non-TTY stdin. Never
 * accepts password as a CLI arg (would land in shell history + `ps`).
 *
 * Single-shot: validation failures exit non-zero and require re-invocation.
 * Matches the UX of `psql`, `mysql`, `gh auth login`.
 */

import { upsertDashboardUser } from "../dashboard/auth-db.js";
import { closePool } from "../db/connection.js";
import { validatePassword, validateUsername } from "../lib/auth-rules.js";
import { resolvePassword } from "../lib/tty-password.js";

export interface ParsedArgs {
  username: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let username: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--username") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--username requires a value");
      }
      username = value;
      i++;
    } else if (arg.startsWith("--username=")) {
      username = arg.slice("--username=".length);
    } else {
      throw new Error(
        `Unknown argument: ${arg}. Usage: create-user --username <name>`,
      );
    }
  }

  if (!username) {
    throw new Error("--username is required. Usage: create-user --username <name>");
  }
  return { username };
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  try {
    const { username } = parseArgs(argv);
    validateUsername(username);

    const password = await resolvePassword(env, stdin, stderr);
    validatePassword(password);

    const { rawToken } = await upsertDashboardUser(username, password);
    stdout.write(
      `Created/updated user "${username}". API token (shown once, copy now): ${rawToken}\n`,
    );
    return 0;
  } catch (err) {
    stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  } finally {
    await closePool();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(
    process.argv.slice(2),
    process.env,
    process.stdin,
    process.stdout,
    process.stderr,
  )
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`Fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
