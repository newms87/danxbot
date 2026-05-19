/**
 * DX-701 — worker endpoint for setting / clearing the issue-poller's
 * `pickupNamePrefix` filter on the drift-side settings file.
 *
 * Routing: `POST /api/test-isolation/pickup-prefix` → this handler.
 *
 * Body: `{prefix: string | null}`. A non-empty string engages the
 * filter; `null` (or an empty string) clears it. The handler routes
 * the change through `writeSettings({testIsolation, writtenBy: "setup"})`
 * so the canonical drift-file path is resolved by the same code the
 * poller reads from — works under both host and docker runtimes
 * regardless of `DANX_RUNTIME_ROOT` resolution rules.
 *
 * Sole caller: the Layer 3 system-test harness
 * (`src/__tests__/system/run-system-tests.sh`). Workers are only
 * reachable on `danxbot-net`, so dashboard-proxy or local-only
 * callers already passed the auth gate — the worker does not
 * re-authenticate.
 *
 * Pre-DX-701 the harness wrote `overrides.issuePoller.pickupNamePrefix`
 * directly to `<repo>/.danxbot/settings.json` (the contract file),
 * which left a meta-only diff on the consumed repo on every Layer 3
 * run — exactly the runtime-state-into-consumed-repo pattern DX-668
 * (Worker Cleanup) was designed to prevent. The field now lives on
 * `<runtime-volume>/<repo>/settings-runtime.json` (the drift file)
 * and the harness routes through this endpoint.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json, parseBody } from "../http/helpers.js";
import { createLogger } from "../logger.js";
import { writeSettings } from "../settings-file.js";
import type { RepoContext } from "../types.js";

const log = createLogger("test-isolation-route");

export interface SetPickupPrefixResponse {
  pickupNamePrefix: string | null;
}

export async function handleSetPickupPrefix(
  req: IncomingMessage,
  res: ServerResponse,
  repo: RepoContext,
): Promise<void> {
  try {
    let body: Record<string, unknown>;
    try {
      body = await parseBody(req);
    } catch (err) {
      json(res, 400, {
        error:
          err instanceof Error ? err.message : "Invalid JSON body",
      });
      return;
    }
    const raw = body.prefix;
    // Fail-loud on shape: only string-or-null is accepted. A request
    // carrying a number / object / array means the caller is broken;
    // silently coercing to null would hide the bug.
    if (raw !== null && raw !== undefined && typeof raw !== "string") {
      json(res, 400, { error: "prefix must be string or null" });
      return;
    }
    const prefix =
      typeof raw === "string" && raw.length > 0 ? raw : null;

    await writeSettings(repo.localPath, {
      testIsolation: { pickupNamePrefix: prefix },
      writtenBy: "setup",
    });

    log.info(
      `[${repo.name}] Set testIsolation.pickupNamePrefix=${
        prefix === null ? "null" : JSON.stringify(prefix)
      }`,
    );
    const resp: SetPickupPrefixResponse = { pickupNamePrefix: prefix };
    json(res, 200, resp);
  } catch (err) {
    log.error(`[${repo.name}] Failed to set pickupNamePrefix`, err);
    json(res, 500, {
      error:
        err instanceof Error
          ? err.message
          : "Failed to set pickupNamePrefix",
    });
  }
}
