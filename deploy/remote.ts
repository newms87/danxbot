/**
 * Remote operations on the EC2 instance via SSH and SCP.
 * RemoteHost encapsulates config + IP as instance state, eliminating
 * parameter threading across all SSH/SCP operations.
 *
 * This is a PRUNED base class compared to gpt-manager's RemoteHost.
 * The methods for compose-file upload, repos-env update, and container
 * restart are deliberately omitted — Phase 5 modules (compose-infra.ts,
 * workers.ts) wrap this class with flytebot's multi-repo semantics.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { DeployConfig } from "./config.js";
import { run, runStreaming, tryRun } from "./exec.js";

/**
 * Resolve the SSH private key path from config. Exported for use outside the class.
 * Throws when HOME is unset — `path.resolve` does not expand `~`, so falling back
 * to the literal string silently produces the wrong path.
 */
export function resolveKeyPath(config: DeployConfig): string {
  if (config.instance.sshKey) return config.instance.sshKey;
  const home = process.env.HOME;
  if (!home) {
    throw new Error(
      "HOME environment variable is not set — cannot resolve generated SSH key path",
    );
  }
  return resolve(home, ".ssh", `${config.name}-key.pem`);
}

/**
 * Apply template substitutions. Keys are treated as literal strings
 * (not regexes) — the function escapes regex metacharacters internally.
 */
export function applyTemplateVars(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [pattern, replacement] of Object.entries(vars)) {
    result = result.replace(
      new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
      replacement,
    );
  }
  return result;
}

/**
 * Encapsulates SSH/SCP operations against a specific remote host.
 * Stores config and IP once — all methods use them implicitly.
 */
export class RemoteHost {
  private readonly keyPath: string;
  private readonly baseFlags: string;

  constructor(
    private readonly config: DeployConfig,
    private readonly ip: string,
  ) {
    this.keyPath = resolveKeyPath(config);
    this.baseFlags = `-i ${this.keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR`;
  }

  /** Build a shell command that SSHes into the instance and runs `command`. */
  private sshCommand(command: string): string {
    const escaped = command.replace(/'/g, "'\\''");
    return `ssh ${this.baseFlags} ubuntu@${this.ip} '${escaped}'`;
  }

  sshRun(command: string): string {
    return run(this.sshCommand(command));
  }

  sshRunStreaming(command: string): void {
    runStreaming(this.sshCommand(command));
  }

  scpUpload(localPath: string, remotePath: string): void {
    run(`scp ${this.baseFlags} ${localPath} ubuntu@${this.ip}:${remotePath}`);
  }

  /**
   * Upload Claude Code auth files to the instance.
   * Throws if auth directory or either required file is missing — a deploy
   * without full auth produces a broken instance that cannot dispatch agents.
   *
   * Canonical layout (Trello 0bjFD0a2):
   *   <claudeAuthDir>/.claude.json              ← root, file-bind
   *   <claudeAuthDir>/.claude/.credentials.json ← subdir, dir-bind
   * The remote layout under /danxbot/claude-auth/ mirrors the local
   * snapshot dir layout exactly — the mount targets in compose then
   * read the same shapes regardless of dev vs prod.
   */
  uploadClaudeAuth(): void {
    const authDir = this.config.claudeAuthDir;
    if (!existsSync(authDir)) {
      throw new Error(
        `Claude auth directory not found at ${authDir}. Deploy cannot proceed without it.`,
      );
    }

    const claudeJson = resolve(authDir, ".claude.json");
    const credentialsJson = resolve(authDir, ".claude", ".credentials.json");

    if (!existsSync(claudeJson)) {
      throw new Error(
        `Claude auth file missing: ${claudeJson}. Both .claude.json and .claude/.credentials.json are required.`,
      );
    }
    if (!existsSync(credentialsJson)) {
      throw new Error(
        `Claude auth file missing: ${credentialsJson}. Both .claude.json and .claude/.credentials.json are required.`,
      );
    }

    console.log("\n── Uploading Claude Code auth ──");

    this.scpUpload(claudeJson, "/tmp/.claude.json");
    this.sshRun(
      "sudo mv /tmp/.claude.json /danxbot/claude-auth/.claude.json && sudo chown ubuntu:ubuntu /danxbot/claude-auth/.claude.json",
    );
    console.log("  Uploaded .claude.json");

    this.scpUpload(credentialsJson, "/tmp/.credentials.json");
    // mkdir + chown the .claude/ subdir under /danxbot/claude-auth/
    // before mv — first deploy after the layout migration finds an empty
    // or absent subdir; subsequent deploys are idempotent.
    this.sshRun(
      "sudo mkdir -p /danxbot/claude-auth/.claude && sudo chown ubuntu:ubuntu /danxbot/claude-auth/.claude && sudo mv /tmp/.credentials.json /danxbot/claude-auth/.claude/.credentials.json && sudo chown ubuntu:ubuntu /danxbot/claude-auth/.claude/.credentials.json",
    );
    console.log("  Uploaded .claude/.credentials.json");
  }

  openSshSession(): void {
    runStreaming(`ssh ${this.baseFlags} ubuntu@${this.ip}`);
  }

  tailLogs(): void {
    this.sshRunStreaming(
      "cd /danxbot && docker compose -f docker-compose.prod.yml logs -f --tail=100",
    );
  }

  async waitForSsh(
    maxAttempts: number = 40,
    intervalMs: number = 5000,
  ): Promise<void> {
    const probeCmd = `ssh ${this.baseFlags} -o ConnectTimeout=5 ubuntu@${this.ip} echo ok`;

    for (let attempt = 1; attempt < maxAttempts; attempt++) {
      const result = tryRun(probeCmd);
      if (result === "ok") {
        console.log(`  SSH ready (attempt ${attempt}/${maxAttempts})`);
        return;
      }
      console.log(`  Waiting for SSH... (attempt ${attempt}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    // Final attempt: surface the real SSH error (key perms, auth, routing)
    // instead of swallowing it with a generic "failed after N attempts" message.
    try {
      if (run(probeCmd) === "ok") {
        console.log(`  SSH ready (attempt ${maxAttempts}/${maxAttempts})`);
        return;
      }
      throw new Error(`SSH probe returned unexpected output`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `SSH connection to ${this.ip} failed after ${maxAttempts} attempts: ${detail}`,
      );
    }
  }
}
