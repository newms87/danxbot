// DX-256: unit tests for the host-portability + reachability helper.

import { describe, it, expect } from "vitest";
import { resolveTestPgHost, probePgReachable } from "./test-pg.js";

describe("resolveTestPgHost (DX-256)", () => {
  it("substitutes 127.0.0.1 for the Docker-network hostname on host", () => {
    expect(resolveTestPgHost("postgres", /* isHost */ true)).toBe("127.0.0.1");
  });

  it("passes other hostnames through unchanged on host", () => {
    expect(resolveTestPgHost("127.0.0.1", true)).toBe("127.0.0.1");
    expect(resolveTestPgHost("localhost", true)).toBe("localhost");
    expect(resolveTestPgHost("pg.example.com", true)).toBe("pg.example.com");
  });

  it("is a no-op inside a container — even for the Docker name", () => {
    // Inside a worker container the Docker DNS resolves `postgres`
    // natively AND `127.0.0.1` is the container's loopback (no pg
    // listening there). Substituting would actively break the
    // in-container run.
    expect(resolveTestPgHost("postgres", /* isHost */ false)).toBe("postgres");
    expect(resolveTestPgHost("danxbot-postgres-1", false)).toBe(
      "danxbot-postgres-1",
    );
  });
});

describe("probePgReachable (DX-256)", () => {
  it("returns false and resolves under hookTimeout on a refused connect", async () => {
    // Loopback port 1 is reserved + nothing listens — guaranteed
    // refusal. The 5s ceiling regressions against the original
    // 10s-hookTimeout symptom (our 2s connectionTimeoutMillis must
    // stay well under it).
    const start = Date.now();
    const reachable = await probePgReachable({
      host: "127.0.0.1",
      port: 1,
      user: "no-one",
      password: "nothing",
      database: "nope",
    });
    expect(reachable).toBe(false);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  // Probe success path — gated on the same env block the consumer
  // suites use (host + user + password + database all required so
  // pg's default-database-from-username does not steer the probe at
  // a non-existent DB on a misconfigured runner). Skips cleanly when
  // the dev pg pool isn't up; never hangs.
  function readEnvForProbe():
    | {
        host: string;
        port?: number;
        user: string;
        password: string;
        database: string;
      }
    | undefined {
    const host = process.env.DANXBOT_DB_HOST;
    const user = process.env.DANXBOT_DB_USER;
    const password = process.env.DANXBOT_DB_PASSWORD;
    const database = process.env.DANXBOT_DB_NAME;
    if (!host || !user || !password || !database) return undefined;
    const portRaw = process.env.DANXBOT_DB_PORT;
    const port = portRaw ? parseInt(portRaw, 10) : undefined;
    return {
      host: resolveTestPgHost(host),
      ...(port && Number.isFinite(port) ? { port } : {}),
      user,
      password,
      database,
    };
  }
  const env = readEnvForProbe();
  const itIfDb = env ? it : it.skip;
  itIfDb("returns true against the dev pg pool when reachable", async () => {
    if (!env) return;
    expect(await probePgReachable(env)).toBe(true);
  });
});
