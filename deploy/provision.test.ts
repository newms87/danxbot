import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  backendConfigFlags,
  writeTfVars,
  getTerraformOutputs,
  saveGeneratedSshKey,
  terraformApply,
  DRY_RUN_TERRAFORM_OUTPUTS,
} from "./provision.js";
import { setDryRun } from "./exec.js";
import { makeConfig } from "./test-helpers.js";

describe("provision backend flags", () => {
  it("emits bucket/key/region/lock/encrypt flags", () => {
    const flags = backendConfigFlags(
      makeConfig({ name: "danxbot-production", region: "us-east-1" }),
    );
    expect(flags).toContain(
      "-backend-config=bucket=danxbot-production-terraform-state",
    );
    expect(flags).toContain("-backend-config=key=danxbot/terraform.tfstate");
    expect(flags).toContain("-backend-config=region=us-east-1");
    expect(flags).toContain(
      "-backend-config=dynamodb_table=danxbot-production-terraform-locks",
    );
    expect(flags).toContain("-backend-config=encrypt=true");
  });

  it("includes profile flag (profile is always required)", () => {
    const flags = backendConfigFlags(makeConfig({ aws: { profile: "gpt" } }));
    expect(flags).toContain("-backend-config=profile=gpt");
  });

  it("propagates a non-default region", () => {
    const flags = backendConfigFlags(makeConfig({ region: "eu-west-1" }));
    expect(flags).toContain("-backend-config=region=eu-west-1");
  });

  it("throws when aws.profile is empty (defense-in-depth beyond config loader)", () => {
    expect(() => backendConfigFlags(makeConfig({ aws: { profile: "" } }))).toThrow(
      "aws.profile is required",
    );
  });
});

describe("writeTfVars", () => {
  it("maps every DeployConfig field to a Terraform variable in terraform.tfvars.json", () => {
    const config = makeConfig({
      name: "test-bot",
      region: "eu-west-1",
      domain: "bot.example.com",
      hostedZone: "example.com",
      instance: {
        type: "t3.large",
        volumeSize: 40,
        dataVolumeSize: 150,
        sshKey: "my-key",
        sshAllowedCidrs: ["10.0.0.0/8"],
      },
      aws: { profile: "gpt" },
      ssmPrefix: "/danxbot-test",
      claudeAuthDir: "/tmp/auth",
      repos: [],
      dashboard: { port: 9000 },
    });

    writeTfVars(config);

    const tfVarsPath = resolve(
      new URL(".", import.meta.url).pathname,
      "terraform",
      "terraform.tfvars.json",
    );
    const written = JSON.parse(readFileSync(tfVarsPath, "utf-8")) as Record<string, unknown>;

    expect(written).toEqual({
      name: "test-bot",
      region: "eu-west-1",
      domain: "bot.example.com",
      hosted_zone: "example.com",
      instance_type: "t3.large",
      volume_size: 40,
      data_volume_size: 150,
      ssh_key_name: "my-key",
      ssh_allowed_cidrs: ["10.0.0.0/8"],
      aws_profile: "gpt",
      ssm_parameter_prefix: "/danxbot-test",
      dashboard_port: 9000,
    });
  });
});

