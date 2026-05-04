import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseEnvFile,
  collectDeploymentSecrets,
  buildSsmPutCommands,
  buildTargetOverrides,
  getOrCreateDispatchToken,
  buildPushSecretsCommands,
  parsePutParameterCommand,
  filterUnchangedPuts,
  buildGetParametersCommands,
  parseGetParametersOutput,
  fetchExistingSsmValues,
  pushSecrets,
} from "./secrets.js";
import { setDryRun } from "./exec.js";
import { makeConfig } from "./test-helpers.js";

const TMP = resolve("/tmp/danxbot-secrets-test");

describe("parseEnvFile", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("parses KEY=VALUE lines, ignores comments and blank lines", () => {
    const p = resolve(TMP, "x.env");
    writeFileSync(p, "# comment\nFOO=bar\n\nBAZ=hello world\nQUX=\n");
    expect(parseEnvFile(p)).toEqual({
      FOO: "bar",
      BAZ: "hello world",
      QUX: "",
    });
  });

  it("returns empty object when file does not exist", () => {
    expect(parseEnvFile(resolve(TMP, "missing.env"))).toEqual({});
  });

  it("strips surrounding quotes on values", () => {
    const p = resolve(TMP, "q.env");
    writeFileSync(p, 'FOO="bar baz"\nQUOTED=\'single\'\n');
    expect(parseEnvFile(p)).toEqual({ FOO: "bar baz", QUOTED: "single" });
  });

  it("skips lines without =", () => {
    const p = resolve(TMP, "no-eq.env");
    writeFileSync(p, "FOO=bar\nnokey\nBAZ=qux\n");
    expect(parseEnvFile(p)).toEqual({ FOO: "bar", BAZ: "qux" });
  });
});

