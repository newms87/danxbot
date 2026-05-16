/**
 * Unit tests for the per-worktree DB provisioner (DX-571). All Postgres
 * + docker-exec calls go through injected fakes — these tests are
 * Docker-free and run in milliseconds. The integration suite at
 * `src/__tests__/integration/worktree-database.test.ts` exercises real
 * Postgres against `gpt-manager-pgsql-1`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  deriveWorktreeIdentifiers,
  isLaravelPgsqlRepo,
  parseDotenv,
  provisionWorktreeDatabase,
  rewriteDotenv,
  writeWorktreeEnvFile,
  WorktreeDatabaseError,
  type PgAdminClient,
  type PgClientFactory,
  type WorktreeSecretStore,
} from "./worktree-database.js";

// --------------------------------------------------------------------
// Fixture helpers
// --------------------------------------------------------------------

interface QueryRecord {
  sql: string;
  params?: ReadonlyArray<unknown>;
}

interface FakeClientOptions {
  /** Roles that already exist (for the `pg_roles` lookup). */
  existingRoles?: ReadonlyArray<string>;
  /** Databases that already exist (for the `pg_database` lookup). */
  existingDatabases?: ReadonlyArray<string>;
}

function fakeClient(opts: FakeClientOptions = {}): PgAdminClient & {
  queries: QueryRecord[];
  endCalls: number;
} {
  const queries: QueryRecord[] = [];
  let endCalls = 0;
  const existingRoles = new Set(opts.existingRoles ?? []);
  const existingDatabases = new Set(opts.existingDatabases ?? []);
  return {
    queries,
    get endCalls() {
      return endCalls;
    },
    async query(sql, params) {
      queries.push({ sql, params });
      if (/FROM pg_roles WHERE rolname/.test(sql)) {
        const name = params?.[0] as string | undefined;
        return existingRoles.has(name ?? "")
          ? { rows: [{ "?column?": 1 }] }
          : { rows: [] };
      }
      if (/FROM pg_database WHERE datname/.test(sql)) {
        const name = params?.[0] as string | undefined;
        return existingDatabases.has(name ?? "")
          ? { rows: [{ "?column?": 1 }] }
          : { rows: [] };
      }
      return { rows: [] };
    },
    async end() {
      endCalls += 1;
    },
  };
}

function factoryReturning(
  client: PgAdminClient,
): PgClientFactory & { configs: any[] } {
  const configs: any[] = [];
  const f: any = async (cfg: any) => {
    configs.push(cfg);
    return client;
  };
  f.configs = configs;
  return f;
}

function memorySecretStore(): WorktreeSecretStore & { reads: any[]; writes: any[] } {
  const map = new Map<string, string>();
  const reads: any[] = [];
  const writes: any[] = [];
  return {
    reads,
    writes,
    read(repoRoot, name) {
      reads.push({ repoRoot, name });
      return map.get(`${repoRoot}|${name}`) ?? null;
    },
    write(repoRoot, name, pw) {
      writes.push({ repoRoot, name, pw });
      map.set(`${repoRoot}|${name}`, pw);
    },
  };
}

let workArea: string;
let repoRoot: string;
let worktreePath: string;

beforeEach(() => {
  workArea = mkdtempSync(join(tmpdir(), "worktree-db-"));
  repoRoot = join(workArea, "repo");
  worktreePath = join(repoRoot, ".danxbot", "worktrees", "buildy");
  mkdirSync(worktreePath, { recursive: true });
});

afterEach(() => {
  rmSync(workArea, { recursive: true, force: true });
});

function seedEnv(content: string): void {
  writeFileSync(join(repoRoot, ".env"), content);
}

const LARAVEL_ENV = [
  "APP_NAME=Laravel",
  "DB_CONNECTION=pgsql",
  "DB_HOST=pgsql",
  "DB_PORT=5432",
  "DB_DATABASE=laravel",
  "DB_USERNAME=sail",
  "DB_PASSWORD=password",
  "PUSHER_KEY=keep-me",
  "",
].join("\n");

// --------------------------------------------------------------------
// parseDotenv
// --------------------------------------------------------------------

