/**
 * DX-540 — hourly SFC-deps provisioning cron job.
 *
 * Runs every 1h via the in-worker cron loop (`src/cron/worker-loop.ts`, DX-551).
 * Resolves the manifest source from env (`SFC_DEPS_LOCAL_MANIFEST_DIR`
 * for dev, `SFC_DEPS_S3_BUCKET` for prod), iterates manifests, and
 * materializes `/srv/sfc-deps/<shell_version>/node_modules/` per
 * `provisionSfcDeps`. Pairs with `prune-sfc-deps.ts` which runs daily.
 *
 * Idempotent: re-running against an unchanged manifest set is a no-op
 * (skip path in the provisioner). A missing manifest source (neither
 * env var set) skips the tick with a log line — not an error — so a
 * fresh danxbot install does not page on a missing bucket.
 */

import { resolveManifestSourceFromEnv } from "../../sfc-deps/manifest-source.js";
import { provisionSfcDeps } from "../../sfc-deps/provisioner.js";
import { jsonLineLogger, resolveBaseDir } from "../../sfc-deps/log.js";
import type { CronJob } from "../types.js";

export const SFC_DEPS_DEFAULT_BASE_DIR = "/srv/sfc-deps";

export interface ProvisionCronDeps {
  env?: NodeJS.ProcessEnv;
  baseDir?: string;
  log?: (line: object) => void;
  /** Override the install primitive (tests inject a fake; defaults to `npm install`). */
  runInstall?: (dir: string) => Promise<void>;
}

export async function runProvisionSfcDepsJob(
  deps: ProvisionCronDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? jsonLineLogger("provision-sfc-deps");
  const baseDir = resolveBaseDir(env, deps.baseDir, SFC_DEPS_DEFAULT_BASE_DIR);

  const source = resolveManifestSourceFromEnv(env);
  if (!source) {
    log({
      name: "provision-sfc-deps",
      kind: "skipped-no-source",
      reason:
        "Neither SFC_DEPS_LOCAL_MANIFEST_DIR nor SFC_DEPS_S3_BUCKET is set",
    });
    return;
  }

  const result = await provisionSfcDeps({
    source,
    baseDir,
    runInstall: deps.runInstall,
    log: (line) => log({ name: "provision-sfc-deps", ...line }),
  });

  log({
    name: "provision-sfc-deps",
    kind: "tick-complete",
    source_kind: source.kind,
    provisioned: result.provisioned.length,
    skipped: result.skipped.length,
    failed: result.failed.length,
  });
}

export const provisionSfcDepsJob: CronJob = {
  name: "provision-sfc-deps",
  intervalSec: 3600,
  run: () => runProvisionSfcDepsJob(),
};