describe("collectDeploymentSecrets", () => {
  const CWD = resolve(TMP, "cwd");

  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(resolve(CWD, "repos/app/.danxbot"), { recursive: true });
    writeFileSync(resolve(CWD, ".env"), "ANTHROPIC_API_KEY=sk-xxx\n");
    writeFileSync(
      resolve(CWD, "repos/app/.danxbot/.env"),
      "DANX_SLACK_BOT_TOKEN=xoxb-yyy\n",
    );
    writeFileSync(
      resolve(CWD, "repos/app/.env"),
      "APP_KEY=base64:zzz\nDB_PASSWORD=secret\n",
    );
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("collects shared + per-repo danxbot + per-repo app env", () => {
    const result = collectDeploymentSecrets(
      makeConfig({
        repos: [{ name: "app", url: "https://github.com/x/app.git", workerPort: 5561, branch: "main" }],
      }),
      CWD,
    );

    expect(result.shared).toEqual({ ANTHROPIC_API_KEY: "sk-xxx" });
    expect(result.perRepo.app.danxbot).toEqual({
      DANX_SLACK_BOT_TOKEN: "xoxb-yyy",
    });
    expect(result.perRepo.app.app).toEqual({
      APP_KEY: "base64:zzz",
      DB_PASSWORD: "secret",
    });
  });

  it("reads the app .env from <repo>/<app_env_subpath>/.env when subpath is set", () => {
    // Simulate platform's layout: Sail .env lives at repos/platform/ssap/.env.
    const cwd3 = resolve(TMP, "cwd-subpath");
    mkdirSync(resolve(cwd3, "repos/platform/ssap"), { recursive: true });
    mkdirSync(resolve(cwd3, "repos/platform/.danxbot"), { recursive: true });
    writeFileSync(
      resolve(cwd3, "repos/platform/ssap/.env"),
      "APP_KEY=base64:plat\nDB_PASSWORD=plat-secret\n",
    );
    writeFileSync(
      resolve(cwd3, "repos/platform/.danxbot/.env"),
      "DANX_TRELLO_API_KEY=tr-xxx\n",
    );
    // Intentionally also place a decoy at repos/platform/.env — the collector
    // must ignore it when app_env_subpath is set (otherwise the wrong .env
    // would be pushed to SSM and materialized on the prod box).
    writeFileSync(resolve(cwd3, "repos/platform/.env"), "DECOY=should-not-read\n");

    const result = collectDeploymentSecrets(
      makeConfig({
        repos: [
          {
            name: "platform",
            url: "https://github.com/x/platform.git",
            appEnvSubpath: "ssap",
            workerPort: 5563,
            branch: "main",
          },
        ],
      }),
      cwd3,
    );

    expect(result.perRepo.platform.app).toEqual({
      APP_KEY: "base64:plat",
      DB_PASSWORD: "plat-secret",
    });
    expect(result.perRepo.platform.danxbot).toEqual({
      DANX_TRELLO_API_KEY: "tr-xxx",
    });
  });

  it("handles mixed repos — one with app_env_subpath, one without — independently", () => {
    const cwd4 = resolve(TMP, "cwd-mixed");
    mkdirSync(resolve(cwd4, "repos/platform/ssap"), { recursive: true });
    mkdirSync(resolve(cwd4, "repos/platform/.danxbot"), { recursive: true });
    mkdirSync(resolve(cwd4, "repos/simple/.danxbot"), { recursive: true });
    writeFileSync(
      resolve(cwd4, "repos/platform/ssap/.env"),
      "APP_KEY=base64:plat\n",
    );
    writeFileSync(resolve(cwd4, "repos/simple/.env"), "APP_KEY=base64:simp\n");

    const result = collectDeploymentSecrets(
      makeConfig({
        repos: [
          {
            name: "platform",
            url: "https://github.com/x/p.git",
            appEnvSubpath: "ssap",
            workerPort: 5563,
            branch: "main",
          },
          { name: "simple", url: "https://github.com/x/s.git", workerPort: 5564, branch: "main" },
        ],
      }),
      cwd4,
    );

    expect(result.perRepo.platform.app).toEqual({ APP_KEY: "base64:plat" });
    expect(result.perRepo.simple.app).toEqual({ APP_KEY: "base64:simp" });
  });

  it("returns empty app env when app_env_subpath is set but the file is absent (no fallback to <repo>/.env)", () => {
    // Guards against a future refactor silently falling back to the repo-root
    // .env — which would push the wrong values to SSM.
    const cwd5 = resolve(TMP, "cwd-miss-subpath");
    mkdirSync(resolve(cwd5, "repos/platform/.danxbot"), { recursive: true });
    // NO repos/platform/ssap/.env, but a decoy at repos/platform/.env.
    writeFileSync(
      resolve(cwd5, "repos/platform/.env"),
      "DECOY=should-not-read\n",
    );

    const result = collectDeploymentSecrets(
      makeConfig({
        repos: [
          {
            name: "platform",
            url: "https://github.com/x/p.git",
            appEnvSubpath: "ssap",
            workerPort: 5563,
            branch: "main",
          },
        ],
      }),
      cwd5,
    );

    expect(result.perRepo.platform.app).toEqual({});
  });

  it("returns empty per-repo entries when files are missing", () => {
    const cwd2 = resolve(TMP, "cwd-missing");
    mkdirSync(cwd2, { recursive: true });
    const result = collectDeploymentSecrets(
      makeConfig({
        repos: [{ name: "ghost", url: "https://example.com/g.git", workerPort: 5599, branch: "main" }],
      }),
      cwd2,
    );
    expect(result.shared).toEqual({});
    expect(result.perRepo.ghost).toEqual({ danxbot: {}, app: {} });
  });

  it("layers <root>/.env.<target> on top of <root>/.env when target is provided", () => {
    // Shared root .env carries dev-default ANTHROPIC_API_KEY; the per-target
    // override file points the production deployment at a different key
    // without mutating the dev file or requiring a second commit cycle.
    const cwd6 = resolve(TMP, "cwd-shared-override");
    mkdirSync(cwd6, { recursive: true });
    writeFileSync(
      resolve(cwd6, ".env"),
      "ANTHROPIC_API_KEY=sk-dev\nDANXBOT_GIT_EMAIL=dev@example.com\n",
    );
    writeFileSync(
      resolve(cwd6, ".env.platform"),
      "ANTHROPIC_API_KEY=sk-prod\n",
    );

    const result = collectDeploymentSecrets(
      makeConfig({ repos: [] }),
      cwd6,
      "platform",
    );

    expect(result.shared).toEqual({
      ANTHROPIC_API_KEY: "sk-prod",
      DANXBOT_GIT_EMAIL: "dev@example.com",
    });
  });

  it("layers <repo>/.danxbot/.env.<target> on top of <repo>/.danxbot/.env", () => {
    // Per-repo example: production deployment needs a different Slack
    // channel than local dev; the override file is the single source of
    // truth for the prod-only value.
    const cwd7 = resolve(TMP, "cwd-perrepo-override");
    mkdirSync(resolve(cwd7, "repos/platform/.danxbot"), { recursive: true });
    writeFileSync(
      resolve(cwd7, "repos/platform/.danxbot/.env"),
      "DANX_SLACK_CHANNEL_ID=C_LOCAL\nDANX_SLACK_BOT_TOKEN=xoxb-dev\n",
    );
    writeFileSync(
      resolve(cwd7, "repos/platform/.danxbot/.env.platform"),
      "DANX_SLACK_CHANNEL_ID=C_PROD\n",
    );

    const result = collectDeploymentSecrets(
      makeConfig({
        repos: [
          { name: "platform", url: "https://github.com/x/p.git", workerPort: 5561, branch: "main" },
        ],
      }),
      cwd7,
      "platform",
    );

    expect(result.perRepo.platform.danxbot).toEqual({
      DANX_SLACK_CHANNEL_ID: "C_PROD",
      DANX_SLACK_BOT_TOKEN: "xoxb-dev",
    });
  });

  it("layers <repo>/<app_env_subpath>/.env.<target> on top of the app .env", () => {
    // Symmetry guard: the app-subpath layout (Laravel sail at platform/ssap/.env)
    // must support per-target overrides exactly like the danxbot layer does.
    const cwd8 = resolve(TMP, "cwd-app-override");
    mkdirSync(resolve(cwd8, "repos/platform/ssap"), { recursive: true });
    mkdirSync(resolve(cwd8, "repos/platform/.danxbot"), { recursive: true });
    writeFileSync(
      resolve(cwd8, "repos/platform/ssap/.env"),
      "APP_KEY=base64:dev\nDB_HOST=localhost\n",
    );
    writeFileSync(
      resolve(cwd8, "repos/platform/ssap/.env.platform"),
      "APP_KEY=base64:prod\nAPP_URL=https://prod.example\n",
    );

    const result = collectDeploymentSecrets(
      makeConfig({
        repos: [
          {
            name: "platform",
            url: "https://github.com/x/p.git",
            appEnvSubpath: "ssap",
            workerPort: 5561,
            branch: "main",
          },
        ],
      }),
      cwd8,
      "platform",
    );

    expect(result.perRepo.platform.app).toEqual({
      APP_KEY: "base64:prod",
      DB_HOST: "localhost",
      APP_URL: "https://prod.example",
    });
  });

  it("ignores .env.<target> files when target is not provided (local dev path)", () => {
    // Pre-existing callers (none today, but guard against future) that omit
    // target must see the local-dev values only — never the prod overrides.
    const cwd9 = resolve(TMP, "cwd-no-target");
    mkdirSync(resolve(cwd9, "repos/platform/.danxbot"), { recursive: true });
    writeFileSync(resolve(cwd9, ".env"), "ANTHROPIC_API_KEY=sk-dev\n");
    writeFileSync(
      resolve(cwd9, ".env.platform"),
      "ANTHROPIC_API_KEY=sk-prod\n",
    );
    writeFileSync(
      resolve(cwd9, "repos/platform/.danxbot/.env"),
      "DANX_SLACK_CHANNEL_ID=C_LOCAL\n",
    );
    writeFileSync(
      resolve(cwd9, "repos/platform/.danxbot/.env.platform"),
      "DANX_SLACK_CHANNEL_ID=C_PROD\n",
    );

    const result = collectDeploymentSecrets(
      makeConfig({
        repos: [
          { name: "platform", url: "https://github.com/x/p.git", workerPort: 5561, branch: "main" },
        ],
      }),
      cwd9,
      // no target argument
    );

    expect(result.shared).toEqual({ ANTHROPIC_API_KEY: "sk-dev" });
    expect(result.perRepo.platform.danxbot).toEqual({
      DANX_SLACK_CHANNEL_ID: "C_LOCAL",
    });
  });

  it("treats a missing .env.<target> as a no-op when target is provided", () => {
    // Missing override file must NOT erase base values — the merge is
    // strictly additive.
    const cwd10 = resolve(TMP, "cwd-missing-override");
    mkdirSync(resolve(cwd10, "repos/platform/.danxbot"), { recursive: true });
    writeFileSync(resolve(cwd10, ".env"), "ANTHROPIC_API_KEY=sk-dev\n");
    writeFileSync(
      resolve(cwd10, "repos/platform/.danxbot/.env"),
      "DANX_SLACK_CHANNEL_ID=C_LOCAL\n",
    );

    const result = collectDeploymentSecrets(
      makeConfig({
        repos: [
          { name: "platform", url: "https://github.com/x/p.git", workerPort: 5561, branch: "main" },
        ],
      }),
      cwd10,
      "platform",
    );

    expect(result.shared).toEqual({ ANTHROPIC_API_KEY: "sk-dev" });
    expect(result.perRepo.platform.danxbot).toEqual({
      DANX_SLACK_CHANNEL_ID: "C_LOCAL",
    });
  });

  it("scopes overrides per target name (different .env.<target> files do not bleed)", () => {
    // Same cwd serves multiple deploy targets; each target must read only
    // its own override file. Reading .env.gpt must not leak into a deploy
    // of TARGET=platform.
    const cwd11 = resolve(TMP, "cwd-multi-target");
    mkdirSync(cwd11, { recursive: true });
    writeFileSync(resolve(cwd11, ".env"), "SHARED=base\n");
    writeFileSync(resolve(cwd11, ".env.platform"), "SHARED=plat\n");
    writeFileSync(resolve(cwd11, ".env.gpt"), "SHARED=gpt\n");

    const platformResult = collectDeploymentSecrets(
      makeConfig({ repos: [] }),
      cwd11,
      "platform",
    );
    const gptResult = collectDeploymentSecrets(
      makeConfig({ repos: [] }),
      cwd11,
      "gpt",
    );

    expect(platformResult.shared).toEqual({ SHARED: "plat" });
    expect(gptResult.shared).toEqual({ SHARED: "gpt" });
  });
});

