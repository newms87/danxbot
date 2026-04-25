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
  repoNames: string[],
): string {
  // One claude-projects mount per connected repo, matching the dev override
  // layout in `src/cli/dev-compose-override.ts`. Each repo's worker writes
  // to its OWN host dir (via the worker compose's static `../../claude-projects`
  // mount); the dashboard reads each via a namespaced RO mount so
  // `jsonl-path-resolver.ts::expectedJsonlPath` finds the file under the
  // correct repo namespace. Trello cjAyJpgr replaced a single shared
  // `/danxbot/claude-projects` source under multiple namespaces with this
  // per-repo layout — non-danxbot dispatches were rendering empty timelines
  // because workers and resolver disagreed on the source dir.
  const claudeProjectsMounts = repoNames
    .map(
      (name) =>
        `      - /danxbot/repos/${name}/claude-projects:/danxbot/app/claude-projects/${name}:ro`,
    )
    .join("\n");
  return applyTemplateVars(readFileSync(TEMPLATE, "utf-8"), {
    "${ECR_IMAGE}": ecrImage,
    "${DASHBOARD_PORT}": String(dashboardPort),
    "${CLAUDE_PROJECTS_MOUNTS}": claudeProjectsMounts,
  });
}

/**
 * Command run on the deploy host before the docker pulls of every deploy.
 *
 * `image prune -a` — removes images NOT referenced by any container; `-f` —
 * skip the confirmation prompt. The 5 long-running containers on the prod
 * box (dashboard, mysql, playwright, two workers) all hold their current
 * images, so this only touches stale layers from prior deploys.
 *
 * Why this is safe and `system prune` is NOT:
 *   - `system prune` would also remove unused NETWORKS — including
 *     `danxbot-net`, the bridge that the dashboard, mysql, and both workers
 *     share. Removing it mid-deploy disconnects every container from every
 *     other one. Tests in compose-infra.test.ts lock against this regression.
 *   - `--volumes` would remove unused volumes — the MySQL data volume
 *     becomes "unused" the instant `docker compose down` kills the mysql
 *     container, and the next deploy would silently truncate the database.
 *
 * Exported so tests can assert the exact command shape, and so the wiring
 * call site stays a one-liner.
 */
export const PRUNE_COMMAND = "docker image prune -af";

/**
 * Reclaim disk on the deploy host before docker pulls run. Without this,
 * each deploy lands new image layers but never frees the previous deploy's
 * unreferenced layers, the EBS root volume fills up over weeks of normal
 * use, and the next deploy fails mid-pull with "no space left on device"
 * (observed under load on April 25 — root volume hit 98% with 22GB of
 * reclaimable image churn). Running this once per deploy keeps disk
 * pressure proportional to image size, not deploy count.
 */
export function pruneStaleDockerImages(remote: RemoteHost): void {
  console.log("\n── Pruning stale Docker images on instance ──");
  remote.sshRunStreaming(PRUNE_COMMAND);
}

export function uploadAndRestartInfra(
  remote: RemoteHost,
  ecrImage: string,
  dashboardPort: number,
  region: string,
  repoNames: string[],
): void {
  console.log("\n── Uploading /danxbot/docker-compose.prod.yml ──");
  const rendered = renderProdCompose(ecrImage, dashboardPort, repoNames);
  // Unique tmp path so concurrent deploys from the same workstation don't stomp.
  const localTmpDir = mkdtempSync(resolve(tmpdir(), "danxbot-compose-"));
  const tmp = resolve(localTmpDir, "docker-compose.prod.yml");
  writeFileSync(tmp, rendered);
  remote.scpUpload(tmp, "/tmp/docker-compose.prod.yml");
  remote.sshRun(
    "sudo mv /tmp/docker-compose.prod.yml /danxbot/docker-compose.prod.yml && sudo chown ubuntu:ubuntu /danxbot/docker-compose.prod.yml",
  );

  // Per-repo claude-projects host dirs are pre-created in launchWorkers()
  // — they're sibling concerns to the per-repo worker compose mount, so
  // creation lives next to that. This function used to mkdir a shared
  // `/danxbot/claude-projects` here; that single dir is gone (Trello cjAyJpgr).

  const registry = ecrImage.split("/")[0];
  remote.sshRun(
    `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registry}`,
  );
  remote.sshRunStreaming(`docker pull ${ecrImage}`);
  remote.sshRunStreaming(
    "cd /danxbot && docker compose -f docker-compose.prod.yml up -d --remove-orphans --force-recreate",
  );
}
