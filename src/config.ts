import { existsSync } from "node:fs";
import type { RepoConfig } from "./types.js";
import { getReposBase } from "./poller/constants.js";
import { required, optional } from "./env.js";
import { parseReposEnv } from "./repos-env.js";

function parseRepos(envValue: string): RepoConfig[] {
  return parseReposEnv(envValue).map(({ name, url }) => ({
    name,
    url,
    localPath: `${getReposBase()}/${name}`,
  }));
}

/**
 * Parse REPO_WORKER_PORTS — companion env var for REPOS, maps repo name to
 * worker container port. Format: "name:port,name:port". Used by the dashboard
 * to forward external dispatch requests to the matching worker container on
 * the danxbot-net docker network.
 */
function parseWorkerPorts(envValue: string): Record<string, number> {
  if (!envValue.trim()) return {};
  const result: Record<string, number> = {};
  for (const entry of envValue.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex <= 0) {
      throw new Error(
        `Invalid REPO_WORKER_PORTS entry "${entry}" — expected "name:port" format`,
      );
    }
    const name = trimmed.slice(0, colonIndex).trim();
    const portStr = trimmed.slice(colonIndex + 1).trim();
    const port = parseInt(portStr, 10);
    if (!name || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        `Invalid REPO_WORKER_PORTS entry "${entry}" — name required, port must be 1-65535`,
      );
    }
    result[name] = port;
  }
  return result;
}

/**
 * Attach workerPort entries from REPO_WORKER_PORTS onto matching REPOS entries.
 * Throws on orphaned port entries (port name with no matching repo) — silent
 * discards turn typos into 500s at proxy-request time.
 */
function attachWorkerPorts(
  parsedRepos: RepoConfig[],
  ports: Record<string, number>,
): RepoConfig[] {
  const repoNames = new Set(parsedRepos.map((r) => r.name));
  for (const name of Object.keys(ports)) {
    if (!repoNames.has(name)) {
      throw new Error(
        `REPO_WORKER_PORTS references unknown repo "${name}" — each name must match an entry in REPOS`,
      );
    }
  }
  return parsedRepos.map((r) =>
    ports[r.name] !== undefined ? { ...r, workerPort: ports[r.name] } : r,
  );
}

/**
 * Parse REPO_WORKER_HOSTS — optional per-repo docker hostname override that
 * winds through `<repo>/.danxbot/config/compose.yml` `container_name`. Format:
 * "name:host,name:host". Repos absent from this map fall back to the
 * default `danxbot-worker-<name>` in `src/dashboard/dispatch-proxy.ts`.
 *
 * Whitespace inside a hostname (DNS labels can't contain spaces) and an
 * empty value after the colon are rejected loudly — both are config
 * mistakes that would silently skew proxy behavior.
 */
function parseWorkerHosts(envValue: string): Record<string, string> {
  if (!envValue.trim()) return {};
  const result: Record<string, string> = {};
  for (const entry of envValue.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex <= 0) {
      throw new Error(
        `Invalid REPO_WORKER_HOSTS entry "${entry}" — expected "name:host" format`,
      );
    }
    const name = trimmed.slice(0, colonIndex).trim();
    const host = trimmed.slice(colonIndex + 1).trim();
    if (!name || !host || /\s/.test(host)) {
      throw new Error(
        `Invalid REPO_WORKER_HOSTS entry "${entry}" — name required, host must be a non-empty whitespace-free string`,
      );
    }
    result[name] = host;
  }
  return result;
}

/**
 * Attach workerHost entries from REPO_WORKER_HOSTS onto matching REPOS
 * entries. Same fail-loud contract as `attachWorkerPorts` — typos surface at
 * boot, not as silent 502s under load.
 */
function attachWorkerHosts(
  parsedRepos: RepoConfig[],
  hosts: Record<string, string>,
): RepoConfig[] {
  const repoNames = new Set(parsedRepos.map((r) => r.name));
  for (const name of Object.keys(hosts)) {
    if (!repoNames.has(name)) {
      throw new Error(
        `REPO_WORKER_HOSTS references unknown repo "${name}" — each name must match an entry in REPOS`,
      );
    }
  }
  return parsedRepos.map((r) =>
    hosts[r.name] !== undefined ? { ...r, workerHost: hosts[r.name] } : r,
  );
}

export const repos: RepoConfig[] = attachWorkerHosts(
  attachWorkerPorts(
    parseRepos(optional("REPOS", "")),
    parseWorkerPorts(optional("REPO_WORKER_PORTS", "")),
  ),
  parseWorkerHosts(optional("REPO_WORKER_HOSTS", "")),
);

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
    throw new Error(`Repo "${name}" is not configured in REPOS env var`);
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
