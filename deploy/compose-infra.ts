/**
 * Render + upload the shared-infra prod compose file to the instance.
 * Replaces gpt-manager's RemoteHost.uploadComposeFile with a dedicated
 * module so flytebot's multi-service infra (dashboard + mysql + playwright)
 * lives in one obvious place.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyTemplateVars, type RemoteHost } from "./remote.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(__dirname, "templates/docker-compose.prod.yml");

export function renderProdCompose(
  ecrImage: string,
  dashboardPort: number,
): string {
  return applyTemplateVars(readFileSync(TEMPLATE, "utf-8"), {
    "${ECR_IMAGE}": ecrImage,
    "${DASHBOARD_PORT}": String(dashboardPort),
  });
}

export function uploadAndRestartInfra(
  remote: RemoteHost,
  ecrImage: string,
  dashboardPort: number,
  region: string,
): void {
  console.log("\n── Uploading /danxbot/docker-compose.prod.yml ──");
  const rendered = renderProdCompose(ecrImage, dashboardPort);
  // Unique tmp path so concurrent deploys from the same workstation don't stomp.
  const localTmpDir = mkdtempSync(resolve(tmpdir(), "danxbot-compose-"));
  const tmp = resolve(localTmpDir, "docker-compose.prod.yml");
  writeFileSync(tmp, rendered);
  remote.scpUpload(tmp, "/tmp/docker-compose.prod.yml");
  remote.sshRun(
    "sudo mv /tmp/docker-compose.prod.yml /danxbot/docker-compose.prod.yml && sudo chown ubuntu:ubuntu /danxbot/docker-compose.prod.yml",
  );

  // Ensure the shared Claude Code JSONL dir exists with ownership that
  // matches the in-container danxbot user (uid 1000 — first non-system
  // uid from `useradd -m danxbot` in the Dockerfile). On Ubuntu hosts
  // uid 1000 is also `ubuntu`, so numeric ownership shows as ubuntu in
  // `ls -la`. cloud-init handles fresh instances; this line handles
  // existing instances and is idempotent (mkdir -p + chown).
  remote.sshRun(
    "sudo mkdir -p /danxbot/claude-projects && sudo chown 1000:1000 /danxbot/claude-projects",
  );

  const registry = ecrImage.split("/")[0];
  remote.sshRun(
    `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registry}`,
  );
  remote.sshRunStreaming(`docker pull ${ecrImage}`);
  remote.sshRunStreaming(
    "cd /danxbot && docker compose -f docker-compose.prod.yml up -d --remove-orphans --force-recreate",
  );
}
