/**
 * S3 backend bootstrapping for Terraform state.
 * Creates the S3 bucket and DynamoDB lock table if they don't exist.
 * This runs before `terraform init` to solve the chicken-and-egg problem.
 *
 * Multi-deployment isolation: each deployment's bucket and lock table are named
 * <config.name>-terraform-state and <config.name>-terraform-locks. Two deployments
 * with different names never share state.
 */

import type { DeployConfig } from "./config.js";
import { awsCmd, run, tryRun } from "./exec.js";

export function getBackendConfig(config: DeployConfig) {
  return {
    bucket: `${config.name}-terraform-state`,
    key: "danxbot/terraform.tfstate",
    region: config.region,
    dynamodbTable: `${config.name}-terraform-locks`,
    encrypt: true,
  };
}

/**
 * Ensure the S3 bucket and DynamoDB table exist for Terraform state.
 * Idempotent — safe to call on every deploy.
 */
export function bootstrapBackend(config: DeployConfig): void {
  const backend = getBackendConfig(config);
  const profile = config.aws.profile;

  console.log("\n── Bootstrapping Terraform backend ──");

  const bucketExists = tryRun(
    awsCmd(
      profile,
      `s3api head-bucket --bucket ${backend.bucket} --region ${backend.region}`,
    ),
  );

  if (bucketExists === null) {
    console.log(`  Creating S3 bucket: ${backend.bucket}`);

    // us-east-1 doesn't accept LocationConstraint
    const locationConstraint =
      backend.region === "us-east-1"
        ? ""
        : `--create-bucket-configuration LocationConstraint=${backend.region}`;

    run(
      awsCmd(
        profile,
        `s3api create-bucket --bucket ${backend.bucket} --region ${backend.region} ${locationConstraint}`,
      ),
    );

    run(
      awsCmd(
        profile,
        `s3api put-bucket-versioning --bucket ${backend.bucket} --versioning-configuration Status=Enabled`,
      ),
    );

    run(
      awsCmd(
        profile,
        `s3api put-public-access-block --bucket ${backend.bucket} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`,
      ),
    );

    console.log("  S3 bucket created and configured.");
  } else {
    console.log(`  S3 bucket already exists: ${backend.bucket}`);
  }

  const tableExists = tryRun(
    awsCmd(
      profile,
      `dynamodb describe-table --table-name ${backend.dynamodbTable} --region ${backend.region} --query "Table.TableStatus" --output text`,
    ),
  );

  if (tableExists === null) {
    console.log(`  Creating DynamoDB lock table: ${backend.dynamodbTable}`);

    run(
      awsCmd(
        profile,
        `dynamodb create-table --table-name ${backend.dynamodbTable} --region ${backend.region} --attribute-definitions AttributeName=LockID,AttributeType=S --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST`,
      ),
    );

    run(
      awsCmd(
        profile,
        `dynamodb wait table-exists --table-name ${backend.dynamodbTable} --region ${backend.region}`,
      ),
    );

    console.log("  DynamoDB lock table created.");
  } else {
    console.log(
      `  DynamoDB lock table already exists: ${backend.dynamodbTable}`,
    );
  }
}
