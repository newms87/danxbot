/**
 * Docker image build and ECR push for deploy.
 *
 * The build runs ON THE EC2 INSTANCE, not on the operator's host. Local
 * builds on WSL2 / macOS hit the Ubuntu archive CDN through residential
 * networks that intermittently time out — a single failed mirror fetch
 * during `apt-get install` produces a partial package index and exit 100
 * ("Unable to locate package"). Failed builds blocked deploys for
 * 15-20 min at a time. Building on EC2 routes apt + npm fetches through
 * AWS's network (reliable) and ECR push stays in-region (faster).
 *
 * Flow:
 *   1. Resolve danxbot SHA + image tags locally (cheap, deterministic).
 *   2. Pack tracked source via `git archive HEAD` (excludes .git +
 *      gitignored junk; honors .gitattributes export-ignore).
 *   3. scp the tarball to the EC2 instance.
 *   4. ssh: extract, `docker build`, `ecr-login.sh`, `docker push` x2.
 *   5. Clean up the remote build dir + tarball.
 *
 * EC2 prerequisites (already shipped by cloud-init.yaml.tpl):
 *   - docker (ubuntu user is in the docker group)
 *   - aws cli v2
 *   - /usr/local/bin/ecr-login.sh (registry-aware login helper)
 *   - IAM role with ECR push verbs (deploy/terraform/iam.tf "ecr_pull"
 *     policy — name predates the push additions; renaming would force
 *     a Terraform replace)
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeployConfig } from "./config.js";
import type { RemoteHost } from "./remote.js";
import { isDryRun, runStreaming, tryRun } from "./exec.js";
import { DRY_RUN_SHA } from "./dry-run-placeholders.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

export interface ImageTags {
  latestTag: string;
  timestampTag: string;
}

/**
 * Resolve the short danxbot repo SHA at deploy time. Throws if the deploy
 * is run outside a git checkout — silently shipping an image without a SHA
 * would re-create the original bug this card fixed (every dispatch row
 * landing with `danxbot_commit = NULL`). Fail loud per
 * `.claude/rules/code-quality.md` (Fallbacks Are Bugs).
 *
 * In dry-run, returns DRY_RUN_SHA instead of running `git rev-parse`.
 */
export function getDanxbotShaForBuild(): string {
  if (isDryRun()) return DRY_RUN_SHA;
  const sha = tryRun("git rev-parse --short HEAD", { cwd: REPO_ROOT })?.trim();
  if (!sha) {
    throw new Error(
      "deploy: cannot resolve danxbot commit SHA — `git rev-parse --short HEAD` failed in " +
        `${REPO_ROOT}. Run from a git checkout so the deployed image carries its build SHA.`,
    );
  }
  return sha;
}

/**
 * Compute :latest and :<timestamp> tags for a given ECR repository URL.
 * Pure function — no docker, no I/O. Unit-testable.
 */
export function buildImageTags(ecrRepositoryUrl: string): ImageTags {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return {
    latestTag: `${ecrRepositoryUrl}:latest`,
    timestampTag: `${ecrRepositoryUrl}:${timestamp}`,
  };
}

/**
 * Build the `docker build` command, optionally injecting `--build-arg
 * DANXBOT_COMMIT=<sha>` so the runtime `getDanxbotCommit()` reports the
 * baked SHA without a `.git` dir. Empty `sha` produces an unparameterized
 * build (runtime falls back to git rev-parse). Pure — unit-testable.
 */
export function buildDockerBuildCommand(
  tags: ImageTags,
  sha: string,
): string {
  const buildArg = sha ? `--build-arg DANXBOT_COMMIT=${sha} ` : "";
  return `docker build ${buildArg}-t ${tags.latestTag} -t ${tags.timestampTag} .`;
}

export interface RemoteBuildPaths {
  /** Local temp file holding the source tarball before scp. */
  localTarball: string;
  /** Remote path the tarball is uploaded to. */
  remoteTarball: string;
  /** Remote dir the tarball is extracted into for `docker build`. */
  remoteBuildDir: string;
}

