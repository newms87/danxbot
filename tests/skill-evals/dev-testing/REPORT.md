# Skill-eval report: dev:testing

**Overall: FAIL**

## Parameters

- Eval-set: `/home/newms/web/danxbot/repos/danxbot/.danxbot/worktrees/dani/tests/skill-evals/dev-testing/eval-set.json`
- Seed: `1`
- Runs per query: `3`
- Pricing model: `claude-sonnet-4-6`
- Elapsed: `2m 2s`
- Total cost: `~$0.0000`

## Accuracy

| Side  | Correct | Total | Accuracy |
| ----- | ------- | ----- | -------- |
| train | 6 | 12 | 50.00% |
| test | 4 | 8 | 50.00% |

## Failures

### (train) false-negative — `Add a pytest fixture for the new DatabaseWrapper class.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`352a1a32-c73e-4381-a959-185842a28ece`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/f133fb9c-802b-467f-a60c-ec36c37befe0.jsonl
```

Run 2 (jobId=`ddd5652b-32dc-4213-be2a-eae0e03e5720`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/856c6120-d013-43ef-8758-f5a0d7fb2b55.jsonl
```

Run 3 (jobId=`ab7fc6df-f666-4c8d-bfd4-b14ec1d539b9`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/5409fc82-f61b-4b29-a754-0bafaff3b9e9.jsonl
```

### (train) false-negative — `Mock the `spawn` call in the spawnAgent test using vi.mock so it doesn't actually fork.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`edac63cf-aaf1-480c-8484-c31b92e96fb5`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/f94643a0-6064-4a35-9098-8c1ec812a3c2.jsonl
```

Run 2 (jobId=`9caeada0-4335-4526-a7a5-9ea0c18e5601`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/fabb53f0-3ee1-49f8-a103-048b1958ca68.jsonl
```

Run 3 (jobId=`45e19def-9663-4ae9-9dcc-0aa45cbdd7a1`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/c31ef6e4-4922-4bb1-961c-52f650318327.jsonl
```

### (train) false-negative — `Delete the obsolete test src/legacy/__tests__/old-router.test.ts — the module it covered is gone.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`da2ffc23-14db-4a77-be69-f639851634f1`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/2b9cc5e7-05b9-4da7-be1f-04e0d830a8f6.jsonl
```

Run 2 (jobId=`9fb01a77-8bfb-4bb7-84fa-0f23721b6c10`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/dfb93577-4dfd-4a34-a28a-812af764dc53.jsonl
```

Run 3 (jobId=`43f98485-ea5a-45d6-a6c5-e4ff16826e4e`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/76acdaaf-07d6-40b2-b2bc-eb6e60e43edb.jsonl
```

### (train) false-negative — `Fix the broken test in src/poller/index.test.ts — it's failing on the new dispatch return shape.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`e1b6b8fb-6604-41cd-bc4c-8d8a482d5ec6`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/a345cf81-c9ca-44a5-92f3-c514d17c7c1b.jsonl
```

Run 2 (jobId=`ed737768-e424-4539-a154-dfe3465011b5`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/6d3b398a-2fcb-4d60-b7ce-c7bec96dfb4f.jsonl
```

Run 3 (jobId=`4eca943e-d11f-4721-99fc-53a1c42c656d`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/21ed8567-cd52-4410-9808-8fcb2503af98.jsonl
```

### (train) false-negative — `Write a vitest test for validateEvalSet's error path on an empty array input.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`8f993397-369c-4caa-b6b9-293c8434ea15`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/befa9ebd-4aba-4852-94ff-25dbe628d1bb.jsonl
```

Run 2 (jobId=`7b27a41f-01d5-4211-b8ae-2c5ecf2bb9f6`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/58a9d82c-a2c8-4d28-af5d-922e4d17199a.jsonl
```

Run 3 (jobId=`c926dc45-23bb-4137-a953-6bc9a4712ae7`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/de758328-b0f4-4427-8495-df88ba205686.jsonl
```

### (train) false-negative — `Run `make test-unit` and report the failure count to me.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`error-jsonl-not-found-0`): did NOT trigger

```
reason: probe error (jsonl-not-found): scanned 2042 JSONL file(s) in /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval; none contained dispatch tag <!-- danxbot-dispatch:d03d0172-ca24-4aa7-bd4a-33b225c715df -->
```

Run 2 (jobId=`error-jsonl-not-found-1`): did NOT trigger

```
reason: probe error (jsonl-not-found): scanned 2042 JSONL file(s) in /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval; none contained dispatch tag <!-- danxbot-dispatch:1658679f-af1e-4a90-afe4-2f71145cd2f5 -->
```

Run 3 (jobId=`541a7d7c-6121-47d2-8713-8e169109afa7`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/a1a5312b-bb81-4791-a535-9bea93738bab.jsonl
```

### (test) false-negative — `Reason about whether the test coverage for danxbot_complete is sufficient — list the gaps.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`f8207200-2d45-4160-834a-299ac8fe89dd`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/0ec629be-0815-432d-9447-0754101b62fa.jsonl
```

Run 2 (jobId=`4b1835be-242c-4801-8371-0f8c7380b0cf`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/a6a00e19-c9be-416b-8a09-7fae7a0ffdd3.jsonl
```

Run 3 (jobId=`6fc92a1e-348b-4588-b5c8-1f2232cdd948`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/e894c54b-f9fd-449f-8fe2-bf2d9bb22fa7.jsonl
```

### (test) false-negative — `Inspect dashboard/src/composables/useAuth.test.ts — does it cover the 401 retry path?`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`16d5ab38-239c-430c-8d25-264b53cab2e1`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/35c9f17e-b9e6-4ba5-beca-049bcc5f30c1.jsonl
```

Run 2 (jobId=`57e4e2fe-cbab-4fd4-8e90-9c559ad9f82f`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/7323c956-11f2-46e7-87b0-3651c2a9bfc8.jsonl
```

Run 3 (jobId=`16e57e2e-ee12-493a-9438-6066fe124fc4`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/f46cd658-6c21-442d-b9b1-cde27749530b.jsonl
```

### (test) false-negative — `Write a jest snapshot test for the AgentBadge.vue component covering name, avatar, and busy states.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`bd29368c-f05e-432c-9afe-4ca8b8eeb7db`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/83b6bcfb-0d70-42f7-89e6-b7c53c368e90.jsonl
```

Run 2 (jobId=`3aa16a90-4f02-4a91-a2f5-30877ca178aa`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/892462a9-4747-4287-887c-878ec2181ce5.jsonl
```

Run 3 (jobId=`0d6a2c6b-7308-493c-a304-8a10eea5a93d`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/31591bb7-a4ec-441f-a50b-bb48a24857bc.jsonl
```

### (test) false-negative — `Run `npx vitest run src/skill-eval/eval-set.test.ts` and tell me if it passes.`

- **Vote:** 0 / 3 runs triggered the expected skill
- **Expected should_trigger:** `true`

Run 1 (jobId=`ae7be847-397a-469a-b312-d16374be2f19`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/438b6513-d5e2-465a-b19f-573991733e1c.jsonl
```

Run 2 (jobId=`ad1794ce-8aaf-46e6-b1b6-7cfde9a95b25`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/187cc1cc-34b5-4c3f-9548-f0fdd384da34.jsonl
```

Run 3 (jobId=`65b2a013-1eb2-4f20-b73f-2ed3af2eed63`): did NOT trigger

```
reason: Assistant produced text without invoking any Skill — expected dev:testing
first_assistant_text: Invalid API key · Fix external API key
jsonl: /home/newms/.claude/projects/-home-newms-web-danxbot--danxbot-worktrees-dani--danxbot-workspaces-skill-eval/bdbebd8e-1145-4ee4-8138-b88ca9532c22.jsonl
```

_Last run: 2026-05-14T01:41:47.551Z_
