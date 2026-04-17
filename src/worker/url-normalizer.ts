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

  const parsed = new URL(url);
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return url;

  parsed.hostname = DOCKER_HOST_ALIAS;
  return parsed.toString();
}
