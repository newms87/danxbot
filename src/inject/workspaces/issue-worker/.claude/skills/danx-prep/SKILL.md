---
name: danx-prep
description: MANDATORY when the dispatch prompt begins with `/danx-prep <PREFIX>-N`. Runs the pre-dispatch prep step on the agent's worktree — uncommitted-work recovery, branch sync, conflict check against in-progress siblings, card sanity check — then emits a verdict via `mcp__danxbot__danxbot_prep_verdict`. NEVER runs `git stash`, `git reset --hard`, `git checkout <ref>`, `git restore`, or `git clean -f`; commit-first is the only recovery primitive.
---

# Danx Prep

You are running because the poller dispatched you with `/danx-prep <PREFIX>-N`. The candidate card the dispatch picked is the one named in that argument.

Your job is to bring the worktree to a state where the candidate is safe to work — recover any uncommitted work from a prior session, sync the branch against `origin/main`, and check for file-scope overlap with cards other agents are currently working on. At the end you emit ONE verdict via `mcp__danxbot__danxbot_prep_verdict`. The worker route applies the YAML / settings side-effects and decides whether the dispatch continues.

**Two prep modes** are configured per repo via `agentDefaults.prepMode` in `<repo>/.danxbot/settings.json`:

- **Combined** — your dispatch prompt contains `/danx-prep <PREFIX>-N` AND a `/danx-next` body. After you emit verdict `ok` the worker leaves the dispatch running and you proceed straight into the `/danx-next` workflow in the same session.
- **Separate** — your dispatch prompt contains ONLY `/danx-prep <PREFIX>-N`. After emitting the verdict you call `danxbot_complete` and exit. The poller picks the card again on the next tick for the actual work dispatch.

Both modes share the same skill body, the same MCP tool, the same worktree.

## ABSOLUTE BAN — destructive git ops

`git stash`, `git stash push`, `git stash pop`, `git reset --hard`, `git checkout <ref>`, `git checkout -- <path>`, `git restore`, `git restore --staged`, `git clean -f`, `git push --force`, `git push --force-with-lease` are FORBIDDEN at every step of this skill. They destroy uncommitted work irrecoverably. The only allowed recovery primitive is **commit first** — the commit is the recoverable trail, anything else can be reset by a human later.

If a sync step needs more than `git fetch` + `git pull --ff-only` + `git rebase`, **abort**. Emit verdict `abort` with a clear reason instead of attempting a destructive recovery.

User-facing rule reference: `~/web/claude-plugins/dev/skills/git-discipline/SKILL.md` "Never Destroy Work. Ever."

---

## Step 1 — Read context

1. Read the candidate YAML at `<worktree>/.danxbot/issues/open/<PREFIX>-N.yml` to learn the work scope — `description`, `ac[]`, `comments[]`, file paths mentioned anywhere.
2. Run:

   ```bash
   git fetch origin --quiet
   git status --porcelain
   git rev-list --left-right --count origin/main...HEAD
   ```

   Capture: the uncommitted-changes set, the ahead count, the behind count.
3. List `<worktree>/.danxbot/issues/open/*.yml`. Read every YAML whose `status: In Progress` (exclude the candidate itself). Defensive cap: 20 cards.

This is read-only. No edits, no commits yet.

---

## Step 2 — Uncommitted work recovery

If `git status --porcelain` from Step 1 is empty → skip to Step 3.

If non-empty, **commit the work as-is — do not stash, do not reset, do not discard**.

First, identify your own agent name: the literal between `You are ` and the trailing period on the first line of your dispatch prompt (the persona block — see `<worktree>/.danxbot/workspaces/issue-worker/CLAUDE.md` "Path placeholder convention"). The orchestrator stamps this onto every card it claims, so matching against it is the strongest "this is the card I was just working on" signal.

Then compute the set of modified paths from the porcelain output and score every YAML under `<worktree>/.danxbot/issues/{open,closed}/` against them:

