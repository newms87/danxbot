# Skill-eval report: investigate:investigate

**Overall: FAIL**

## Parameters

- Eval-set: `/home/newms/web/danxbot/repos/danxbot/.danxbot/worktrees/dani/tests/skill-evals/investigate-investigate/eval-set.json`
- Seed: `1`
- Runs per query: `3`
- Pricing model: `claude-sonnet-4-6`
- Elapsed: `16m 15s`
- Total cost: `~$27.6620`

## Accuracy

| Side  | Correct | Total | Accuracy |
| ----- | ------- | ----- | -------- |
| train | 12 | 12 | 100.00% |
| test | 7 | 8 | 87.50% |

## Failures

### (test) false-positive — `Audit the SQL queries in src/db/issues-mirror.ts and add the missing indexes you find.`

- **Vote:** 2 / 3 runs triggered the expected skill
- **Expected should_trigger:** `false`

Run 1 (jobId=`db10c3f5-58bb-4bfe-b3fc-e1d41aeb26c9`): triggered

```
reason: Skill(investigate:investigate) invoked before first assistant text
observed_skills: investigate:investigate
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/ab6804ef-24fd-4465-9817-58323c93f568.jsonl
```

Run 2 (jobId=`1112661f-d961-4ba1-a66f-fe1a62060911`): triggered

```
reason: Skill(investigate:investigate) invoked before first assistant text
observed_skills: investigate:investigate
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/221609d2-1d57-462e-b332-43bf9647370a.jsonl
```

Run 3 (jobId=`044813f0-43d9-4074-a454-529bd42de122`): did NOT trigger

```
reason: Assistant produced text after invoking dev:debugging — expected investigate:investigate was NOT among them
observed_skills: dev:debugging
first_assistant_text: ## Audit — `src/db/issues-mirror.ts` SQL vs existing indexes

**Goal.** Verify every SQL query in the mirror has a supporting index; add anything missing.

**Queries audited (6 total, all in `createPg
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/b39edda5-9005-480e-b3cd-568505a965bf.jsonl
```

_Last run: 2026-05-14T03:33:42.831Z_
