# Skill-eval report: dev:debugging

**Overall: FAIL**

## Parameters

- Eval-set: `/home/newms/web/danxbot/repos/danxbot/.danxbot/worktrees/dani/tests/skill-evals/dev-debugging/eval-set.json`
- Seed: `1`
- Runs per query: `3`
- Pricing model: `claude-sonnet-4-6`
- Elapsed: `1m 41s`
- Total cost: `~$0.0000`

## Accuracy

| Side  | Correct | Total | Accuracy |
| ----- | ------- | ----- | -------- |
| train | 6 | 12 | 50.00% |
| test | 4 | 8 | 50.00% |

## Failures

### (train) false-negative — `Why is the dispatch agent stuck on DX-244?`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`7ceaa4fa-1a83-49d3-b18f-d06b5cfaaa00`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/98896d51-a4f3-4fd5-84fe-761e4c1b5a01.jsonl
```

Run 2 (jobId=`81a82fed-c00b-4dda-a299-2f1abeb2e236`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/46f957bc-a168-4abb-b859-0a1d2a1c1afa.jsonl
```

Run 3 (jobId=`f5722fb7-2f4a-4fd3-922d-7bd2ffaa2955`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/b2ca2642-a91f-4c66-b32a-7aebe7335b77.jsonl
```

### (train) false-negative — `What config value is used for the worker port in production — is it the same DANXBOT_WORKER_PORT env var or does the deploy target override it?`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`03b48a80-8a1e-421b-8014-ed4fefc2876f`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/53a5dbd7-8708-42cd-a972-694c98be232e.jsonl
```

Run 2 (jobId=`ba8da8e1-d82b-4ce8-96d7-e05830fc3796`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/2576c306-2b3a-4e3b-86b9-d71bb9ac678d.jsonl
```

Run 3 (jobId=`7eb25c69-581a-4fc4-85c7-272de61a4d5f`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/8a60bd05-0eb5-448a-b391-2e8a5a69c75c.jsonl
```

### (train) false-negative — `Three tests in src/poller/index.test.ts are failing — figure out what changed.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`12823d57-11a5-430f-9b61-163535acd3be`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/e1a5dca3-5107-4d0c-b69d-4f67d5434c3c.jsonl
```

Run 2 (jobId=`ab6e28bd-29a4-4391-8444-e0832d5b54a4`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/f91ef057-797f-4ca9-945b-ae04fd62c254.jsonl
```

Run 3 (jobId=`56f9b4e3-dac1-4b2a-a08b-592586de2983`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/b4c5f335-f1e9-4b78-88c3-42b6483fa8fb.jsonl
```

### (train) false-negative — `What is broken about the dispatch round-trip for DX-244 — the JSONL shows the agent stopped responding but the worker still reports running.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`ebbdbd05-24d1-487a-8d54-55d47d8b48f9`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/4bd14f36-5759-4f92-97a2-d1927c3386b1.jsonl
```

Run 2 (jobId=`f417917b-e0b6-4197-951e-b22b995a6ef6`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/61c7e85d-66ef-4700-a738-870b2c9ee8d9.jsonl
```

Run 3 (jobId=`a935aad2-2365-4a4c-a30d-d6c3cfa0d770`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/129fba45-8e24-42ad-b6cc-5f796735241c.jsonl
```

### (train) false-negative — `Summarize the failures from the latest CI run on PR #142 — the build-log artifact is at /tmp/ci-build-log.txt.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`0b710a20-45a7-4c20-9ec0-32756e4f9517`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/69d0bdad-2d27-4f97-baf4-931811cb7b1a.jsonl
```

Run 2 (jobId=`e3c432a6-5e25-4f5e-bdc5-15d12194a22b`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/213e4fec-b78e-4391-a1d1-71cb1d220f2a.jsonl
```

Run 3 (jobId=`fd37b859-91a0-4f0f-822a-9d29df51c8c8`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/80d4133e-38a8-426f-a797-342f0b56589a.jsonl
```

### (train) false-negative — `How does SessionLogWatcher detect a stalled agent?`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`490051ad-d35a-4ead-af34-9cec70915a43`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/4afe397b-e076-4384-9f4b-e2073611ff0d.jsonl
```

Run 2 (jobId=`bc329636-28ce-4159-bcdc-bc4a585f1f26`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/f2880229-e8e2-4282-97d6-4bedfba5da0c.jsonl
```

Run 3 (jobId=`3050b96a-40fc-4c48-8256-522a9cd83883`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/0c411251-b8ee-43d5-b91d-6d2eee1c78b3.jsonl
```

### (test) false-negative — `The deploy to gpt this morning introduced a regression in the dashboard auth flow — login returns 401 for the monitor account. What happened?`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`8b7f6bd3-982a-4519-bcf4-1e4a55ae0fbd`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/3a6114e7-385d-4596-9c15-f9e0bb276456.jsonl
```

Run 2 (jobId=`a0637d4a-07a6-4b5f-9a28-f807660a9834`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/c4ba2108-b406-4fb2-9cea-d6d112e5d3a0.jsonl
```

Run 3 (jobId=`e9003454-4abc-4e50-a843-4e58e55ba220`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/8c1997a3-249f-44dd-8577-28b4c4793087.jsonl
```

### (test) false-negative — `Dig into why src/__tests__/system/run-system-tests.sh is taking 8 minutes instead of the usual 2 — the change landed yesterday.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`26e91b2c-1206-4d3c-9063-e5cd80ec666f`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/134ec932-e0bb-4b67-a3a5-3ee6af1e3425.jsonl
```

Run 2 (jobId=`ab16d84c-72d4-4603-9d61-d382d36926de`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/a7802fc5-4868-46e4-adef-6b7e1203276f.jsonl
```

Run 3 (jobId=`e6254630-de8b-42b1-956a-f49dbd50a046`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/b79862e3-744a-48b7-a5e9-ad6d7198d025.jsonl
```

### (test) false-negative — `Report on the failed dispatches over the last 24 hours — the dashboard shows 7 with status=failed and 2 with status=critical_failure.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`dfac7730-4e8a-4692-a88f-efd346214046`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/37f1ee1c-8632-4d3e-99b0-ca0f064f24b7.jsonl
```

Run 2 (jobId=`a4b6af94-4f75-42d7-8f51-05c2b02b2c1a`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/560793bb-2518-4e3c-b463-90fd66ba9cd5.jsonl
```

Run 3 (jobId=`5fd0baa6-fcd8-41eb-85b1-ce1e3a49b8e8`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/b324326a-15da-416b-941e-8155ab5c5238.jsonl
```

### (test) false-negative — `Look at /tmp/danxbot-test-system6.log and tell me what the test results were.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`error-jsonl-not-found-0`): did NOT trigger

```
reason: probe error (jsonl-not-found): scanned 1918 JSONL file(s) in /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval; none contained dispatch tag <!-- danxbot-dispatch:b1f150ba-7abc-4034-9269-03462866bc03 -->
```

Run 2 (jobId=`error-jsonl-not-found-1`): did NOT trigger

```
reason: probe error (jsonl-not-found): scanned 1919 JSONL file(s) in /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval; none contained dispatch tag <!-- danxbot-dispatch:27771b4f-d765-46fd-87fb-485a7294a729 -->
```

Run 3 (jobId=`dc66334d-5d9a-4064-97f6-78719a059374`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:debugging
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/f470bd6a-09fd-43c8-a3f3-a218b9866b49.jsonl
```

_Last run: 2026-05-14T01:37:56.926Z_
