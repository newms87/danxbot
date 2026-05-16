/**
 * Full-stack round-trip integration test (alpine httpd + postgres:16-alpine).
 *
 * Drives the END-TO-END agent worktree lifecycle against a fixture
 * "consumer repo":
 *
 *   1. Spin a real `postgres:16-alpine` on an ephemeral host port
 *      (the "operator's primary Postgres" the agent shares).
 *   2. Build a fixture repo at a tmpdir with:
 *        - .env (Laravel-pgsql shape pointing at the test pg)
 *        - docker-compose.yml with one alpine httpd service that binds
 *          on ${APP_PORT}, serves "hello" on /
 *        - git init + initial commit so worktree add can succeed
 *   3. Call worktreeManager.bootstrap(ctx, "harry"):
 *        → git worktree at <repo>/.danxbot/worktrees/harry
 *        → DB role agent_harry + db <primary>_harry on the test pg
 *        → port-registry offset allocated
 *        → docker compose -p danxbot-<repo>-harry up → httpd container
 *          listening on the worktree's APP_PORT
 *   4. curl 127.0.0.1:APP_PORT → "hello"
 *   5. Call worktreeManager.teardown(ctx, "harry"):
 *        → compose down --volumes → httpd container gone
 *        → DB role+db dropped on the test pg
 *        → port offset freed
 *        → git worktree removed
 *        → worktree dir gone
 *   6. curl 127.0.0.1:APP_PORT → connection refused (proves stack down)
 *
 * Image reuse: postgres:16-alpine + alpine:latest only (both already
 * cached on host per danxbot infra + the existing compose smoke test).
 * No new image downloads.
 *
 * Auto-skips when Docker is unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { request } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { createWorktreeManager } from "../../agent/worktree-manager.js";
import { composeProjectName } from "../../agent/worktree-compose.js";
import { readRegistry, PORT_BASES } from "../../agent/worktree-ports.js";
import { defaultSecretStore } from "../../agent/worktree-database.js";

const execFile = promisify(execFileCb);

const CONTAINER_PG = `danxbot-test-roundtrip-pg-${process.pid}`;
const PG_USER = "postgres";
const PG_PASS = "test-only";
const PRIMARY_DB = "app";
const AGENT_NAME = "harry";
const REPO_NAME = `roundtrip-${process.pid}`;

let pgHostPort: number;
let workArea: string;
let repoRoot: string;

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
        reject(new Error("port pick failed"));
      }
    });
    s.on("error", reject);
  });
}

async function waitForPg(port: number, timeoutMs = 30_000): Promise<void> {
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
  throw new Error(`Postgres not ready in ${timeoutMs}ms`);
}

async function httpGet(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host, port, method: "GET", path: "/", timeout: 5_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("http timeout"));
    });
    req.end();
  });
}

async function gitExec(cwd: string, ...args: string[]): Promise<void> {
  await execFile("git", args, { cwd });
}

// Minimal hello-world TCP service inside alpine — busybox nc is
// installed by default; busybox httpd is NOT, so we serve via a tiny
// HTTP loop in shell. Single GET per nc invocation, looped forever.
const COMPOSE = `services:
  webserver:
    image: alpine:latest
    container_name: \${COMPOSE_PROJECT_NAME}_web
    ports:
      - "\${APP_PORT:-8080}:80"
    command:
      - sh
      - -c
      - "while true; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 5\\r\\nConnection: close\\r\\n\\r\\nhello' | nc -l -p 80; done"
`;

const dockerOk = await dockerAvailable();
const describeIfDocker = dockerOk ? describe : describe.skip;

describeIfDocker("agent full-stack round-trip", () => {
  beforeAll(async () => {
    pgHostPort = await pickFreePort();
    await execFile("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      CONTAINER_PG,
      "-p",
      `127.0.0.1:${pgHostPort}:5432`,
      "-e",
      `POSTGRES_USER=${PG_USER}`,
      "-e",
      `POSTGRES_PASSWORD=${PG_PASS}`,
      "-e",
      "POSTGRES_DB=postgres",
      "postgres:16-alpine",
    ]);
    await waitForPg(pgHostPort);

    // Bootstrap primary DB on the test pg.
    const pool = new Pool({
      host: "127.0.0.1",
      port: pgHostPort,
      user: PG_USER,
      password: PG_PASS,
      database: "postgres",
    });
    await pool.query(`CREATE DATABASE "${PRIMARY_DB}"`);
    await pool.end();

    // Build the fixture "consumer repo" — a real git repo so
    // `git worktree add origin/main` resolves cleanly. Origin is a
    // bare clone so `--branch` resolves.
    workArea = mkdtempSync(join(tmpdir(), "roundtrip-fixture-"));
    const origin = join(workArea, "origin.git");
    repoRoot = join(workArea, "checkout");

    await execFile("git", ["init", "--bare", origin]);

    // Seed origin via a throwaway clone so refs/remotes/origin/main exists.
    const seed = join(workArea, "seed");
    await execFile("git", ["clone", origin, seed]);
    writeFileSync(join(seed, "README.md"), "fixture\n");
    writeFileSync(join(seed, "docker-compose.yml"), COMPOSE);
    writeFileSync(
      join(seed, ".env"),
      [
        "DB_CONNECTION=pgsql",
        "DB_HOST=127.0.0.1",
        `DB_PORT=${pgHostPort}`,
        `DB_DATABASE=${PRIMARY_DB}`,
        `DB_USERNAME=${PG_USER}`,
        `DB_PASSWORD=${PG_PASS}`,
        "",
      ].join("\n"),
    );
    await gitExec(seed, "config", "user.email", "test@danxbot.local");
    await gitExec(seed, "config", "user.name", "test");
    await gitExec(seed, "add", ".");
    await gitExec(seed, "commit", "-m", "init");
    await gitExec(seed, "branch", "-M", "main");
    await gitExec(seed, "push", "origin", "main");
    // Set origin's HEAD to main so the next clone checks out main, not
    // a stale `master` ref.
    await execFile("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/main"]);

    // The actual repo clone the manager works against.
    await execFile("git", ["clone", "-b", "main", origin, repoRoot]);
    await gitExec(repoRoot, "config", "user.email", "test@danxbot.local");
    await gitExec(repoRoot, "config", "user.name", "test");
  }, 90_000);

  afterAll(async () => {
    try {
      // Best-effort sweep — teardown should have run, but if a test
      // failed mid-way, force the compose stack down to release ports.
      await execFile("docker", [
        "compose",
        "-p",
        composeProjectName(REPO_NAME, AGENT_NAME),
        "down",
        "--volumes",
        "--remove-orphans",
      ]).catch(() => {});
      await execFile("docker", ["kill", CONTAINER_PG]).catch(() => {});
    } finally {
      if (workArea && existsSync(workArea)) {
        rmSync(workArea, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it("bootstrap → DB role + worker stack up + httpd serves hello on allocated APP_PORT", async () => {
    const wm = createWorktreeManager();
    process.env.DANXBOT_PLATFORM_DB_HOST = "127.0.0.1";
    process.env.DANXBOT_PLATFORM_DB_PORT = String(pgHostPort);
    try {
      await wm.bootstrap(
        { name: REPO_NAME, localPath: repoRoot, hostPath: repoRoot },
        AGENT_NAME,
      );

      // Worktree dir present
      const wtPath = join(repoRoot, ".danxbot", "worktrees", AGENT_NAME);
      expect(existsSync(wtPath)).toBe(true);

      // Port offset allocated
      const reg = readRegistry(repoRoot);
      const offset = reg.offsets[AGENT_NAME];
      expect(offset).toBeGreaterThan(0);
      const appPort = PORT_BASES.APP_PORT + offset;

      // DB role exists on the test pg
      const admin = new Pool({
        host: "127.0.0.1",
        port: pgHostPort,
        user: PG_USER,
        password: PG_PASS,
        database: "postgres",
      });
      const rolesRows = await admin.query(
        `SELECT 1 FROM pg_roles WHERE rolname = $1`,
        [`agent_${AGENT_NAME}`],
      );
      expect(rolesRows.rows).toHaveLength(1);
      const dbsRows = await admin.query(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [`${PRIMARY_DB}_${AGENT_NAME}`],
      );
      expect(dbsRows.rows).toHaveLength(1);
      await admin.end();

      // httpd container is up
      const { stdout: ps } = await execFile("docker", [
        "ps",
        "--filter",
        `label=com.docker.compose.project=${composeProjectName(REPO_NAME, AGENT_NAME)}`,
        "--format",
        "{{.Names}}",
      ]);
      expect(ps).toMatch(/_web/);

      // httpd serves "hello" on the allocated APP_PORT — wait briefly
      // for the busybox httpd to be ready (container start + entrypoint
      // shell + mkdir + httpd boot).
      let body = "";
      for (let i = 0; i < 20; i += 1) {
        try {
          body = await httpGet("127.0.0.1", appPort);
          if (body.includes("hello")) break;
        } catch {
          // not ready yet
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(body).toBe("hello");

      // Secret persisted for the agent role
      expect(defaultSecretStore.read(repoRoot, AGENT_NAME)).not.toBeNull();
    } finally {
      delete process.env.DANXBOT_PLATFORM_DB_HOST;
      delete process.env.DANXBOT_PLATFORM_DB_PORT;
    }
  }, 120_000);

  it("teardown → stack down, DB role gone, ports freed, dir gone", async () => {
    const wm = createWorktreeManager();
    const reg = readRegistry(repoRoot);
    const offset = reg.offsets[AGENT_NAME];
    expect(offset).toBeGreaterThan(0); // sanity — bootstrap ran
    const appPort = PORT_BASES.APP_PORT + offset;

    process.env.DANXBOT_PLATFORM_DB_HOST = "127.0.0.1";
    process.env.DANXBOT_PLATFORM_DB_PORT = String(pgHostPort);
    try {
      await wm.teardown(
        { name: REPO_NAME, localPath: repoRoot, hostPath: repoRoot },
        AGENT_NAME,
      );
    } finally {
      delete process.env.DANXBOT_PLATFORM_DB_HOST;
      delete process.env.DANXBOT_PLATFORM_DB_PORT;
    }

    // Stack down — httpd container gone
    const { stdout: psAfter } = await execFile("docker", [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${composeProjectName(REPO_NAME, AGENT_NAME)}`,
      "--format",
      "{{.Names}}",
    ]);
    expect(psAfter.trim()).toBe("");

    // Port no longer serves anything
    await expect(httpGet("127.0.0.1", appPort)).rejects.toThrow();

    // DB role + db gone
    const admin = new Pool({
      host: "127.0.0.1",
      port: pgHostPort,
      user: PG_USER,
      password: PG_PASS,
      database: "postgres",
    });
    const rolesRows = await admin.query(
      `SELECT 1 FROM pg_roles WHERE rolname = $1`,
      [`agent_${AGENT_NAME}`],
    );
    expect(rolesRows.rows).toHaveLength(0);
    const dbsRows = await admin.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [`${PRIMARY_DB}_${AGENT_NAME}`],
    );
    expect(dbsRows.rows).toHaveLength(0);
    await admin.end();

    // Port offset freed
    expect(readRegistry(repoRoot).offsets[AGENT_NAME]).toBeUndefined();
    // Worktree dir gone
    expect(
      existsSync(join(repoRoot, ".danxbot", "worktrees", AGENT_NAME)),
    ).toBe(false);
    // Secret removed
    expect(defaultSecretStore.read(repoRoot, AGENT_NAME)).toBeNull();
  }, 90_000);
});
