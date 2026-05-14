# Skill-eval report: dev:git-discipline

**Overall: FAIL**

## Parameters

- Eval-set: `/home/newms/web/danxbot/repos/danxbot/.danxbot/worktrees/murphy/tests/skill-evals/dev-git-discipline/eval-set.json`
- Seed: `1`
- Runs per query: `3`
- Pricing model: `claude-sonnet-4-6`
- Elapsed: `6m 22s`
- Total cost: `~$16.5513`

## Accuracy

| Side  | Correct | Total | Accuracy |
| ----- | ------- | ----- | -------- |
| train | 9 | 12 | 75.00% |
| test | 4 | 8 | 50.00% |

## Failures

### (train) false-negative — `Cherry-pick commit abc123 from feature/foo onto main.`

- **Vote:** 1 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`af4ff992-818b-461d-b4bc-f9d81bfe9c8e`): triggered

```
reason: Skill(dev:git-discipline) invoked before first assistant text
observed_skills: dev:git-discipline
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/91c6ba0e-426a-4354-8889-68d969c82617.jsonl
```

Run 2 (jobId=`937ed48e-9b40-4fd8-8fe8-5b1c1e29e056`): did NOT trigger

```
reason: Session ended without any Skill tool_use — expected dev:git-discipline
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/683ca97c-2a48-4bb3-96cb-f17185c8cca4.jsonl
```

Run 3 (jobId=`error-jsonl-not-found-2`): did NOT trigger

```
reason: probe error (jsonl-not-found): scanned 23 JSONL file(s) in /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval; none contained dispatch tag <!-- danxbot-dispatch:7b810f07-4388-4b1a-8118-e2e9b69d3128 -->
```

### (train) false-negative — `Run `git stash` to set aside the WIP changes while I check out main.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`226ac377-a41a-4a68-a25b-b8b51371cfb0`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Refuse. `git stash` forbidden per `dev:git-discipline` + agent-dispatch forbidden-patterns row — destroys uncommitted work irrecoverably.

Safer: commit WIP to current branch.

```
git add -A && git c
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/0138c661-25e0-4901-a57b-a0c5004815e1.jsonl
```