describe("buildSsmPutCommands", () => {
  it("emits put-parameter commands for shared and per-repo keys", () => {
    const cfg = makeConfig({
      name: "danxbot-production",
      region: "us-west-2",
      ssmPrefix: "/danxbot-gpt",
      aws: { profile: "gpt" },
      repos: [{ name: "app", url: "https://github.com/x/app.git", workerPort: 5561, branch: "main" }],
    });
    const collected = {
      shared: { ANTHROPIC_API_KEY: "sk-xxx" },
      perRepo: {
        app: {
          danxbot: { DANX_SLACK_BOT_TOKEN: "xoxb" },
          app: { APP_KEY: "base64:zz" },
        },
      },
    };
    const cmds = buildSsmPutCommands(cfg, collected);

    expect(cmds).toContainEqual(
      expect.stringContaining(
        `aws --profile gpt ssm put-parameter --name "/danxbot-gpt/shared/ANTHROPIC_API_KEY"`,
      ),
    );
    expect(cmds).toContainEqual(
      expect.stringContaining(`--value 'sk-xxx'`),
    );
    expect(cmds).toContainEqual(
      expect.stringContaining(
        `--name "/danxbot-gpt/repos/app/DANX_SLACK_BOT_TOKEN"`,
      ),
    );
    expect(cmds).toContainEqual(
      expect.stringContaining(
        `--name "/danxbot-gpt/repos/app/REPO_ENV_APP_KEY"`,
      ),
    );
    expect(cmds).toContainEqual(
      expect.stringContaining(`--region us-west-2`),
    );
    expect(cmds).toContainEqual(
      expect.stringContaining(`--type SecureString`),
    );
    // Intelligent-Tiering lets SSM transparently promote >4KB values (e.g.
    // base64 RSA keys) to Advanced tier without charging Advanced rates for
    // sub-4KB values — regression guard against the old Standard-only form.
    expect(cmds).toContainEqual(
      expect.stringContaining(`--tier Intelligent-Tiering`),
    );
  });

  it("single-quote-wraps values so shell does not interpolate $VAR / backticks", () => {
    const cfg = makeConfig({
      ssmPrefix: "/danxbot-test",
      aws: { profile: "p" },
    });
    const collected = {
      shared: {
        LITERAL_DOLLAR: "${APP_NAME}",
        LITERAL_BACKTICK: "has`cmd`sub",
        QUOTED: 'has"quotes',
      },
      perRepo: {},
    };
    const cmds = buildSsmPutCommands(cfg, collected);
    expect(cmds.find((c) => c.includes("LITERAL_DOLLAR"))).toContain(
      `--value '\${APP_NAME}'`,
    );
    expect(cmds.find((c) => c.includes("LITERAL_BACKTICK"))).toContain(
      "--value 'has`cmd`sub'",
    );
    // Double quotes pass through single-quoted values untouched.
    expect(cmds.find((c) => c.includes("QUOTED"))).toContain(
      `--value 'has"quotes'`,
    );
  });

  it("escapes embedded single quotes in secret values", () => {
    const cfg = makeConfig({
      ssmPrefix: "/danxbot-test",
      aws: { profile: "p" },
    });
    const cmds = buildSsmPutCommands(cfg, {
      shared: { SQ: "it's fine" },
      perRepo: {},
    });
    // Single-quote escape: `'` → `'\''` → closing quote + escaped quote + reopen
    expect(cmds[0]).toContain(`--value 'it'\\''s fine'`);
  });

  it("emits zero commands when nothing is collected", () => {
    const cfg = makeConfig({ ssmPrefix: "/d", aws: { profile: "p" } });
    const cmds = buildSsmPutCommands(cfg, { shared: {}, perRepo: {} });
    expect(cmds).toEqual([]);
  });

  it("collides REPO_ENV_FOO (danxbot key literal) with FOO (app key) onto the same SSM path", () => {
    // Documented hazard from the card: a danxbot-side key literally named
    // `REPO_ENV_FOO` and an app-side key `FOO` both produce the SSM path
    // `<prefix>/repos/<name>/REPO_ENV_FOO`. The materializer's split rule
    // (REPO_ENV_* → app .env, others → danxbot .env) would route the danxbot
    // key into the app .env. There is no upstream validation forbidding the
    // collision, so the LAST value written to that path wins, and which one
    // wins depends on JS object insertion order — which is collected.danxbot
    // first then collected.app within a repo. This test pins that behavior:
    // we DO emit both put-parameter commands at the same path, and the LATER
    // one (the app key) overwrites the earlier one when applied. If a future
    // change adds collision detection, this test should be updated to
    // expect the new behavior (e.g. throw at build time).
    const cfg = makeConfig({
      ssmPrefix: "/danxbot-test",
      aws: { profile: "p" },
      repos: [{ name: "app", url: "https://github.com/x/a.git", workerPort: 5561, branch: "main" }],
    });
    const cmds = buildSsmPutCommands(cfg, {
      shared: {},
      perRepo: {
        app: {
          danxbot: { REPO_ENV_FOO: "danxbot-side-value" },
          app: { FOO: "app-side-value" },
        },
      },
    });
    // Both writes target the same SSM path:
    const targetingCollidedPath = cmds.filter((c) =>
      c.includes(`--name "/danxbot-test/repos/app/REPO_ENV_FOO"`),
    );
    expect(targetingCollidedPath).toHaveLength(2);
    // Order matches collection order: danxbot side first, app side last.
    expect(targetingCollidedPath[0]).toContain(`--value 'danxbot-side-value'`);
    expect(targetingCollidedPath[1]).toContain(`--value 'app-side-value'`);
  });

  it("skips empty-string values (SSM rejects them)", () => {
    const cfg = makeConfig({
      ssmPrefix: "/danxbot-test",
      aws: { profile: "p" },
      repos: [{ name: "app", url: "https://github.com/x/a.git", workerPort: 5561, branch: "main" }],
    });
    const cmds = buildSsmPutCommands(cfg, {
      shared: { FILLED: "value", EMPTY: "" },
      perRepo: {
        app: {
          danxbot: { TOKEN: "xoxb", BLANK: "" },
          app: { APP_KEY: "k", EMPTY_APP: "" },
        },
      },
    });
    const joined = cmds.join("\n");
    expect(joined).toContain("/danxbot-test/shared/FILLED");
    expect(joined).not.toContain("/danxbot-test/shared/EMPTY");
    expect(joined).toContain("/danxbot-test/repos/app/TOKEN");
    expect(joined).not.toContain("/danxbot-test/repos/app/BLANK");
    expect(joined).toContain("/danxbot-test/repos/app/REPO_ENV_APP_KEY");
    expect(joined).not.toContain("/danxbot-test/repos/app/REPO_ENV_EMPTY_APP");
  });
});

