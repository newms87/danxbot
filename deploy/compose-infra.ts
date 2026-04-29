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
import { execSync } from "node:child_process";
import { applyTemplateVars, type RemoteHost } from "./remote.js";
import { isDryRun } from "./exec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(__dirname, "templates/docker-compose.prod.yml");
const REPO_ROOT = resolve(__dirname, "..");
const PLAYWRIGHT_SOURCE_DIR = "playwright-screenshot";

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

/**
 * Ship the playwright-screenshot/ source tree to the EC2 instance so the
 * prod compose file's `build: ./playwright-screenshot` step has a Dockerfile
 * + server.ts to build from. Mirrors the local docker-compose.yml shape
 * verbatim — same Dockerfile, same source, same build context — instead of
 * pushing a custom image to ECR or trying to run the base playwright image
 * directly (which has no HTTP server inside, see Trello 4u13Qe8r).
 *
 * Implementation: tar the source dir locally, scp the tarball, extract on
 * the instance under /danxbot/playwright-screenshot/. Idempotent — wipes
 * the remote dir before extract so removed files don't linger across
 * deploys. tar pipe is used instead of `scp -r` for cross-version
 * reliability (some scp builds reject directory uploads without -r, and
 * -r itself has surprising symlink behavior).
 */
export function uploadPlaywrightSource(remote: RemoteHost): void {
  console.log("\n── Uploading /danxbot/playwright-screenshot/ source ──");
  // In dry-run, the local `mkdtempSync` + `execSync(tar -cf ...)` would
  // actually create a tmp dir and produce a real tarball on the operator's
  // host. The deploy contract is "no real local writes during dry-run" — so
  // print the would-run shape and skip both the local prep and the remote
  // SCP/SSH steps. The SSH commands ARE dry-run-aware via `runStreaming`,
  // but skipping them keeps the dry-run output shorter and doesn't reference
  // a tarball that was never created.
  if (isDryRun()) {
    console.log(
      `  [dry-run] would tar ${PLAYWRIGHT_SOURCE_DIR}/ from ${REPO_ROOT}, scp to instance, extract to /danxbot/${PLAYWRIGHT_SOURCE_DIR}`,
    );
    return;
  }
  const localTmpDir = mkdtempSync(resolve(tmpdir(), "danxbot-pw-"));
  const tarball = resolve(localTmpDir, `${PLAYWRIGHT_SOURCE_DIR}.tar`);
  execSync(`tar -cf ${tarball} -C ${REPO_ROOT} ${PLAYWRIGHT_SOURCE_DIR}`);
  remote.scpUpload(tarball, `/tmp/${PLAYWRIGHT_SOURCE_DIR}.tar`);
  remote.sshRun(
    [
      `sudo rm -rf /danxbot/${PLAYWRIGHT_SOURCE_DIR}`,
      `sudo tar -xf /tmp/${PLAYWRIGHT_SOURCE_DIR}.tar -C /danxbot`,
      `sudo chown -R ubuntu:ubuntu /danxbot/${PLAYWRIGHT_SOURCE_DIR}`,
      `sudo rm /tmp/${PLAYWRIGHT_SOURCE_DIR}.tar`,
    ].join(" && "),
  );
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
  // In dry-run, skip the local mkdtemp + writeFileSync + scp + ssh sequence
  // entirely. Like `uploadPlaywrightSource`, the local prep work is real-fs
  // mutation that the dry-run contract forbids. Render the prod compose
  // (pure, no I/O) so any operator-facing summary line still has the
  // ecrImage substitution, then print the would-run shape and skip the
  // SCP / docker pull / docker compose up steps.
  if (isDryRun()) {
    console.log(
      `  [dry-run] would render docker-compose.prod.yml (${rendered.split("\n").length} lines), scp to instance, ecr-login + docker pull ${ecrImage}, then docker compose up -d --build --force-recreate`,
    );
    return;
  }
  // Unique tmp path so concurrent deploys from the same workstation don't stomp.
  const localTmpDir = mkdtempSync(resolve(tmpdir(), "danxbot-compose-"));
  const tmp = resolve(localTmpDir, "docker-compose.prod.yml");
  writeFileSync(tmp, rendered);
  remote.scpUpload(tmp, "/tmp/docker-compose.prod.yml");
  remote.sshRun(
    "sudo mv /tmp/docker-compose.prod.yml /danxbot/docker-compose.prod.yml && sudo chown ubuntu:ubuntu /danxbot/docker-compose.prod.yml",
  );

  // Ship the playwright build context — the compose file's
  // `build: ./playwright-screenshot` requires source on the instance.
  uploadPlaywrightSource(remote);

  // Per-repo claude-projects host dirs are pre-created in launchWorkers()
  // — they're sibling concerns to the per-repo worker compose mount, so
  // creation lives next to that. This function used to mkdir a shared
  // `/danxbot/claude-projects` here; that single dir is gone (Trello cjAyJpgr).

  const registry = ecrImage.split("/")[0];
  remote.sshRun(
    `aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registry}`,
  );
  remote.sshRunStreaming(`docker pull ${ecrImage}`);
  // `--build` triggers `docker compose build` for any service with a
  // `build:` block — i.e. playwright. Builds are layer-cached, so steady-
  // state deploys with no playwright-source change are near-instant.
  remote.sshRunStreaming(
    "cd /danxbot && docker compose -f docker-compose.prod.yml up -d --build --remove-orphans --force-recreate",
  );
}
