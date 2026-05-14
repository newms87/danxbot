# Skill-eval report: danxbot:issue-card-workflow

**Overall: FAIL**

## Parameters

- Eval-set: `/home/newms/web/danxbot/repos/danxbot/.danxbot/worktrees/dani/tests/skill-evals/danxbot-issue-card-workflow/eval-set.json`
- Seed: `1`
- Runs per query: `3`
- Pricing model: `claude-sonnet-4-6`
- Elapsed: `1m 36s`
- Total cost: `~$0.0000`

## Accuracy

| Side  | Correct | Total | Accuracy |
| ----- | ------- | ----- | -------- |
| train | 6 | 12 | 50.00% |
| test | 4 | 8 | 50.00% |

## Failures

### (train) false-negative — `Add a comment to issue card DX-279 summarizing today's progress.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`56e05cb5-6ff0-4657-b137-99d648d2b1b7`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/f5fa3940-a638-4845-9d15-c7a2ab000c09.jsonl
```

Run 2 (jobId=`a4ef436f-eb2e-41fa-8e0d-1eed4b951b97`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/72284e06-c458-4b49-9040-b1af9e0171b1.jsonl
```

Run 3 (jobId=`8eb825e4-44d0-45e5-b3f6-7984e60398d6`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/82a3133a-61fd-4c9d-b91a-6fe500af56f2.jsonl
```

### (train) false-negative — `Create a ticket for the missing test coverage on src/worker/auto-sync.ts.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`a596aba6-ce23-4d5b-b9d8-31dac3e14150`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/8d687ea5-3bfc-4164-897a-500ab40ee5da.jsonl
```

Run 2 (jobId=`fe53f360-db9e-4e65-b2d7-a106deba81fe`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/07e50864-6834-4a42-a842-eceaf482ad24.jsonl
```

Run 3 (jobId=`c619f63c-1706-4997-919f-39a598507c18`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/68bf3a63-73e4-4bd0-8ca7-9fc5717ba4fe.jsonl
```

### (train) false-negative — `Split this large feature into phases — each phase its own separate card under a new epic.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`a1c62e2e-79e1-44d3-886b-6ccf0759074b`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/686f2af1-543a-4ae0-ba84-472483f2327c.jsonl
```

Run 2 (jobId=`acf0593b-0269-4c6a-b343-e359c46e23b6`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/7ef849e1-a8e3-4e21-8c2c-259996d32fe3.jsonl
```

Run 3 (jobId=`error-jsonl-not-found-2`): did NOT trigger

```
reason: probe error (jsonl-not-found): scanned 1884 JSONL file(s) in /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval; none contained dispatch tag <!-- danxbot-dispatch:de38fdcf-007b-430f-b829-ad16965bde77 -->
```

### (train) false-negative — `Make a card for the bug where dispatches occasionally produce duplicate retro comments.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`1832e3e0-c050-4e73-9c02-b38a6ce287bf`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/a568fc28-a41c-4505-8510-23236d0997f9.jsonl
```

Run 2 (jobId=`817bd09c-62e2-4f33-87fe-ed2732d4d05e`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/9bf84ea5-961b-4847-9b3b-34bfee2df734.jsonl
```

Run 3 (jobId=`015c03b5-ae81-418c-b40b-4748f9357a60`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/10400474-a29c-44d8-85dd-22dda12d35cb.jsonl
```

### (train) false-negative — `Create an epic for the new authentication overhaul and split it into 4 phase cards.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`8185f6d7-72d0-4aa4-a6cf-f10ebd03855f`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/9612e26b-980f-4228-b7a3-7234ed7a8103.jsonl
```

Run 2 (jobId=`9df908a5-d339-4089-a299-69b1e8622dcd`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/bad13404-a1ed-4209-b935-2f28235cfb8d.jsonl
```

Run 3 (jobId=`1d640f9e-42e0-41ac-8d97-bc4828c404f7`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/0566198b-f7d7-4bbb-9869-c60890c51d3f.jsonl
```

### (train) false-negative — `Read the YAML at .danxbot/issues/open/DX-244.yml and tell me what work is left on it.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`847f33d5-79b8-4871-bb40-261744327055`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/94bd1824-a46e-40a8-9a8e-29c0c7653d04.jsonl
```

Run 2 (jobId=`4dfb742e-726e-453f-8cd9-8fe1f979c42f`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/030b59c9-c65d-435f-b6b4-dba66dc1a14b.jsonl
```

Run 3 (jobId=`6a0ce382-ec03-4133-bc5a-555637fa7000`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/ee028ad9-0f30-42e8-a8d1-f922f106296a.jsonl
```

### (test) false-negative — `Write a draft YAML for a Bug card and call mcp__danx-issue__danx_issue_create on it.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`error-jsonl-not-found-0`): did NOT trigger

```
reason: probe error (jsonl-not-found): scanned 1884 JSONL file(s) in /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval; none contained dispatch tag <!-- danxbot-dispatch:31ba419f-f8f6-4878-996d-b203d59f61af -->
```

Run 2 (jobId=`error-jsonl-not-found-1`): did NOT trigger

```
reason: probe error (jsonl-not-found): scanned 1884 JSONL file(s) in /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval; none contained dispatch tag <!-- danxbot-dispatch:4834af52-bfe5-4642-aa07-8b327a5954f6 -->
```

Run 3 (jobId=`b05c562b-9443-4cb0-a82b-72c8c7536c0f`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/9bb1b9d6-a48c-40e0-8be1-be52d1808982.jsonl
```

### (test) false-negative — `Move DX-99 from ToDo to Blocked and populate the blocked record with a reason.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`a147d510-fc06-4d5a-8b3b-42aedbbdcc9a`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/79dd65cf-51fe-4c33-a497-02e89faab587.jsonl
```

Run 2 (jobId=`cb301b67-a016-493b-a0a0-bb17e63d0c1d`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/c6c5c863-804d-49b1-bcd0-bedc1a0fb2d0.jsonl
```

Run 3 (jobId=`3e1eb1a8-6631-4496-9892-cd5d49f8efec`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/e16494e3-5167-4b09-a311-0d543b4a6f40.jsonl
```

### (test) false-negative — `Append a comment to DX-279 with the verdict from the test-reviewer subagent run.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`18e88366-76b3-48ca-b6fe-73fa94dba9fb`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/d54a8eea-1fef-4251-8f97-000aba0db983.jsonl
```

Run 2 (jobId=`b0e36604-fe08-4191-84cf-16c9ab5ae157`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/23795726-960e-4bf8-aa12-ee1de59611bd.jsonl
```

Run 3 (jobId=`3984c593-d694-4aee-92f7-c82c8cf07aa7`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/ebde1b72-cd55-45f9-b5a0-c02fb9b85952.jsonl
```

### (test) false-negative — `Pick up DX-300 and process it through danx-next.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`c0467b61-0945-4085-8e11-2feada8c7392`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/f859f95c-aca5-4925-bbb7-f84dd29c3f27.jsonl
```

Run 2 (jobId=`bddf54a5-3352-4182-81e5-6c57394d426b`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/b3e38af6-9307-4bd7-986a-69894dd6986e.jsonl
```

Run 3 (jobId=`5d98727b-a499-4a26-ab68-17489a989c73`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected danxbot:issue-card-workflow
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/b8ffad07-f27d-4c78-a64d-747a15e39294.jsonl
```

_Last run: 2026-05-14T01:36:15.695Z_
