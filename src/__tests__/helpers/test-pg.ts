import { existsSync } from "node:fs";
import { Pool, type PoolConfig } from "pg";

/**
 * DX-256: real-pg test suites that consume `DANXBOT_DB_*` env directly
 * inherit the production hostname `postgres` (the Docker-network DNS
 * name for `danxbot-postgres-1`), which does not resolve from the host
 * shell. `new Pool({ host: "postgres" })` then hangs on connect until
 * vitest's 10s hookTimeout fires. Substituting `127.0.0.1` (the
 * docker-compose published port) is the host-portable equivalent —
 * mirrors `src/db/test-db.ts#adminPoolOptions`'s decision.
 *
 * Container-safe: gated on `/.dockerenv` exactly like
 * `src/config.ts#isHost`. Inside a worker container the Docker DNS
 * resolves `postgres` natively AND `127.0.0.1` points at the
 * container's own loopback (no pg there), so the substitution would
 * actively break the in-container scenario. The `isHost` parameter
 * is exposed for unit tests; default value is the real runtime probe.
 */
export function resolveTestPgHost(
  host: string,
  isHost: boolean = !existsSync("/.dockerenv"),
): string {
  return isHost && host === "postgres" ? "127.0.0.1" : host;
}

/**
 * Fast async connectivity probe for the dev postgres pool. Returns
 * `true` when a TCP connect + auth handshake succeeds within ~2s;
 * `false` on any failure (host unreachable, connection refused, auth
 * rejected, schema missing). Real-pg suites use this in `beforeAll`
 * to gate per-test `beforeEach` setup so a stopped postgres container
 * results in clean skips instead of one 10s `Hook timed out` failure
 * per test plus the `Called end on pool more than once` cascade noise
 * that follows.
 */
export async function probePgReachable(config: PoolConfig): Promise<boolean> {
  const probe = new Pool({
    ...config,
    max: 1,
    idleTimeoutMillis: 500,
    connectionTimeoutMillis: 2_000,
  });
  try {
    const client = await probe.connect();
    client.release();
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}
