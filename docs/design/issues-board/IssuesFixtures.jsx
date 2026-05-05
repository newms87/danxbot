// Fixtures for the Issues board — issues for platform / gpt-manager / danxbot.
// Shape mirrors the proposed YAML schema (.danxbot/issues/{open,closed}/*.yml).

const ISSUE_NOW = Date.now();
const I_MIN = 60_000;
const I_HOUR = 3600_000;
const I_DAY = 86400_000;

// Statuses → kanban columns
// review · todo · in_progress · needs_help · done · cancelled
const FIXTURE_ISSUES = [
  // ───────── platform ─────────
  {
    id: "ISS-101", repo: "platform", type: "epic",
    title: "Trello poller resilience: rate-limits, retries, backpressure",
    status: "in_progress", parent_id: null,
    children: ["ISS-102", "ISS-103", "ISS-104", "ISS-105"],
    description: "The Trello poller currently retries forever on 429s and silently drops cards when the worker is busy. This epic hardens it with proper rate-limit handling, an exponential-backoff queue, and an observable backpressure signal we can alert on.",
    ac: [
      { text: "Honors `Retry-After` header from Trello", done: true },
      { text: "Backoff queue capped at 200 cards", done: true },
      { text: "Exposes /metrics/poller-depth", done: false },
      { text: "Alerts when queue > 50 for >5min", done: false },
      { text: "Documented in runbook", done: false },
    ],
    phases: [
      { name: "Spike: reproduce the retry storm", status: "done" },
      { name: "Implement Retry-After honoring", status: "done" },
      { name: "Backoff queue + drop policy", status: "in_progress" },
      { name: "Metrics + alerting", status: "todo" },
    ],
    comments_count: 8, has_retro: false, blocked: null, triaged: true,
    updatedAt: ISSUE_NOW - 14*I_MIN,
  },
  {
    id: "ISS-102", repo: "platform", type: "bug",
    title: "Trello rate-limit backoff isn't honoring Retry-After header",
    status: "done", parent_id: "ISS-101",
    description: "When Trello returns a 429 with a `Retry-After: 30` header, our poller ignores it and immediately retries, which gets us banned for ~10 minutes. Need to read the header and sleep accordingly.",
    ac: [
      { text: "Read Retry-After in seconds", done: true },
      { text: "Read Retry-After as HTTP date", done: true },
      { text: "Cap max wait at 5min", done: true },
      { text: "Unit tests for both formats", done: true },
    ],
    phases: [],
    comments_count: 3, has_retro: true, blocked: null, triaged: true,
    updatedAt: ISSUE_NOW - 2*I_HOUR,
    retro: {
      good: ["Repro was fast — alice sent a Slack with the exact card", "Fix was 12 lines"],
      bad: ["Should have caught this in the original Trello adapter PR"],
      action_items: ["Add 429 handling to the lint checklist for new HTTP clients"],
      commits: ["3a91c2", "f02bb1"],
    },
  },
  {
    id: "ISS-103", repo: "platform", type: "feature",
    title: "Backoff queue with bounded capacity + drop-oldest policy",
    status: "in_progress", parent_id: "ISS-101",
    description: "Replace the current unbounded retry list with a real queue. Cap at 200 cards, drop oldest when full, emit a counter so we can graph drops over time.",
    ac: [
      { text: "Queue caps at 200", done: true },
      { text: "Drop-oldest semantics verified", done: true },
      { text: "Counter exposed at /metrics/poller-drops", done: false },
      { text: "Drops emit a structured log line", done: false },
    ],
    phases: [],
    comments_count: 5, has_retro: false, blocked: null, triaged: true,
    updatedAt: ISSUE_NOW - 35*I_MIN,
  },
  {
    id: "ISS-104", repo: "platform", type: "feature",
    title: "Expose /metrics/poller-depth for Prometheus scraping",
    status: "todo", parent_id: "ISS-101",
    description: "Add a Prometheus-compatible gauge that reports current queue depth. Needs to be reachable from the metrics sidecar.",
    ac: [
      { text: "Gauge: poller_depth", done: false },
      { text: "Counter: poller_drops_total", done: false },
      { text: "Sidecar can scrape from worker port", done: false },
    ],
    phases: [],
    comments_count: 1, has_retro: false, blocked: null, triaged: true,
    updatedAt: ISSUE_NOW - 6*I_HOUR,
  },
  {
    id: "ISS-105", repo: "platform", type: "feature",
    title: "Alert when queue depth > 50 for more than 5 minutes",
    status: "needs_help", parent_id: "ISS-101",
    description: "Once metrics are exposed, write the alert. Need help deciding whether this fires to PagerDuty or just Slack #platform-alerts.",
    ac: [
      { text: "Alert defined in alerts.yml", done: false },
      { text: "Routing decided", done: false },
      { text: "Tested with synthetic load", done: false },
    ],
    phases: [],
    comments_count: 4, has_retro: false,
    blocked: { reason: "Routing policy decision pending — PagerDuty vs Slack", by: ["ISS-104"] },
    triaged: true,
    updatedAt: ISSUE_NOW - 18*I_HOUR,
  },
  {
    id: "ISS-110", repo: "platform", type: "bug",
    title: "Dispatch detail panel scrolls behind the scrim on mobile",
    status: "review", parent_id: null,
    description: "On viewports < 480px the DispatchDetail slide-over has body scroll passthrough — touch scrolling on the panel scrolls the page underneath instead.",
    ac: [
      { text: "Touch scroll stays inside panel", done: false },
      { text: "Verified on iOS Safari + Chrome Android", done: false },
    ],
    phases: [],
    comments_count: 2, has_retro: false, blocked: null, triaged: false,
    updatedAt: ISSUE_NOW - 40*I_MIN,
  },
  {
    id: "ISS-111", repo: "platform", type: "feature",
    title: "Add `/api/dispatches/:id/cancel` to abort an in-flight run",
    status: "todo", parent_id: null,
    description: "Operators need a way to cancel a runaway dispatch from the dashboard without restarting the worker.",
    ac: [
      { text: "Endpoint signals worker via SIGTERM-style hook", done: false },
      { text: "Returns 202 + final status in stream", done: false },
      { text: "Auth gated to admin role", done: false },
    ],
    phases: [],
    comments_count: 0, has_retro: false, blocked: null, triaged: true,
    updatedAt: ISSUE_NOW - 1*I_DAY,
  },

  // ───────── gpt-manager ─────────
  {
    id: "ISS-201", repo: "gpt-manager", type: "epic",
    title: "Migrate auth middleware off legacy session cookies",
    status: "in_progress", parent_id: null,
    children: ["ISS-202", "ISS-203", "ISS-204"],
    description: "Move from the homegrown signed-cookie session to JWT-based auth. The legacy code is brittle, hard to test, and doesn't support our new SSO requirements.",
    ac: [
      { text: "All routes use the new middleware", done: true },
      { text: "JWT secret rotation documented", done: true },
      { text: "SSO integration tests pass", done: false },
      { text: "Old middleware removed", done: false },
    ],
    phases: [
      { name: "Add JWT middleware alongside legacy", status: "done" },
      { name: "Migrate routes one by one", status: "in_progress" },
      { name: "Remove legacy code", status: "todo" },
    ],
    comments_count: 12, has_retro: false, blocked: null, triaged: true,
    updatedAt: ISSUE_NOW - 4*I_HOUR,
  },
  {
    id: "ISS-202", repo: "gpt-manager", type: "feature",
    title: "JWT verification middleware (alongside legacy)",
    status: "done", parent_id: "ISS-201",
    description: "Add a new JWT middleware that runs alongside the legacy session middleware. Routes that opt in use the new one.",
    ac: [
      { text: "Verifies signature + expiry", done: true },
      { text: "Attaches user to ctx.state.user", done: true },
      { text: "401s with structured error", done: true },
    ],
    phases: [],
    comments_count: 4, has_retro: true, blocked: null, triaged: true,
    updatedAt: ISSUE_NOW - 2*I_DAY,
  },
  {
    id: "ISS-203", repo: "gpt-manager", type: "feature",
    title: "Migrate /api/agents/* to JWT middleware",
    status: "in_progress", parent_id: "ISS-201",
    description: "Switch the agents route family over to the new JWT auth. Requires updating fixtures and the dashboard's agent list call.",
    ac: [
      { text: "All /api/agents/* routes migrated", done: true },
      { text: "Dashboard updated", done: true },
      { text: "Fixtures updated", done: false },
      { text: "Integration tests pass", done: false },
    ],
    phases: [],
    comments_count: 6, has_retro: false, blocked: null, triaged: true,
    updatedAt: ISSUE_NOW - 28*I_MIN,
  },
  {
    id: "ISS-204", repo: "gpt-manager", type: "bug",
    title: "Anthropic token expired warning fires twice on cold start",
    status: "needs_help", parent_id: "ISS-201",
    description: "When the worker boots cold, the token check fires once during init and once on the first dispatch — double warning in Slack. Carlos asked about this.",
    ac: [
      { text: "Warning fires at most once per token rotation", done: false },
      { text: "Repro test added", done: false },
    ],
    phases: [],
    comments_count: 7, has_retro: false,
    blocked: { reason: "Need clarity on whether init-time check is even needed now that JWT middleware does it", by: ["ISS-202"] },
    triaged: true,
    updatedAt: ISSUE_NOW - 5*I_HOUR,
  },
  {
    id: "ISS-210", repo: "gpt-manager", type: "feature",
    title: "Surface tokens-in vs tokens-out in dispatch table",
    status: "todo", parent_id: null,
    description: "We store both already; just add two columns and a Tweak to toggle them.",
    ac: [
      { text: "Columns added", done: false },
      { text: "Sortable", done: false },
      { text: "Tweak: hide by default", done: false },
    ],
    phases: [],
    comments_count: 1, has_retro: false, blocked: null, triaged: true,
    updatedAt: ISSUE_NOW - 12*I_HOUR,
  },
  {
    id: "ISS-211", repo: "gpt-manager", type: "bug",
    title: "Sub-agent timeline indentation breaks at depth > 2",
    status: "review", parent_id: null,
    description: "The recursive timeline renderer caps indent at 2 levels — deeper sub-agents collapse into the parent visually.",
    ac: [
      { text: "Indent scales linearly with depth", done: true },
      { text: "Visual divider per level", done: false },
    ],
    phases: [],
    comments_count: 3, has_retro: false, blocked: null, triaged: true,
    updatedAt: ISSUE_NOW - 50*I_MIN,
  },
  {
    id: "ISS-212", repo: "gpt-manager", type: "bug",
    title: "Refactor cancelled dispatch — duplicate of jordan's report",
    status: "cancelled", parent_id: null,
    description: "Closed as duplicate of ISS-211.",
    ac: [], phases: [],
    comments_count: 1, has_retro: false, blocked: null, triaged: false,
    updatedAt: ISSUE_NOW - 11*I_HOUR,
  },

  // ───────── danxbot ─────────
  {
    id: "ISS-301", repo: "danxbot", type: "epic",
    title: "Issues board: read-only kanban over .danxbot/issues",
    status: "in_progress", parent_id: null,
    children: ["ISS-302", "ISS-303", "ISS-304", "ISS-305"],
    description: "New top-level tab in the dashboard. Reads issue YAMLs, renders a 6-column kanban, supports a slide-over detail drawer with epic relationship UX. Read-only for v1; editing comes later.",
    ac: [
      { text: "Tab appears in DashboardHeader", done: true },
      { text: "GET /api/issues + /api/issues/:id endpoints", done: false },
      { text: "Board with 6 columns", done: false },
      { text: "Detail drawer with 4 tabs", done: false },
      { text: "Search + filter chrome", done: false },
      { text: "Epic scope filter / highlight toggle", done: false },
    ],
    phases: [
      { name: "Backend list+detail endpoints", status: "in_progress" },
      { name: "Board skeleton + repo wiring", status: "todo" },
      { name: "Detail drawer + epic links", status: "todo" },
      { name: "Search + filters + URL state", status: "todo" },
    ],
    comments_count: 11, has_retro: false, blocked: null, triaged: true,
    updatedAt: ISSUE_NOW - 8*I_MIN,
  },
  {
    id: "ISS-302", repo: "danxbot", type: "feature",
    title: "GET /api/issues + /api/issues/:id endpoints",
    status: "in_progress", parent_id: "ISS-301",
    description: "Reads issue YAMLs from `<repo>/.danxbot/issues/{open,closed}/*.yml`. Cap closed at last 50 by mtime.",
    ac: [
      { text: "Returns minimal list shape", done: true },
      { text: "Detail returns full Issue object", done: true },
      { text: "Closed cap = 50, ?include_closed=all overrides", done: false },
      { text: "Auth gated like /api/agents", done: false },
      { text: "Tests with fixture YAMLs", done: false },
    ],
    phases: [],
    comments_count: 3, has_retro: false, blocked: null, triaged: true,
    updatedAt: ISSUE_NOW - 16*I_MIN,
  },
  {
    id: "ISS-303", repo: "danxbot", type: "feature",
    title: "Board skeleton: 6 columns, repo selector, minimal card",
    status: "todo", parent_id: "ISS-301",
    description: "Just the chrome — no detail drawer, no filters, no epic UX yet. Get the columns and cards rendering against the new endpoints.",
    ac: [
      { text: "6 columns: review/todo/in_progress/needs_help/done/cancelled", done: false },
      { text: "Done + Cancelled collapsed by default", done: false },
      { text: "Card: id chip + title + footer", done: false },
      { text: "Repo selector wired", done: false },
    ],
    phases: [],
    comments_count: 2, has_retro: false, blocked: null, triaged: true,
    updatedAt: ISSUE_NOW - 1*I_HOUR,
  },
  {
    id: "ISS-304", repo: "danxbot", type: "feature",
    title: "Detail drawer with Overview / Comments / Retro / Raw tabs",
    status: "todo", parent_id: "ISS-301",
    description: "Right-side slide-over using danx-ui dialog. Click a card → drawer opens with the 4 tabs. Markdown rendered read-only.",
    ac: [
      { text: "Slide-over animation", done: false },
      { text: "All 4 tabs render", done: false },
      { text: "Parent/child chips clickable", done: false },
      { text: "AC checklist read-only", done: false },
      { text: "Retro hidden if not populated", done: false },
    ],
    phases: [],
    comments_count: 4, has_retro: false, blocked: null, triaged: true,
    updatedAt: ISSUE_NOW - 90*I_MIN,
  },
  {
    id: "ISS-305", repo: "danxbot", type: "feature",
    title: "Search + filter chrome with URL-state persistence",
    status: "todo", parent_id: "ISS-301",
    description: "Free-text search, type chips, blocked toggle, closed-cap override. All filter state mirrored to query string for shareable links.",
    ac: [
      { text: "Free-text matches id/title/desc/comments", done: false },
      { text: "Type chips multi-select", done: false },
      { text: "Blocked-only toggle", done: false },
      { text: "Closed-cap override", done: false },
      { text: "Query-string persistence", done: false },
    ],
    phases: [],
    comments_count: 1, has_retro: false, blocked: null, triaged: true,
    updatedAt: ISSUE_NOW - 4*I_HOUR,
  },
  {
    id: "ISS-310", repo: "danxbot", type: "bug",
    title: "Worker shows reachable=true after container exits",
    status: "needs_help", parent_id: null,
    description: "If the worker container crashes, the dashboard still reports it as reachable for ~30s until the next poll. Need shorter detection window or a push-based heartbeat.",
    ac: [
      { text: "Detection within 5s", done: false },
      { text: "Doesn't false-positive on transient timeouts", done: false },
    ],
    phases: [],
    comments_count: 2, has_retro: false,
    blocked: { reason: "Awaiting decision on whether to add a websocket from worker → dashboard or shorten poll interval", by: [] },
    triaged: true,
    updatedAt: ISSUE_NOW - 7*I_HOUR,
  },
];