describe("buildTargetOverrides", () => {
  it("synthesizes DANXBOT_TARGET from the target FILENAME stem (not config.name)", () => {
    // Phase B: the runtime reads connected repos directly from
    // deploy/targets/<TARGET>.yml via src/target.ts#loadTarget. The
    // worker container only needs to know WHICH target file to load.
    //
    // CRITICAL: DANXBOT_TARGET MUST be the filename stem (e.g. "gpt"),
    // not config.name (e.g. "danxbot-production"). loadTarget resolves
    // `deploy/targets/${DANXBOT_TARGET}.yml`, so passing config.name
    // would point the worker at a non-existent file. The deploy CLI
    // invokes us with the filename stem as `target` and threads it
    // through.
    const cfg = makeConfig({
      name: "danxbot-production",
      repos: [
        { name: "danxbot", url: "https://github.com/x/d.git", workerPort: 5561, branch: "main" },
        { name: "gpt-manager", url: "https://github.com/x/g.git", workerPort: 5562, branch: "main" },
      ],
    });
    expect(buildTargetOverrides(cfg, "gpt")).toEqual({
      DANXBOT_TARGET: "gpt",
    });
    // Negative: must NOT use cfg.name even when both are passed.
    expect(buildTargetOverrides(cfg, "gpt").DANXBOT_TARGET).not.toBe(cfg.name);
  });

  it("returns the same DANXBOT_TARGET when the deployment has no repos (target identity is independent of repos[])", () => {
    const cfg = makeConfig({ repos: [] });
    expect(buildTargetOverrides(cfg, "gpt")).toEqual({
      DANXBOT_TARGET: "gpt",
    });
  });

  it("emits an SSM put command for DANXBOT_TARGET when merged into shared", () => {
    const cfg = makeConfig({
      ssmPrefix: "/danxbot-gpt",
      aws: { profile: "gpt" },
      repos: [
        { name: "danxbot", url: "https://github.com/x/d.git", workerPort: 5561, branch: "main" },
      ],
    });
    const overrides = buildTargetOverrides(cfg, "gpt");
    const cmds = buildSsmPutCommands(cfg, {
      shared: { ...overrides, DANXBOT_DISPATCH_TOKEN: "tok" },
      perRepo: {},
    });
    const joined = cmds.join("\n");
    expect(joined).toContain("/danxbot-gpt/shared/DANXBOT_TARGET");
    expect(joined).toContain(`--value 'gpt'`);
    expect(joined).toContain("/danxbot-gpt/shared/DANXBOT_DISPATCH_TOKEN");
    // Negative: the retired CSV vars must NEVER be emitted.
    expect(joined).not.toContain("/danxbot-gpt/shared/REPOS");
    expect(joined).not.toContain("/danxbot-gpt/shared/REPO_WORKER_PORTS");
    expect(joined).not.toContain("/danxbot-gpt/shared/REPO_WORKER_HOSTS");
  });
});