describe("parseDotenv", () => {
  it("parses simple KEY=VALUE lines", () => {
    expect(parseDotenv("FOO=bar\nBAZ=qux")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores comments + blank lines", () => {
    expect(parseDotenv("# comment\n\nFOO=bar\n# another\nBAZ=qux")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("unwraps double + single quoted values", () => {
    expect(parseDotenv('FOO="bar baz"\nQUX=\'sp ace\'')).toEqual({
      FOO: "bar baz",
      QUX: "sp ace",
    });
  });

  it("rejects keys that are not shell-identifier-shaped", () => {
    expect(parseDotenv("1FOO=bar\nFOO-BAR=baz\nGOOD=ok")).toEqual({ GOOD: "ok" });
  });
});

// --------------------------------------------------------------------
// rewriteDotenv
// --------------------------------------------------------------------

describe("rewriteDotenv", () => {
  it("rewrites existing keys in place + preserves order", () => {
    const out = rewriteDotenv(LARAVEL_ENV, {
      DB_DATABASE: "laravel_buildy",
      DB_USERNAME: "agent_buildy",
    });
    expect(out).toContain("DB_DATABASE=laravel_buildy");
    expect(out).toContain("DB_USERNAME=agent_buildy");
    // Unrelated keys preserved verbatim
    expect(out).toContain("DB_HOST=pgsql");
    expect(out).toContain("PUSHER_KEY=keep-me");
    // Order: DB_HOST line index < DB_DATABASE line index < PUSHER line index
    const lines = out.split("\n");
    expect(lines.indexOf("DB_HOST=pgsql")).toBeLessThan(
      lines.indexOf("DB_DATABASE=laravel_buildy"),
    );
  });

  it("appends keys that did not previously exist", () => {
    const out = rewriteDotenv("FOO=bar\n", { NEW_KEY: "newval" });
    expect(out).toContain("NEW_KEY=newval");
  });

  it("preserves comments + blank lines verbatim", () => {
    const src = "# top comment\n\nFOO=bar\n# inline\nBAZ=qux\n";
    const out = rewriteDotenv(src, { FOO: "new" });
    expect(out).toContain("# top comment");
    expect(out).toContain("# inline");
    expect(out).toMatch(/\n\n/);
    expect(out).toContain("FOO=new");
  });

  it("preserves indentation on the rewritten key", () => {
    const src = "  FOO=bar\n";
    const out = rewriteDotenv(src, { FOO: "new" });
    expect(out).toBe("  FOO=new\n");
  });
});

// --------------------------------------------------------------------
// isLaravelPgsqlRepo
// --------------------------------------------------------------------

describe("isLaravelPgsqlRepo", () => {
  beforeEach(() => mkdirSync(repoRoot, { recursive: true }));

  it("returns true for DB_CONNECTION=pgsql with DB_DATABASE set", () => {
    seedEnv(LARAVEL_ENV);
    expect(isLaravelPgsqlRepo(repoRoot)).toBe(true);
  });

  it("returns false when DB_CONNECTION is mysql / sqlite", () => {
    seedEnv("DB_CONNECTION=mysql\nDB_DATABASE=app\n");
    expect(isLaravelPgsqlRepo(repoRoot)).toBe(false);
    seedEnv("DB_CONNECTION=sqlite\nDB_DATABASE=app\n");
    expect(isLaravelPgsqlRepo(repoRoot)).toBe(false);
  });

  it("returns false when DB_CONNECTION is missing", () => {
    seedEnv("FOO=bar\n");
    expect(isLaravelPgsqlRepo(repoRoot)).toBe(false);
  });

  it("returns false when DB_DATABASE is missing", () => {
    seedEnv("DB_CONNECTION=pgsql\n");
    expect(isLaravelPgsqlRepo(repoRoot)).toBe(false);
  });

  it("returns false when .env does not exist", () => {
    expect(isLaravelPgsqlRepo(repoRoot)).toBe(false);
  });
});

// --------------------------------------------------------------------
// deriveWorktreeIdentifiers
// --------------------------------------------------------------------

describe("deriveWorktreeIdentifiers", () => {
  it("composes <primary>_<name> and agent_<name>", () => {
    expect(deriveWorktreeIdentifiers("laravel", "buildy")).toEqual({
      workerDb: "laravel_buildy",
      workerRole: "agent_buildy",
    });
  });

  it("translates `-` in worktree name to `_` for Postgres identifier shape", () => {
    expect(deriveWorktreeIdentifiers("laravel", "feat-x")).toEqual({
      workerDb: "laravel_feat_x",
      workerRole: "agent_feat_x",
    });
  });

  it("rejects an injection-shaped primary db", () => {
    expect(() =>
      deriveWorktreeIdentifiers('laravel"; DROP', "buildy"),
    ).toThrow(WorktreeDatabaseError);
  });
});

// --------------------------------------------------------------------
// writeWorktreeEnvFile
// --------------------------------------------------------------------

describe("writeWorktreeEnvFile", () => {
  it("writes a real file (not a symlink) with rewritten DB_* keys", () => {
    writeWorktreeEnvFile(worktreePath, LARAVEL_ENV, {
      DB_DATABASE: "laravel_buildy",
      DB_USERNAME: "agent_buildy",
      DB_PASSWORD: "secret",
    });
    const target = join(worktreePath, ".env");
    const st = lstatSync(target);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    const content = readFileSync(target, "utf-8");
    expect(content).toContain("DB_DATABASE=laravel_buildy");
    expect(content).toContain("DB_USERNAME=agent_buildy");
    expect(content).toContain("DB_PASSWORD=secret");
    expect(content).toContain("PUSHER_KEY=keep-me");
  });

  it("replaces an existing symlink with a real file", () => {
    const target = join(worktreePath, ".env");
    const fakeParent = join(workArea, "parent.env");
    writeFileSync(fakeParent, "PRE=existing\n");
    symlinkSync(fakeParent, target, "file");
    expect(lstatSync(target).isSymbolicLink()).toBe(true);

    writeWorktreeEnvFile(worktreePath, LARAVEL_ENV, {
      DB_DATABASE: "laravel_buildy",
    });

    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    // The parent file untouched — we did not follow the symlink to write.
    expect(readFileSync(fakeParent, "utf-8")).toBe("PRE=existing\n");
  });

  it("permission is 0600 (DB password is secret)", () => {
    writeWorktreeEnvFile(worktreePath, LARAVEL_ENV, {
      DB_PASSWORD: "secret",
    });
    const mode = lstatSync(join(worktreePath, ".env")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// --------------------------------------------------------------------
// provisionWorktreeDatabase — happy path + idempotency + skips
// --------------------------------------------------------------------

describe("provisionWorktreeDatabase", () => {
  it("returns skipped + makes ZERO postgres calls for non-Laravel repos", async () => {
    mkdirSync(repoRoot, { recursive: true });
    seedEnv("DB_CONNECTION=mysql\nDB_DATABASE=app\n");
    const client = fakeClient();
    const factory = factoryReturning(client);
    const result = await provisionWorktreeDatabase({
      repoRoot,
      worktreePath,
      worktreeName: "buildy",
      pgClientFactory: factory,
      secretStore: memorySecretStore(),
    });
    expect(result.kind).toBe("skipped");
    expect(factory.configs).toHaveLength(0);
    expect(client.queries).toHaveLength(0);
    // No .env written either
    expect(existsSync(join(worktreePath, ".env"))).toBe(false);
  });

  it("creates DB + role + GRANT + REVOKE on first run", async () => {
    seedEnv(LARAVEL_ENV);
    const client = fakeClient();
    const factory = factoryReturning(client);
    const secrets = memorySecretStore();

    const result = await provisionWorktreeDatabase({
      repoRoot,
      worktreePath,
      worktreeName: "buildy",
      pgClientFactory: factory,
      secretStore: secrets,
    });

    expect(result.kind).toBe("provisioned");
    if (result.kind !== "provisioned") return;
    expect(result.workerDb).toBe("laravel_buildy");
    expect(result.workerRole).toBe("agent_buildy");
    expect(result.created).toEqual({ database: true, role: true });

    // Two SELECTs (role lookup + db lookup) then DDL.
    const sqls = client.queries.map((q) => q.sql);
    expect(sqls.some((s) => /CREATE ROLE "agent_buildy"/.test(s))).toBe(true);
    expect(sqls.some((s) => /CREATE DATABASE "laravel_buildy"/.test(s))).toBe(
      true,
    );
    expect(
      sqls.some((s) =>
        /GRANT ALL PRIVILEGES ON DATABASE "laravel_buildy" TO "agent_buildy"/.test(
          s,
        ),
      ),
    ).toBe(true);
    // Two REVOKEs — FROM PUBLIC (the actual lock) AND FROM the per-role
    // (defense-in-depth). Order is load-bearing per the worktree-database
    // header — pin it explicitly so a future refactor flipping the
    // sequence is caught.
    const revokeIdx = sqls
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => /REVOKE CONNECT ON DATABASE "laravel"/.test(s));
    expect(revokeIdx).toHaveLength(2);
    expect(revokeIdx[0].s).toMatch(/FROM PUBLIC$/);
    expect(revokeIdx[1].s).toMatch(/FROM "agent_buildy"$/);
    expect(revokeIdx[0].i).toBeLessThan(revokeIdx[1].i);
    expect(client.endCalls).toBe(1);

    // Secret persisted
    expect(secrets.writes).toHaveLength(1);
    // .env written
    expect(lstatSync(join(worktreePath, ".env")).isFile()).toBe(true);
  });

  it("is idempotent — second run with existing role + db reuses them", async () => {
    seedEnv(LARAVEL_ENV);
    const client = fakeClient({
      existingRoles: ["agent_buildy"],
      existingDatabases: ["laravel_buildy"],
    });
    const factory = factoryReturning(client);
    const secrets = memorySecretStore();
    // Seed an existing password so the rotation path uses the persisted secret
    secrets.write(repoRoot, "buildy", "persisted-secret");

    const result = await provisionWorktreeDatabase({
      repoRoot,
      worktreePath,
      worktreeName: "buildy",
      pgClientFactory: factory,
      secretStore: secrets,
    });

    expect(result.kind).toBe("provisioned");
    if (result.kind !== "provisioned") return;
    expect(result.created).toEqual({ database: false, role: false });
    const sqls = client.queries.map((q) => q.sql);
    expect(sqls.some((s) => /CREATE ROLE/.test(s))).toBe(false);
    expect(sqls.some((s) => /CREATE DATABASE/.test(s))).toBe(false);
    // ALTER ROLE rotates password to the persisted value
    expect(sqls.some((s) => /ALTER ROLE "agent_buildy"/.test(s))).toBe(true);
    expect(
      sqls.some((s) => s.includes("persisted-secret")),
    ).toBe(true);
    // GRANT + REVOKE still re-applied (idempotent in Postgres)
    expect(sqls.some((s) => /GRANT ALL PRIVILEGES/.test(s))).toBe(true);
    expect(sqls.some((s) => /REVOKE CONNECT/.test(s))).toBe(true);
  });

  it("replaces an existing .env symlink with a real per-worktree .env", async () => {
    seedEnv(LARAVEL_ENV);
    // Pre-seed the worktree with a symlink (the legacy state)
    symlinkSync(join(repoRoot, ".env"), join(worktreePath, ".env"), "file");
    expect(lstatSync(join(worktreePath, ".env")).isSymbolicLink()).toBe(true);

    const client = fakeClient();
    await provisionWorktreeDatabase({
      repoRoot,
      worktreePath,
      worktreeName: "buildy",
      pgClientFactory: factoryReturning(client),
      secretStore: memorySecretStore(),
    });

    const st = lstatSync(join(worktreePath, ".env"));
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    const body = readFileSync(join(worktreePath, ".env"), "utf-8");
    expect(body).toContain("DB_DATABASE=laravel_buildy");
    expect(body).toContain("DB_USERNAME=agent_buildy");
  });

  it("uses the persisted secret on the second run instead of regenerating", async () => {
    seedEnv(LARAVEL_ENV);
    const secrets = memorySecretStore();

    // First run — generates + persists
    await provisionWorktreeDatabase({
      repoRoot,
      worktreePath,
      worktreeName: "buildy",
      pgClientFactory: factoryReturning(fakeClient()),
      secretStore: secrets,
    });
    const firstWrite = secrets.writes[0].pw;

    // Second run — reads, does NOT write again
    const writeCountBefore = secrets.writes.length;
    await provisionWorktreeDatabase({
      repoRoot,
      worktreePath,
      worktreeName: "buildy",
      pgClientFactory: factoryReturning(
        fakeClient({
          existingRoles: ["agent_buildy"],
          existingDatabases: ["laravel_buildy"],
        }),
      ),
      secretStore: secrets,
    });
    expect(secrets.writes.length).toBe(writeCountBefore);
    expect(secrets.reads.length).toBeGreaterThan(1);
    // Re-read returns the persisted secret
    expect(secrets.read(repoRoot, "buildy")).toBe(firstWrite);
  });

  it("forwards host/port overrides to the pg client factory (host-mode operator path)", async () => {
    seedEnv(LARAVEL_ENV);
    const factory = factoryReturning(fakeClient());
    await provisionWorktreeDatabase({
      repoRoot,
      worktreePath,
      worktreeName: "buildy",
      pgClientFactory: factory,
      secretStore: memorySecretStore(),
      pgHostOverride: "localhost",
      pgPortOverride: 5444,
    });
    expect(factory.configs[0].host).toBe("localhost");
    expect(factory.configs[0].port).toBe(5444);
  });

  it("REVOKE statement names the parent's primary DB", async () => {
    seedEnv(LARAVEL_ENV.replace("DB_DATABASE=laravel", "DB_DATABASE=flytebot"));
    const client = fakeClient();
    await provisionWorktreeDatabase({
      repoRoot,
      worktreePath,
      worktreeName: "buildy",
      pgClientFactory: factoryReturning(client),
      secretStore: memorySecretStore(),
    });
    const revokes = client.queries.filter((q) => /REVOKE CONNECT/.test(q.sql));
    // Both REVOKEs name the parent's primary DB (not the worker DB).
    expect(revokes.every((r) => r.sql.includes(`"flytebot"`))).toBe(true);
    expect(revokes.some((r) => /FROM PUBLIC/.test(r.sql))).toBe(true);
    expect(revokes.some((r) => r.sql.includes(`"agent_buildy"`))).toBe(true);
  });

  it("validates DB_PORT is a positive integer", async () => {
    seedEnv(LARAVEL_ENV.replace("DB_PORT=5432", "DB_PORT=garbage"));
    await expect(
      provisionWorktreeDatabase({
        repoRoot,
        worktreePath,
        worktreeName: "buildy",
        pgClientFactory: factoryReturning(fakeClient()),
        secretStore: memorySecretStore(),
      }),
    ).rejects.toThrow(WorktreeDatabaseError);
  });

  it("rejects parent .env missing DB_DATABASE / DB_USERNAME (corrupt parent)", async () => {
    seedEnv("DB_CONNECTION=pgsql\nDB_DATABASE=app\nDB_HOST=pgsql\n");
    await expect(
      provisionWorktreeDatabase({
        repoRoot,
        worktreePath,
        worktreeName: "buildy",
        pgClientFactory: factoryReturning(fakeClient()),
        secretStore: memorySecretStore(),
      }),
    ).rejects.toThrow(/DB_DATABASE \/ DB_USERNAME \/ DB_PASSWORD/);
  });

  it("closes the pg client even when DDL throws (defense-in-depth)", async () => {
    seedEnv(LARAVEL_ENV);
    const throwingClient: any = {
      queries: [],
      async query() {
        throw new Error("pg connection lost");
      },
      async end() {
        (throwingClient as any).ended = true;
      },
    };
    await expect(
      provisionWorktreeDatabase({
        repoRoot,
        worktreePath,
        worktreeName: "buildy",
        pgClientFactory: async () => throwingClient,
        secretStore: memorySecretStore(),
      }),
    ).rejects.toThrow("pg connection lost");
    expect((throwingClient as any).ended).toBe(true);
  });
});