// ───── derived helpers ─────
const ISSUE_TYPE_META = {
  epic:    { label: "Epic",    fg: "#a5b4fc", bg: "rgb(99 102 241 / 0.15)", border: "rgb(99 102 241 / 0.35)" },
  bug:     { label: "Bug",     fg: "#fca5a5", bg: "rgb(239 68 68 / 0.15)",  border: "rgb(239 68 68 / 0.35)" },
  feature: { label: "Feature", fg: "#86efac", bg: "rgb(16 185 129 / 0.15)", border: "rgb(16 185 129 / 0.35)" },
};

const STATUS_COLUMNS = [
  { id: "review",      label: "Review",       collapsed: false },
  { id: "todo",        label: "To Do",        collapsed: false },
  { id: "in_progress", label: "In Progress",  collapsed: false },
  { id: "needs_help",  label: "Needs Help",   collapsed: false },
  { id: "done",        label: "Done",         collapsed: true },
  { id: "cancelled",   label: "Cancelled",    collapsed: true },
];

const PHASE_STATUS_META = {
  done:        { fg: "#6ee7b7", bg: "rgb(16 185 129 / 0.18)", glyph: "✓" },
  in_progress: { fg: "#fcd34d", bg: "rgb(245 158 11 / 0.18)", glyph: "◐" },
  todo:        { fg: "#cbd5e1", bg: "rgb(51 65 85 / 0.40)",   glyph: "○" },
  blocked:     { fg: "#fca5a5", bg: "rgb(239 68 68 / 0.18)",  glyph: "⛔" },
};

function relativeTime(ms) {
  const d = ISSUE_NOW - ms;
  if (d < I_MIN) return "just now";
  if (d < I_HOUR) return `${Math.floor(d / I_MIN)}m ago`;
  if (d < I_DAY) return `${Math.floor(d / I_HOUR)}h ago`;
  return `${Math.floor(d / I_DAY)}d ago`;
}

Object.assign(window, {
  FIXTURE_ISSUES, ISSUE_TYPE_META, STATUS_COLUMNS, PHASE_STATUS_META,
  relativeTime,
});
