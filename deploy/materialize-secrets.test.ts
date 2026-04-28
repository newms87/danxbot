import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORK = resolve("/tmp/danxbot-materialize-test");
const SCRIPT = resolve(__dirname, "templates/materialize-secrets.sh");

/**
 * Build a fake `aws` that responds to `aws ssm get-parameters-by-path --path <p>`
 * with the tab-separated Name/Value rows keyed by the path.
 */
function fakeAwsDir(
  paths: Record<string, Array<{ Name: string; Value: string }>>,
): string {
  const bin = resolve(WORK, "bin");
  mkdirSync(bin, { recursive: true });
  const payloadPath = resolve(WORK, "paths.json");
  writeFileSync(payloadPath, JSON.stringify(paths));

  // Use node (available on PATH) to look up the path in the JSON payload.
  const fakeAws = resolve(bin, "aws");
  writeFileSync(
    fakeAws,
    `#!/bin/bash
set -e
path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) path="$2"; shift 2 ;;
    *) shift ;;
  esac
done
node -e '
  const paths = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"));
  const entries = paths[process.argv[2]] || [];
  for (const e of entries) console.log(e.Name + "\\t" + e.Value);
' ${payloadPath} "$path"
`,
  );
  execSync(`chmod +x ${fakeAws}`);
  return bin;
}