/**
 * Pure path resolver — keeps the local + remote layout in one place so
 * tests can assert it without invoking ssh/scp.
 */
export function resolveRemoteBuildPaths(sha: string): RemoteBuildPaths {
  const localTarball = resolve(tmpdir(), `danxbot-deploy-${sha}.tar.gz`);
  const remoteTarball = `/tmp/danxbot-deploy-${sha}.tar.gz`;
  const remoteBuildDir = `/tmp/danxbot-build-${sha}`;
  return { localTarball, remoteTarball, remoteBuildDir };
}

/**
 * Compose the single shell command that runs end-to-end on the EC2 box:
 * extract source, build, ECR login, push both tags, clean up. Pure —
 * returns the command string so tests can assert ordering + flags.
 *
 * `set -euo pipefail` ensures any failure (extract, build, push) fails
 * the whole deploy loudly. The trailing `rm -rf` runs only after both
 * pushes succeed; on failure, the build dir is left in /tmp for triage
 * and reclaimed by `docker image prune` on the next deploy.
 */
export function buildRemoteBuildScript(opts: {
  paths: RemoteBuildPaths;
  buildCmd: string;
  ecrLoginScript?: string;
}): string {
  const ecrLogin = opts.ecrLoginScript ?? "/usr/local/bin/ecr-login.sh";
  const { remoteTarball, remoteBuildDir } = opts.paths;
  return [
    "set -euo pipefail",
    `rm -rf ${remoteBuildDir}`,
    `mkdir -p ${remoteBuildDir}`,
    `tar -xzf ${remoteTarball} -C ${remoteBuildDir}`,
    `cd ${remoteBuildDir}`,
    opts.buildCmd,
    ecrLogin,
    // Tag pushes derived from buildCmd would be brittle to parse — extract
    // them from the buildCmd string here would couple this helper to the
    // exact shape of buildDockerBuildCommand. Instead the caller composes
    // the push commands separately and appends them via the wrapper below.
  ].join(" && ");
}

/**
 * Wrap the remote build script with the two `docker push` calls + cleanup.
 * Split from buildRemoteBuildScript so tests for the pre-push prefix and
 * the full command can assert independently.
 */
export function buildRemotePushScript(opts: {
  prefix: string;
  tags: ImageTags;
  paths: RemoteBuildPaths;
}): string {
  const { remoteBuildDir, remoteTarball } = opts.paths;
  return [
    opts.prefix,
    `docker push ${opts.tags.latestTag}`,
    `docker push ${opts.tags.timestampTag}`,
    `rm -rf ${remoteBuildDir} ${remoteTarball}`,
  ].join(" && ");
}

/**
 * Read .dockerignore and convert each non-comment line to a tar
 * `--exclude=<pattern>` flag. Pure — exposed for test assertions.
 *
 * `git archive HEAD` is NOT a substitute: it would strip gitignored
 * runtime config (deploy/targets/<target>.yml — the live target
 * descriptors are intentionally gitignored because they carry
 * deployment identifiers) which the running container reads at
 * `src/target.ts#findTargetPath`. We need the working tree, minus the
 * same paths the local `docker build .` historically excluded via
 * .dockerignore.
 *
 * Patterns in danxbot's .dockerignore are simple directory / file
 * names (no leading slashes, no negations), which map 1-to-1 to
 * `tar --exclude=<name>` (matches any path component named <name>).
 * If a future .dockerignore line uses unsupported syntax (leading `!`,
 * absolute path, glob like `**`), this helper logs and skips it
 * rather than silently shipping the wrong context.
 */
export function readDockerignoreExcludes(repoRoot: string): string[] {
  const path = resolve(repoRoot, ".dockerignore");
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const excludes: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("!")) {
      console.log(
        `  WARN: .dockerignore negation "${line}" not supported by tar packer — skipped`,
      );
      continue;
    }
    excludes.push(line);
  }
  return excludes;
}

