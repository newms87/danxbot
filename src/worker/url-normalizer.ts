/**
 * Rewrite loopback URLs so they are reachable from inside a worker container.
 *
 * GPT Manager (and any other dispatcher) sends callback URLs like
 * `http://localhost:80/...` that are valid from the host's perspective.
 * In host runtime the worker IS on the host, so those URLs work as-is.
 * In docker runtime `localhost` resolves to the worker container itself,
 * so the callback fails with `fetch failed`.
 *
 * This normalizer lets the dispatcher stay runtime-agnostic: the worker —
 * the component that actually knows its own runtime — translates the URL
 * when needed. Pair this with `extra_hosts: host.docker.internal:host-gateway`
 * in the per-repo worker compose so the rewritten host resolves on Linux.
 *
 * The helper is also applied to every overlay value
 * (`SCHEMA_API_URL`, etc.) so the same fix that protects `status_url`
 * also covers caller-app URLs the dispatched agent will fetch via MCP
 * tools. Overlay values are unconstrained strings — tokens, numeric
 * IDs, raw secrets — so this function MUST be a no-op for any input
 * that is not a parseable absolute URL. Throwing on non-URLs would
 * break uniform application; loopback rewriting is the only behavior
 * change this helper exists to provide.
 */
const DOCKER_HOST_ALIAS = "host.docker.internal";
// WHATWG URL preserves IPv6 loopback as `[::1]` in `hostname`.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function normalizeCallbackUrl(
  url: string | undefined,
  isHost: boolean,
): string | undefined {
  if (url === undefined) return undefined;
  if (isHost) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Non-URL string (overlay token / numeric ID / arbitrary value).
    // Safe pass-through — there is nothing to rewrite.
    return url;
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return url;

  parsed.hostname = DOCKER_HOST_ALIAS;
  // WHATWG URL.toString() adds a trailing slash for origin-only URLs
  // (e.g., "http://host.docker.internal/"). Consumers concatenate paths
  // with `/api/...`, so a trailing slash produces double-slash 404s.
  return parsed.toString().replace(/\/$/, "");
}
