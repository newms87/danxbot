/**
 * Shared test helpers for deploy tests.
 * Provides a factory for DeployConfig with sensible defaults matching
 * the new multi-deployment minimums (t3.small, 100 GB data volume,
 * required aws.profile, ssm_prefix /danxbot-<target>).
 */

import type { DeployConfig } from "./config.js";

export function makeConfig(
  overrides: Partial<DeployConfig> = {},
): DeployConfig {
  return {
    name: "test-bot",
    mode: "deploy",
    region: "us-west-2",
    domain: "bot.example.com",
    hostedZone: "example.com",
    instance: {
      type: "t3.small",
      volumeSize: 30,
      dataVolumeSize: 100,
      sshKey: "",
      sshAllowedCidrs: ["0.0.0.0/0"],
    },
    aws: { profile: "test-profile" },
    ssmPrefix: "/danxbot-test-bot",
    claudeAuthDir: "/tmp/claude-auth",
    repos: [],
    dashboard: { port: 5555 },
    ...overrides,
  };
}