- Direct mention of any modified path in the YAML's `description` / `comments[].text` / `ac[].title` → **+3 per path**.
- YAML's `assigned_agent` equals your agent name → **+2**.
- YAML's most recent timestamp (any comment / history / dispatch field) is within the last 24h → **+1**.

**Tie-breaker rule** (applies to both branches): most recent activity timestamp first; if still tied, lowest `<PREFIX>-N` numeric suffix.

### Branch A — at least one YAML scored above 0 (winner found)

Pick the highest-scoring YAML (tie-breaker per the rule above). Then, in this exact order:

1. **Append a comment** to the winning YAML (use the `Edit` tool against `<worktree>/.danxbot/issues/<state>/<PREFIX>-N.yml`):
   - `author: "danxbot"`
   - `timestamp:` current ISO 8601
   - `text:` multi-line markdown body:

     ```
     ## Recovered uncommitted work — Phase 4 prep

     The pre-dispatch prep step found uncommitted changes on the agent's worktree from a prior session and committed them as-is.

     **Files (uncommitted residue from a prior dispatch):**

     - <path 1>
     - <path 2>

     **Heuristic match score:** <total score> (highest of N candidates examined).

     The committed sha is the most recent `wip:` commit on the agent's branch.
     ```
   - No `id` field.

2. **Commit** the WIP residue AND the YAML comment-append together — one commit, no leftover diff:

   ```bash
   git add -A
   git commit -m "wip: recovered uncommitted work — see <winner-PREFIX>-N comment"
   ```

   Capture the resulting sha (only for log purposes — the comment itself does not need a sha-back-reference because `git log` next to the comment timestamp resolves both).

3. Proceed to Step 3.

### Branch B — no YAML scored above 0 (orphan recovery)

The modified paths reference no existing card. Create a fresh Action Items card so the orphan recovery has a durable home, then commit. Order matters:

1. Call `mcp__danx-issue__danx_issue_create`:

   ```
   mcp__danx-issue__danx_issue_create({
     type: "Bug",
     title: "Investigate orphan uncommitted work — recovered by danx-prep",
     description: <multi-line body with the file list and the heuristic-score table>,
     ac: [{title: "Inspect the wip commit and decide whether to keep, fold into another card, or revert via a follow-up commit"}],
   })
   ```

   Capture the returned `<PREFIX>-N` from the tool's response.

2. **Append a comment** to the freshly-created card (same shape as Branch A step 1).

3. **Commit** the WIP residue AND the YAML create + comment-append together:

   ```bash
   git add -A
   git commit -m "wip: recovered orphan uncommitted work — see <new-PREFIX>-N"
   ```

4. Proceed to Step 3.

### Post-Step-2 invariant

After Branch A or Branch B completes, `git status --porcelain` MUST be empty (the single commit swept up both the prior-session residue and the YAML comment / new-YAML write you just performed). Re-run it; if anything remains, emit verdict `abort` — the recovery did not work as expected and you must NOT attempt a destructive cleanup.

---

## Step 3 — Branch sync

Read `ahead` and `behind` from Step 1's `git rev-list --left-right --count`. Branch on the pair:

| Pair | Action |
|---|---|
| `ahead=0, behind=0` | No-op. Branch is at `origin/main`. |
| `ahead=0, behind>0` | `git pull --ff-only origin main`. If the pull refuses (history diverged), emit verdict `abort` with reason `"branch sync: pull --ff-only refused — history diverged from origin/main"`. |
| `ahead>0` | `git rebase origin/main`. If the rebase reports a conflict: run `git rebase --abort`, then emit verdict `abort` with reason `"branch sync: rebase conflict against origin/main"` and `suggested_steps: ["inspect the worktree by hand", "resolve conflicts manually + commit", "if irrecoverable, clear the broken record via the dashboard"]`. |

After every successful sync, re-run `git rev-list --left-right --count origin/main...HEAD` — the pair MUST be `0\t0` (sync is idempotent). If not, emit verdict `abort`.

**Do not run `git pull` without `--ff-only`.** A non-ff pull would merge silently and corrupt the linear history the squash-on-finalize flow assumes.

---

