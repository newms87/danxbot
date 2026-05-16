---
name: danx-prep
description: "MANDATORY when the dispatch prompt begins with `/danx-prep <PREFIX>-N`. Runs the pre-dispatch prep step on the agent's worktree — sibling-relationship check that distinguishes ONE-WAY sequential dep (verdict `waiting_on` + `depends_on`) from SYMMETRIC file-overlap mutex (verdict `conflict_on` + `conflict_with`), uncommitted-work recovery + assignment reshuffle (with a narrow orphan-discard exception), branch sync with conflict-resolve-in-place + push, card sanity check — then emits one or more verdicts via `mcp__danxbot__danxbot_prep_verdict`. Destructive git ops (`git stash`, `git reset --hard`, `git checkout <ref>`, `git restore`, `git clean -f`) remain BANNED except in the one narrow orphan-discard window Step 3 spells out. Self-block via the `agent_blocked` status on `danxbot_complete` when the prep environment itself wedges and a human must intervene."
---

# Danx Prep

You are running because the poller dispatched you with `/danx-prep <PREFIX>-N` (and optionally `/danx-next <PREFIX>-N` on the next line). The candidate card the dispatch picked is the one named in that argument; the worker has already flipped that card's status to `In Progress` before spawning you (auto-flip), so the YAML on disk reads `status: In Progress` even on the very first turn.

The worker also injected the in-progress sibling list into your prompt as a single line:

```
In Progress cards: [<PREFIX>-A, <PREFIX>-B, ...]
```

That list is the work-set against which you check for conflicts in Step 2 — DO NOT enumerate the issues directory yourself.

Your job: bring the worktree to a state where the candidate is safe to work, then emit ONE verdict via `mcp__danxbot__danxbot_prep_verdict`. The worker route applies the YAML / settings side-effects and decides whether the dispatch continues.

**Two prep modes** (per repo via `agentDefaults.prepMode` in `<repo>/.danxbot/settings.json`):

- **Combined** — prompt has `/danx-prep <PREFIX>-N` AND `/danx-next <PREFIX>-N`. Verdict `ok` keeps the dispatch running; you proceed straight into `/danx-next`.
- **Separate** — prompt has only `/danx-prep <PREFIX>-N`. After the verdict you call `danxbot_complete` and exit. Poller re-picks the card next tick for the work dispatch.

Both modes share the same body, the same MCP tools, the same worktree.

## ABSOLUTE BAN — destructive git ops (with ONE narrow exception)

`git stash`, `git stash push`, `git stash pop`, `git reset --hard`, `git checkout <ref>`, `git checkout -- <path>`, `git restore`, `git restore --staged`, `git clean -f`, `git push --force` are FORBIDDEN at every step of this skill — they destroy uncommitted work irrecoverably. The default recovery primitive is **commit first**.

**The ONE narrow exception** — in Step 3, the orphan-discard window: when uncommitted residue matches NO recently-updated card (24h file-timestamp window) AND you are certain the work is incomplete junk that MUST be discarded to recover a valid state — you may run a systematic reset of the modified files. See Step 3 "Branch C (orphan discard)" for the gate.

`git push --force-with-lease` IS allowed in Step 4 after a successful rebase — it is not destructive (it refuses to overwrite remote work the agent has not seen).

User-facing rule reference: `~/web/claude-plugins/dev/skills/git-discipline/SKILL.md` "Never Destroy Work. Ever."

---

## Step 1 — Read context

