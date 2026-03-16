# Orchestrator — Card Processing Workflow

This rule defines how the autonomous agent team processes Trello cards. The `/start-team` and `/next-card` skills trigger this workflow.

## Config Sources

- **Trello IDs:** `.claude/rules/trello-config.md` (auto-generated from env vars by the poller)
- **Repo config:** `.claude/rules/repo-config.md` (auto-generated from `repo-config.yml` by the poller)

Reference these files for all board/list/label IDs and repo commands. Never hardcode IDs or commands.

Every card MUST have a label. Apply labels when creating cards or picking them up.

## Card Processing Workflow

YOU are the orchestrator. Do NOT launch a separate orchestrator agent.

### Step 1: Pick Up Card

1. Move card to In Progress (position: `"top"`)
2. If the card has no label, add the appropriate label (Bug or Feature) using `update_card_details`
3. Add a **Progress** checklist with items: Planning, Tests Written, Implementation, Tests Pass, Code Review, Committed

### Step 2: Plan

1. Read the card description, check the card's labels, and fetch all comments using `get_card_comments` (cardId). Comments contain user context, previous investigation results, and clarifications that are essential for understanding the full scope of work.
2. Fetch the "Acceptance Criteria" checklist using `get_acceptance_criteria` (cardId). These criteria were written by the ideator and define what "done" means for this card
3. **For Bug cards:** Investigate the root cause first. Read logs, relevant source files, and error messages. Understand what's broken and why before planning the fix.
4. **Check for Needs Help:** If the task requires human intervention outside the dev environment (changing Slack/Trello settings, external service config, manual account setup, etc.), add the `Needs Help` label using `update_card_details`, add a comment explaining what help is needed with `<!-- danxbot -->` appended at the end, move the card to Needs Help list, and skip this card. The `<!-- danxbot -->` marker is REQUIRED — the poller uses it to distinguish bot comments from user responses.
5. **Detect target repo:** Determine whether changes target danxbot (`src/`) or the connected repo (`repos/<name>/`). A card targets the connected repo when its description references that repo's domain, framework, models, components, or directories. When targeting the connected repo, follow `.claude/rules/repo-workflow.md` — edit files at `repos/<name>/`, use feature branches, and open PRs instead of committing to danxbot's main branch. Read `.claude/rules/repo-config.md` for the repo name, paths, and commands.
6. Design the implementation approach, ensuring every acceptance criterion is addressed
7. Check off "Planning"

### Step 3: Evaluate Scope

If 3+ phases, different domains, or >500 lines — split into epic:
1. Change the parent card's label to `Epic` using `update_card_details` (read the Epic label ID from `.claude/rules/trello-config.md`)
2. Add a "Phases" checklist to the epic card with one item per phase
3. Create N new phase cards in **In Progress** (position: `"top"`): `Epic Title > Phase N: Description`
4. Each phase card gets its own description, acceptance criteria, and the appropriate label (Bug or Feature)
5. Add a split comment to the epic card listing all phases
6. Move the epic card to Done
7. Pick up the first phase card from In Progress

**Phase processing:** After completing a phase card, search In Progress for the next phase card (not ToDo). This keeps epic phases prioritized and prevents them from mixing with unrelated ToDo cards.

### Step 4: Implement (TDD)

The orchestrator implements the code directly using strict TDD:

1. **Write failing test** — Create or update test file with tests that verify the expected behavior
2. **Run tests** — Confirm the new test fails. For danxbot: `npx vitest run`. For connected repo cards: read the test command from `.claude/rules/repo-config.md` and run it via the method described in `.claude/rules/repo-workflow.md`
3. **Implement** — Write the minimum code to make the test pass
4. **Run tests** — Confirm all tests pass (new AND existing)
5. **Refactor** — Clean up if needed, run tests again
6. **Type check** — `npx tsc --noEmit` (danxbot only; for connected repo, read type_check command from repo-config.md — skip if empty)

**Documentation-only changes** (README, comments, docs): Skip TDD — just make the edit directly. Check off "Tests Written", "Implementation", "Tests Pass" together.

For large-scale repetitive edits (renaming across many files, pattern upgrades, etc.), launch a `batch-editor` subagent via the Task tool.

Check off "Tests Written", "Implementation", "Tests Pass".

### Step 5: Quality Gates

Launch in parallel via Task tool with `mode: "bypassPermissions"`:
- **test-reviewer**: Audit test coverage
- **code-reviewer**: Check code quality
- **validator**: Only if changes touch `src/agent/`, Claude SDK, or router

**Post results to Trello:** After each reviewer completes, post their output as a Trello comment using `add_comment`. Format the comment with a header identifying the reviewer:
- Test reviewer: `## Test Review\n\n{output}`
- Code reviewer: `## Code Review\n\n{output}`
- Validator: `## Validation\n\n{output}`

If critical issues are found, fix them directly and re-run the failed gate. After fixing, post a follow-up comment summarizing what was addressed: `## Review Fixes\n\n{summary of changes made}`.

Check off "Code Review".

### Step 6: Check Off Acceptance Criteria

After implementation and quality gates pass, verify each acceptance criterion is satisfied and check them off using `update_checklist_item` (cardId, checkItemId, state: "complete"). All acceptance criteria MUST be checked off before committing.

### Step 7: Commit

**For danxbot cards:** Stage and commit changes directly.

**For connected repo cards:** Follow the git workflow in `.claude/rules/repo-workflow.md`:
1. Create feature branch (`danxbot/<kebab-case>`)
2. Stage and commit
3. Push to origin
4. Create PR via `gh pr create`
5. Return to main branch

Check off "Committed".

### Step 8: Complete

1. Move card to Done (position: `"top"`)
2. **For Bug cards:** Add a "Bug Diagnosis" comment with: Problem (what the user saw), Root Cause (why it happened), Solution (what was changed and why)
3. Add a retro comment using this exact format:

```
## Retro

**What went well:** [1-2 sentences about what worked]

**What went wrong:** [1-2 sentences about problems, or "Nothing"]

**Action items:** [Improvements for next iteration, or "Nothing"]

**Commits:** [commit sha(s)]
```

4. **Create Action Item cards:** If the retro has action items (not "Nothing"), create a new card in the **Action Items** list for each action item:
   - Card name: The action item text
   - Card description: `Action item from [card name](card URL).\n\n**Context:** [1 sentence explaining why this action item was created]`
   - After creating the card, update the retro comment to include links: replace each action item with `[action item text](new card URL)`

### Step 9: Self-Termination Check (MANDATORY)

**This step is MANDATORY after every card completion or Needs Help move. Never skip it.**

1. Run `echo $DANXBOT_EPHEMERAL` to check the environment variable
2. If the output is `1`: execute `rm -f .poller-running && kill $PPID` immediately
3. If the output is NOT `1`: do nothing (interactive session)

**Never assume you know the session type.** Always run the check. The poller sets `DANXBOT_EPHEMERAL=1` when spawning temporary sessions. Interactive sessions (user-invoked `/next-card`) do NOT have this set. The only way to know is to check — guessing is a workflow violation.

**One card per Claude instance.** The poller spawns a fresh Claude process for each card. After completing your card, terminate immediately. Do NOT loop to the next card — the poller handles scheduling. The lock file removal signals the poller that work is complete, and it will spawn a new instance if more cards remain in ToDo.
