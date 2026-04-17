import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseEnvFile,
  collectDeploymentSecrets,
  buildSsmPutCommands,
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
        repos: [{ name: "app", url: "https://github.com/x/app.git" }],
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

  it("returns empty per-repo entries when files are missing", () => {
    const cwd2 = resolve(TMP, "cwd-missing");
    mkdirSync(cwd2, { recursive: true });
    const result = collectDeploymentSecrets(
      makeConfig({
        repos: [{ name: "ghost", url: "https://example.com/g.git" }],
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
      repos: [{ name: "app", url: "https://github.com/x/app.git" }],
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
      repos: [{ name: "app", url: "https://github.com/x/a.git" }],
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