1. Read the candidate YAML at `<worktree>/.danxbot/issues/open/<PREFIX>-N.yml` to learn the work scope — `description`, `ac[]`, `comments[]`, file paths mentioned anywhere.
2. Parse the `In Progress cards: [...]` line from the prompt body. That is the sibling work-set for Step 2.
3. Read every sibling YAML the line names (skip the candidate's own id). Defensive cap: 20 cards.
4. Run:

   ```bash
   git fetch origin --quiet
   git status --porcelain
   git rev-list --left-right --count origin/main...HEAD
   ```

   Capture: uncommitted-changes set, ahead count, behind count.

This is read-only. No edits, no commits yet.

---

## Step 2 — Conflict check against in-progress siblings

For each sibling YAML you read in Step 1, reason about the relationship with the candidate. **Two distinct gates** apply — pick the right primitive:

### 2a — Sequential phase precedence → `waiting_on`

If the candidate sequentially depends on a sibling (Phase 2 cannot start until Phase 1 has SHIPPED — schema landed, package published, migration run), that is ONE-WAY precedence. The candidate needs the sibling's output to exist before its own work begins; the sibling does NOT need the candidate.

Signals:

- Candidate's `description` / `parent_id` shared-epic context says "Phase N — depends on Phase N-1" / "MUST be complete first" / "needs published validator".
- Sibling card delivers a contract (schema, package, migration, API) the candidate consumes.
- Reverse direction does NOT apply: sibling could ship without the candidate existing.

Emit `waiting_on`:

```
mcp__danxbot__danxbot_prep_verdict({
  verdict: "waiting_on",
  reason: "<one sentence naming the sequential dependency>",
  depends_on: ["<PREFIX>-X", ...],
})
```

The worker stamps `waiting_on: {by: depends_on, reason, timestamp}` on the candidate YAML. The poller's `isEffectivelyWaitingOn` filter skips the candidate while any dep is non-terminal; the picker's Pass A also releases the agent (clear `assigned_agent` + flip status → ToDo) so the agent is free for other work.

### 2b — Symmetric file-overlap mutex → `conflict_on`

If the candidate and a sibling touch the same files / region but NEITHER waits on the other's output, that is symmetric mutual exclusion. Both could ship in either order; they just cannot run concurrently without git rebase carnage.

Signals:

- BOTH cards mention the same source file(s) / module / generated artifact.
- Either could ship first; the second one rebases on the first.
- No "phase ordering" / "must land first" framing in either description.

Emit `conflict_on`:

```
mcp__danxbot__danxbot_prep_verdict({
  verdict: "conflict_on",
  reason: "<one sentence naming the overlapping module/file>",
  conflict_with: ["<PREFIX>-X", "<PREFIX>-Y", ...],
})
```

The worker appends one `{id, reason}` entry per partner to the candidate YAML's `conflict_on[]`. The poller's two-way `isEffectivelyConflicted` filter then skips the candidate while any partner is non-terminal; the picker's Pass A releases the agent (same as waiting_on).

### 2c — Both gates apply

A candidate can be BOTH sequentially dependent on Phase 1 AND symmetrically file-overlapping with sibling Phase 3. Emit both verdicts — separate `danxbot_prep_verdict` calls, one per primitive, with the appropriate partner lists.

### After the verdict

**Abort the rest of this skill on `waiting_on` / `conflict_on`.** Do not touch any files, do not sync, do not commit. The worker stops the dispatch and releases the claim.

If no gate applies → continue to Step 3.

---

## Step 3 — Uncommitted work recovery + assignment reshuffle

If `git status --porcelain` from Step 1 is empty → skip to Step 4.

If non-empty, you have residue from a prior session. Default: **commit it on the agent's branch** — never stash, never reset, except in the narrow orphan-discard window below.

Identify the residue's owner card by scoring every YAML under `<worktree>/.danxbot/issues/{open,closed}/` against the modified-path set, restricted to YAMLs whose **most recent file timestamp (YAML mtime) is within the last 24h**:

- Direct mention of any modified path in `description` / `comments[].text` / `ac[].title` → **+3 per path**.
- YAML's `assigned_agent` equals your agent name (from the persona block) → **+2**.
- YAML's most recent comment / history timestamp is within the last 24h → **+1**.

Tie-breaker: most recent activity first; if still tied, lowest `<PREFIX>-N`.

### Branch A — winner found (highest score > 0)

The residue belongs to a real card. Do the assignment reshuffle so the poller's invariants stay consistent.

1. **Unassign yourself from the candidate** the dispatch picked: Edit `<worktree>/.danxbot/issues/open/<PREFIX>-N.yml` to set `assigned_agent: null` AND `status: ToDo` (revert the auto-flip the worker just performed — the candidate is going back into the pool).
2. **Assign yourself to the resolved owner card** (the winner). Edit that YAML to `assigned_agent: <your-agent-name>` AND `status: In Progress`.
3. **Append a recovery comment** to the owner card explaining: residue files, score, what you intend to do with the work (finish vs commit-as-WIP for human review). Use markdown.
4. Decide what to do with the residue:
   - **If the work is complete and you can verify it (passes tests, matches the card's AC)** — commit it cleanly with a real commit message describing the finished work.
   - **If the work is partial but coherent** — commit it as `wip:` so the next session can resume.
   - **If you cannot decide** — commit as `wip:` and emit verdict `blocked` after this step with a clear reason for the next agent / operator.
5. `git add -A && git commit -m "<message>"`. Push when you reach Step 4.
6. Proceed to Step 4 — but note that the candidate id you were dispatched on has changed. The verdict you emit at Step 6 still references the ORIGINAL candidate the dispatch picked (the prep route reads `issue_id` off the dispatch row).

### Branch B — no winner (orphan, OR all candidates outside 24h window)

The residue references no recently-updated card. You have two paths:

#### Branch B.1 — File an Action Items orphan card (default)

1. `mcp__danx-issue__danx_issue_create` an Action Items / Bug card titled "Investigate orphan uncommitted work — recovered by danx-prep" with file list + score table in the description.
2. **Unassign yourself from the candidate** (set `assigned_agent: null` + `status: ToDo` on the candidate YAML).
3. Append a recovery comment to the new orphan card describing what you found.
4. `git add -A && git commit -m "wip: recovered orphan uncommitted work — see <new-PREFIX>-N"`.
5. Proceed to Step 4.

#### Branch B.2 — Narrow orphan-discard window (RARE)

ALL of the following gates MUST hold:

1. No YAML (open OR closed) scored above 0 in the 24h window.
2. The modified files do NOT form a coherent change — partial edits, half-finished scaffolding, broken syntax, debug output left behind.
3. Keeping the residue would corrupt the next agent's view of the codebase (e.g., a half-applied refactor that would mislead reading-the-code).
4. You can state in one sentence WHY this residue is junk.

When ALL four gates hold, you may discard the residue via systematic per-file reset — the worktree-guard hook still rejects `git reset --hard` / `git clean -f`, so work within what's allowed:

- For tracked files with modifications: `git checkout HEAD -- <file>` for EACH path individually (the worktree-guard hook permits per-path checkout in this prep skill's narrow case — single-file reverts of TRACKED paths are allowed; whole-tree `git reset --hard` is not).
- For untracked files: `rm <file>` for each path individually.

Steps in order:

1. Append a comment to a fresh Action Items card via `danx_issue_create` documenting WHAT was discarded + WHY — the audit trail survives the discard.
2. **Unassign yourself from the candidate** (set `assigned_agent: null` + `status: ToDo`).
3. Per-file checkout / rm to clear the residue.
4. Verify `git status --porcelain` is now empty.
5. Proceed to Step 4.

If you cannot articulate WHY in step 4 of the gate, you are not in Branch B.2 — fall back to Branch B.1 and let a human decide.

### Post-Step-3 invariant

After Branch A / B.1 / B.2 completes, `git status --porcelain` MUST be empty. If anything remains, emit verdict `blocked` with reason `"Step 3 recovery did not zero the working tree — manual inspection required"` and stop here.

---

## Step 4 — Branch sync (DO NOT ABORT — resolve conflicts in place)

Read `ahead` and `behind` from Step 1's `git rev-list --left-right --count`.

| Pair | Action |
|---|---|
| `ahead=0, behind=0` | No-op. Branch is at `origin/main`. Skip to Step 5. |
| `ahead=0, behind>0` | `git pull --ff-only origin main`. Then push: `git push` (no force needed — your branch was an ancestor). |
| `ahead>0` | `git rebase origin/main`. **If conflicts surface, RESOLVE THEM IN PLACE.** Read each conflicted file, reconcile the two sides using your understanding of both the candidate work AND the upstream change, `git add <file>`, `git rebase --continue`. Repeat until rebase reports `Successfully rebased`. Then `git push --force-with-lease`. |

**DO NOT `git rebase --abort`.** No one else is going to resolve these conflicts — if you cannot resolve them, no one can. Work through them file by file using semantic understanding.

Only escalate to verdict `agent_blocked` (Step 5 self-block path) if a conflict involves a region where you genuinely cannot tell which side is correct — for example, a half-finished refactor on `main` that contradicts your work and you can't reconstruct intent from either side. Document the exact file + region in the `summary` of the self-block.

After every successful sync + push, re-run `git rev-list --left-right --count origin/main...HEAD` — pair MUST be `0\t0`. If not, emit `agent_blocked` with the diagnostic.

**`git pull --ff-only` only.** Never `git pull` without `--ff-only` — a non-ff pull would merge silently and corrupt the linear history downstream flows depend on.

**`git push --force-with-lease` only**, never `git push --force`. `--force-with-lease` refuses to overwrite remote SHAs the agent has not seen, so a concurrent push (rare on agent-owned branches but possible) refuses cleanly instead of stomping.

---

## Step 5 — Self-stuck check (card sanity)

Does the candidate describe work an autonomous agent can perform right now? Mechanical reasons to escalate:

- AC items are impossible to satisfy (refer to non-existent files, contradict the description, depend on credentials only a human can rotate).
- Spec is ambiguous in a way that changes the goal of the card.
- Scope crosses red-line architectural decisions only a human can make.
- Card matches the "Blocked — Hard Gate Before Saving" criteria in `danxbot:issue-card-workflow`.

If any apply — **load the `danxbot:issue-blocker` skill first**. Its 8-item gating checklist distinguishes a real human-only block from a punt. Only if the gate passes:

- For card-itself stuckness → emit verdict `blocked` (Step 6).
- For prep-environment failure (your worktree is wedged, branch sync failed irrecoverably, MCP tool unreachable) → call `danxbot_complete({status: "agent_blocked", summary: "<one-sentence reason>"})` directly INSTEAD of emitting a verdict. The MCP server stamps `blocked: {at: <now ISO>, reason: summary}` on the candidate YAML (status derives to `Blocked` via `deriveStatus` rule 3) and terminates the dispatch as failed. Use this when you got past Step 2 / 3 / 4 but the environment will not let you proceed safely.

Otherwise → continue to Step 6 with verdict `ok`.

---

## Step 6 — Emit verdict

Call `mcp__danxbot__danxbot_prep_verdict` **once per verdict**. Most preps emit exactly one; cards that hit BOTH gates from Step 2 (sequential dep + symmetric overlap) emit two separate calls.

```
mcp__danxbot__danxbot_prep_verdict({
  verdict: "ok" | "conflict_on" | "waiting_on" | "blocked" | "abort",
  reason: "<one-sentence justification — non-empty>",
  conflict_with: ["<PREFIX>-X"],           // REQUIRED iff verdict === "conflict_on"
  depends_on:    ["<PREFIX>-Y"],           // REQUIRED iff verdict === "waiting_on"
  broken_details: { suggested_steps: [] }, // REQUIRED iff verdict === "abort"
})
```

The MCP tool requires the dispatch row's `issue_id` for `conflict_on` / `waiting_on` / `blocked`, and `agent_name` for `abort`. Both are populated by the poller. The route returns the applied side-effects (`conflict_on[]` entries appended, `waiting_on` stamped, `blocked` record stamped, `agents.<name>.broken` stamped).

Picking the right verdict:

- `conflict_on` — SYMMETRIC mutex (Step 2b). Both cards touch the same files; either could ship first.
- `waiting_on` — ONE-WAY precedence (Step 2a). Candidate consumes the partner's output (schema, package, migration); reverse is not true.
- `blocked` — the CARD ITSELF is stuck (spec ambiguous, AC contradictory, missing context). Distinct from `agent_blocked` (env-broken, see Step 5).
- `abort` — the PREP environment is broken (Bash unavailable, MCP unreachable mid-prep). Operator must clear `agents.<name>.broken`.
- `ok` — no gate fires; proceed to work.

Reject-on-call patterns the tool surfaces back:

- `blocked_by:` arg → use `conflict_with` (symmetric) or `depends_on` (sequential) instead — error message lists both.
- Empty `reason` → rejected.
- Missing `conflict_with` when `verdict === "conflict_on"` → rejected.
- Missing `depends_on` when `verdict === "waiting_on"` → rejected.
- Missing `broken_details` when `verdict === "abort"` → rejected.

---

## Step 7 — Continuation

After the verdict ack returns:

- **Combined mode** (prompt contained `/danx-next` after `/danx-prep`):
  - `ok` → proceed with `/danx-next`. Work dispatch continues in the same session.
  - `conflict_on` / `waiting_on` / `blocked` / `abort` → DO NOT begin the work body. The worker already stopped the dispatch (and on `conflict_on` / `waiting_on` the picker has released your `assigned_agent` claim — that is expected). Stop output here.

- **Separate mode** (prompt contained only `/danx-prep`):
  - ANY verdict → call `danxbot_complete({status: "completed", summary: "prep <verdict>: <reason>"})` and exit.
  - Exception: for `abort`, the worker route may have already called `job.stop("failed", ...)`. Call `danxbot_complete` anyway; the second call is idempotent on a terminal row.

---

## Forbidden patterns inside this skill

| Pattern | Why forbidden |
|---|---|
| `git stash` / `git stash push` / `git stash pop` | Hides work from the commit history; subsequent reset or clean discards the stash. Commit-first only. |
| `git reset --hard` (any flags) | Discards uncommitted work irrecoverably. The narrow orphan-discard window in Step 3 uses per-file `git checkout HEAD -- <file>` / `rm`, NOT whole-tree reset. |
| `git clean -f` (any flags) | Deletes untracked files irrecoverably. Step 3 B.2 uses per-file `rm` only. |
| `git checkout <ref>` (branch / commit switch) | Discards uncommitted work. Distinct from per-file `git checkout HEAD -- <path>` which IS allowed in Step 3 B.2. |
| `git rebase --abort` | NEVER abort a Step 4 rebase. Resolve conflicts in place file by file. Escalate to `agent_blocked` only when a region is genuinely unreconcilable. |
| `git push --force` (no `--force-with-lease`) | Stomps any concurrent remote push. Step 4 uses `--force-with-lease` after rebase. |
| Enumerating `<worktree>/.danxbot/issues/open/*.yml` for the sibling list | The worker pre-resolved the list and injected `In Progress cards: [...]` into your prompt body. Parse the line; do not search. |
| `mcp__trello__*` | Trello is background infrastructure. Issues are local YAMLs. |
| Returning a verdict without inspecting the siblings in `In Progress cards: [...]` | Verdict accuracy is load-bearing for the poller's two-way conflict gate. |
| Emitting `conflict_on` for a sequential phase dep ("Phase 2 needs Phase 1 to ship first") | That is one-way precedence — emit `waiting_on` + `depends_on`. `conflict_on` is the SYMMETRIC mutex for same-file overlap. |
| Emitting `waiting_on` for symmetric file overlap ("Phase 2 and Phase 3 touch the same files") | That is symmetric mutex — emit `conflict_on` + `conflict_with`. `waiting_on` is for sequential precedence. |

---

## Self-block via `agent_blocked` (Step 5 detail)

`danxbot_complete({status: "agent_blocked", summary})` is the agent's self-block primitive when the prep ENVIRONMENT (not the candidate's spec) wedges. The MCP server requires the dispatch row to carry `issue_id` — the worker stamps `blocked: {at: <now ISO>, reason: summary}` on that card's YAML (status derives to `Blocked` via `deriveStatus` rule 3) and ends the dispatch as `failed`.

Use this only when:

- You completed Step 2 (conflict check passed) AND Step 3 (working tree zeroed).
- Step 4 sync hit an unreconcilable rebase conflict you cannot semantically resolve, OR a downstream tool / MCP repeatedly errored after exhaustion of in-session retries.
- Load the `danxbot:issue-blocker` plugin skill FIRST — its 8-item gate guards against punting.

The `summary` becomes the `blocked.reason` verbatim. Make it one sentence stating the exact wedge: "Rebase conflict in `src/foo.ts:42` between candidate's rename and main's deletion — neither side has enough context to reconstruct intent."

For card-itself stuckness (impossible AC, ambiguous spec) — use the `blocked` verdict in Step 6 instead. The two paths land at the same on-disk state (`blocked: {at, reason}` stamped → derived status `Blocked`) but the verdict path is the right semantic when you have not yet entered the work body.

---

## Why this skill exists

Replaces the retired `runConflictCheck` + `dispatchInRecoveryMode` precursor pair (DX-297). Three failure modes those introduced:

1. The conflict check ran in a separate 90s-capped session → timeouts produced false-positive partner stamps (DX-273, DX-274).
2. The check ran in the shared `issue-worker` workspace cwd, not the agent's worktree — could not reason about branch state.
3. Recovery was a destructive `git reset --hard` on every "clean" path → silent loss of work.

This skill collapses all three concerns into a single pre-agent dispatch on the **agent's worktree** that uses commit-first as the only recovery primitive (with the one narrow orphan-discard exception spelled out above), resolves rebase conflicts in place, and pushes after sync so concurrent agents see a consistent remote.
