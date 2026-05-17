export interface ThreadState {
  threadTs: string;
  channelId: string;
  sessionId: string | null;
  messages: ThreadMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMessage {
  user: string;
  text: string;
  ts: string;
  isBot: boolean;
}

export interface AgentLogEntry {
  timestamp: number;
  type: string;
  subtype?: string;
  summary: string;
  data: Record<string, unknown>;
}

/**
 * Sub-agent lineage carried on AgentLogEntry.data (and propagated into every
 * emitted EventPayload.data) so gpt-manager can attribute usage to the
 * originating sub-agent within the same dispatch. Set by SessionLogWatcher for
 * entries read from `<parent-session>/subagents/*.jsonl`; absent on parent entries.
 */
export interface AgentLineage {
  subagent_id: string;
  parent_session_id: string | null;
  agent_type: string | undefined;
}

export interface RouterResult {
  quickResponse: string;
  needsAgent: boolean;
  reason: string;
  error: string | null;
  isOperational?: boolean;
  request: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
  usage: ApiCallUsage | null;
}

export interface ApiCallUsage {
  source: "router";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
  timestamp: number;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

export interface AgentUsageSummary {
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  modelUsage: Record<string, ModelUsage>;
}

export interface RepoConfig {
  name: string;
  url: string;
  localPath: string;
  /**
   * Canonical absolute repo path — same value in host + docker
   * runtimes. Used for `git worktree` ops + spawn cwd so worktree
   * metadata is runtime-agnostic. See `src/agent/portable-path.ts`.
   */
  hostPath: string;
  /**
   * Worker container port used to forward external dispatch requests.
   * Sourced from `deploy/targets/<TARGET>.yml` per-repo `worker_port`.
   * Required — the loader (`src/target.ts#loadTarget`) rejects entries
   * that omit it, so the dispatch proxy can always route.
   */
  workerPort: number;
  /**
   * Optional docker hostname override used by the proxy. Sourced from
   * `deploy/targets/<TARGET>.yml` per-repo `worker_host`. When undefined
   * the dashboard falls back to `danxbot-worker-<name>` (the per-repo
   * compose default). Set this when the connected repo's compose
   * `container_name` deviates from the default — without it, dispatches
   * to that repo silently 502.
   */
  workerHost?: string;
}

export interface TrelloConfig {
  apiKey: string;
  apiToken: string;
  boardId: string;
  bugLabelId: string;
  featureLabelId: string;
  epicLabelId: string;
  needsHelpLabelId: string;
  /**
   * Label applied to cards whose YAML carries a non-null `blocked` field.
   * Managed automatically by the worker (paired with `setLabels({blocked})`)
   * so a card waiting on other in-flight work surfaces visually on the
   * Trello board without an operator manually toggling it. Provisioned by
   * the setup skill alongside the other danxbot-managed labels.
   */
  blockedLabelId: string;
  /**
   * Label applied to cards whose YAML carries `requires_human != null`.
   * Managed automatically by the worker (paired with
   * `setLabels({requires_human})`) so a card needing human action surfaces
   * visually on the Trello board. Empty string = the operator has not yet
   * provisioned the label — `setLabels` skips applying / stripping so the
   * field stays a no-op on not-yet-upgraded boards. The card stays in its
   * current Trello list (Review / ToDo / Blocked / In Progress)
   * regardless; `requires_human` is the orthogonal indicator label, not a
   * list move.
   *
   * DX-231 introduced this field as the replacement for the retired
   * `Needs Approval` parking status. Provisioned by the setup skill on
   * fresh boards (Phase 3 of DX-231); existing repos add the row to
   * `<repo>/.danxbot/config/trello.yml` once the operator creates the
   * "Requires Human" label on the board.
   */
  requiresHumanLabelId: string;
  triagedLabelId?: string;
}

export interface SlackConfig {
  enabled: boolean;
  botToken: string;
  appToken: string;
  channelId: string;
}

export interface RepoDatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  enabled: boolean;
}

export interface RepoContext {
  name: string;
  url: string;
  localPath: string;
  /** See `RepoConfig.hostPath` + `src/agent/portable-path.ts`. */
  hostPath: string;
  trello: TrelloConfig;
  trelloEnabled: boolean;
  slack: SlackConfig;
  db: RepoDatabaseConfig;
  githubToken: string;
  workerPort: number;
  /**
   * Per-repo issue id namespace prefix (`DX`, `SG`, `FD`, …). Loaded from
   * `<repo>/.danxbot/config/config.yml` `issue_prefix` field; validated
   * against `^[A-Z]{2,4}$`. Phase 4 of ISS-99 retired the warn-once
   * `"ISS"` fallback — a missing `issue_prefix` field now fails loud
   * (`loadIssuePrefix` throws) instead of silently defaulting. Flip via
   * the dashboard's `PUT /api/agents/:repo/issue-prefix` route to
   * rewrite YAMLs + config in lockstep.
   */
  issuePrefix: string;
}

export interface AgentResponse {
  text: string;
  sessionId: string | null;
  subscriptionCostUsd: number;
  turns: number;
  config: Record<string, unknown>;
  log: AgentLogEntry[];
  usage: AgentUsageSummary | null;
}
