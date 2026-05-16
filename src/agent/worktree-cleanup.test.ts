/**
 * Unit tests for `cleanupWorktreeArtifacts` — the symmetric inverse of
 * `provisionWorktreeArtifacts`. Used by:
 *   - `WorktreeManager.teardown` (operator DELETE)
 *   - `handlePostAgent` rollback path (failed POST after partial
 *     provisioning)
 *
 * Every step is idempotent — running against an already-cleaned worktree
 * returns successfully. Failures are logged + swallowed so a cleanup
 * call site can rely on the helper never throwing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanupWorktreeArtifacts,
  type CleanupDeps,
} from "./worktree-cleanup.js";
import {
  provisionWorktreePorts,
  readRegistry,
} from "./worktree-ports.js";
import type {
  PgAdminClient,
  PgClientFactory,
  WorktreeSecretStore,
} from "./worktree-database.js";

let workArea: string;
let repoRoot: string;
let worktreePath: string;

beforeEach(() => {
  workArea = mkdtempSync(join(tmpdir(), "worktree-cleanup-"));
  repoRoot = join(workArea, "repo");
  worktreePath = join(repoRoot, ".danxbot", "worktrees", "harry");
  mkdirSync(worktreePath, { recursive: true });
});

afterEach(() => {
  rmSync(workArea, { recursive: true, force: true });
});

const LARAVEL_ENV = [
  "DB_CONNECTION=pgsql",
  "DB_HOST=pgsql",
  "DB_PORT=5432",
  "DB_DATABASE=laravel",
  "DB_USERNAME=sail",
  "DB_PASSWORD=secret",
  "",
].join("\n");

function seedLaravelEnv(): void {
  writeFileSync(join(repoRoot, ".env"), LARAVEL_ENV);
}

function fakePgClient(opts: {
  existingRoles?: string[];
  existingDatabases?: string[];
} = {}): PgAdminClient & { queries: string[] } {
  const queries: string[] = [];
  const roles = new Set(opts.existingRoles ?? []);
  const dbs = new Set(opts.existingDatabases ?? []);
  return {
    queries,
    async query(sql, params) {
      queries.push(sql);
      if (/FROM pg_roles WHERE rolname/.test(sql)) {
        const n = params?.[0] as string | undefined;
        return roles.has(n ?? "") ? { rows: [{ "?column?": 1 }] } : { rows: [] };
      }
      if (/FROM pg_database WHERE datname/.test(sql)) {
        const n = params?.[0] as string | undefined;
        return dbs.has(n ?? "") ? { rows: [{ "?column?": 1 }] } : { rows: [] };
      }
      return { rows: [] };
    },
    async end() {},
  };
}

function fakeFactory(client: PgAdminClient): PgClientFactory {
  return async () => client;
}

function memorySecrets(): WorktreeSecretStore & { removed: string[] } {
  const map = new Map<string, string>();
  const removed: string[] = [];
  return {
    removed,
    read(_repo, name) {
      return map.get(name) ?? null;
    },
    write(_repo, name, pw) {
      map.set(name, pw);
    },
    remove(_repo, name) {
      map.delete(name);
      removed.push(name);
    },
  };
}

describe("cleanupWorktreeArtifacts — happy path on Laravel-pgsql repo", () => {
  it("drops DB, frees port offset, removes secret, removes worktree dir", async () => {
    seedLaravelEnv();
    // Pre-allocate a port offset
    provisionWorktreePorts(repoRoot, "harry");
    expect(readRegistry(repoRoot).offsets.harry).toBeDefined();
    // Pre-populate worktree dir contents (simulating partially provisioned state)
    writeFileSync(join(worktreePath, ".env"), "DB_DATABASE=laravel_harry\n");

    const client = fakePgClient({
      existingRoles: ["agent_harry"],
      existingDatabases: ["laravel_harry"],
    });
    const secrets = memorySecrets();
    secrets.write(repoRoot, "harry", "to-go");

    const deps: CleanupDeps = {
      pgClientFactory: fakeFactory(client),
      secretStore: secrets,
    };

    const result = await cleanupWorktreeArtifacts(repoRoot, worktreePath, "harry", deps);

    expect(result.databaseDropped).toBe(true);
    expect(result.roleDropped).toBe(true);
    expect(result.portsReleased).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.secretRemoved).toBe(true);

    // Port offset gone
    expect(readRegistry(repoRoot).offsets.harry).toBeUndefined();
    // Worktree dir gone
    expect(existsSync(worktreePath)).toBe(false);
    // Secret removed
    expect(secrets.removed).toContain("harry");
    // DDL ran
    expect(client.queries.some((q) => /DROP DATABASE.*"laravel_harry"/.test(q))).toBe(true);
    expect(client.queries.some((q) => /DROP ROLE.*"agent_harry"/.test(q))).toBe(true);
  });
});

describe("cleanupWorktreeArtifacts — idempotency", () => {
  it("returns success when called twice — second call drops nothing", async () => {
    seedLaravelEnv();
    provisionWorktreePorts(repoRoot, "harry");

    const client1 = fakePgClient({
      existingRoles: ["agent_harry"],
      existingDatabases: ["laravel_harry"],
    });
    await cleanupWorktreeArtifacts(repoRoot, worktreePath, "harry", {
      pgClientFactory: fakeFactory(client1),
      secretStore: memorySecrets(),
    });

    // Second pass — nothing left to clean
    const client2 = fakePgClient({ existingRoles: [], existingDatabases: [] });
    const result = await cleanupWorktreeArtifacts(repoRoot, worktreePath, "harry", {
      pgClientFactory: fakeFactory(client2),
      secretStore: memorySecrets(),
    });

    expect(result.databaseDropped).toBe(false);
    expect(result.roleDropped).toBe(false);
    expect(result.portsReleased).toBe(false); // already released
    expect(result.worktreeRemoved).toBe(false); // already gone
  });

  it("non-Laravel repo skips DB step entirely (zero pg client calls)", async () => {
    writeFileSync(join(repoRoot, ".env"), "DB_CONNECTION=mysql\nDB_DATABASE=app\n");
    provisionWorktreePorts(repoRoot, "harry");

    const client = fakePgClient();
    const result = await cleanupWorktreeArtifacts(repoRoot, worktreePath, "harry", {
      pgClientFactory: fakeFactory(client),
      secretStore: memorySecrets(),
    });

    expect(client.queries).toHaveLength(0);
    expect(result.databaseDropped).toBe(false);
    expect(result.roleDropped).toBe(false);
    // Non-DB artifacts still cleaned
    expect(result.portsReleased).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
  });
});

describe("cleanupWorktreeArtifacts — fail-soft contract", () => {
  it("logs + swallows a DB drop failure; still releases ports + removes dir", async () => {
    seedLaravelEnv();
    provisionWorktreePorts(repoRoot, "harry");

    const throwingClient: PgAdminClient = {
      async query() {
        throw new Error("pg unreachable");
      },
      async end() {},
    };

    const result = await cleanupWorktreeArtifacts(repoRoot, worktreePath, "harry", {
      pgClientFactory: fakeFactory(throwingClient),
      secretStore: memorySecrets(),
    });

    // DB step failed but rest succeeded
    expect(result.databaseDropped).toBe(false);
    expect(result.databaseError).toMatch(/pg unreachable/);
    expect(result.portsReleased).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
  });

  it("does not throw even when every step fails", async () => {
    // No .env file → isLaravelPgsqlRepo returns false → DB step skipped
    // No registry file → releaseWorktreePorts no-op
    // worktreePath already gone after this rm
    rmSync(worktreePath, { recursive: true, force: true });

    const result = await cleanupWorktreeArtifacts(
      repoRoot,
      worktreePath,
      "harry",
      {
        pgClientFactory: fakeFactory(fakePgClient()),
        secretStore: memorySecrets(),
      },
    );

    // Nothing to clean, no throw, all flags false
    expect(result.databaseDropped).toBe(false);
    expect(result.portsReleased).toBe(false);
    expect(result.worktreeRemoved).toBe(false);
  });
});
