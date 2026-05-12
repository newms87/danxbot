/**
 * Per-dispatch systemd transient scope unit helpers (DX-325 / DX-323).
 *
 * Every host-mode dispatch wraps its `claude` invocation in a systemd
 * user-scope so backgrounded grandchildren (`yes > /dev/null &`,
 * double-forks, daemons) inherit the cgroup and the whole tree is a
 * single kill target. See `.claude/rules/agent-dispatch.md` "Single
 * Fork Principle" for the runtime invariant and DX-262 for the prod
 * incident that motivated this layer.
 *
 * The functions in this module are pure — they build the systemd-run
 * argv from inputs. The boot-time availability check lives in
 * `systemd-preflight.ts`; the actual `spawn("systemd-run", ...)` call
 * site lives in `spawn-docker-mode.ts` (headless path) and
 * `terminal.ts#buildDispatchScript` (host TUI path).
 */

/**
 * Env var name children + observers read to discover their owning
 * scope unit without parsing argv. Pinned via test so a typo in the
 * `spawnAgent` env-injection site is caught at unit-test time.
 */
export const DANXBOT_DISPATCH_SCOPE_ENV = "DANXBOT_DISPATCH_SCOPE";

/**
 * Canonical scope unit name for a dispatch id — `danxbot-dispatch-<id>`.
 *
 * The literal dispatchId is preserved (no slug, no truncation) so Phase
 * 3's `systemctl --user stop danxbot-dispatch-<id>.scope` can address
 * the unit using the same id stamped on the `dispatches` row + the
 * issue YAML's `dispatch.id`.
 */
export function scopeUnitName(dispatchId: string): string {
  if (!dispatchId) {
    throw new Error(
      "scopeUnitName: dispatchId must be non-empty — an empty id collides with every other empty-id dispatch in the same systemd user session",
    );
  }
  return `danxbot-dispatch-${dispatchId}`;
}

export interface BuildSystemdRunArgsOptions {
  /** Dispatch UUID — flows into the `--unit` flag verbatim. */
  dispatchId: string;
  /** Path to the claude binary (`"claude"` for PATH lookup, or absolute). */
  claudePath: string;
  /** The claude CLI flags + prompt args that follow the `--` separator. */
  claudeArgs: string[];
}

/**
 * Build the argv for `spawn("systemd-run", ...)` that wraps a claude
 * dispatch in a per-dispatch transient scope unit.
 *
 * Shape:
 *
 *   --user --scope --unit danxbot-dispatch-<id> --quiet --collect \
 *     -- <claudePath> <...claudeArgs>
 *
 *   --user      — register the scope under the calling user's systemd
 *                 instance (no system bus access; `loginctl enable-linger`
 *                 is the operator's setup requirement). The boot
 *                 preflight asserts `systemctl --user is-system-running`
 *                 before we ever reach this builder.
 *   --scope     — register a transient scope unit (group of processes,
 *                 not a daemon-managed service). systemd-run runs the
 *                 command directly in the caller's tree; the scope is
 *                 the cgroup boundary.
 *   --unit      — pinned unit name; required so the reaper + Phase 3's
 *                 `systemctl --user stop` can address each dispatch by
 *                 id rather than by ephemeral systemd-generated names.
 *   --quiet     — suppress systemd-run's "Running scope as unit: …"
 *                 banner so the headless path's stderr-pipe (used for
 *                 failure summaries) doesn't get polluted.
 *   --collect   — remove the scope unit from systemd state after exit
 *                 (success OR failure). Without this, completed scopes
 *                 linger in `systemctl --user list-units --all` and
 *                 the reaper's join against the `dispatches` table
 *                 balloons over time.
 *   --          — POSIX end-of-options. `--unit <name>` would otherwise
 *                 absorb the following claude argv when systemd-run
 *                 saw an unknown flag (defense-in-depth — `--unit` is
 *                 not variadic, but pinning the separator means future
 *                 flag additions can't accidentally bleed into claude
 *                 argv).
 */
export function buildSystemdRunArgs(
  opts: BuildSystemdRunArgsOptions,
): string[] {
  if (!opts.claudePath) {
    throw new Error(
      "buildSystemdRunArgs: claudePath must be non-empty — an empty value would surface as the confusing 'execvp: : No such file or directory' error deep inside systemd-run's exec",
    );
  }
  const unit = scopeUnitName(opts.dispatchId);
  return [
    "--user",
    "--scope",
    "--unit",
    unit,
    "--quiet",
    "--collect",
    "--",
    opts.claudePath,
    ...opts.claudeArgs,
  ];
}
