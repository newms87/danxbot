/**
 * DX-540 — daily SFC-deps stale-dir prune cron job.
 *
 * Runs every 86400s (1 day). Re-discovers the live manifest set from
 * the same env-resolved source as the provisioner, then drops any
 * `/srv/sfc-deps/<v>/` dir that is BOTH inactive AND older than 30d.
 * See `prune.ts` for the keep-active + keep-fresh invariants.
 *
 * A missing manifest source skips the tick — the active set is
 * unknowable, so deleting anything would be unsafe.
 */

import { resolveManifestSourceFromEnv } from "../../sfc-deps/manifest-source.js";
import { pruneStaleSfcDeps } from "../../sfc-deps/prune.js";
import { jsonLineLogger, resolveBaseDir } from "../../sfc-deps/log.js";
import { SFC_DEPS_DEFAULT_BASE_DIR } from "./provision-sfc-deps.js";
import type { CronJob } from "../types.js";

export const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface PruneCronDeps {
  env?: NodeJS.ProcessEnv;
  baseDir?: string;
  staleAfterMs?: number;
  log?: (line: object) => void;
}

export async function runPruneSfcDepsJob(
  deps: PruneCronDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? jsonLineLogger("prune-sfc-deps");
  const baseDir = resolveBaseDir(env, deps.baseDir, SFC_DEPS_DEFAULT_BASE_DIR);
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  const source = resolveManifestSourceFromEnv(env);
  if (!source) {
    log({
      name: "prune-sfc-deps",
      kind: "skipped-no-source",
      reason: "active manifest set unknowable; refusing to prune",
    });
    return;
  }

  const entries = await source.list();
  const active = new Set(entries.map((e) => e.shell_version));

  const result = await pruneStaleSfcDeps({
    baseDir,
    activeShellVersions: active,
    staleAfterMs,
    log: (line) => log({ name: "prune-sfc-deps", ...line }),
  });

  log({
    name: "prune-sfc-deps",
    kind: "tick-complete",
    pruned: result.pruned.length,
    kept: result.kept.length,
    failed: result.failed.length,
  });
}

export const pruneSfcDepsJob: CronJob = {
  name: "prune-sfc-deps",
  intervalSec: 86400,
  run: () => runPruneSfcDepsJob(),
};
