/**
 * Docker image build and ECR push for deploy.
 * Builds the danxbot image locally and pushes it to the ECR repository
 * provisioned by Terraform.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeployConfig } from "./config.js";
import { awsCmd, runStreaming } from "./exec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

export interface ImageTags {
  latestTag: string;
  timestampTag: string;
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

  runStreaming(`docker build -t ${latestTag} -t ${timestampTag} .`, {
    cwd: REPO_ROOT,
  });

  console.log("\n── Pushing to ECR ──");
  ecrLogin(config, ecrRepositoryUrl);
  runStreaming(`docker push ${latestTag}`);
  runStreaming(`docker push ${timestampTag}`);

  console.log(`  Pushed: ${latestTag}`);
  console.log(`  Pushed: ${timestampTag}`);

  return latestTag;
}
