# Skill-eval report: investigate:investigate

**Overall: FAIL**

## Parameters

- Eval-set: `/home/newms/web/danxbot/repos/danxbot/.danxbot/worktrees/dani/tests/skill-evals/investigate-investigate/eval-set.json`
- Seed: `1`
- Runs per query: `3`
- Pricing model: `claude-sonnet-4-6`
- Elapsed: `1m 50s`
- Total cost: `~$0.0000`

## Accuracy

| Side  | Correct | Total | Accuracy |
| ----- | ------- | ----- | -------- |
| train | 6 | 12 | 50.00% |
| test | 4 | 8 | 50.00% |

## Failures

### (train) false-negative — `Trace the path a Slack message takes from the bolt listener to danxbot_slack_reply — call-chain only, no edits.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`b3b412d8-e1cc-4f8f-aaf3-2ff65266d486`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/bd31c0b4-7e56-4298-ac61-2210260a3d1c.jsonl
```

Run 2 (jobId=`914b4aec-d63a-41fa-9281-fa4ebc64483c`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/aac22c7f-2097-4e97-90ed-aac8970a86b4.jsonl
```

Run 3 (jobId=`50c23bd6-efde-4a48-91a5-28203d77d297`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/8e1e2fdc-3bdc-40b2-83ba-6407e1e9cadd.jsonl
```

### (train) false-negative — `Find out which workers are currently running on the gpt target right now — read-only inventory, no restarts.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`aa75dba3-00fb-4866-9dd4-984024708d7f`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/60f291d5-f235-4f57-8351-636886ef748a.jsonl
```

Run 2 (jobId=`81515f0f-0289-4b36-93fc-731f222eb764`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/4c9623b7-9f32-4329-8b2f-e76fb3a97484.jsonl
```

Run 3 (jobId=`38c534c9-b95d-4cbe-9c18-1aa87e453339`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/caeb4923-0448-45a3-9d3c-79b83f1fcd8f.jsonl
```

### (train) false-negative — `Dig into the difference between StallDetector and ApiErrorDetector — read-only comparison of when each fires.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`50aa5308-f23c-4944-a1a5-cbd4c65cc459`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/02d60697-d5c2-449e-b14a-1ac72e7d6399.jsonl
```

Run 2 (jobId=`05726929-d0e2-48e6-b351-b214351210d0`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/fd6e1692-0b9c-4b40-9ca4-7dfa6fced80d.jsonl
```

Run 3 (jobId=`fe40b1aa-843b-4d0f-8f1a-f7b760447fd5`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/bc8584b4-c3cc-4d00-97fa-01e0966c92bc.jsonl
```

### (train) false-negative — `Audit how the chokidar watcher in src/db/issues-mirror.ts decides when to mirror — read-only walk-through.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`6d045cc1-9a19-4976-9ee9-9bde18c4a8c7`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/3d49115a-3e67-44bf-8b9d-09298925714e.jsonl
```

Run 2 (jobId=`97c63f6f-c8e4-4c1f-99da-d270ff578625`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/a56ae7fa-f191-4439-9ad0-6397d2357ab5.jsonl
```

Run 3 (jobId=`59c5812d-dbea-4a84-84ca-cf80535a1e52`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/c9686940-dc56-4e31-b905-3761a52b60c5.jsonl
```

### (train) false-negative — `Look into how isFeatureEnabled falls back when settings.json is malformed — I want to understand it, not modify it.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`8c033e92-2e1c-4431-b409-b69dd9a5101f`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/f53fe438-9934-4500-8def-842753fafa20.jsonl
```

Run 2 (jobId=`f8146d26-0b0f-4c1d-9c18-f87c2f15da4d`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/8b58b597-5b6e-47dc-9874-d7741138d674.jsonl
```

Run 3 (jobId=`f0b2a88a-a357-433d-a3c0-2c882efdfd45`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/903bee65-f32a-43cf-9305-9a88a4fe533e.jsonl
```

### (train) false-negative — `How does the worker resolve DANXBOT_WORKER_PORT differently in production versus local dev?`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`4b825d0c-5e1c-4168-8397-a6cab92b3f0c`): did NOT trigger

```
reason: Session ended without any Skill tool_use — expected investigate:investigate
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/9c7475af-49f8-44eb-b619-d4feb451972d.jsonl
```

Run 2 (jobId=`c05f60bc-b2fc-4d02-8c45-190ddd2b9587`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/461fd3ad-c674-45e5-820d-e59094d51899.jsonl
```

Run 3 (jobId=`2fd74189-9669-4236-a305-2783ffce8194`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/b1b06796-3a32-42f0-9107-a6dcc4c5962c.jsonl
```

### (test) false-negative — `Check on the production worker health — is the dispatch API actually reachable from the dashboard right now? Don't touch anything.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`06585bfb-c36b-4ca6-85d4-0a4dc087ad10`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/c7c1a040-089d-4587-95b7-91162d91c2b5.jsonl
```

Run 2 (jobId=`dae7154e-128e-47ea-95df-aad612ac6f57`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/c987647d-8810-44c7-a1e2-62b575bddf45.jsonl
```

Run 3 (jobId=`1c1114cd-ea76-4d2b-b014-0349eacb2b95`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/01ba1a80-2345-4ab6-9c42-96d41f39e20e.jsonl
```

### (test) false-negative — `Why does the poller skip cards with non-null waiting_on? Walk me through the dispatch filter logic.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`5d10297f-17f5-4840-a25d-a8d7d85c1896`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/a5127542-f615-453a-8131-7012b61b1126.jsonl
```

Run 2 (jobId=`64268c93-f4d4-468e-a6a4-8f4b34392b5b`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/0a0b7ee2-c55c-42a8-9b0d-d8b44aa424df.jsonl
```

Run 3 (jobId=`11325077-1688-4678-8a51-83c350db7111`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/f1fde6e2-c6bb-41a9-a3aa-111ea1a7727e.jsonl
```

### (test) false-negative — `Figure out what triggers a critical_failure flag end-to-end — I'm trying to understand the contract.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`dfa0ba77-4e75-42cb-87d2-4aad6cb8e0ff`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/171d3d59-15ff-48b4-a222-98960cd73d70.jsonl
```

Run 2 (jobId=`d3b3aaf9-d301-4741-bfde-dcae411c1ff9`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/544ca904-3c32-482e-90fc-1fb61316c3d0.jsonl
```

Run 3 (jobId=`7d7dcdd9-6612-4b52-80e8-bb2718bd58a9`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/30959f63-870c-40a6-bde7-04ddc33b6091.jsonl
```

### (test) false-negative — `Investigate dispatch latency on the gpt target — read-only audit, no changes to anything.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`0d94e5a0-40c5-43b3-bc5d-200948b19b62`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/c0c7ec0e-b5f2-4d45-ba4b-37005187de82.jsonl
```

Run 2 (jobId=`35ca2168-8f54-45c3-817a-74fd0f9d5a16`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/7ef2e362-9356-4b60-9437-e1b6ff1af373.jsonl
```

Run 3 (jobId=`7f41a97b-8156-4a79-a22d-ea74c81dcfdc`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected investigate:investigate
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/09ada4fd-4b2d-4ea2-96cc-4a40290cfff6.jsonl
```

_Last run: 2026-05-14T01:43:37.114Z_