describe("materialize-secrets.sh", () => {
  beforeEach(() => {
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    mkdirSync(resolve(WORK, "danxbot/repos/app/.danxbot"), { recursive: true });
  });

  afterEach(() => {
    rmSync(WORK, { recursive: true, force: true });
  });

  it("writes shared keys to $ROOT/.env and per-repo keys to the right files", () => {
    const bin = fakeAwsDir({
      "/danxbot-test/shared/": [
        { Name: "/danxbot-test/shared/ANTHROPIC_API_KEY", Value: "sk-xxx" },
        { Name: "/danxbot-test/shared/DANXBOT_GIT_EMAIL", Value: "bot@x.io" },
      ],
      "/danxbot-test/repos/app/": [
        { Name: "/danxbot-test/repos/app/DANX_SLACK_BOT_TOKEN", Value: "xoxb" },
        { Name: "/danxbot-test/repos/app/REPO_ENV_APP_KEY", Value: "base64:z" },
        { Name: "/danxbot-test/repos/app/REPO_ENV_DB_PASSWORD", Value: "sec" },
      ],
    });

    execSync(`bash ${SCRIPT} /danxbot-test us-east-1 app`, {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DANXBOT_ROOT: resolve(WORK, "danxbot"),
      },
    });

    const sharedEnv = readFileSync(resolve(WORK, "danxbot/.env"), "utf-8");
    expect(sharedEnv).toContain("ANTHROPIC_API_KEY=sk-xxx");
    expect(sharedEnv).toContain("DANXBOT_GIT_EMAIL=bot@x.io");

    const danxbotRepoEnv = readFileSync(
      resolve(WORK, "danxbot/repos/app/.danxbot/.env"),
      "utf-8",
    );
    expect(danxbotRepoEnv).toContain("DANX_SLACK_BOT_TOKEN=xoxb");
    expect(danxbotRepoEnv).not.toContain("APP_KEY");

    const appEnv = readFileSync(
      resolve(WORK, "danxbot/repos/app/.env"),
      "utf-8",
    );
    expect(appEnv).toContain("APP_KEY=base64:z");
    expect(appEnv).toContain("DB_PASSWORD=sec");
    expect(appEnv).not.toContain("DANX_SLACK_BOT_TOKEN");
  });

  it("truncates existing .env files before writing (no stale keys)", () => {
    const root = resolve(WORK, "danxbot");
    mkdirSync(root, { recursive: true });
    writeFileSync(resolve(root, ".env"), "OLD_KEY=stale\n");

    const bin = fakeAwsDir({
      "/danxbot-test/shared/": [
        { Name: "/danxbot-test/shared/NEW_KEY", Value: "fresh" },
      ],
    });

    execSync(`bash ${SCRIPT} /danxbot-test us-east-1`, {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DANXBOT_ROOT: root,
      },
    });

    const contents = readFileSync(resolve(root, ".env"), "utf-8");
    expect(contents).not.toContain("OLD_KEY");
    expect(contents).toContain("NEW_KEY=fresh");
  });

  it("writes app env to <repo>/<subpath>/.env when repo arg has :subpath form", () => {
    // platform-style layout: Sail expects the app .env at ssap/.env.
    // Danxbot-side .env is unchanged (.danxbot/.env) — only the app env moves.
    mkdirSync(resolve(WORK, "danxbot/repos/platform/.danxbot"), {
      recursive: true,
    });
    mkdirSync(resolve(WORK, "danxbot/repos/platform/ssap"), { recursive: true });

    const bin = fakeAwsDir({
      "/danxbot-test/shared/": [],
      "/danxbot-test/repos/platform/": [
        { Name: "/danxbot-test/repos/platform/DANX_TRELLO_API_KEY", Value: "tr" },
        { Name: "/danxbot-test/repos/platform/REPO_ENV_APP_KEY", Value: "base64:p" },
        { Name: "/danxbot-test/repos/platform/REPO_ENV_DB_PASSWORD", Value: "sec" },
      ],
    });

    execSync(`bash ${SCRIPT} /danxbot-test us-east-1 platform:ssap`, {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DANXBOT_ROOT: resolve(WORK, "danxbot"),
      },
    });

    // Danxbot agent env stays at .danxbot/.env (subpath must NOT affect it).
    const danxbotEnv = readFileSync(
      resolve(WORK, "danxbot/repos/platform/.danxbot/.env"),
      "utf-8",
    );
    expect(danxbotEnv).toContain("DANX_TRELLO_API_KEY=tr");

    // App env lives under the subpath.
    const appEnv = readFileSync(
      resolve(WORK, "danxbot/repos/platform/ssap/.env"),
      "utf-8",
    );
    expect(appEnv).toContain("APP_KEY=base64:p");
    expect(appEnv).toContain("DB_PASSWORD=sec");

    // Nothing written at the repo root (would confuse Sail).
    expect(() =>
      readFileSync(resolve(WORK, "danxbot/repos/platform/.env"), "utf-8"),
    ).toThrow();
  });

  it("creates the subpath directory if missing on disk (fresh EC2)", () => {
    // On a fresh deploy the app directory may not exist yet. The script
    // must `mkdir -p` the subpath so the .env write doesn't fail.
    // Intentionally do NOT mkdir repos/platform/ssap here.
    mkdirSync(resolve(WORK, "danxbot/repos/platform/.danxbot"), {
      recursive: true,
    });

    const bin = fakeAwsDir({
      "/danxbot-test/shared/": [],
      "/danxbot-test/repos/platform/": [
        { Name: "/danxbot-test/repos/platform/REPO_ENV_APP_KEY", Value: "k" },
      ],
    });

    execSync(`bash ${SCRIPT} /danxbot-test us-east-1 platform:ssap`, {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DANXBOT_ROOT: resolve(WORK, "danxbot"),
      },
    });

    expect(
      readFileSync(
        resolve(WORK, "danxbot/repos/platform/ssap/.env"),
        "utf-8",
      ),
    ).toContain("APP_KEY=k");
  });

  it("handles mixed specs — bare repo and :subpath repo in one invocation", () => {
    mkdirSync(resolve(WORK, "danxbot/repos/a/.danxbot"), { recursive: true });
    mkdirSync(resolve(WORK, "danxbot/repos/b/.danxbot"), { recursive: true });

    const bin = fakeAwsDir({
      "/danxbot-test/shared/": [],
      "/danxbot-test/repos/a/": [
        { Name: "/danxbot-test/repos/a/REPO_ENV_K", Value: "from-a" },
      ],
      "/danxbot-test/repos/b/": [
        { Name: "/danxbot-test/repos/b/REPO_ENV_K", Value: "from-b" },
      ],
    });

    execSync(`bash ${SCRIPT} /danxbot-test us-east-1 a b:inner`, {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DANXBOT_ROOT: resolve(WORK, "danxbot"),
      },
    });

    // Bare repo arg: app env at repo root.
    expect(
      readFileSync(resolve(WORK, "danxbot/repos/a/.env"), "utf-8"),
    ).toContain("K=from-a");
    // :subpath repo arg: app env under subpath.
    expect(
      readFileSync(resolve(WORK, "danxbot/repos/b/inner/.env"), "utf-8"),
    ).toContain("K=from-b");
    // No stray app env at repo root for the subpath case.
    expect(() =>
      readFileSync(resolve(WORK, "danxbot/repos/b/.env"), "utf-8"),
    ).toThrow();
  });

  it("rejects absolute subpath and exits non-zero (defense-in-depth)", () => {
    mkdirSync(resolve(WORK, "danxbot/repos/bad/.danxbot"), { recursive: true });
    const bin = fakeAwsDir({ "/danxbot-test/shared/": [] });

    expect(() => {
      execSync(`bash ${SCRIPT} /danxbot-test us-east-1 bad:/etc`, {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DANXBOT_ROOT: resolve(WORK, "danxbot"),
        },
        stdio: "pipe",
      });
    }).toThrow(/absolute/i);
  });

  it("rejects traversing subpath and exits non-zero (defense-in-depth)", () => {
    mkdirSync(resolve(WORK, "danxbot/repos/bad/.danxbot"), { recursive: true });
    const bin = fakeAwsDir({ "/danxbot-test/shared/": [] });

    expect(() => {
      execSync(`bash ${SCRIPT} /danxbot-test us-east-1 bad:ssap/../escape`, {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DANXBOT_ROOT: resolve(WORK, "danxbot"),
        },
        stdio: "pipe",
      });
    }).toThrow(/\.\./);
  });

  it("accepts a subpath with '..' as a substring but not a path segment (foo..bar)", () => {
    // Segment-level guard, not substring. Directory names like "v8.3..sail"
    // must not be rejected.
    mkdirSync(resolve(WORK, "danxbot/repos/r/.danxbot"), { recursive: true });
    const bin = fakeAwsDir({
      "/danxbot-test/shared/": [],
      "/danxbot-test/repos/r/": [
        { Name: "/danxbot-test/repos/r/REPO_ENV_K", Value: "v" },
      ],
    });

    execSync(`bash ${SCRIPT} /danxbot-test us-east-1 r:foo..bar`, {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DANXBOT_ROOT: resolve(WORK, "danxbot"),
      },
    });

    expect(
      readFileSync(resolve(WORK, "danxbot/repos/r/foo..bar/.env"), "utf-8"),
    ).toContain("K=v");
  });

  it("preserves tab characters embedded in values (awk reassembles fields with \\t separators)", () => {
    // The fake-aws emits Name\tValue per line; if Value itself contains a
    // tab, the awk script sees NF >= 3 and reassembles columns 2..NF with
    // a tab between them. A regression that just took $2 would silently
    // truncate at the first embedded tab. Real cause: a multi-line PEM
    // formatted with tabs would lose every byte after the first tab.
    const root = resolve(WORK, "danxbot");
    mkdirSync(root, { recursive: true });

    const bin = fakeAwsDir({
      "/danxbot-test/shared/": [
        // Embedded tab inside the value — verifies awk reassembly.
        { Name: "/danxbot-test/shared/TAB_VALUE", Value: "before\tafter" },
        // Plain alphanumeric value to confirm normal path still works.
        { Name: "/danxbot-test/shared/PLAIN", Value: "ok" },
      ],
    });

    execSync(`bash ${SCRIPT} /danxbot-test us-east-1`, {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DANXBOT_ROOT: root,
      },
    });

    const env = readFileSync(resolve(root, ".env"), "utf-8");
    // The awk emit function quotes values that contain whitespace (tab is
    // matched by the [ \t#$"\\] character class), so the line is double-
    // quoted and the literal tab is inside the quotes.
    expect(env).toContain('TAB_VALUE="before\tafter"');
    expect(env).toContain("PLAIN=ok");
  });

  it("handles multiple repos", () => {
    mkdirSync(resolve(WORK, "danxbot/repos/a/.danxbot"), { recursive: true });
    mkdirSync(resolve(WORK, "danxbot/repos/b/.danxbot"), { recursive: true });
    const bin = fakeAwsDir({
      "/danxbot-test/shared/": [],
      "/danxbot-test/repos/a/": [
        { Name: "/danxbot-test/repos/a/K1", Value: "v1" },
      ],
      "/danxbot-test/repos/b/": [
        { Name: "/danxbot-test/repos/b/K2", Value: "v2" },
      ],
    });

    execSync(`bash ${SCRIPT} /danxbot-test us-east-1 a b`, {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DANXBOT_ROOT: resolve(WORK, "danxbot"),
      },
    });

    expect(
      readFileSync(resolve(WORK, "danxbot/repos/a/.danxbot/.env"), "utf-8"),
    ).toContain("K1=v1");
    expect(
      readFileSync(resolve(WORK, "danxbot/repos/b/.danxbot/.env"), "utf-8"),
    ).toContain("K2=v2");
  });
});