describe("getTerraformOutputs", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("./exec.js");
  });

  it("maps every output JSON key to its typed string field", async () => {
    vi.doMock("./exec.js", () => ({
      run: () =>
        JSON.stringify({
          instance_id: { value: "i-12345" },
          public_ip: { value: "1.2.3.4" },
          domain: { value: "https://bot.example.com" },
          ecr_repository_url: { value: "123.dkr.ecr.us-east-1.amazonaws.com/bot" },
          ssh_command: { value: "ssh -i key.pem ubuntu@1.2.3.4" },
          security_group_id: { value: "sg-abc" },
          data_volume_id: { value: "vol-xyz" },
          iam_role_arn: { value: "arn:aws:iam::123:role/bot" },
        }),
      runStreaming: () => undefined,
    }));

    const { getTerraformOutputs: fn } = await import("./provision.js?t=" + Date.now());
    const outputs = fn();

    expect(outputs.instanceId).toBe("i-12345");
    expect(outputs.publicIp).toBe("1.2.3.4");
    expect(outputs.domain).toBe("https://bot.example.com");
    expect(outputs.ecrRepositoryUrl).toBe(
      "123.dkr.ecr.us-east-1.amazonaws.com/bot",
    );
    expect(outputs.sshCommand).toBe("ssh -i key.pem ubuntu@1.2.3.4");
    expect(outputs.securityGroupId).toBe("sg-abc");
    expect(outputs.dataVolumeId).toBe("vol-xyz");
    expect(outputs.iamRoleArn).toBe("arn:aws:iam::123:role/bot");
  });

  it("coerces numeric values to strings", async () => {
    vi.doMock("./exec.js", () => ({
      run: () =>
        JSON.stringify({
          instance_id: { value: 12345 },
          public_ip: { value: "1.2.3.4" },
          domain: { value: "d" },
          ecr_repository_url: { value: "u" },
          ssh_command: { value: "s" },
          security_group_id: { value: "g" },
          data_volume_id: { value: "v" },
          iam_role_arn: { value: "a" },
        }),
      runStreaming: () => undefined,
    }));

    const { getTerraformOutputs: fn } = await import("./provision.js?t=" + (Date.now() + 1));
    const outputs = fn();

    expect(typeof outputs.instanceId).toBe("string");
    expect(outputs.instanceId).toBe("12345");
  });
});

describe("saveGeneratedSshKey", () => {
  let tmpHome: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(resolve(tmpdir(), "danxbot-sshkey-"));
    savedHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns null early when the user provided a key name (no file written)", () => {
    const config = makeConfig({
      instance: {
        type: "t3.small",
        volumeSize: 30,
        dataVolumeSize: 100,
        sshKey: "my-existing-key",
        sshAllowedCidrs: ["0.0.0.0/0"],
      },
    });

    const result = saveGeneratedSshKey(config);
    expect(result).toBeNull();
  });

  it("returns null in dry-run without invoking terraform output or writing a key file", () => {
    // saveGeneratedSshKey uses execSync directly (run() trims newlines, which
    // would corrupt the key). In dry-run we'd otherwise actually call
    // terraform output -raw (real subprocess) and persist whatever it returns
    // as a real key file under $HOME — both unwanted side effects.
    setDryRun(true);
    try {
      const config = makeConfig({
        name: "dry-run-bot",
        instance: {
          type: "t3.small",
          volumeSize: 30,
          dataVolumeSize: 100,
          sshKey: "",
          sshAllowedCidrs: ["0.0.0.0/0"],
        },
      });
      expect(saveGeneratedSshKey(config)).toBeNull();
      expect(existsSync(resolve(tmpHome, ".ssh", "dry-run-bot-key.pem"))).toBe(
        false,
      );
    } finally {
      setDryRun(false);
    }
  });
});

describe("dry-run", () => {
  const TFVARS = resolve(
    new URL(".", import.meta.url).pathname,
    "terraform",
    "terraform.tfvars.json",
  );

  afterEach(() => {
    setDryRun(false);
  });

  it("writeTfVars in dry-run does not touch terraform.tfvars.json", () => {
    if (existsSync(TFVARS)) unlinkSync(TFVARS);
    setDryRun(true);
    writeTfVars(makeConfig());
    expect(existsSync(TFVARS)).toBe(false);
  });

  it("terraformApply returns synthetic outputs without invoking terraform", () => {
    setDryRun(true);
    // terraformApply would normally call writeTfVars (skipped in dry-run),
    // runStreaming("terraform apply", ...) (printed in dry-run), and then
    // getTerraformOutputs (would throw on JSON.parse("")). The early return
    // path returns DRY_RUN_TERRAFORM_OUTPUTS instead.
    const outputs = terraformApply(makeConfig());
    expect(outputs).toEqual(DRY_RUN_TERRAFORM_OUTPUTS);
    expect(outputs.publicIp).toBe("<INSTANCE_IP>");
    expect(outputs.ecrRepositoryUrl).toBe("<ECR_REPOSITORY_URL>");
  });
});