## Step 4 — Conflict check (file-scope overlap)

For each in-progress sibling YAML you read in Step 1, reason about file-scope overlap with the candidate:

- File paths mentioned in `description` / `ac[].title` / `comments[].text` of BOTH cards.
- Module / domain proximity — same source file, same component, same generated artifact.

**Overlap is mutual exclusion, NOT precedence.** "A and B cannot both be In Progress because their work spaces collide" — neither one consumes the other's output. If overlap is detected:

- Emit verdict `conflict_on` with:
  - `reason:` one sentence naming the overlapping module / file.
  - `conflict_with: ["<PREFIX>-X", "<PREFIX>-Y", ...]` listing every overlapping sibling's id.

The worker appends one `{id, reason}` entry per partner to the candidate YAML's `conflict_on[]` (sharing the verdict's `reason` per entry; dedupe by id). The poller's `isAnyKindBlocked` filter (`src/poller/local-issues.ts`) walks `conflict_on[]` in BOTH directions — the gate is symmetric, so you do NOT need to also stamp the partner. The gate auto-resolves the moment the partner reaches terminal status.

**Never emit `waiting_on` for file-scope overlap.** `waiting_on` is the one-way precedence field ("A consumes B's output; A waits for B to ship") — a different semantic. The MCP tool rejects `verdict: "waiting_on"` and `blocked_by:` arg names with an explicit hint pointing at the new names.

If no overlap → continue to Step 5.

---

## Step 5 — Card-itself sanity check (self-stuck check)

Does the candidate describe work that an autonomous agent can perform right now? This is the **self-stuck** check — distinct from the file-scope overlap check in Step 4 (`conflict_on`). Mechanical reasons to block:

- AC items are impossible to satisfy (refer to non-existent files, contradict the description, depend on credentials only a human can rotate).
- Spec is ambiguous in a way that changes the goal of the card or its implementation plan.
- Scope crosses red-line architectural decisions only a human can make.
- Card matches the "Blocked — Hard Gate Before Saving" criteria in `danxbot:issue-card-workflow`.

If any apply → emit verdict `blocked` with a one-sentence reason. The worker stamps `status: "Blocked"` + `blocked: {reason, timestamp}` on the candidate YAML.

Otherwise → emit verdict `ok`.

---

## Step 6 — Emit verdict

Call `mcp__danxbot__danxbot_prep_verdict` **exactly once** with the verdict you reached. Do not loop or retry on the ack; the worker route is idempotent only for the specific dispatch row it carries, so a second call within the same dispatch is a double-stamp.

```
mcp__danxbot__danxbot_prep_verdict({
  verdict: "ok" | "conflict_on" | "blocked" | "abort",
  reason: "<one-sentence justification — non-empty>",
  conflict_with: ["DX-273", "DX-274"],         // actual repo ids — REQUIRED iff verdict === "conflict_on"
  broken_details: { suggested_steps: [...] },  // REQUIRED iff verdict === "abort"
})
```

The `conflict_with` entries above are illustrative. Replace them with the concrete `<PREFIX>-N` ids of the cards your repo uses (e.g. `DX-273`, `SG-12`). The validator rejects the literal placeholder `"<PREFIX>-N"` — it tests each entry against `^${repo prefix}-\d+$`.

The MCP tool returns the worker's ack — the applied side-effects (`conflict_on[]` entries appended, `blocked` record stamped, `agents.<name>.broken` stamped). The ack is informational.

The MCP tool requires the dispatch row to carry `issue_id` for `conflict_on` / `blocked` (the candidate card to stamp) and `agent_name` for `abort` (the agent to mark broken). Both are populated by the poller's standard agent-bound dispatch path; missing either returns a 400 from the worker route — surface the ack message back to the dispatch and stop output instead of retrying.

Reject-on-call patterns the tool surfaces back — do NOT retry on the old shape, fix the call shape and emit the verdict once:

