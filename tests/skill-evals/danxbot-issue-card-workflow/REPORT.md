# Skill-eval report: danxbot:issue-card-workflow

**Overall: FAIL**

## Parameters

- Eval-set: `/home/newms/web/danxbot/repos/danxbot/.danxbot/worktrees/phil/tests/skill-evals/danxbot-issue-card-workflow/eval-set.json`
- Seed: `1`
- Runs per query: `3`
- Pricing model: `claude-sonnet-4-6`
- Elapsed: `2m 13s`
- Total cost: `~$13.8908`

## Accuracy

| Side  | Correct | Total | Accuracy |
| ----- | ------- | ----- | -------- |
| train | 12 | 12 | 100.00% |
| test | 7 | 8 | 87.50% |

## Failures

### (test) false-negative — `Pick up DX-300 and process it through danx-next.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`5772e5c2-0dab-429d-a2a7-c56b9c1b0b8f`): did NOT trigger

```
reason: Session ended after invoking danxbot:danx-next but never matched danxbot:issue-card-workflow
observed_skills: danxbot:danx-next
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-phil--danxbot-workspaces-skill-eval/ad0271fc-ddab-4b38-b970-b78f502dfc9e.jsonl
```

Run 2 (jobId=`41c2b99d-a83c-4186-a29d-71e2df17baee`): did NOT trigger

```
reason: Session ended after invoking danxbot:danx-next but never matched danxbot:issue-card-workflow
observed_skills: danxbot:danx-next
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-phil--danxbot-workspaces-skill-eval/c4a4c574-055e-4334-8e46-f8852b42261b.jsonl
```

Run 3 (jobId=`e221427f-2645-4237-ac15-dd2f5185e319`): did NOT trigger

```
reason: Session ended after invoking danxbot:danx-next but never matched danxbot:issue-card-workflow
observed_skills: danxbot:danx-next
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-phil--danxbot-workspaces-skill-eval/9c6a776c-52f1-4b04-97fc-0a25a57b5df8.jsonl
```

_Last run: 2026-05-14T05:52:18.559Z_
