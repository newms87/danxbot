/**
 * Docker image build and ECR push for deploy.
 * Builds the danxbot image locally and pushes it to the ECR repository
 * provisioned by Terraform.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeployConfig } from "./config.js";
import { awsCmd, isDryRun, runStreaming, tryRun } from "./exec.js";
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
 * `tryRun` itself returns null in dry-run, which would re-trigger the throw —
 * dry-run is meant to emit the would-run docker build command, not refuse to
 * proceed when run outside a git checkout (e.g. in CI of a downstream repo).
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

/**
 * Authenticate Docker to ECR. Required before push.
 */
function ecrLogin(config: DeployConfig, ecrRegistryUrl: string): void {
  const registry = ecrRegistryUrl.split("/")[0];
  console.log(`  Authenticating Docker to ECR: ${registry}`);

  // Single pipeline: get password and pipe directly to docker login.
  // Avoids shell metacharacter issues from storing the token in a variable.
  runStreaming(
    `${awsCmd(config.aws.profile, `ecr get-login-password --region ${config.region}`)} | docker login --username AWS --password-stdin ${registry}`,
  );
}

/**
 * Build the Docker image and push to ECR.
 * Tags with both :latest and :<timestamp> for rollback.
 */
export function buildAndPush(
  config: DeployConfig,
  ecrRepositoryUrl: string,
): string {
  console.log("\n── Building Docker image ──");
  const { latestTag, timestampTag } = buildImageTags(ecrRepositoryUrl);

  // Bake the danxbot repo SHA into the image so getDanxbotCommit() reports
  // it at runtime without needing a `.git` dir inside the container. Empty
  // value is a no-op (the runtime falls back to git rev-parse).
  const cmd = buildDockerBuildCommand(
    { latestTag, timestampTag },
    getDanxbotShaForBuild(),
  );

  runStreaming(cmd, { cwd: REPO_ROOT });

  console.log("\n── Pushing to ECR ──");
  ecrLogin(config, ecrRepositoryUrl);
  runStreaming(`docker push ${latestTag}`);
  runStreaming(`docker push ${timestampTag}`);

  console.log(`  Pushed: ${latestTag}`);
  console.log(`  Pushed: ${timestampTag}`);

  return latestTag;
}