describe("getOrCreateDispatchToken", () => {
  const cfg = makeConfig({
    ssmPrefix: "/danxbot-gpt",
    aws: { profile: "gpt" },
  });

  it("returns the existing SSM value when present", () => {
    const exec = (_cmd: string): string => "existing-token-abc123";
    expect(getOrCreateDispatchToken(cfg, exec)).toBe("existing-token-abc123");
  });

  it("trims surrounding whitespace/newlines from the SSM value", () => {
    const exec = (_cmd: string): string => "  token-with-newline\n";
    expect(getOrCreateDispatchToken(cfg, exec)).toBe("token-with-newline");
  });

  it('rejects the literal "None" emitted by aws-cli --output text on unset values', () => {
    const exec = (_cmd: string): string => "None\n";
    const result = getOrCreateDispatchToken(cfg, exec);
    // Falls through to generation branch — must be a fresh hex token, not "None"
    expect(result).not.toBe("None");
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates a fresh 64-hex token on ParameterNotFound", () => {
    const exec = (_cmd: string): string => {
      throw new Error("An error occurred (ParameterNotFound): Parameter not found.");
    };
    const token = getOrCreateDispatchToken(cfg, exec);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("re-throws on non-ParameterNotFound AWS errors (does not silently regenerate)", () => {
    const exec = (_cmd: string): string => {
      throw new Error("ExpiredTokenException: The security token included in the request is expired");
    };
    expect(() => getOrCreateDispatchToken(cfg, exec)).toThrow(/ExpiredTokenException/);
  });

  it("each generated token is unique (not deterministic)", () => {
    const exec = (_cmd: string): string => {
      throw new Error("ParameterNotFound");
    };
    const a = getOrCreateDispatchToken(cfg, exec);
    const b = getOrCreateDispatchToken(cfg, exec);
    expect(a).not.toBe(b);
  });
});

describe("buildPushSecretsCommands", () => {
  // The orchestrator concern: how `pushSecrets` merges the three input streams
  // (collected .env values, per-target overrides, dispatch token) before
  // emitting put-parameter commands. The merge order is load-bearing —
  // operator-local values must NOT leak into a target that should only see
  // its own values. Pre-Phase-B this guarded REPOS / REPO_WORKER_PORTS;
  // Phase B retired those CSV vars in favor of DANXBOT_TARGET (the runtime
  // resolves repos from deploy/targets/<TARGET>.yml directly).
  const cfg = makeConfig({
    ssmPrefix: "/danxbot-test",
    aws: { profile: "p" },
    repos: [
      { name: "danxbot", url: "https://github.com/x/d.git", workerPort: 5561, branch: "main" },
    ],
  });

  it("target overrides win over conflicting keys in collected.shared", () => {
    // Operator's local .env may have a stale DANXBOT_TARGET from a prior
    // deploy of a different target. The deploy CLI's target overrides
    // must overwrite that — otherwise the worker container would boot
    // pointed at the wrong YML and load the wrong connected-repo list.
    const collected = {
      shared: { DANXBOT_TARGET: "stale-other-target", ANTHROPIC_API_KEY: "sk-x" },
      perRepo: {},
    };
    const overrides = { DANXBOT_TARGET: "gpt" };
    const cmds = buildPushSecretsCommands(cfg, collected, overrides, "tok");
    const targetCmd = cmds.find((c) =>
      c.includes(`--name "/danxbot-test/shared/DANXBOT_TARGET"`),
    );
    expect(targetCmd).toBeDefined();
    expect(targetCmd).toContain(`--value 'gpt'`);
    expect(targetCmd).not.toContain("stale-other-target");
  });

  it("DANXBOT_DISPATCH_TOKEN always lands in shared", () => {
    const cmds = buildPushSecretsCommands(
      cfg,
      { shared: {}, perRepo: {} },
      {},
      "the-token-value",
    );
    const tokenCmd = cmds.find((c) =>
      c.includes(`--name "/danxbot-test/shared/DANXBOT_DISPATCH_TOKEN"`),
    );
    expect(tokenCmd).toBeDefined();
    expect(tokenCmd).toContain("--value 'the-token-value'");
  });

  it("does NOT mutate the caller's collected object (pure function)", () => {
    // pushSecrets passes its own `collected` and reuses it elsewhere — if
    // buildPushSecretsCommands mutates it in place, surprises happen.
    const collected = {
      shared: { ANTHROPIC_API_KEY: "sk-x" } as Record<string, string>,
      perRepo: {} as Record<
        string,
        { danxbot: Record<string, string>; app: Record<string, string> }
      >,
    };
    const before = JSON.stringify(collected);
    buildPushSecretsCommands(cfg, collected, { DANXBOT_TARGET: "x" }, "tok");
    expect(JSON.stringify(collected)).toBe(before);
  });

  it("preserves per-repo entries from collected (not just shared)", () => {
    // The merge only touches `shared`; `perRepo` must pass through
    // untouched. Otherwise per-repo Slack tokens / DB creds would silently
    // disappear from the SSM push.
    const collected = {
      shared: {},
      perRepo: {
        danxbot: {
          danxbot: { DANX_SLACK_BOT_TOKEN: "xoxb-yyy" },
          app: { APP_KEY: "k" },
        },
      },
    };
    const cmds = buildPushSecretsCommands(cfg, collected, {}, "tok");
    const joined = cmds.join("\n");
    expect(joined).toContain("/danxbot-test/repos/danxbot/DANX_SLACK_BOT_TOKEN");
    expect(joined).toContain("/danxbot-test/repos/danxbot/REPO_ENV_APP_KEY");
  });

  it("emits one command per expected SSM path (shared + per-repo + overrides + token)", () => {
    // Verify by SET MEMBERSHIP rather than exact count — a future legitimate
    // override addition (e.g. a 4th synthesized key) shouldn't false-positive
    // this test, but a missing OR an unexpected SSM path should.
    const collected = {
      shared: { ANTHROPIC_API_KEY: "sk-x" },
      perRepo: {
        danxbot: {
          danxbot: { DANX_TRELLO_API_KEY: "tr" },
          app: { APP_KEY: "k" },
        },
      },
    };
    const overrides = {
      DANXBOT_TARGET: "gpt",
    };
    const cmds = buildPushSecretsCommands(cfg, collected, overrides, "tok");
    const paths = new Set(
      cmds.map((c) => c.match(/--name "([^"]+)"/)?.[1]).filter(Boolean),
    );
    expect(paths).toEqual(
      new Set([
        "/danxbot-test/shared/ANTHROPIC_API_KEY",
        "/danxbot-test/shared/DANXBOT_TARGET",
        "/danxbot-test/shared/DANXBOT_DISPATCH_TOKEN",
        "/danxbot-test/repos/danxbot/DANX_TRELLO_API_KEY",
        "/danxbot-test/repos/danxbot/REPO_ENV_APP_KEY",
      ]),
    );
  });

  it("dispatch token wins over an override-supplied DANXBOT_DISPATCH_TOKEN (precedence guard)", () => {
    // Belt-and-suspenders for the spread order. Today, no caller puts
    // DANXBOT_DISPATCH_TOKEN in `overrides` — but the function's contract is
    // "the explicit dispatchToken arg is the source of truth." A refactor
    // that swapped the spread order would silently break that.
    const cmds = buildPushSecretsCommands(
      cfg,
      { shared: {}, perRepo: {} },
      { DANXBOT_DISPATCH_TOKEN: "from-overrides-should-lose" },
      "the-real-token",
    );
    const tokenCmd = cmds.find((c) =>
      c.includes("/danxbot-test/shared/DANXBOT_DISPATCH_TOKEN"),
    );
    expect(tokenCmd).toContain("--value 'the-real-token'");
    expect(tokenCmd).not.toContain("from-overrides-should-lose");
  });
});

describe("parsePutParameterCommand", () => {
  it("extracts path and unescaped value from a built put-parameter command", () => {
    const cfg = makeConfig({ ssmPrefix: "/d", aws: { profile: "p" } });
    const [cmd] = buildSsmPutCommands(cfg, {
      shared: { FOO: "bar baz" },
      perRepo: {},
    });
    expect(parsePutParameterCommand(cmd)).toEqual({
      path: "/d/shared/FOO",
      value: "bar baz",
    });
  });

  it("reverses the shell single-quote escape so `'\\''` becomes `'`", () => {
    // Roundtrip guarantee: buildSsmPutCommands escapes single quotes via
    // `'\\''`. The parser must invert that exactly so the diff filter compares
    // raw secret values, not shell-quoted forms — otherwise a value that
    // contains a real single quote would always look "changed" and never
    // skip the put.
    const cfg = makeConfig({ ssmPrefix: "/d", aws: { profile: "p" } });
    const [cmd] = buildSsmPutCommands(cfg, {
      shared: { SQ: "it's fine" },
      perRepo: {},
    });
    expect(parsePutParameterCommand(cmd)).toEqual({
      path: "/d/shared/SQ",
      value: "it's fine",
    });
  });

  it("returns null on an unparseable command (defensive — caller must keep it)", () => {
    expect(parsePutParameterCommand("aws ssm describe-parameters")).toBeNull();
    expect(parsePutParameterCommand("")).toBeNull();
  });

  it("handles values containing literal `${VAR}` and backticks (no shell expansion)", () => {
    const cfg = makeConfig({ ssmPrefix: "/d", aws: { profile: "p" } });
    const [cmd] = buildSsmPutCommands(cfg, {
      shared: { LIT: "${APP_NAME}-`cmd`" },
      perRepo: {},
    });
    expect(parsePutParameterCommand(cmd)).toEqual({
      path: "/d/shared/LIT",
      value: "${APP_NAME}-`cmd`",
    });
  });
});

describe("filterUnchangedPuts", () => {
  const cfg = makeConfig({ ssmPrefix: "/d", aws: { profile: "p" } });
  const cmds = buildSsmPutCommands(cfg, {
    shared: { A: "1", B: "2", C: "3" },
    perRepo: {},
  });

  it("keeps puts whose value differs from existing SSM", () => {
    const existing = new Map<string, string>([
      ["/d/shared/A", "1"], // unchanged
      ["/d/shared/B", "old"], // changed
      // C absent — must push
    ]);
    const { toPush, skipped } = filterUnchangedPuts(cmds, existing);
    expect(skipped).toEqual(["/d/shared/A"]);
    expect(toPush).toHaveLength(2);
    expect(toPush.find((c) => c.includes("/d/shared/B"))).toBeDefined();
    expect(toPush.find((c) => c.includes("/d/shared/C"))).toBeDefined();
  });

  it("skips ALL puts when every value matches existing SSM", () => {
    const existing = new Map<string, string>([
      ["/d/shared/A", "1"],
      ["/d/shared/B", "2"],
      ["/d/shared/C", "3"],
    ]);
    const { toPush, skipped } = filterUnchangedPuts(cmds, existing);
    expect(toPush).toEqual([]);
    expect(skipped).toHaveLength(3);
  });

  it("pushes ALL puts when SSM has no matching parameters (first-time deploy)", () => {
    const { toPush, skipped } = filterUnchangedPuts(cmds, new Map());
    expect(toPush).toEqual(cmds);
    expect(skipped).toEqual([]);
  });

  it("keeps unparseable commands defensively (never silently drops a put)", () => {
    const weird = ["totally not a put-parameter command"];
    const { toPush, skipped } = filterUnchangedPuts(weird, new Map());
    expect(toPush).toEqual(weird);
    expect(skipped).toEqual([]);
  });
});

describe("buildGetParametersCommands", () => {
  const cfg = makeConfig({
    ssmPrefix: "/d",
    region: "us-west-2",
    aws: { profile: "p" },
  });

  it("emits one batched aws ssm get-parameters command per 10 paths (AWS limit)", () => {
    // AWS SSM `get-parameters` accepts max 10 names per call. Going over
    // produces a 400 ValidationException, so the batcher MUST slice at 10.
    const paths = Array.from({ length: 25 }, (_, i) => `/d/shared/K${i}`);
    const cmds = buildGetParametersCommands(cfg, paths);
    expect(cmds).toHaveLength(3); // 10 + 10 + 5
  });

  it("emits zero commands when given no paths", () => {
    expect(buildGetParametersCommands(cfg, [])).toEqual([]);
  });

  it("emits one command for fewer than 10 paths", () => {
    expect(
      buildGetParametersCommands(cfg, ["/d/shared/A", "/d/shared/B"]),
    ).toHaveLength(1);
  });

  it("includes profile, region, --with-decryption, and --output json", () => {
    const [cmd] = buildGetParametersCommands(cfg, ["/d/shared/A"]);
    expect(cmd).toContain("aws --profile p");
    expect(cmd).toContain("ssm get-parameters");
    expect(cmd).toContain("--with-decryption");
    expect(cmd).toContain("--region us-west-2");
    expect(cmd).toContain("--output json");
    expect(cmd).toContain('"/d/shared/A"');
  });

  it("quotes each path so spaces or unusual chars don't break the shell split", () => {
    const [cmd] = buildGetParametersCommands(cfg, [
      "/d/shared/A",
      "/d/shared/B",
    ]);
    expect(cmd).toMatch(/"\/d\/shared\/A"\s+"\/d\/shared\/B"/);
  });
});

describe("parseGetParametersOutput", () => {
  it("returns a Map of Name → Value for AWS get-parameters JSON", () => {
    const json = JSON.stringify([
      { Name: "/d/shared/A", Value: "1" },
      { Name: "/d/shared/B", Value: "two words" },
    ]);
    const result = parseGetParametersOutput(json);
    expect(result.get("/d/shared/A")).toBe("1");
    expect(result.get("/d/shared/B")).toBe("two words");
    expect(result.size).toBe(2);
  });

  it("returns an empty Map for an empty array (all paths were missing)", () => {
    expect(parseGetParametersOutput("[]").size).toBe(0);
  });

  it("returns an empty Map for empty input string (skipped batch)", () => {
    expect(parseGetParametersOutput("").size).toBe(0);
  });
});

describe("fetchExistingSsmValues", () => {
  const cfg = makeConfig({
    ssmPrefix: "/d",
    region: "us-west-2",
    aws: { profile: "p" },
  });

  it("merges results from multiple batches into a single Map", async () => {
    // Forces two get-parameters calls (>10 paths).
    const paths = Array.from({ length: 12 }, (_, i) => `/d/shared/K${i}`);
    let calls = 0;
    const exec = async (cmd: string): Promise<string> => {
      calls++;
      // Return a different value per batch to prove both are merged.
      if (cmd.includes('"/d/shared/K0"')) {
        return JSON.stringify([
          { Name: "/d/shared/K0", Value: "v0" },
          { Name: "/d/shared/K9", Value: "v9" },
        ]);
      }
      return JSON.stringify([{ Name: "/d/shared/K10", Value: "v10" }]);
    };
    const result = await fetchExistingSsmValues(cfg, paths, exec);
    expect(calls).toBe(2);
    expect(result.get("/d/shared/K0")).toBe("v0");
    expect(result.get("/d/shared/K9")).toBe("v9");
    expect(result.get("/d/shared/K10")).toBe("v10");
  });

  it("returns an empty Map when no paths are provided (no exec calls)", async () => {
    let calls = 0;
    const exec = async (_: string): Promise<string> => {
      calls++;
      return "[]";
    };
    expect((await fetchExistingSsmValues(cfg, [], exec)).size).toBe(0);
    expect(calls).toBe(0);
  });

  it("treats a thrown exec (auth error, etc.) as empty existing → first-time-deploy semantics", async () => {
    // Network or auth failures during the diff phase must NOT abort the
    // deploy — they degrade gracefully to "push everything," same as a
    // fresh SSM. The push step itself surfaces real auth failures loudly.
    const exec = async (_: string): Promise<string> => {
      throw new Error("ExpiredTokenException");
    };
    const result = await fetchExistingSsmValues(cfg, ["/d/shared/A"], exec);
    expect(result.size).toBe(0);
  });

  it("runs multiple batches in parallel (concurrent get-parameters calls)", async () => {
    // Force 50 paths → 5 batches. Track max in-flight to prove the diff
    // phase doesn't run serially. With concurrency >= 2 the max in-flight
    // count must exceed 1.
    const paths = Array.from({ length: 50 }, (_, i) => `/d/shared/K${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const exec = async (_: string): Promise<string> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield to the event loop a few times so other workers can claim
      // their batches and bump inFlight before this one resolves.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return "[]";
    };
    await fetchExistingSsmValues(cfg, paths, exec);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("partial batch failure does NOT poison the whole diff (other batches still merge)", async () => {
    // Batch 1 throws (transient error), batch 2 returns a value. The
    // result must include batch 2's value — one bad batch should never
    // erase the whole diff phase.
    const paths = Array.from({ length: 12 }, (_, i) => `/d/shared/K${i}`);
    const exec = async (cmd: string): Promise<string> => {
      if (cmd.includes('"/d/shared/K0"')) {
        throw new Error("transient");
      }
      return JSON.stringify([{ Name: "/d/shared/K10", Value: "v10" }]);
    };
    const result = await fetchExistingSsmValues(cfg, paths, exec);
    expect(result.get("/d/shared/K10")).toBe("v10");
    expect(result.has("/d/shared/K0")).toBe(false);
  });
});

describe("pushSecrets — diff + parallel", () => {
  const CWD2 = resolve("/tmp/danxbot-pushsecrets-test");
  const cfg = makeConfig({
    ssmPrefix: "/d",
    region: "us-west-2",
    aws: { profile: "p" },
    repos: [
      {
        name: "app",
        url: "https://github.com/x/app.git",
        workerPort: 5561,
        branch: "main",
      },
    ],
  });

  beforeEach(() => {
    rmSync(CWD2, { recursive: true, force: true });
    mkdirSync(resolve(CWD2, "repos/app/.danxbot"), { recursive: true });
    writeFileSync(resolve(CWD2, ".env"), "ANTHROPIC_API_KEY=sk-shared\n");
    writeFileSync(
      resolve(CWD2, "repos/app/.danxbot/.env"),
      "DANX_SLACK_BOT_TOKEN=xoxb-token\nDANX_TRELLO_API_KEY=tr-key\n",
    );
    writeFileSync(
      resolve(CWD2, "repos/app/.env"),
      "APP_KEY=base64:zz\nDB_PASSWORD=secret\n",
    );
  });

  afterEach(() => {
    rmSync(CWD2, { recursive: true, force: true });
    setDryRun(false);
  });

  it("skips puts for paths whose SSM value already matches the local value", async () => {
    const ranCmds: string[] = [];
    const ssmReader = async (
      _cfg: typeof cfg,
      _paths: string[],
    ): Promise<Map<string, string>> =>
      new Map([
        // Pretend these two are already up to date — they MUST be skipped.
        ["/d/shared/ANTHROPIC_API_KEY", "sk-shared"],
        ["/d/repos/app/DANX_SLACK_BOT_TOKEN", "xoxb-token"],
        // Stale value — MUST be re-pushed.
        ["/d/repos/app/DANX_TRELLO_API_KEY", "old-stale-key"],
      ]);
    const runner = async (
      cmds: { cmd: string; logLabel?: string }[],
      _concurrency: number,
    ): Promise<void> => {
      for (const { cmd } of cmds) ranCmds.push(cmd);
    };

    await pushSecrets(cfg, CWD2, "test-target", {
      ssmReader,
      runner,
      // Force a fixed dispatch token so we don't hit the SSM-read for it
      // (already covered by getOrCreateDispatchToken's own tests).
      dispatchToken: "fixed-token",
    });

    const pushedPaths = new Set(
      ranCmds
        .map((c) => parsePutParameterCommand(c)?.path)
        .filter(Boolean) as string[],
    );
    // Skipped (unchanged):
    expect(pushedPaths.has("/d/shared/ANTHROPIC_API_KEY")).toBe(false);
    expect(pushedPaths.has("/d/repos/app/DANX_SLACK_BOT_TOKEN")).toBe(false);
    // Pushed (changed or first-time):
    expect(pushedPaths.has("/d/repos/app/DANX_TRELLO_API_KEY")).toBe(true);
    expect(pushedPaths.has("/d/repos/app/REPO_ENV_APP_KEY")).toBe(true);
    expect(pushedPaths.has("/d/repos/app/REPO_ENV_DB_PASSWORD")).toBe(true);
    expect(pushedPaths.has("/d/shared/DANXBOT_DISPATCH_TOKEN")).toBe(true);
  });

  it("forwards the concurrency option to the runner", async () => {
    let observedConcurrency = -1;
    const ssmReader = async (): Promise<Map<string, string>> => new Map();
    const runner = async (
      _cmds: { cmd: string; logLabel?: string }[],
      concurrency: number,
    ): Promise<void> => {
      observedConcurrency = concurrency;
    };

    await pushSecrets(cfg, CWD2, "test-target", {
      ssmReader,
      runner,
      concurrency: 25,
      dispatchToken: "tok",
    });

    expect(observedConcurrency).toBe(25);
  });

  it("uses a default concurrency of at least 5 when none is supplied", async () => {
    // Lower bound only — exact value can change with throttle observations,
    // but it MUST be >1 (otherwise the parallelization is dead code) and
    // SHOULD stay well below the default 40 TPS PutParameter throttle.
    let observedConcurrency = -1;
    const ssmReader = async (): Promise<Map<string, string>> => new Map();
    const runner = async (
      _cmds: { cmd: string; logLabel?: string }[],
      concurrency: number,
    ): Promise<void> => {
      observedConcurrency = concurrency;
    };

    await pushSecrets(cfg, CWD2, "test-target", {
      ssmReader,
      runner,
      dispatchToken: "tok",
    });

    expect(observedConcurrency).toBeGreaterThanOrEqual(5);
    expect(observedConcurrency).toBeLessThanOrEqual(40);
  });

  it("still pushes everything when ssmReader returns an empty Map (first-time deploy)", async () => {
    const ranCmds: string[] = [];
    const ssmReader = async (): Promise<Map<string, string>> => new Map();
    const runner = async (
      cmds: { cmd: string; logLabel?: string }[],
    ): Promise<void> => {
      for (const { cmd } of cmds) ranCmds.push(cmd);
    };
    await pushSecrets(cfg, CWD2, "test-target", {
      ssmReader,
      runner,
      dispatchToken: "tok",
    });
    expect(ranCmds.length).toBeGreaterThan(0);
    const pushedPaths = new Set(
      ranCmds
        .map((c) => parsePutParameterCommand(c)?.path)
        .filter(Boolean) as string[],
    );
    expect(pushedPaths.has("/d/shared/ANTHROPIC_API_KEY")).toBe(true);
    expect(pushedPaths.has("/d/repos/app/DANX_SLACK_BOT_TOKEN")).toBe(true);
  });

  it("dry-run path skips the diff read AND emits dry-run lines for all puts (unchanged behavior)", async () => {
    setDryRun(true);
    let readerCalled = false;
    let runnerCalled = false;
    const ssmReader = async (): Promise<Map<string, string>> => {
      readerCalled = true;
      return new Map();
    };
    const runner = async (): Promise<void> => {
      runnerCalled = true;
    };
    await pushSecrets(cfg, CWD2, "test-target", {
      ssmReader,
      runner,
      dispatchToken: "tok",
    });
    // In dry-run, we never hit SSM (no auth available, no real param write):
    expect(readerCalled).toBe(false);
    // The runner is still called so dry-run logs print every put — the
    // runner itself short-circuits on dryRunEnabled.
    expect(runnerCalled).toBe(true);
  });
});
