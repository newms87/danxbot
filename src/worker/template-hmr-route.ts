/**
 * SG-189 — `GET /api/template-hmr/active` route.
 *
 * Returns `{url, dispatchId, port, templateId}` for the live Vite dev-server
 * keyed by the `templateId` query param, or 404 when none. The gpt-manager
 * frontend reads this via Laravel proxy to resolve the iframe URL for an
 * active template preview.
 *
 * `dispatchId` is the FIRST referring dispatch on the entry — the field is
 * advisory (frontends should never assume singular ownership). HMR servers
 * are reference-counted across dispatches sharing the same templateId.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { json } from "../http/helpers.js";
import { getActiveHmr, listActiveHmr } from "../template-hmr/index.js";

export function handleTemplateHmrActive(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const url = new URL(req.url || "/", "http://localhost");
  const templateId = url.searchParams.get("templateId");

  if (!templateId) {
    // List endpoint — useful for diagnostics + dashboard rendering of all
    // live HMR sessions. Keeps the route surface narrow (one path, two
    // shapes determined by query) at the cost of a small response-shape
    // branch. Either shape is JSON.
    json(res, 200, {
      active: listActiveHmr().map(serializeInfo),
    });
    return;
  }

  if (!/^\d+$/.test(templateId)) {
    json(res, 400, {
      error: "templateId must be a positive integer",
    });
    return;
  }

  const info = getActiveHmr(templateId);
  if (!info) {
    json(res, 404, {
      error: `no active HMR server for templateId ${templateId}`,
    });
    return;
  }

  json(res, 200, serializeInfo(info));
}

function serializeInfo(info: {
  templateId: string;
  port: number;
  url: string;
  refDispatchIds: string[];
  startedAt: Date;
}) {
  // The entry is reference-counted across dispatches; expose the full set
  // and let callers pick. No silent "first one wins" — frontends should
  // never assume singular ownership; if a caller needs "any active
  // dispatch", `refDispatchIds[0]` is right there.
  return {
    templateId: info.templateId,
    port: info.port,
    url: info.url,
    refDispatchIds: info.refDispatchIds,
    startedAt: info.startedAt.toISOString(),
  };
}
