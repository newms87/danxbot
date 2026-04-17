/**
 * Terraform wrapper — init, apply, output, destroy.
 * The deploy CLI never exposes Terraform directly to the user.
 *
 * Multi-deployment variant: aws.profile is always present in config
 * (required by config.ts). Unlike gpt-manager, there is no empty-profile
 * fallback because running a deploy without an explicit profile is a
 * wrong-account-is-expensive risk.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import type { DeployConfig } from "./config.js";
import { getBackendConfig } from "./bootstrap.js";
import { run, runStreaming } from "./exec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TERRAFORM_DIR = resolve(__dirname, "terraform");

export function backendConfigFlags(config: DeployConfig): string {
  if (!config.aws.profile) {
    throw new Error(
      "aws.profile is required for Terraform backend config — wrong-account deploys are expensive",
    );
  }
  const backend = getBackendConfig(config);
  return [
    `-backend-config=bucket=${backend.bucket}`,
    `-backend-config=key=${backend.key}`,
    `-backend-config=region=${backend.region}`,
    `-backend-config=dynamodb_table=${backend.dynamodbTable}`,
    `-backend-config=encrypt=${backend.encrypt}`,
    `-backend-config=profile=${config.aws.profile}`,
  ].join(" ");
}

/**
 * Write terraform.tfvars.json from the deploy config.
 * Bridges YAML config to Terraform variables. aws.profile is always present.
 * Exported for test-coverage of the field mapping — production callers should
 * go through terraformApply/terraformDestroy which invoke this internally.
 */
export function writeTfVars(config: DeployConfig): void {
  const vars = {
    name: config.name,
    region: config.region,
    domain: config.domain,
    hosted_zone: config.hostedZone,
    instance_type: config.instance.type,
    volume_size: config.instance.volumeSize,
    data_volume_size: config.instance.dataVolumeSize,
    ssh_key_name: config.instance.sshKey,
    ssh_allowed_cidrs: config.instance.sshAllowedCidrs,
    aws_profile: config.aws.profile,
    ssm_parameter_prefix: config.ssmPrefix,
    dashboard_port: config.dashboard.port,
  };

  const path = resolve(TERRAFORM_DIR, "terraform.tfvars.json");
  writeFileSync(path, JSON.stringify(vars, null, 2));
  console.log(`  Wrote terraform.tfvars.json`);
}

export function terraformInit(config: DeployConfig): void {
  console.log("\n── Terraform init ──");
  runStreaming(`terraform init -reconfigure ${backendConfigFlags(config)}`, {
    cwd: TERRAFORM_DIR,
  });
}

export function terraformApply(config: DeployConfig): TerraformOutputs {
  writeTfVars(config);

  console.log("\n── Terraform apply ──");
  runStreaming("terraform apply -auto-approve", { cwd: TERRAFORM_DIR });

  return getTerraformOutputs();
}

export function getTerraformOutputs(): TerraformOutputs {
  const raw = run("terraform output -json", { cwd: TERRAFORM_DIR });
  const outputs = JSON.parse(raw) as Record<string, { value: string | number }>;

  return {
    instanceId: String(outputs.instance_id.value),
    publicIp: String(outputs.public_ip.value),
    domain: String(outputs.domain.value),
    ecrRepositoryUrl: String(outputs.ecr_repository_url.value),
    sshCommand: String(outputs.ssh_command.value),
    securityGroupId: String(outputs.security_group_id.value),
    dataVolumeId: String(outputs.data_volume_id.value),
    iamRoleArn: String(outputs.iam_role_arn.value),
  };
}

export interface TerraformOutputs {
  instanceId: string;
  publicIp: string;
  domain: string;
  ecrRepositoryUrl: string;
  sshCommand: string;
  securityGroupId: string;
  dataVolumeId: string;
  iamRoleArn: string;
}

export function terraformDestroy(config: DeployConfig): void {
  writeTfVars(config);

  console.log("\n── Terraform destroy ──");
  runStreaming("terraform destroy -auto-approve", { cwd: TERRAFORM_DIR });
}

/**
 * Save the generated SSH private key to disk (only when auto-generated).
 */
export function saveGeneratedSshKey(config: DeployConfig): string | null {
  if (config.instance.sshKey) return null;

  // execSync directly — run() trims stdout which corrupts the key's trailing newline
  const raw = execSync(
    'terraform output -raw ssh_private_key 2>/dev/null || echo ""',
    {
      cwd: TERRAFORM_DIR,
      encoding: "utf-8",
    },
  ) as string;

  if (!raw.trim()) return null;

  const keyPath = resolve(
    process.env.HOME ?? "~",
    ".ssh",
    `${config.name}-key.pem`,
  );

  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, raw, { mode: 0o600 });

  console.log(`  SSH private key saved to ${keyPath}`);
  return keyPath;
}
