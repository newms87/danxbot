import { existsSync } from "node:fs";
import type { RepoConfig } from "./types.js";
import { required, optional } from "./env.js";
import { loadTarget } from "./target.js";

/**
 * Resolve the connected-repo list from `deploy/targets/<DANXBOT_TARGET>.yml`
 * (defaulting to `local` when DANXBOT_TARGET is unset).
 *
 * Pre-Phase-B this came from two parallel CSV env vars in the local `.env`
 * (REPOS + REPO_WORKER_PORTS, plus optional REPO_WORKER_HOSTS) and from
 * SSM-materialized copies of the same vars in production. Both surfaces
 * routinely desynced from the per-repo authoritative DANXBOT_WORKER_PORT
 * in `<repo>/.danxbot/.env`. The deploy YML is now the single source of
 * truth for both local and prod — the parallel env vars are gone.
 *
 * Loaded at module-import time (alongside `config` below). A missing or
 * malformed target YML throws loudly here rather than at first access —
 * if the dashboard or a worker can't locate its target there is no
 * meaningful work it can do, so failing import is the right semantics.
 */
const _activeTarget = loadTarget();
export const repos: RepoConfig[] = _activeTarget.repos;
/**
 * Active deployment target name as declared in
 * `deploy/targets/<DANXBOT_TARGET>.yml` (e.g. `danxbot-production`,
 * `local`). Used as the `holder` identifier in the cross-environment
 * dispatch lock (`src/issue-tracker/lock.ts`) so two pollers on
 * different deployments don't double-claim the same tracker card.
 */
export const targetName: string = _activeTarget.name;

/**
 * Worker mode: DANXBOT_REPO_NAME is set — this process manages one repo only
 * (poller, Slack listener, dispatch API). Dashboard is not started.
 *
 * Dashboard mode: DANXBOT_REPO_NAME is not set — this process runs the shared
 * dashboard, migrations, and cleanup. No poller or Slack.
 */
export const workerRepoName = optional("DANXBOT_REPO_NAME", "");
export const isWorkerMode = !!workerRepoName;
export const isDashboardMode = !isWorkerMode;

export function getRepoPath(name: string): string {
  const repo = repos.find((r) => r.name === name);
  if (!repo) {
    throw new Error(
      `Repo "${name}" is not configured in the active target (deploy/targets/<DANXBOT_TARGET>.yml)`,
    );
  }
  return repo.localPath;
}

// Runtime is detected from the filesystem, never from an env var. A process
// running inside a Docker container has /.dockerenv; a host process does not.
// Conflating "how was I launched" with a config flag caused a long-standing
// bug where host-mode launches still used docker paths/hostnames.
const isHost = !existsSync("/.dockerenv");
const runtimeValue: "docker" | "host" = isHost ? "host" : "docker";

/**
 * Shared infrastructure config — NOT per-repo.
 * Per-repo config (trello, slack, db) lives in RepoContext.
 */
