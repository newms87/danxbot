/**
 * Per-worktree consumer-stack lifecycle.
 *
 * Every agent worktree is its own docker-compose project. The compose
 * file lives at `<worktree>/docker-compose.yml` (mirrored from the
 * consumer repo's root via git worktree) and the per-worktree `.env`
 * (written by `provisionWorktreeDatabase` for Laravel-pgsql repos,
 * symlink to parent otherwise) carries the worktree-unique port +
 * DB env overrides.
 *
 * Project name: `danxbot-<repo>-<agent>` — globally unique on the host
 * so two agents on the same repo do not share container names / volumes
 * / networks.
 *
 * Provision: `docker compose -p <project> -f <worktree>/docker-compose.yml
 *            --project-directory <worktree> --env-file <worktree>/.env
 *            up -d --remove-orphans`
 *
 * Teardown: `docker compose -p <project> -f ... down --volumes
 *            --remove-orphans`
 *
 * Silent skip when `<worktree>/docker-compose.yml` is absent — repos
 * with no docker stack (pure-node, pure-rust) skip this lifecycle
 * entirely. Skip when Docker is unreachable (host without Docker
 * daemon, host-mode worker running on a CI box).
 *
 * Idempotent: `up -d` against an already-running stack is a no-op;
 * `down` against a missing stack is a no-op.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const execFile = promisify(execFileCb);
const log = createLogger("worktree-compose");

export interface ComposeOpts {
  worktreePath: string;
  repoName: string;
  worktreeName: string;
  /**
   * Override `docker` binary path — tests inject a stub. Defaults to
   * "docker" (resolved via PATH).
   */
  dockerBin?: string;
}

export type ProvisionStackResult =
  | { kind: "skipped"; reason: string }
  | { kind: "provisioned"; projectName: string };

export type TeardownStackResult =
  | { kind: "skipped"; reason: string }
  | { kind: "torn-down"; projectName: string };

export class WorktreeComposeError extends Error {
  constructor(
    message: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = "WorktreeComposeError";
  }
}

/**
 * Deterministic compose project name. Lowercases the input + replaces
 * any non-`[a-z0-9_-]` char with `-` so consumer repo names and agent
 * names that contain `_` or `-` survive intact while accidental
 * uppercase / spaces normalize.
 */
export function composeProjectName(repoName: string, agentName: string): string {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `danxbot-${norm(repoName)}-${norm(agentName)}`;
}

function composeArgs(opts: ComposeOpts): { args: string[]; project: string } {
  const project = composeProjectName(opts.repoName, opts.worktreeName);
  return {
    project,
    args: [
      "compose",
      "-p",
      project,
      "-f",
      join(opts.worktreePath, "docker-compose.yml"),
      "--project-directory",
      opts.worktreePath,
      "--env-file",
      join(opts.worktreePath, ".env"),
    ],
  };
}

async function dockerReachable(bin: string): Promise<boolean> {
  try {
    await execFile(bin, ["info"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function provisionConsumerStack(
  opts: ComposeOpts,
): Promise<ProvisionStackResult> {
  const composePath = join(opts.worktreePath, "docker-compose.yml");
  if (!existsSync(composePath)) {
    return { kind: "skipped", reason: "no docker-compose.yml in worktree" };
  }
  const bin = opts.dockerBin ?? "docker";
  if (!(await dockerReachable(bin))) {
    return { kind: "skipped", reason: "docker daemon unreachable" };
  }

  const { args, project } = composeArgs(opts);
  try {
    const { stdout, stderr } = await execFile(
      bin,
      [...args, "up", "-d", "--remove-orphans"],
      {
        // 5 min ceiling — image build (first run) + pull is the long
        // tail; subsequent `up -d` is seconds.
        timeout: 5 * 60 * 1000,
        // Compose can be chatty; give the buffer headroom.
        maxBuffer: 50 * 1024 * 1024,
      },
    );
    log.info(
      `provisionConsumerStack(${project}): up succeeded (stdout=${stdout.length}b stderr=${stderr.length}b)`,
    );
    return { kind: "provisioned", projectName: project };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    throw new WorktreeComposeError(
      `provisionConsumerStack(${project}): docker compose up failed: ${e.message ?? String(err)}`,
      stderr,
    );
  }
}

export async function teardownConsumerStack(
  opts: ComposeOpts,
): Promise<TeardownStackResult> {
  const composePath = join(opts.worktreePath, "docker-compose.yml");
  if (!existsSync(composePath)) {
    return { kind: "skipped", reason: "no docker-compose.yml in worktree" };
  }
  const bin = opts.dockerBin ?? "docker";
  if (!(await dockerReachable(bin))) {
    return { kind: "skipped", reason: "docker daemon unreachable" };
  }

  const { args, project } = composeArgs(opts);
  try {
    // `--volumes` wipes any anonymous + named volumes scoped to this
    // project. The point of per-agent stacks is full isolation; leaving
    // volumes around defeats it (next provision inherits state).
    // `--remove-orphans` reaps any service that was renamed in the
    // compose file between up + down.
    await execFile(
      bin,
      [...args, "down", "--volumes", "--remove-orphans"],
      {
        timeout: 2 * 60 * 1000,
        maxBuffer: 50 * 1024 * 1024,
      },
    );
    log.info(`teardownConsumerStack(${project}): down succeeded`);
    return { kind: "torn-down", projectName: project };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    // `down` against a never-up project returns exit 0 + a no-op
    // message on modern compose; failure here is a real problem
    // (Docker daemon flap, locked compose file). Surface as error so
    // teardown caller can decide to retry vs orphan.
    throw new WorktreeComposeError(
      `teardownConsumerStack(${project}): docker compose down failed: ${e.message ?? String(err)}`,
      stderr,
    );
  }
}
