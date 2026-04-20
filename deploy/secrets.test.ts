import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseEnvFile,
  collectDeploymentSecrets,
  buildSsmPutCommands,
  buildTargetOverrides,
  getOrCreateDispatchToken,
} from "./secrets.js";
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
    });
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
