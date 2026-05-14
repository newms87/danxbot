# Skill-eval report: dev:git-discipline

**Overall: FAIL**

## Parameters

- Eval-set: `/home/newms/web/danxbot/repos/danxbot/.danxbot/worktrees/dani/tests/skill-evals/dev-git-discipline/eval-set.json`
- Seed: `1`
- Runs per query: `3`
- Pricing model: `claude-sonnet-4-6`
- Elapsed: `1m 49s`
- Total cost: `~$0.0000`

## Accuracy

| Side  | Correct | Total | Accuracy |
| ----- | ------- | ----- | -------- |
| train | 6 | 12 | 50.00% |
| test | 4 | 8 | 50.00% |

## Failures

### (train) false-negative — `Delete the file src/legacy/old-router.ts — it's unused.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`6b7042fb-88dc-49b4-9a36-7db083e03946`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/2f71e03d-5a22-4795-978c-0a986e8994cb.jsonl
```

Run 2 (jobId=`ca7b6739-e1d0-49f8-ad9e-7a10127d5868`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/9fa83448-1e35-4781-a58d-d8a02523eb76.jsonl
```

Run 3 (jobId=`6ea39ffc-8b1c-4907-bc35-d06e959051e0`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/7e516ce1-5752-41de-b27c-5e92211c9125.jsonl
```

### (train) false-negative — `Checkout the main branch and pull the latest from origin.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`bc69bd80-b09e-4d5e-9008-f1223f75b2df`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/1100f587-51de-45ac-b45d-af3849885c4f.jsonl
```

Run 2 (jobId=`b1f9e7db-c2c6-4240-a0e4-30c1df1b8d88`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/26c35ee7-49e7-4e3c-87ea-e06bbe269549.jsonl
```

Run 3 (jobId=`a0beae92-b9cb-4dc1-b3aa-9451ccf87d53`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/5b2a1d3a-bb6d-4d38-8275-a089d9919531.jsonl
```

### (train) false-negative — `Cherry-pick commit abc123 from feature/foo onto main.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`a8d7aee0-56d9-4abd-9768-23acf3ae47d9`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/b03f608a-edc5-4648-858d-529b5ee15b91.jsonl
```

Run 2 (jobId=`3e91354b-cdb6-4dcd-8273-5f97769d2caa`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/e5e48eed-0f35-4e24-b43a-f525ee23eb19.jsonl
```

Run 3 (jobId=`5f0ec2b1-13c8-4bc8-8fcd-4d2ec7701c57`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/2a308fe7-134d-48cb-82f0-45b0dce850fe.jsonl
```

### (train) false-negative — `Revert the last commit on this branch.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`b9722376-afd7-45f7-aa7f-2a415e772a19`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/86a46f87-87b2-4c80-857c-bf18dc4f41e2.jsonl
```

Run 2 (jobId=`f402755c-b6ba-4077-895f-89f3453e074b`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/3ea41fff-8ce1-4424-bcc9-21f7e746db4d.jsonl
```

Run 3 (jobId=`9425d06e-0cbc-4502-ba7b-b8b45ca633f9`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/2d056bba-8bfa-4f3f-a2bf-b245b1cd0859.jsonl
```

### (train) false-negative — `Run `git stash` to set aside the WIP changes while I check out main.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`d7977df6-cf0b-40a4-b146-f8e5e74bb076`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/01e15a55-cc05-4baa-aedc-79e2bab30c6f.jsonl
```

Run 2 (jobId=`d227477d-540d-4cc6-b6d0-ee6c78520916`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/96c0779c-dcc3-44fb-8900-0a824968323e.jsonl
```

Run 3 (jobId=`ead3ebf6-8160-4814-8f52-2878cda7f325`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/df4e641d-786a-42db-9574-0e6df603047a.jsonl
```

### (train) false-negative — `Clean up untracked files with `git clean -fd`.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`098a3cbf-33ef-4534-9363-178444c7b993`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/900e2198-f123-458e-8167-d82e0849425a.jsonl
```

Run 2 (jobId=`a18de03c-cb9a-4bb8-b75c-c0f2d0b6c0c7`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/b4c04278-ed8e-4524-8244-b7d5141852c4.jsonl
```

Run 3 (jobId=`ff6bbd5c-1386-4ba0-b88f-82a317219a29`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/0dd0d64c-4070-4032-9661-cfc382ea7ca0.jsonl
```

### (test) false-negative — `Run `git restore src/agent/launcher.ts` to discard the local edits.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`4b6ea954-3c9a-488d-92a3-ee9b4abfdb7d`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/40afdf79-b9ac-4922-9b98-0b901b59839a.jsonl
```

Run 2 (jobId=`9e98e2ea-59e1-4306-8e45-a62fc4d8ab38`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/5b5ad0f2-cbe7-45c3-bee7-9b2d48dae0fb.jsonl
```

Run 3 (jobId=`8edca3de-5bbd-4205-9ec8-2326914f20d3`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/b7de7284-2fae-4b56-b84b-954ecedeaa74.jsonl
```

### (test) false-negative — `Run `git reset --hard HEAD~3` to drop the last three commits.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`error-jsonl-not-found-0`): did NOT trigger

```
reason: probe error (jsonl-not-found): scanned 1985 JSONL file(s) in /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval; none contained dispatch tag <!-- danxbot-dispatch:7ee914bf-e477-4f3a-939e-de8dff76b5bb -->
```

Run 2 (jobId=`error-jsonl-not-found-1`): did NOT trigger

```
reason: probe error (jsonl-not-found): scanned 1985 JSONL file(s) in /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval; none contained dispatch tag <!-- danxbot-dispatch:62ae5315-8cc8-4607-b337-6009d386080e -->
```

Run 3 (jobId=`error-jsonl-not-found-2`): did NOT trigger

```
reason: probe error (jsonl-not-found): scanned 1985 JSONL file(s) in /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval; none contained dispatch tag <!-- danxbot-dispatch:6108d51a-3aaf-4837-8e1c-6a39a471ef09 -->
```

### (test) false-negative — `Dispatch a subagent with isolation: "worktree" to run the refactor in parallel.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`ac27ba4d-6dd9-4163-9c5d-16a14d2da92b`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/6e21e642-f5dd-4228-a697-00e137f071d7.jsonl
```

Run 2 (jobId=`93c4744a-b41f-4da4-8576-d997b3693bb1`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/a1166aab-9b7e-4adc-bed5-51289849d0c5.jsonl
```

Run 3 (jobId=`80808ca2-740b-4bbe-8551-28810ab8975e`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/d3beeef5-36d3-4f4e-ba49-788e03880f48.jsonl
```

### (test) false-negative — `Commit the changes to src/skill-eval/run.ts with message 'feat(DX-312): add --dry-run flag'.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`0e5d54e2-1263-443f-9a12-fdae8a442de4`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/82a1f51f-1c47-4b57-8158-65ae65e4d64d.jsonl
```

Run 2 (jobId=`a28b8337-c56a-424d-85c1-2d446798822f`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/8aeeadc7-54f5-4c34-95b5-c8406c01569b.jsonl
```

Run 3 (jobId=`803361a2-d482-491a-84d2-7577bca46656`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:git-discipline
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/782fb23d-edc1-492b-927c-9a5b64cfefa0.jsonl
```

_Last run: 2026-05-14T01:39:45.427Z_