- `verdict: "waiting_on"` → renamed to `conflict_on`. The MCP server rejects with a hint.
- `blocked_by:` arg → renamed to `conflict_with`. Same rejection.
- Empty `reason` → rejected. Always supply a sentence.
- Missing `conflict_with` when `verdict === "conflict_on"` → rejected.
- Missing `broken_details` when `verdict === "abort"` → rejected.

---

## Step 7 — Continuation

After the verdict ack returns:

- **Combined mode** (your prompt contained `/danx-next` after `/danx-prep`):
  - Verdict `ok` → proceed with the `/danx-next` body. The work dispatch runs in the same session.
  - Verdict `conflict_on` / `blocked` / `abort` → DO NOT begin the work body. The worker has already stopped the dispatch via the verdict route. Stop output here.

- **Separate mode** (your prompt contained ONLY `/danx-prep`):
  - For ANY verdict, call `danxbot_complete({status: "completed", summary: "prep <verdict>: <reason>"})` and exit.
  - Exception: for verdict `abort`, the worker route already calls `job.stop("failed", ...)` after applying the broken stamp — the dispatch may finalize before your `danxbot_complete` lands. Either outcome is fine; just call it.

---

## Forbidden patterns inside this skill

Enumerate so a future agent reading this body never reaches for them.

| Pattern | Why forbidden |
|---|---|
| `git stash` / `git stash push` / `git stash pop` | Hides work from the commit history; a subsequent `git reset` or `git clean` discards the stash. Commit-first is the only recovery primitive. |
| `git reset --hard` | Discards uncommitted work irrecoverably. |
| `git checkout <ref>` / `git checkout -- <path>` | Overwrites working-tree state without a commit; same destructive class as reset. |
| `git restore` / `git restore --staged` | Equivalent of `git checkout -- <path>` under the new git CLI. Same prohibition. |
| `git clean -f` (any flags) | Deletes untracked files irrecoverably. |
| `git push --force` / `git push --force-with-lease` | Rewrites remote history; outside the worktree-guard scope but never legitimate from a prep step. |
| Writing to any path outside the worktree | The worktree-guard `PreToolUse` hook rejects this; never attempt to bypass via shell-escapes. Edits go to `<worktree>/...` only. The single approved out-of-worktree write is the Action Items card creation in Step 2 step 6, which goes through `mcp__danx-issue__danx_issue_create` and the watcher mirror, NOT a direct filesystem write. |
| Reading or calling `mcp__trello__*` | Trello is background infrastructure; never agent path. Issues are local YAMLs. |
| Returning a verdict without inspecting the in-progress YAMLs | No "I assume no conflict." Read every YAML with `status: "In Progress"` in Step 1 — verdict accuracy is load-bearing for the poller's two-way conflict gate. |
| Emitting `waiting_on` as the verdict for file-scope overlap | The verdict is `conflict_on`. Use `waiting_on` ONLY when the candidate genuinely consumes the partner's output (one-way precedence). The MCP tool rejects the old verdict name. |
| Emitting `blocked_by:` as the arg name for conflict partners | Renamed to `conflict_with`. The MCP tool rejects the old arg name. |

---

## Why this skill exists

The retired `runConflictCheck` (`src/dispatch/conflict-check.ts`, deleted in DX-297) was a separate Claude dispatch in the shared `issue-worker` workspace, capped at 90s. Three failure modes routinely fired false-positive conflicts:

1. The check's session timed out → conservative `ok: false` → `waiting_on` stamp on the candidate. Pattern observed on DX-273 + DX-274.
2. The check ran in the shared workspace cwd, not the agent's worktree → it could not triage "is my branch ready to take new work?" alongside the file-overlap question.
3. Branch prep was a separate concern (`fetchOrigin` + `validate` + `resetClean`) inside `dispatchWithRecovery` that ran AFTER conflict-check and used a destructive `git reset --hard` on every "clean" path.

This skill collapses all three concerns into a single pre-agent dispatch on the **target agent's worktree** that is read-write only via the commit-first primitive. The legacy two-step gauntlet (conflict-check + recovery + work) is replaced by one prep step followed by the work (combined) or two prep+work dispatches (separate).
