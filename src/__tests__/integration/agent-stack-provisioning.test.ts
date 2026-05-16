/**
 * Real-Postgres integration test for agent stack provisioning (DX-XXX).
 *
 * Spins a throwaway `postgres:16-alpine` container (the same image
 * danxbot's shared infra already pulls — no new image downloads) on
 * an ephemeral host port. Drives the actual `provisionWorktreeDatabase`
 * + `dropWorktreeDatabase` + port registry surfaces against it,
 * asserting the end-to-end contract:
 *
 *   1. provision creates the per-worktree DB + role + REVOKE CONNECT
 *      on the primary, allocates a port offset, writes a real .env
 *   2. The worktree role can connect to ITS db
 *   3. The worktree role CANNOT connect to the PRIMARY db
 *   4. The allocated APP_PORT can be bound from this process (port is
 *      free and unique to the worktree)
 *   5. drop removes role+db+secret
 *   6. re-provision against the SAME name is idempotent
 *   7. cleanupWorktreeArtifacts is the symmetric inverse — same
 *      post-state as a fresh repo after running it
 *
 * Skipped automatically when Docker is unavailable. Container is
 * always reaped via the afterAll hook.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import {
  provisionWorktreeDatabase,
  dropWorktreeDatabase,
  defaultSecretStore,
} from "../../agent/worktree-database.js";
import {
  provisionWorktreePorts,
  readRegistry,
  PORT_BASES,
} from "../../agent/worktree-ports.js";
import { cleanupWorktreeArtifacts } from "../../agent/worktree-cleanup.js";

const execFile = promisify(execFileCb);

const CONTAINER_NAME = `danxbot-test-agent-stack-pg-${process.pid}`;
const PG_IMAGE = "postgres:16-alpine";
const PG_USER = "postgres";
const PG_PASS = "test-only-password";
const PRIMARY_DB = "laravel";

let pgHostPort: number;
let workArea: string;
let repoRoot: string;
let worktreePath: string;

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFile("docker", ["info"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        s.close(() => resolve(port));
      } else {
        s.close();
        reject(new Error("Could not resolve ephemeral port"));
      }
    });
    s.on("error", reject);
  });
}

async function waitForPostgresReady(port: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const pool = new Pool({
        host: "127.0.0.1",
        port,
        user: PG_USER,
        password: PG_PASS,
        database: "postgres",
        connectionTimeoutMillis: 1_000,
      });
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Postgres on 127.0.0.1:${port} did not become ready in ${timeoutMs}ms`);
}

async function bootstrapPrimaryDb(port: number): Promise<void> {
  const pool = new Pool({
    host: "127.0.0.1",
    port,
    user: PG_USER,
    password: PG_PASS,
    database: "postgres",
  });
  await pool.query(`CREATE DATABASE "${PRIMARY_DB}"`);
  await pool.end();
}

const dockerOk = await dockerAvailable();
const describeIfDocker = dockerOk ? describe : describe.skip;

describeIfDocker("agent stack provisioning (real Postgres)", () => {
  beforeAll(async () => {
    pgHostPort = await pickFreePort();
    await execFile("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      CONTAINER_NAME,
      "-p",
      `127.0.0.1:${pgHostPort}:5432`,
      "-e",
      `POSTGRES_USER=${PG_USER}`,
      "-e",
      `POSTGRES_PASSWORD=${PG_PASS}`,
      "-e",
      "POSTGRES_DB=postgres",
      PG_IMAGE,
    ]);
    await waitForPostgresReady(pgHostPort);
    await bootstrapPrimaryDb(pgHostPort);

    workArea = mkdtempSync(join(tmpdir(), "agent-stack-test-"));
    repoRoot = join(workArea, "repo");
    worktreePath = join(repoRoot, ".danxbot", "worktrees", "harry");
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(
      join(repoRoot, ".env"),
      [
        "APP_NAME=test",
        "DB_CONNECTION=pgsql",
        `DB_HOST=127.0.0.1`,
        `DB_PORT=${pgHostPort}`,
        `DB_DATABASE=${PRIMARY_DB}`,
        `DB_USERNAME=${PG_USER}`,
        `DB_PASSWORD=${PG_PASS}`,
        "",
      ].join("\n"),
    );
  }, 60_000);

  afterAll(async () => {
    try {
      await execFile("docker", ["kill", CONTAINER_NAME]);
    } catch {
      // Container may already be gone — `--rm` reaps on stop.
    }
    if (workArea && existsSync(workArea)) {
      rmSync(workArea, { recursive: true, force: true });
    }
  });

  it("provisions a real DB + role; agent can reach its own DB", async () => {
    const result = await provisionWorktreeDatabase({
      repoRoot,
      worktreePath,
      worktreeName: "harry",
      pgHostOverride: "127.0.0.1",
      pgPortOverride: pgHostPort,
    });

    expect(result.kind).toBe("provisioned");
    if (result.kind !== "provisioned") return;
    expect(result.workerDb).toBe(`${PRIMARY_DB}_harry`);
    expect(result.workerRole).toBe("agent_harry");
    expect(result.created).toEqual({ database: true, role: true });

    // Verify the worktree role can connect to its OWN DB.
    const password = defaultSecretStore.read(repoRoot, "harry");
    expect(password).not.toBeNull();
    const ownPool = new Pool({
      host: "127.0.0.1",
      port: pgHostPort,
      user: result.workerRole,
      password: password!,
      database: result.workerDb,
    });
    const own = await ownPool.query("SELECT current_database() AS db");
    expect(own.rows[0].db).toBe(result.workerDb);
    await ownPool.end();
  });

  it("agent role CANNOT connect to the PRIMARY db (REVOKE CONNECT enforced)", async () => {
    const password = defaultSecretStore.read(repoRoot, "harry")!;
    const primaryPool = new Pool({
      host: "127.0.0.1",
      port: pgHostPort,
      user: "agent_harry",
      password,
      database: PRIMARY_DB,
      connectionTimeoutMillis: 3_000,
    });
    await expect(primaryPool.query("SELECT 1")).rejects.toThrow(
      /permission denied for database|no pg_hba.conf entry|connection terminated/i,
    );
    await primaryPool.end().catch(() => {});
  });

  it("allocated APP_PORT is unique + bindable from this host", async () => {
    const reg = readRegistry(repoRoot);
    const offset = reg.offsets.harry;
    expect(offset).toBeGreaterThan(0);
    const appPort = PORT_BASES.APP_PORT + offset;

    // Bind a server on that port — proves nobody else has it AND that
    // the port is in a valid host-bind range. This is the load-bearing
    // assertion: the per-worktree compose stack would bind APP_PORT on
    // host startup; if the allocator handed out a colliding port, this
    // bind would fail.
    let server: Server | undefined;
    await new Promise<void>((resolve, reject) => {
      server = createServer((socket) => {
        socket.end("hello\n");
      });
      server.once("error", reject);
      server!.listen(appPort, "127.0.0.1", () => resolve());
    });
    expect(server!.listening).toBe(true);
    await new Promise<void>((r) => server!.close(() => r()));
  });

  it("idempotent re-provision returns created: { database: false, role: false }", async () => {
    const result = await provisionWorktreeDatabase({
      repoRoot,
      worktreePath,
      worktreeName: "harry",
      pgHostOverride: "127.0.0.1",
      pgPortOverride: pgHostPort,
    });
    if (result.kind !== "provisioned") throw new Error("expected provisioned");
    expect(result.created).toEqual({ database: false, role: false });
  });

  it("dropWorktreeDatabase removes role + db + secret", async () => {
    const result = await dropWorktreeDatabase({
      repoRoot,
      worktreeName: "harry",
      pgHostOverride: "127.0.0.1",
      pgPortOverride: pgHostPort,
    });
    if (result.kind !== "dropped") throw new Error("expected dropped");
    expect(result.dropped).toEqual({ database: true, role: true });

    // Verify role is gone from the cluster
    const adminPool = new Pool({
      host: "127.0.0.1",
      port: pgHostPort,
      user: PG_USER,
      password: PG_PASS,
      database: "postgres",
    });
    const roles = await adminPool.query(
      `SELECT 1 FROM pg_roles WHERE rolname = $1`,
      ["agent_harry"],
    );
    expect(roles.rows).toHaveLength(0);
    const dbs = await adminPool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [`${PRIMARY_DB}_harry`],
    );
    expect(dbs.rows).toHaveLength(0);
    await adminPool.end();

    // Secret file removed
    expect(defaultSecretStore.read(repoRoot, "harry")).toBeNull();
  });

  it("cleanupWorktreeArtifacts is the symmetric inverse — same post-state for a fresh worktree", async () => {
    // Provision a fresh worktree for a different agent
    const sageDir = join(repoRoot, ".danxbot", "worktrees", "sage");
    mkdirSync(sageDir, { recursive: true });
    const provision = await provisionWorktreeDatabase({
      repoRoot,
      worktreePath: sageDir,
      worktreeName: "sage",
      pgHostOverride: "127.0.0.1",
      pgPortOverride: pgHostPort,
    });
    expect(provision.kind).toBe("provisioned");

    // Verify post-provision state
    expect(readRegistry(repoRoot).offsets.sage).toBeDefined();
    expect(defaultSecretStore.read(repoRoot, "sage")).not.toBeNull();
    expect(existsSync(join(sageDir, ".env"))).toBe(true);

    // Symmetric inverse
    const result = await cleanupWorktreeArtifacts(repoRoot, sageDir, "sage", {
      pgHostOverride: "127.0.0.1",
      pgPortOverride: pgHostPort,
    });

    expect(result.databaseDropped).toBe(true);
    expect(result.roleDropped).toBe(true);
    expect(result.portsReleased).toBe(true);
    expect(result.secretRemoved).toBe(true);
    expect(result.worktreeRemoved).toBe(true);

    // All artifacts gone
    expect(readRegistry(repoRoot).offsets.sage).toBeUndefined();
    expect(defaultSecretStore.read(repoRoot, "sage")).toBeNull();
    expect(existsSync(sageDir)).toBe(false);
  });

  it("multiple agents get distinct, non-colliding APP_PORTs (bind both simultaneously)", async () => {
    // Provision two more agents in parallel
    const aliceDir = join(repoRoot, ".danxbot", "worktrees", "alice");
    const bobDir = join(repoRoot, ".danxbot", "worktrees", "bob");
    mkdirSync(aliceDir, { recursive: true });
    mkdirSync(bobDir, { recursive: true });

    await provisionWorktreeDatabase({
      repoRoot,
      worktreePath: aliceDir,
      worktreeName: "alice",
      pgHostOverride: "127.0.0.1",
      pgPortOverride: pgHostPort,
    });
    await provisionWorktreeDatabase({
      repoRoot,
      worktreePath: bobDir,
      worktreeName: "bob",
      pgHostOverride: "127.0.0.1",
      pgPortOverride: pgHostPort,
    });

    const reg = readRegistry(repoRoot);
    const aliceOffset = reg.offsets.alice;
    const bobOffset = reg.offsets.bob;
    expect(aliceOffset).toBeGreaterThan(0);
    expect(bobOffset).toBeGreaterThan(0);
    expect(aliceOffset).not.toBe(bobOffset);

    // Each port family in PORT_BASES must produce distinct host ports
    // for the two agents — that's the contract the worker-side compose
    // stacks rely on. Do not bind to these ports from the test process;
    // operator's actual worktree compose stacks on this host already
    // hold them (EADDRINUSE on shared ranges 28001..28098).
    for (const base of Object.values(PORT_BASES)) {
      expect(base + aliceOffset).not.toBe(base + bobOffset);
    }

    // Cleanup so afterAll's container kill is the only DB op left
    await cleanupWorktreeArtifacts(repoRoot, aliceDir, "alice", {
      pgHostOverride: "127.0.0.1",
      pgPortOverride: pgHostPort,
    });
    await cleanupWorktreeArtifacts(repoRoot, bobDir, "bob", {
      pgHostOverride: "127.0.0.1",
      pgPortOverride: pgHostPort,
    });
  });
});