/**
 * Compose the `tar` command that produces the deploy build context.
 * Pure — returned string is fed to runStreaming. Always excludes .git
 * (huge, never needed in image; `getDanxbotShaForBuild` runs locally
 * and bakes the SHA via build-arg). Always excludes the operator's
 * temp tarballs in case `tmpdir()` resolves inside REPO_ROOT (rare,
 * but cheap to guard).
 */
export function buildTarCommand(opts: {
  repoRoot: string;
  localTarball: string;
  dockerignoreExcludes: string[];
}): string {
  const baseExcludes = [
    ".git",
    "danxbot-deploy-*.tar.gz",
    // Terraform state (`deploy/terraform/.terraform/`, `terraform.tfvars.json`,
    // `.terraform.lock.hcl`, `.terraform.tfstate.lock.info`) is rewritten
    // during the `terraform apply` step that runs EARLIER in the same
    // deploy. The image never executes terraform, so the entire dir is
    // safe to drop. Without this, tar saw "file removed before we read it"
    // mid-archive and exit 1 → the whole deploy aborted.
    "deploy/terraform",
    // Per-target output cache (deploy/targets/.cache/) is host-local;
    // never needed inside the image.
    "deploy/targets/.cache",
    ...opts.dockerignoreExcludes,
  ];
  const excludeFlags = baseExcludes
    .map((p) => `--exclude=${p}`)
    .join(" ");
  // --warning=no-file-changed/no-file-removed: tolerate transient writes
  // by other agents in the workspace (multi-agent shared cwd). Exit code
  // 0 unless tar fails for a real reason (missing input, no disk).
  return `tar --warning=no-file-changed --warning=no-file-removed ${excludeFlags} -czf ${opts.localTarball} -C ${opts.repoRoot} .`;
}

/**
 * Pack the working-tree source into a tarball matching the historical
 * `docker build .` build context (working tree minus .dockerignore +
 * .git). Throws loudly if the resulting tarball is missing.
 */
export function packDanxbotSource(localTarball: string): void {
  const parent = dirname(localTarball);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const excludes = readDockerignoreExcludes(REPO_ROOT);
  runStreaming(
    buildTarCommand({
      repoRoot: REPO_ROOT,
      localTarball,
      dockerignoreExcludes: excludes,
    }),
  );
  if (!isDryRun() && !existsSync(localTarball)) {
    throw new Error(
      `deploy: tar completed but ${localTarball} does not exist`,
    );
  }
}

/**
 * Build the Docker image on the EC2 instance and push to ECR.
 * Tags with both :latest and :<timestamp> for rollback.
 *
 * Returns the :latest tag so callers can pass it to compose templates.
 */
export function buildAndPush(
  config: DeployConfig,
  ecrRepositoryUrl: string,
  remote: RemoteHost,
): string {
  console.log("\n── Building Docker image on EC2 ──");
  const sha = getDanxbotShaForBuild();
  const tags = buildImageTags(ecrRepositoryUrl);
  const paths = resolveRemoteBuildPaths(sha);

  console.log(`  SHA: ${sha}`);
  console.log(`  Latest tag: ${tags.latestTag}`);
  console.log(`  Timestamp tag: ${tags.timestampTag}`);

  console.log("\n  Packing source via `git archive HEAD`");
  packDanxbotSource(paths.localTarball);

  console.log(`  Uploading tarball -> ${paths.remoteTarball}`);
  remote.scpUpload(paths.localTarball, paths.remoteTarball);

  const buildCmd = buildDockerBuildCommand(tags, sha);
  const prefix = buildRemoteBuildScript({ paths, buildCmd });
  const fullScript = buildRemotePushScript({ prefix, tags, paths });

  // Honor isDryRun — RemoteHost.sshRunStreaming itself flows through
  // runStreaming which prints the would-run command in dry-run mode.
  console.log("\n  Running remote build + push");
  void config;
  remote.sshRunStreaming(fullScript);

  console.log(`\n  Pushed: ${tags.latestTag}`);
  console.log(`  Pushed: ${tags.timestampTag}`);

  return tags.latestTag;
}
