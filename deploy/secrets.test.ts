import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  parseEnvFile,
  collectDeploymentSecrets,
  buildSsmPutCommands,
  buildTargetOverrides,
  getOrCreateDispatchToken,
  buildPushSecretsCommands,
} from "./secrets.js";
import { setDryRun } from "./exec.js";
import { DRY_RUN_DISPATCH_TOKEN } from "./dry-run-placeholders.js";
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
        repos: [{ name: "app", url: "https://github.com/x/app.git", workerPort: 5561 }],
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
          },
          { name: "simple", url: "https://github.com/x/s.git", workerPort: 5564 },
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
        repos: [{ name: "ghost", url: "https://example.com/g.git", workerPort: 5599 }],
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
          { name: "platform", url: "https://github.com/x/p.git", workerPort: 5561 },
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
          { name: "platform", url: "https://github.com/x/p.git", workerPort: 5561 },
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
          { name: "platform", url: "https://github.com/x/p.git", workerPort: 5561 },
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
      repos: [{ name: "app", url: "https://github.com/x/app.git", workerPort: 5561 }],
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
      repos: [{ name: "app", url: "https://github.com/x/a.git", workerPort: 5561 }],
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
      repos: [{ name: "app", url: "https://github.com/x/a.git", workerPort: 5561 }],
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
  it("synthesizes REPOS from deploy config (not local .env)", () => {
    const cfg = makeConfig({
      repos: [
        { name: "danxbot", url: "https://github.com/x/d.git", workerPort: 5561 },
        { name: "gpt-manager", url: "https://github.com/x/g.git", workerPort: 5562 },
      ],
    });
    expect(buildTargetOverrides(cfg).REPOS).toBe(
      "danxbot:https://github.com/x/d.git,gpt-manager:https://github.com/x/g.git",
    );
  });

  it("synthesizes REPO_WORKER_PORTS matching each repo", () => {
    const cfg = makeConfig({
      repos: [
        { name: "platform", url: "https://github.com/x/p.git", workerPort: 5561 },
        { name: "gpt-manager", url: "https://github.com/x/g.git", workerPort: 5562 },
      ],
    });
    expect(buildTargetOverrides(cfg).REPO_WORKER_PORTS).toBe(
      "platform:5561,gpt-manager:5562",
    );
  });

  it("returns empty strings when the deployment has no repos", () => {
    const cfg = makeConfig({ repos: [] });
    expect(buildTargetOverrides(cfg)).toEqual({
      REPOS: "",
      REPO_WORKER_PORTS: "",
      REPO_WORKER_HOSTS: "",
    });
  });

  it("synthesizes REPO_WORKER_HOSTS only for repos that declare worker_host", () => {
    // Per-repo worker_host overrides the default `danxbot-worker-<name>`
    // hostname for repos whose compose file renames the container. Only
    // repos that explicitly declare it appear in the env var; the rest
    // fall back to the default in src/config.ts at parse time.
    const cfg = makeConfig({
      repos: [
        {
          name: "custom",
          url: "https://github.com/x/c.git",
          workerPort: 5561,
          workerHost: "container-alias",
        },
        { name: "defaulted", url: "https://github.com/x/d.git", workerPort: 5562 },
      ],
    });
    expect(buildTargetOverrides(cfg).REPO_WORKER_HOSTS).toBe(
      "custom:container-alias",
    );
  });

  it("REPO_WORKER_HOSTS preserves config.repos order with multiple overrides", () => {
    // Order matters because the same comma-separated form is the round-trip
    // key/value layout the dashboard parses back. A reordering bug would
    // not break parsing but would shuffle which name owns which host.
    const cfg = makeConfig({
      repos: [
        {
          name: "alpha",
          url: "https://github.com/x/a.git",
          workerPort: 5561,
          workerHost: "alpha-host",
        },
        {
          name: "beta",
          url: "https://github.com/x/b.git",
          workerPort: 5562,
          workerHost: "beta-host",
        },
      ],
    });
    expect(buildTargetOverrides(cfg).REPO_WORKER_HOSTS).toBe(
      "alpha:alpha-host,beta:beta-host",
    );
  });

  it("emits an empty REPO_WORKER_HOSTS when no repo declares worker_host", () => {
    // Empty SSM values are skipped by buildSsmPutCommands, so nothing lands
    // in production — but the override map ALWAYS carries the key so it
    // overwrites any operator-local REPO_WORKER_HOSTS leaking via .env.
    const cfg = makeConfig({
      repos: [
        { name: "a", url: "https://github.com/x/a.git", workerPort: 5561 },
        { name: "b", url: "https://github.com/x/b.git", workerPort: 5562 },
      ],
    });
    expect(buildTargetOverrides(cfg).REPO_WORKER_HOSTS).toBe("");
  });

  it("emits SSM put commands for the override values when merged into shared", () => {
    const cfg = makeConfig({
      ssmPrefix: "/danxbot-gpt",
      aws: { profile: "gpt" },
      repos: [
        { name: "danxbot", url: "https://github.com/x/d.git", workerPort: 5561 },
      ],
    });
    const overrides = buildTargetOverrides(cfg);
    const cmds = buildSsmPutCommands(cfg, {
      shared: { ...overrides, DANXBOT_DISPATCH_TOKEN: "tok" },
      perRepo: {},
    });
    const joined = cmds.join("\n");
    expect(joined).toContain("/danxbot-gpt/shared/REPOS");
    expect(joined).toContain(
      "--value 'danxbot:https://github.com/x/d.git'",
    );
    expect(joined).toContain("/danxbot-gpt/shared/REPO_WORKER_PORTS");
    expect(joined).toContain("--value 'danxbot:5561'");
    expect(joined).toContain("/danxbot-gpt/shared/DANXBOT_DISPATCH_TOKEN");
  });

  it("pushes REPO_WORKER_HOSTS to SSM when at least one repo declares worker_host", () => {
    const cfg = makeConfig({
      ssmPrefix: "/danxbot-gpt",
      aws: { profile: "gpt" },
      repos: [
        {
          name: "danxbot",
          url: "https://github.com/x/d.git",
          workerPort: 5561,
          workerHost: "renamed-container",
        },
      ],
    });
    const overrides = buildTargetOverrides(cfg);
    const cmds = buildSsmPutCommands(cfg, {
      shared: { ...overrides, DANXBOT_DISPATCH_TOKEN: "tok" },
      perRepo: {},
    });
    const joined = cmds.join("\n");
    expect(joined).toContain("/danxbot-gpt/shared/REPO_WORKER_HOSTS");
    expect(joined).toContain("--value 'danxbot:renamed-container'");
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
  // operator-local REPOS / REPO_WORKER_PORTS must NOT leak into a target
  // that should only see its own repos. These tests verify the merge
  // without exercising `runStreaming` or SSM.
  const cfg = makeConfig({
    ssmPrefix: "/danxbot-test",
    aws: { profile: "p" },
    repos: [
      { name: "danxbot", url: "https://github.com/x/d.git", workerPort: 5561 },
    ],
  });

  it("target overrides win over conflicting keys in collected.shared", () => {
    // Operator's local .env has REPOS=foo:url,bar:url (every repo they
    // touch). Deploying the gpt target must push gpt's repo list, not the
    // operator's union. buildTargetOverrides supplies the gpt-only value
    // and it must overwrite the local one.
    const collected = {
      shared: { REPOS: "operator-local-junk", ANTHROPIC_API_KEY: "sk-x" },
      perRepo: {},
    };
    const overrides = { REPOS: "danxbot:https://github.com/x/d.git" };
    const cmds = buildPushSecretsCommands(cfg, collected, overrides, "tok");
    const reposCmd = cmds.find((c) =>
      c.includes(`--name "/danxbot-test/shared/REPOS"`),
    );
    expect(reposCmd).toBeDefined();
    expect(reposCmd).toContain("--value 'danxbot:https://github.com/x/d.git'");
    expect(reposCmd).not.toContain("operator-local-junk");
  });

  it("target overrides win over conflicting REPO_WORKER_HOSTS in collected.shared", () => {
    // Same precedence guard as the REPOS test above — an operator's local
    // REPO_WORKER_HOSTS (e.g. dev container aliases for a repo not in this
    // deployment) must NEVER leak into the target's SSM. The override key
    // is always present in buildTargetOverrides, even when empty, so it
    // overwrites the local value unconditionally.
    const collected = {
      shared: {
        REPO_WORKER_HOSTS: "operator-junk:bad-host",
        ANTHROPIC_API_KEY: "sk-x",
      },
      perRepo: {},
    };
    const overrides = { REPO_WORKER_HOSTS: "danxbot:correct-host" };
    const cmds = buildPushSecretsCommands(cfg, collected, overrides, "tok");
    const hostsCmd = cmds.find((c) =>
      c.includes(`--name "/danxbot-test/shared/REPO_WORKER_HOSTS"`),
    );
    expect(hostsCmd).toBeDefined();
    expect(hostsCmd).toContain("--value 'danxbot:correct-host'");
    expect(hostsCmd).not.toContain("operator-junk");
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
    buildPushSecretsCommands(cfg, collected, { REPOS: "x" }, "tok");
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
      REPOS: "danxbot:url",
      REPO_WORKER_PORTS: "danxbot:5561",
    };
    const cmds = buildPushSecretsCommands(cfg, collected, overrides, "tok");
    const paths = new Set(
      cmds.map((c) => c.match(/--name "([^"]+)"/)?.[1]).filter(Boolean),
    );
    expect(paths).toEqual(
      new Set([
        "/danxbot-test/shared/ANTHROPIC_API_KEY",
        "/danxbot-test/shared/REPOS",
        "/danxbot-test/shared/REPO_WORKER_PORTS",
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

describe("getOrCreateDispatchToken dry-run", () => {
  afterEach(() => {
    setDryRun(false);
  });

  it("returns the placeholder unconditionally in dry-run (defense-in-depth — never invokes the SSM exec)", () => {
    // The dry-run guard inside getOrCreateDispatchToken protects future
    // callers (rotate-token, etc.) from leaking a real token via the
    // generation banner. The exec callback being NOT invoked is the
    // load-bearing assertion: any code that wires getOrCreateDispatchToken
    // to a real SSM put MUST stay behind the dry-run gate.
    setDryRun(true);
    let invoked = false;
    const exec = (_cmd: string): string => {
      invoked = true;
      return "real-token-leaked";
    };
    expect(getOrCreateDispatchToken(makeConfig(), exec)).toBe(
      DRY_RUN_DISPATCH_TOKEN,
    );
    expect(invoked).toBe(false);
  });
});

describe("pushSecrets dry-run", () => {
  // Validates the dry-run integration end-to-end: in dry-run, the SSM
  // put-parameter command for DANXBOT_DISPATCH_TOKEN must carry the
  // placeholder value (never a real token), and the runStreaming wrapper
  // must short-circuit on each command (no real SSM put). Without these
  // guards a future refactor that re-wires the token resolution could
  // silently push a fresh real token to SSM every time a dry-run is
  // requested — defeating the entire feature.
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("./exec.js");
  });

  it("renders DANXBOT_DISPATCH_TOKEN with the placeholder when isDryRun() is true", async () => {
    const streamCalls: string[] = [];
    vi.doMock("./exec.js", () => ({
      awsCmd: (profile: string, cmd: string) =>
        `aws --profile ${profile} ${cmd}`.replace(/\s+/g, " ").trim(),
      isDryRun: () => true,
      runStreaming: (cmd: string) => {
        streamCalls.push(cmd);
      },
    }));
    const mod = await import("./secrets.js?t=" + Date.now());

    const cwd = mkdtempSync(resolve(tmpdir(), "danxbot-pushsecrets-dryrun-"));
    try {
      // Provide a non-empty .env so at least one shared put-parameter command
      // is built — otherwise the test would pass trivially with zero output.
      writeFileSync(resolve(cwd, ".env"), "ANTHROPIC_API_KEY=sk-fake\n");

      mod.pushSecrets(
        makeConfig({
          ssmPrefix: "/danxbot-test",
          aws: { profile: "test-profile" },
        }),
        cwd,
      );

      const tokenCmd = streamCalls.find((c) =>
        c.includes("DANXBOT_DISPATCH_TOKEN"),
      );
      expect(tokenCmd).toBeDefined();
      expect(tokenCmd).toContain(`--value '${DRY_RUN_DISPATCH_TOKEN}'`);
      expect(tokenCmd).toContain(
        "/danxbot-test/shared/DANXBOT_DISPATCH_TOKEN",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
