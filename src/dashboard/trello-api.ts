/**
 * DX-610 Phase 8b.2 — Minimal Trello API caller for the dashboard
 * process. Used by the list-mapping routes to fetch the configured
 * board's current Trello lists so the operator can pair each danxbot
 * list with a Trello list in the Settings UI (Phase 8b.3).
 *
 * Creds are dashboard-side ONLY (`DASHBOARD_TRELLO_API_KEY` /
 * `DASHBOARD_TRELLO_API_TOKEN`). The per-repo `DANX_TRELLO_API_*`
 * pair in `<repo>/.danxbot/.env` is intentionally separate — it lives
 * inside the worker container, not the dashboard process. See
 * `.claude/rules/docker-runtime.md` "Per-target env overlays".
 *
 * Surface is intentionally tiny: one `fetchBoardLists` call. The
 * route layer caches results for 30s per repo to avoid hammering
 * Trello. Errors surface as `TrelloApiError` carrying the upstream
 * status so the route can return a structured 502.
 */

const TRELLO_BASE = "https://api.trello.com/1";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface TrelloCreds {
  apiKey: string;
  apiToken: string;
}

export interface TrelloListSummary {
  id: string;
  name: string;
}

export class TrelloApiError extends Error {
  public readonly trelloStatus: number | null;
  constructor(message: string, trelloStatus: number | null) {
    super(message);
    this.name = "TrelloApiError";
    this.trelloStatus = trelloStatus;
  }
}

/**
 * Read Trello creds from the dashboard's process env. Returns `null`
 * when EITHER key is missing — routes 503 in that branch with a
 * structured "Trello creds not configured" body so the SPA can show
 * the operator how to wire them.
 */
export function getTrelloCreds(env: NodeJS.ProcessEnv = process.env): TrelloCreds | null {
  const apiKey = env.DASHBOARD_TRELLO_API_KEY;
  const apiToken = env.DASHBOARD_TRELLO_API_TOKEN;
  if (typeof apiKey !== "string" || apiKey.length === 0) return null;
  if (typeof apiToken !== "string" || apiToken.length === 0) return null;
  return { apiKey, apiToken };
}

export interface FetchBoardListsOptions {
  /** Override the global timeout. Used by tests + the Settings UI refresh button. */
  timeoutMs?: number;
  /** Test seam — inject a fetch implementation. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch the open lists on a Trello board. Returns `[{id, name}]`.
 *
 * Throws `TrelloApiError` on non-2xx HTTP, timeout (after `timeoutMs`),
 * or network failure. `trelloStatus` carries the upstream HTTP status
 * when available (network errors / timeouts surface as `null`).
 */
export async function fetchBoardLists(
  boardId: string,
  creds: TrelloCreds,
  opts: FetchBoardListsOptions = {},
): Promise<TrelloListSummary[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const params = new URLSearchParams({
    key: creds.apiKey,
    token: creds.apiToken,
    fields: "id,name",
    filter: "open",
  });
  const url = `${TRELLO_BASE}/boards/${encodeURIComponent(boardId)}/lists?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", signal: controller.signal });
  } catch (err) {
    const aborted = (err as { name?: string } | undefined)?.name === "AbortError";
    throw new TrelloApiError(
      aborted
        ? `Trello fetch timed out after ${timeoutMs}ms`
        : `Trello fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      null,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let bodySnippet = "";
    try {
      bodySnippet = (await response.text()).slice(0, 200);
    } catch {
      /* best-effort */
    }
    throw new TrelloApiError(
      `Trello returned ${response.status}${bodySnippet ? `: ${bodySnippet}` : ""}`,
      response.status,
    );
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (err) {
    throw new TrelloApiError(
      `Trello response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      response.status,
    );
  }
  if (!Array.isArray(raw)) {
    throw new TrelloApiError("Trello /boards/:id/lists response was not an array", response.status);
  }
  const out: TrelloListSummary[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    const name = (entry as { name?: unknown }).name;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof name !== "string") continue;
    out.push({ id, name });
  }
  return out;
}
