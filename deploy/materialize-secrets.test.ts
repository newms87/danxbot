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
