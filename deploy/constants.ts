/**
 * Shared path constants for the deploy layer.
 * These paths are the canonical locations inside the remote instance.
 */

/** Absolute path on the remote instance where repos are bind-mounted. */
export const CONTAINER_REPOS_BASE = "/danxbot/repos";

/**
 * docker-compose-derived service container name for the shared dashboard.
 * Must stay in sync with `services.dashboard` in `docker-compose.yml`
 * (compose appends `-1` to `<project-name>-<service>` to produce the
 * auto-generated container name).
 */
export const DASHBOARD_CONTAINER = "danxbot-flytebot-dashboard-1";