Run 2 (jobId=`8d542bdc-124f-4dd5-9843-ea865217c7d9`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Refuse. `git stash` forbidden per `dev:git-discipline` + danxbot rules — destroys uncommitted work class. Commit-first only.

Options:
1. `git commit -am "wip"` on current branch → `git checkout main`
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/46689575-1df6-42ee-918e-f0b62b3228d4.jsonl
```

Run 3 (jobId=`b6eb583f-787a-4674-b2dd-9e0da5aee5f0`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Refuse. `git stash` forbidden in this repo — destroys uncommitted work (agent-dispatch.md "Never Destroy Work"). Forbidden list also bans `checkout <ref>`, `restore`, `reset --hard`, `clean -f`.

WIP 
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/69d9a5c5-f331-4787-8c0a-eb84c01ccb06.jsonl
```

### (train) false-negative — `Clean up untracked files with `git clean -fd`.`

- **Vote:** 1 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`a8a819ae-50c3-4bb9-8c98-9060d5820b87`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Refuse. `git clean -fd` destructive — destroys untracked work irrecoverably. Forbidden in dispatch/worktree paths per `.claude/rules/agent-dispatch.md`.

Current untracked/modified per git status:
- `
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/d86c8217-0d27-405a-af1e-db09605b77c4.jsonl
```

Run 2 (jobId=`ac2eaf20-08d7-419a-9b12-514035248128`): triggered

```
reason: Skill(dev:git-discipline) invoked before first assistant text
observed_skills: dev:git-discipline
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/a4c2fc37-f0a1-40b0-8950-343a390d9cbe.jsonl
```

Run 3 (jobId=`e446f10b-80a4-405f-9f61-088f7e282bc5`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Refuse. `git clean -fd` destructive, forbidden by rules without explicit per-action auth + may nuke uncommitted work (forbidden pattern in agent-dispatch.md).

Status check:
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/3c2dd772-acf7-45a7-bea6-6140367b1c8f.jsonl
```

### (test) false-negative — `Run `git restore src/agent/launcher.ts` to discard the local edits.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`977f51ba-b8ba-4f09-9f11-69740536679e`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Destructive git op. Load skill first.
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/e3ca3793-d676-44fc-806e-33eedabae277.jsonl
```

Run 2 (jobId=`a1d8362b-6d24-4e7a-b236-92952a487ad7`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Destructive op. Load skill first.
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/f3e480bb-f973-4c89-8c4d-311ed933b609.jsonl
```

Run 3 (jobId=`5eecd95a-8235-4968-a1fd-ff37d382eed3`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Hold. `git restore` destroys uncommitted work irrecoverably — forbidden pattern per agent-dispatch.md. Also git status shows no edits on `src/agent/launcher.ts`:

```
M ../../../src/skill-eval/probe.t
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/a4b92050-9e31-45d1-a020-32a0447c31c6.jsonl
```

### (test) false-negative — `Run `git reset --hard HEAD~3` to drop the last three commits.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`b14a2908-66fc-4174-a920-c5415c2b47ad`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Refuse. `git reset --hard` destroys uncommitted work + drops commits irrecoverably. Forbidden per `dev:git-discipline` + `danxbot:no-false-blockers` (destructive working-tree ops blacklist).

Current 
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/79ff6ce7-a78d-4586-bfef-0522bda394a5.jsonl
```

Run 2 (jobId=`0e64d597-38fc-46e2-9c25-3c4b3295b5f2`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Skill load required → `dev:git-discipline` before any git op.
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/8422e7b0-4501-4e69-85ba-b80d3291e100.jsonl
```

Run 3 (jobId=`7f44a587-8a3d-4d6b-a215-933a70723b3a`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Refuse. `git reset --hard` destroys uncommitted work + rewrites history — forbidden per `dev:git-discipline` + agent-dispatch forbidden-patterns table. No standing authorization for destructive ops.


jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/d3814819-c9de-4ecc-8e16-7a1e5535a3d4.jsonl
```

### (test) false-negative — `Dispatch a subagent with isolation: "worktree" to run the refactor in parallel.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`f17843de-c6a8-4b5b-a07d-ff9872ba1d0d`): did NOT trigger

```
reason: Assistant produced text after invoking base:sub-agent-delegation — expected dev:git-discipline was NOT among them
observed_skills: base:sub-agent-delegation
first_assistant_text: No refactor context this session. What refactor, which files?

Also git status shows local mods to `src/skill-eval/probe.ts` + `.test.ts` on `murphy` worktree — worktree-isolated subagent forks from H
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/6afaaea8-bf83-4352-966d-ecc8689e0824.jsonl
```

Run 2 (jobId=`bd1fe7f3-ca47-4f1c-8482-d5e9e8241115`): did NOT trigger

```
reason: Assistant produced text after invoking base:sub-agent-delegation — expected dev:git-discipline was NOT among them
observed_skills: base:sub-agent-delegation
first_assistant_text: No refactor specified. What refactor? Which files/scope?

Also: worktree dispatch needs clear synthesis output — passthrough Read/Edit not justified vs inline edit.
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/74acaa57-62f8-4565-bb31-a8f6fb79c1bd.jsonl
```

Run 3 (jobId=`def8d68d-1098-40eb-aa7a-5de814f6ba18`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Refactor scope unclear. Which files/goal?
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/bb139487-ebd7-4b8b-ada8-f6b027cd4c5d.jsonl
```

### (test) false-negative — `Commit the changes to src/skill-eval/run.ts with message 'feat(DX-312): add --dry-run flag'.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`86f7fc00-35a4-4d2c-89eb-9767ce4beb8c`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: No `src/skill-eval/run.ts` in changes. Files modified: `.danxbot/.gitignore`, `src/cron/audit-pass.ts`, `src/inject/sync.ts`, `src/issue/reconcile.ts`, `tests/skill-evals/investigate-investigate/REPOR
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/c887c378-4121-4dea-b7da-be9361eaea73.jsonl
```

Run 2 (jobId=`ea9d4933-00b1-41b5-8bb2-73aac6fc6d52`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: No `src/skill-eval/run.ts` change. Modified files: `probe.ts` + `probe.test.ts`. Confirm before committing wrong-message commit?
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/28f774ab-7e46-48f9-8cb7-9c4b7ff1d0d9.jsonl
```

Run 3 (jobId=`45dd4761-4b7b-4dbf-ab21-24eada3e2dbc`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Mismatch. No changes to `src/skill-eval/run.ts`. Modified files: `src/skill-eval/probe.ts` + `probe.test.ts`.

Want me to:
1. Commit probe.ts + probe.test.ts under that message (wrong files, misleadin
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-murphy--danxbot-workspaces-skill-eval/df728fdf-9ad1-43b9-ad0a-342d87ec40bf.jsonl
```

_Last run: 2026-05-14T03:11:10.644Z_