export const config = {
  runtime: runtimeValue,
  isHost,
  anthropic: {
    apiKey: optional("ANTHROPIC_API_KEY", ""),
  },
  db: {
    host: isHost ? "127.0.0.1" : "mysql",
    port: isHost ? parseInt(optional("DANXBOT_DB_PORT", "3308"), 10) : 3306,
    user: required("DANXBOT_DB_USER"),
    password: required("DANXBOT_DB_PASSWORD"),
    database: optional("DANXBOT_DB_NAME", "danxbot_chat"),
    connectTimeoutMs: parseInt(optional("DB_CONNECT_TIMEOUT_MS", "5000"), 10),
  },
  agent: {
    model: optional("CLAUDE_MODEL", "claude-sonnet-4-6"),
    routerModel: optional("CLAUDE_ROUTER_MODEL", "claude-haiku-4-5-20251001"),
    maxTurns: parseInt(optional("MAX_TURNS", "10"), 10),
    maxBudgetUsd: parseFloat(optional("MAX_BUDGET_USD", "1.00")),
    maxThinkingTokens: parseInt(optional("MAX_THINKING_TOKENS", "8000"), 10),
    timeoutMs: parseInt(optional("AGENT_TIMEOUT_MS", "300000"), 10),
    maxThreadMessages: parseInt(optional("MAX_THREAD_MESSAGES", "20"), 10),
    maxRetries: Math.max(0, parseInt(optional("AGENT_MAX_RETRIES", "1"), 10)),
  },
  github: {
    webhookSecret: optional("GITHUB_WEBHOOK_SECRET", ""),
  },
  dispatch: {
    defaultApiUrl: optional("DEFAULT_API_URL", "http://localhost:80"),
    agentTimeoutMs:
      parseInt(optional("DISPATCH_AGENT_TIMEOUT", "3600"), 10) * 1000,
    // Per-server cap for the pre-launch MCP probe. All configured servers
    // are probed in parallel, so total added dispatch latency is bounded by
    // this value regardless of how many servers the agent uses.
    //
    // Dispatches declare their MCP servers per-request, and the registry
    // spawns them via `npx -y <pkg>` — a cold npm cache means the first
    // invocation pays download + install + node startup, typically 15–30s
    // for a small MCP package (measured 19s for @thehammer/mcp-server-trello
    // on a 1Gbps link). Warm-cache subsequent invocations probe in 1–2s.
    // 60s is the worst-case healthy-cold ceiling with 2x safety margin;
    // operators running from a warmed image can override with a lower value.
    // A truly broken server (network down, package gone, hang) still fails
    // loudly within 60s — the `exit` reason path catches fast-failing
    // servers immediately (npm EACCES, 404, etc.), so only hangs hit this.
    mcpProbeTimeoutMs: parseInt(
      optional("DISPATCH_MCP_PROBE_TIMEOUT_MS", "60000"),
      10,
    ),
  },
  logLevel: optional("LOG_LEVEL", "info"),
  logsDir: optional("DANXBOT_LOGS_DIR", isHost ? "./logs" : "/danxbot/logs"),
  pollerIntervalMs: parseInt(optional("POLLER_INTERVAL_MS", "60000"), 10),
  pollerBackoffScheduleMs: [
    60_000, 300_000, 900_000, 1_800_000,
  ] as readonly number[],
} as const;

interface NumericRule {
  path: string;
  value: number;
  min: number;
  exclusive: boolean;
}

export function validateConfig(): void {
  if (!/^[a-zA-Z0-9_]+$/.test(config.db.database)) {
    throw new Error(
      `Invalid database name: ${config.db.database} (must be alphanumeric/underscores only)`,
    );
  }

  const rules: NumericRule[] = [
    {
      path: "agent.maxTurns",
      value: config.agent.maxTurns,
      min: 1,
      exclusive: false,
    },
    {
      path: "agent.maxBudgetUsd",
      value: config.agent.maxBudgetUsd,
      min: 0,
      exclusive: true,
    },
    {
      path: "agent.maxThinkingTokens",
      value: config.agent.maxThinkingTokens,
      min: 1,
      exclusive: false,
    },
    {
      path: "agent.timeoutMs",
      value: config.agent.timeoutMs,
      min: 1,
      exclusive: false,
    },
    {
      path: "agent.maxThreadMessages",
      value: config.agent.maxThreadMessages,
      min: 1,
      exclusive: false,
    },
    {
      path: "agent.maxRetries",
      value: config.agent.maxRetries,
      min: 0,
      exclusive: false,
    },
    {
      path: "db.connectTimeoutMs",
      value: config.db.connectTimeoutMs,
      min: 1,
      exclusive: false,
    },
  ];

  const errors: string[] = [];

  for (const rule of rules) {
    if (!Number.isFinite(rule.value)) {
      errors.push(`${rule.path} must be a finite number (got ${rule.value})`);
    } else if (rule.exclusive && rule.value <= rule.min) {
      errors.push(`${rule.path} must be > ${rule.min} (got ${rule.value})`);
    } else if (!rule.exclusive && rule.value < rule.min) {
      errors.push(`${rule.path} must be >= ${rule.min} (got ${rule.value})`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid config:\n  - ${errors.join("\n  - ")}`);
  }
}

validateConfig();
