/**
 * Shared path constants for the deploy layer.
 * These paths are the canonical locations inside the remote instance.
 */

/** Absolute path on the remote instance where repos are bind-mounted. */
export const CONTAINER_REPOS_BASE = "/danxbot/repos";

/**
 * Auto-generated docker-compose container name for the shared dashboard ON
 * THE REMOTE EC2 INSTANCE — i.e., what `docker exec <name>` targets when SSHed
 * into production. The deploy CLI uses this for remote operator commands like
 * `make create-user TARGET=...`.
 *
 * Compose builds container names as `<project>-<service>-<ordinal>`. On the
 * remote instance the compose project is `danxbot` (the dirname `/danxbot/`),
 * so the dashboard container is `danxbot-dashboard-1`. This is NOT the same
 * as the local-dev container name (`danxbot-flytebot-dashboard-1`, which the
 * Makefile's LOCALHOST branch hardcodes separately).
 */
export const DASHBOARD_CONTAINER = "danxbot-dashboard-1";
