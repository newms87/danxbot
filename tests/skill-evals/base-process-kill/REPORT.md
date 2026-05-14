# Skill-eval report: base:process-kill

**Overall: FAIL**

## Parameters

- Eval-set: `/home/newms/web/danxbot/repos/danxbot/.danxbot/worktrees/dani/tests/skill-evals/base-process-kill/eval-set.json`
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

### (train) false-negative — `Use `kill -9` on the runaway claude subprocess.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`error-jsonl-not-found-0`): did NOT trigger

```
reason: probe error (jsonl-not-found): scanned 1812 JSONL file(s) in /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval; none contained dispatch tag <!-- danxbot-dispatch:847846f7-ae28-438c-bacb-b91d0d44a4e5 -->
```

Run 2 (jobId=`54175917-292c-40f4-89e9-3749319993eb`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/e2a7365b-03d1-4360-8727-9d2848eaea98.jsonl
```

Run 3 (jobId=`86511c03-38c1-470c-98b9-04da94c47027`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/ccc3b633-3b5b-49f3-8a4b-4467b4d00b41.jsonl
```

### (train) false-negative — `Send SIGTERM to every process matching 'vitest' — `pkill vitest`.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`eb0c4bd8-b060-4d0f-946a-822a92ccc874`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/71f9a0e6-c39e-49a7-96ba-30492110f7cc.jsonl
```

Run 2 (jobId=`f809bccc-27d7-4140-82d2-ca29f73cdcf0`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/ac7873f8-78a8-4931-829a-0ecd0cc02ef4.jsonl
```

Run 3 (jobId=`5f77438f-37ff-4cbb-ab0e-916e85597bd2`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/3ca783a9-ca9e-4bc4-83bb-7e5601f0895c.jsonl
```

### (train) false-negative — `Clean up the stale tsx watchers via pkill — they're zombie processes.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`f18a2df1-6c61-41b5-a5b1-5fd7f00c3b2e`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/6b58b69c-8b9e-4fdc-b904-f3a9f33d3326.jsonl
```

Run 2 (jobId=`aa81ada6-2c42-403e-827b-bd28fa90f0fa`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/a420e2b3-e95a-4236-b64c-2af1910d9a4a.jsonl
```

Run 3 (jobId=`8ef395a2-b355-4aec-8061-7f4eaa6f74c6`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/a11b8ba9-dbda-4c4c-b8d5-0f39067f84c2.jsonl
```

### (train) false-negative — `Send SIGKILL to PID 12345.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`4ba052d6-cf60-4f5e-bb1d-cdd73031e435`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/24caacde-1662-4f7a-8560-0fd376b47949.jsonl
```

Run 2 (jobId=`856a6794-3d43-4dec-a027-158854cc1e1c`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/9006c06c-5b64-4d07-8e5a-99adfb7cfd24.jsonl
```

Run 3 (jobId=`f7d81f99-ac09-4000-a88a-98a5e537d311`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/b492402d-6a75-4e75-890d-a165b57fd8f2.jsonl
```

### (train) false-negative — `Run `pkill -f 'node.*tsx watch'` to clear stale tsx watchers.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`c543afee-772e-4e9d-a6cd-8b4b8dda7c8c`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/d7c7d0b4-3adb-45ab-a2ca-878a8a02f6b4.jsonl
```

Run 2 (jobId=`01325a37-664d-49b7-91dd-10ba35d63ffe`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/9edf3b71-1e2f-4639-8c8e-3b73472c9d73.jsonl
```

Run 3 (jobId=`a11d3929-351d-4e03-ad54-f902c7d63f5c`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/1399cd13-2437-4681-8410-5273c7de57f3.jsonl
```

### (train) false-negative — `Run `taskkill /F /PID 5678` to kill the Windows Terminal process.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`5c80f87e-176a-4506-820e-1b6f0f83a1e7`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/666449b2-bc84-49d4-a7ac-79e581855e02.jsonl
```

Run 2 (jobId=`ea6d7412-a690-4459-8985-0bc0217d1913`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/0b3da006-6718-4b12-91cd-d7331835bbd4.jsonl
```

Run 3 (jobId=`66fd69b9-079b-4a27-9435-88b7f987760f`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/de3d0d9e-e641-4675-b887-5a3614c46091.jsonl
```

### (test) false-negative — `Find the dispatch process with `ps aux | grep claude` and then kill it.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`a922c69c-6e70-4e9f-a1e5-3328bbdc820f`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/ee7e29d2-b875-45de-891f-5dc692958f88.jsonl
```

Run 2 (jobId=`82c21bd1-771b-45d4-80b1-aa13878fbbdc`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/3f8d54a1-c3a8-4ee7-ae8b-291f17f103c3.jsonl
```

Run 3 (jobId=`9f9196a9-1695-4a20-8987-d4f9f01c9883`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/adc5af6a-c019-4e32-a2de-03fac9bb4a36.jsonl
```

### (test) false-negative — `Run `docker kill danxbot-worker-danxbot` to terminate the stuck container's main process.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`533a4a9b-8c5c-4546-bd47-1f5f18c872ff`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/969d183a-d43d-43d0-b1db-c688df23df05.jsonl
```

Run 2 (jobId=`45105979-1f18-4cc1-aef9-d2aa89ff20e1`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/3f1d23c4-093f-426b-8699-3f37ade64747.jsonl
```

Run 3 (jobId=`2fce898b-4cf8-4e9e-ada6-29f527618c68`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/2f62cedd-57f2-47be-99bd-1b1a5cdcf9f6.jsonl
```

### (test) false-negative — `Use `docker top danxbot-worker-danxbot` to find the agent PID and then send it SIGKILL.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`0d850bc0-07eb-4182-bd60-be43e9bfd443`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/be7cbe2a-3187-4a6e-aa38-ce5639fcc2a7.jsonl
```

Run 2 (jobId=`31b84604-da3f-4112-84a5-5eea496e9d3c`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/9ad9c5af-2501-482e-86a4-4319b4c86135.jsonl
```

Run 3 (jobId=`dd41f817-4337-4323-9331-ae8a96c2e8fe`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/4e39fb88-1306-4407-85d8-82a794de4eb4.jsonl
```

### (test) false-negative — `Kill the danxbot-worker-danxbot process — it's stuck on a dead dispatch.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`0cf4fb6c-49f1-4264-a183-bef41f8ae091`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/52f925ba-fd3f-46a1-9647-b5705bdff81e.jsonl
```

Run 2 (jobId=`3c7239b6-901d-4750-8f41-24f2ec420d30`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/d2adc06b-2e2c-4c27-be17-6fa5ea9fdb45.jsonl
```

Run 3 (jobId=`e546b6a0-3e62-4706-a6b5-abf579af2741`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected base:process-kill
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/c9720535-feff-4500-8e0b-a1a89efe88ad.jsonl
```

_Last run: 2026-05-14T01:34:39.922Z_
