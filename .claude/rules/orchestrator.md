# Orchestrator — Card Processing Workflow

This rule defines how the autonomous agent team processes Trello cards. The `/start-team` and `/next-card` skills trigger this workflow.

## Trello Board

Board ID: `698fc5b8847b787a3818ad82` (always pass as `boardId` to Trello MCP tools)

| List | ID |
|------|----|
| Review | `698fc5bdfa44ac685050fa35` |
| ToDo | `698fc5be16a280cc321a13ec` |
| In Progress | `698fc5c27de7e01f2884f58f` |
| Needs Help | `6990129be21ee37b649281a5` |
| Done | `698fc5c3396c0c24e921e3f5` |
| Cancelled | `698fc5c598cfdb751069f71c` |
| Action Items | `6994dfb6b3e5311d367a289e` |

## Labels

Every card MUST have a label. Apply labels when creating cards or picking them up.

| Label | ID | Use |
|-------|----|-----|
| Bug | `698fc5b8847b787a3818adac` | Defects, crashes, incorrect behavior |
| Feature | `698fc5b8847b787a3818adae` | New functionality, enhancements |
| Epic | `698fc5b8847b787a3818adad` | Parent card split into phases |
| Needs Help | `698fc5b8847b787a3818adaa` | Requires human intervention |

## Card Processing Workflow

YOU are the orchestrator. Do NOT launch a separate orchestrator agent.

### Step 1: Pick Up Card

1. Move card to In Progress (position: `"top"`)
2. If the card has no label, add the appropriate label (Bug or Feature) using `update_card_details`
3. Add a "Progress" checklist with items: Planning, Tests Written, Implementation, Tests Pass, Code Review, Committed

### Step 2: Plan

1. Read the card description, check the card's labels, and fetch all comments using `get_card_comments` (cardId). Comments contain user context, previous investigation results, and clarifications that are essential for understanding the full scope of work.
2. Fetch the "Acceptance Criteria" checklist using `get_acceptance_criteria` (cardId). These criteria were written by the ideator and define what "done" means for this card
3. **For Bug cards:** Investigate the root cause first. Read logs, relevant source files, and error messages. Understand what's broken and why before planning the fix.
4. **Check for Needs Help:** If the task requires human intervention outside the dev environment (changing Slack/Trello settings, external service config, manual account setup, etc.), add the `Needs Help` label using `update_card_details`, add a comment explaining what help is needed with `<!-- flytebot -->` appended at the end, move the card to Needs Help list, and skip this card. The `<!-- flytebot -->` marker is REQUIRED — the poller uses it to distinguish bot comments from user responses.
5. **Detect target repo:** If the card involves changes to an external repo (e.g., platform — Laravel, Vue, migrations, `ssap/`, `mva/`, media kit, etc.), follow the external repo workflow in `.claude/rules/external-repo-workflow.md`. External repo cards use feature branches, push to the external repo, and open PRs instead of committing to flytebot's main branch.
6. Design the implementation approach, ensuring every acceptance criterion is addressed
7. Check off "Planning"

### Step 3: Evaluate Scope

If 3+ phases, different domains, or >500 lines — split into epic:
1. Change the parent card's label to `Epic` using `update_card_details` (labels: `["698fc5b8847b787a3818adad"]`)
2. Add a "Phases" checklist to the epic card with one item per phase
3. Create N new phase cards in **In Progress** (position: `"top"`): `Epic Name > Phase N > Description`
4. Each phase card gets its own description, acceptance criteria, and the appropriate label (Bug or Feature)
5. Add a split comment to the epic card listing all phases
6. Move the epic card to Done
7. Pick up the first phase card from In Progress

**Phase processing:** After completing a phase card, search In Progress for the next phase card (not ToDo). This keeps epic phases prioritized and prevents them from mixing with unrelated ToDo cards.

### Step 4: Implement (TDD)

The orchestrator implements the code directly using strict TDD:

1. **Write failing test** — Create or update test file with tests that verify the expected behavior
2. **Run tests** — `npx vitest run` (flytebot) or `docker compose -f /flytebot/app/docker-compose.yml run --rm platform php artisan test` (platform cards, see `external-repo-workflow.md`) — Confirm the new test fails
3. **Implement** — Write the minimum code to make the test pass
4. **Run tests** — Confirm all tests pass (new AND existing)
5. **Refactor** — Clean up if needed, run tests again
6. **Type check** — `npx tsc --noEmit`

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

Stage and commit changes. Check off "Committed".

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

### Step 9: Self-Terminate

After completing ONE card (or when the card is moved to Needs Help), remove the lock file and terminate the Claude process so the terminal tab closes:

```bash
rm -f .poller-running && kill $PPID
```

**One card per Claude instance.** The poller spawns a fresh Claude process for each card. After completing your card, terminate immediately. Do NOT loop to the next card — the poller handles scheduling. The lock file removal signals the poller that work is complete, and it will spawn a new instance if more cards remain in ToDo.
