---
name: skill-eval
description: |
  Run skill-trigger probes against the local danxbot worker via host-mode
  interactive dispatch (never `claude -p` — bypasses Anthropic bugs #36570
  and #556). Four modes: (1) one-shot — `/skill-eval --query "<prompt>"
  --expect-skill <plugin>:<skill>` returns a single PASS/FAIL + JSONL
  path; (2) eval-set — `/skill-eval <plugin>:<skill>` runs the JSON
  eval-set under `<repo>/tests/skill-evals/<plugin>-<skill>/eval-set.json`,
  3× per query (configurable), 60/40 train/test split with deterministic
  seed, markdown report with per-failure forensics + cost; (3) iterate —
  `/skill-eval <plugin>:<skill> --iterate` runs the propose-fix-retest
  loop (default 5 iterations, hard-max 8, cost cap ~$2.55) — each
  iteration asks Claude Haiku for a tighter SKILL.md description from
  train failures only, commits + pushes the plugin source, pulls the
  marketplace cache + sanity-checks propagation, re-runs the eval-set,
  selects best by held-out test score, rolls back to best on regression;
  (4) sweep — `/skill-eval --all` discovers every eval-set under
  `<repo>/tests/skill-evals/*/` and runs each sequentially, emits a
  roll-up table to stdout + `SWEEP.md` next to the eval-sets directory.
  Modes 2 / 3 / 4 each auto-regenerate `REPORT.md` next to their
  eval-set so forensics survive across sessions. Exits 0 on green / 1
  otherwise. Invoke when the operator types any of those four forms OR
  asks for a trigger probe / full eval sweep / autonomous description
  tightening.
---

# Skill-Eval — trigger regression harness

Two CLI modes share the same dispatch primitive (`runProbe` in
`src/skill-eval/probe.ts`) so a sweep is just N × single-probes.

## Mode 1 — single query

```
/skill-eval --query "<prompt-text>" --expect-skill <plugin>:<skill>
```

Optional flags:

- `--workspace <name>` — defaults to `skill-eval`
- `--repo <name>` — defaults to `danxbot`
- `--worker-port <n>` — defaults to `$DANXBOT_WORKER_PORT` (read from
  `<repo>/.danxbot/.env`)
- `--timeout-ms <n>` — defaults to 5 minutes
- `--poll-interval-ms <n>` — defaults to 2 seconds

### What to do when this form is invoked

1. **Parse the arguments.** Pull `--query` and `--expect-skill` out of
   the user's invocation. If either is missing, tell the operator the
   required form (see above) and stop — do NOT make up a default query
   or skill name.

2. **Run the runner.** Single Bash call:

   ```bash
   npx tsx <repo-root>/src/skill-eval/run.ts \
     --query "<exactly the operator's query>" \
     --expect-skill <expected-skill>
   ```

   `<repo-root>` is the danxbot install root (e.g.
   `/home/newms/web/danxbot`). The runner discovers the worker port
   from `$DANXBOT_WORKER_PORT` env var or `--worker-port`.

3. **Surface the runner output verbatim.** The runner writes:
   - line 1: `PASS <reason>` or `FAIL <reason>`
   - line 2: `jsonl: <absolute-path>`
   - line 3: `dispatch_tag: <!-- danxbot-dispatch:<jobId> -->`
   - on FAIL: additional lines for `observed_skills:` and
     `first_assistant_text:`.

   Do not paraphrase. The operator wants the literal PASS/FAIL and the
   JSONL path so they can grep for themselves.

4. **Exit codes.** The runner exits `0` on PASS, `1` on FAIL, `2` on
   runner error (worker unreachable, dispatch never reached terminal
   state, JSONL not found). Surface non-zero exits to the operator with
   the runner's stderr lines.

## Mode 2 — eval-set sweep

```
/skill-eval <plugin>:<skill>   [--parallel N] [--seed N] [--runs-per-query N]
```

Runs every query in `<repo>/tests/skill-evals/<plugin>-<skill>/eval-set.json`
(e.g. `tests/skill-evals/dev-debugging/eval-set.json`) three times each,
in bounded parallel dispatch (default 3 concurrent). Splits the queries
60/40 into train + held-out test with a deterministic seed
(`--seed 1` by default — same seed produces the same split).

Per-query "triggered" verdict is a strict majority vote of the 3 runs
(2/3 fires → triggered). Per-side accuracy = correct / total. Exit `0`
iff BOTH train AND test ≥ 95% accuracy; `1` otherwise. `2` if the
runner itself errored (eval-set not found, parse error, etc.).

### Eval-set JSON shape (drop-in compatible with skill-creator)

```json
[
  {"query": "Look at /tmp/X.log and tell me what the test results were.", "should_trigger": true},
  {"query": "Rename function foo to bar in src/baz.ts", "should_trigger": false},
  ...
]
```

Constraints enforced by `validateEvalSet` in `src/skill-eval/eval-set.ts`:

- Top-level array.
- ≥ 8 queries total.
- ≥ 1 positive (should_trigger=true) AND ≥ 1 negative.
- No duplicate `query` strings (duplicates skew the train/test split).

### Available optional flags

- `--parallel N` — bounded concurrency, default `3`
- `--seed N` — deterministic shuffle seed, default `1`
- `--runs-per-query N` — runs per query for majority vote, default `3`
- `--pricing-model <model>` — model used for cost estimation, default
  `claude-sonnet-4-6`. The dispatched agent's actual model is whatever
  the host's `~/.claude` config defaults to; we estimate cost with this
  flag because the JSONL doesn't surface a per-message model field at
  aggregation time. Report the value back to the operator so they know
  the cost is an estimate.
- `--eval-set <path>` — override the convention-based path
- `--workspace`, `--repo`, `--worker-port`, `--repo-root`,
  `--workspace-cwd`, `--timeout-ms`, `--poll-interval-ms` — same as
  Mode 1.

### What to do when this form is invoked

1. **Parse the arguments.** The first positional arg is `<plugin>:<skill>`
   (or `--plugin-skill <name>` form).
2. **Run the runner.** Single Bash call:

   ```bash
   npx tsx <repo-root>/src/skill-eval/run-eval-set.ts <plugin>:<skill>
   ```

   Add `--parallel`, `--seed`, `--runs-per-query` only if the operator
   asked for non-default values.

3. **Surface the markdown report verbatim.** The runner writes the
   report to stdout. The report carries:
   - `# Skill-eval report: <plugin>:<skill>`
   - `**Overall: PASS|FAIL**`
   - Parameters (eval-set path, seed, runs-per-query, pricing model,
     elapsed, total cost USD)
   - Accuracy table (train + test correct/total/percent)
   - `## Failures` — per-failure forensics (prompt, vote count,
     observed skills, first assistant text, JSONL path per run). Omitted
     when nothing failed.

4. **Exit codes.** `0` for PASS, `1` for FAIL (accuracy below 95% on
   either side), `2` for runner errors (eval-set parse / not found,
   worker unreachable on every probe, etc.).

5. **REPORT.md** is auto-regenerated at
   `<repo>/tests/skill-evals/<plugin>-<skill>/REPORT.md` on every run.
   Contains the full stdout markdown plus a `_Last run: <ISO>_` footer.
   Atomic write (temp+rename) so a crash mid-write cannot tear the file;
   overwrites the prior run unconditionally.

## Mode 3 — propose-fix-retest iteration (`--iterate`)

```
/skill-eval <plugin>:<skill> --iterate
   [--max-iterations N]   (default 5, hard-max 8)
   [--cost-cap-usd X]     (default 2.55)
   [--proposer-model M]   (default claude-haiku-4-5)
   [--source-root <dir>]  (default ~/web/claude-plugins)
   [--cache-root <dir>]   (default ~/.claude/plugins/marketplaces/newms-plugins)
   (plus every Mode-2 flag: --parallel, --seed, etc.)
```

Mirrors Anthropic's skill-creator `run_loop` algorithm — but routes the
eval-set step through this repo's host-mode dispatch (sidesteps the
broken `claude -p` runner) and routes the description-edit step through
Claude Haiku via the Anthropic SDK.

### What the loop does

1. **Run eval-set** against the current SKILL.md description.
2. If train + test both ≥ 95%: **GREEN** — stop.
3. If iteration count hits `--max-iterations`: **MAX-ITERATIONS** — stop.
4. If accumulated cost + estimated next-iter cost > `--cost-cap-usd`:
   **COST-CAP** — stop.
5. **Propose** — ask Haiku for a tighter description, given the current
   description + the TRAIN failures only (held-out test is the
   overfitting defense — never shown to the proposer).
6. **Apply** — `replaceDescription` writes the new description into the
   source SKILL.md. `validateDiff` enforces that ONLY the frontmatter
   `description:` field changed; body bytes + every other frontmatter
   key are byte-identical.
7. **Commit + push** the plugin source repo at `--source-root`
   (default `~/web/claude-plugins`), one commit per iteration.
8. **Reload-propagation sanity check** — `git pull --ff-only` the
   marketplace cache repo at `--cache-root`, re-read the cached
   SKILL.md, and assert the on-disk description matches what we just
   pushed. Bail loudly on drift (the next iteration would otherwise
   measure the OLD description).
9. **Re-run eval-set**, loop.

### Best-iteration selection + rollback

The loop tracks the iteration with the highest held-out **test** score.
If the FINAL iteration's test score is below that best, the loop
performs one extra commit + push that restores the best iteration's
description before exiting. The report's `Rolled back to iteration N`
line surfaces this. If the rollback push itself fails (push rejected,
marketplace pull conflict), the result carries `rollbackError` instead
— operator must restore manually.

### Cost + safety

- 1 iteration ≈ 1 full eval-set (~$0.50) + 1 Haiku proposal (~$0.01) = ~$0.51.
- 5 iterations ≈ ~$2.55 (default cost cap).
- Hard-max iteration cap = 8 (`HARD_MAX_ITERATIONS` in `iterate.ts`) —
  refuses to start if `--max-iterations` is set above this.
- Description length cap = 5000 chars (`MAX_DESCRIPTION_LENGTH` in
  `description-editor.ts`) — proposer responses exceeding the cap fail
  loud rather than commit runaway growth.
- Edit surface is enforced both in writer (`replaceDescription`) and
  in policer (`validateDiff`) — body or non-description-key edits
  abort the iteration.
- Plugin commit + push is **destructive**: this loop will mutate your
  `claude-plugins` repo. Confirm you have a clean working tree on the
  branch you want to commit to BEFORE invoking.

### What to do when this form is invoked

1. **Parse the arguments.** First positional is `<plugin>:<skill>`.
   `--iterate` is a flag (no value).
2. **Run the runner.** Single Bash call:

   ```bash
   npx tsx <repo-root>/src/skill-eval/run-iterate.ts <plugin>:<skill>
   ```

   Pass `--max-iterations`, `--cost-cap-usd`, etc. only when the
   operator asked for non-default values.

3. **Surface the markdown report verbatim.** The runner writes:
   - `# Skill-eval iterate report: <plugin>:<skill>`
   - `**Status: <green|max-iterations|cost-cap|fatal-error>**`
   - Best test accuracy + iteration index.
   - Total cost (~$X estimated).
   - Per-iteration table (train, test, cost, sha, status).
   - `## Errors` block when a proposer / reload / edit failure
     short-circuited the loop.

4. **Exit codes.** `0` on green, `1` on every other terminal status.

5. **REPORT.md** is auto-regenerated at
   `<repo>/tests/skill-evals/<plugin>-<skill>/REPORT.md` on every
   `--iterate` run. Contains the per-iteration history table (iter,
   train, test, cost, sha, status), errors block, and a `_Last run:
   <ISO>_` footer. Same writer as Mode 2.

## Mode 4 — sweep every eval-set (`--all`)

```
/skill-eval --all   [--seed N] [--runs-per-query N] [--parallel N]
                    [--pricing-model M] [--eval-sets-dir <dir>]
```

Discovers every `<plugin>-<skill>/eval-set.json` under
`<repo>/tests/skill-evals/` and runs each in turn through Mode 2
(`runEvalSetCore`). Sequential, NOT parallel — JSONL workspace
contention + cross-eval-set cost ceiling. Internal `--runs-per-query`
parallelism inside each eval-set is honored as normal.

Side effects:

- One `REPORT.md` written next to each eval-set (same writer as Modes
  2 + 3).
- One `SWEEP.md` written at `<repo>/tests/skill-evals/SWEEP.md`
  containing the roll-up table with columns: skill, train %, test %,
  runs-per-query, cost, elapsed, status (GREEN | FAIL | ERROR).

### Eval-set discovery

- Walks `<repo>/tests/skill-evals/*` one level deep.
- Skips subdirectories without an `eval-set.json` file.
- Parses directory names `<plugin>-<skill>` by splitting on the FIRST
  hyphen so skill names with hyphens (`issue-card-workflow`,
  `process-kill`) round-trip correctly. Plugin names with internal
  hyphens are out of scope for V1.
- Returns entries sorted lexicographically for deterministic ordering.

### What to do when this form is invoked

1. **No positional plugin:skill.** Recognize the `--all` flag.
2. **Run the runner.** Single Bash call:

   ```bash
   npx tsx <repo-root>/src/skill-eval/run-all-sweep.ts
   ```

   Pass `--parallel`, `--seed`, `--runs-per-query`, `--pricing-model`,
   `--eval-sets-dir` only when the operator asked for non-default
   values.

3. **Surface the markdown roll-up table verbatim.** The runner writes
   the SWEEP.md content to stdout. The operator wants the literal
   table — do not paraphrase.

4. **Exit codes.** `0` iff every entry GREEN; `1` if any entry FAIL or
   ERROR; `2` if no eval-sets were discovered (likely wrong
   `--eval-sets-dir`).

### Failure isolation

A throw from `runEvalSetCore` (eval-set parse failure, worker
unreachable on every probe inside one eval-set, etc.) records the
entry as `status: ERROR` with the message in the Status column and
DOES NOT abort the sweep — every other discoverable eval-set still
runs. The roll-up table surfaces the error message so the operator
can fix the underlying file and re-sweep without re-discovering
which eval-set tripped.

## Architecture (read once)

- **Workspace:** `<repo>/.danxbot/workspaces/skill-eval/` — fully
  isolated so probe JSONLs do not pollute the `issue-worker` /
  `system-test` projects directories. Same plugin set as `issue-worker`
  (`base`, `investigate`, `dev`, `pipeline`, `danxbot`) so any **plugin
  skill** that can fire in production can fire here. Workspace-injected
  danxbot skills (`/danx-next`, `/danx-start`, the issue-worker SKILL.md
  set under `src/poller/inject/workspaces/issue-worker/.claude/skills/`)
  are NOT installed in this workspace and cannot be probed by name — the
  harness is designed for plugin-skill trigger regression checks, not
  for whole-workflow rehearsal.

- **Dispatch surface:** the runner POSTs to `POST /api/launch` on the
  local worker, which is the exact entry point `make test-system` uses.
  No new HTTP routes, no new MCP servers — `dispatch()` from
  `src/dispatch/core.ts` is the only spawn path.

- **Host-mode only:** the runner never invokes `claude` directly. The
  worker handles the spawn shape; on the developer's host that means
  `script -q -f` wrapping interactive claude inside a Windows Terminal
  tab, NEVER `claude -p`. Bugs #36570 and #556 (Claude Code repo) affect
  `-p`-mode skill loading in ways that would invalidate every verdict —
  the harness sidesteps them by routing through host-mode dispatch.

- **JSONL parsing:** `src/skill-eval/jsonl-parser.ts` is pure. It finds
  the dispatch tag, walks entries in order, and matches the first
  `Skill` tool_use (`name: "Skill"`, `input.skill === expected`) against
  the first non-empty assistant text block.

- **Aggregation:** `src/skill-eval/aggregate.ts` is pure. Strict
  majority vote (3 runs → 2/3 fires is triggered; 2/4 is NOT a
  majority). Per-side accuracy = correct / total. Pass threshold is
  0.95 on BOTH train and test.

- **Concurrency:** `src/skill-eval/run-eval-set.ts` implements
  bounded-parallel dispatch via a small cursor-based semaphore. A
  transient `ProbeError` (worker timeout, JSONL missing) is recorded as
  a "did-not-trigger" run with the error in the reason field — it does
  NOT abort the sweep.

## Cost note

Each probe is one real Claude API dispatch (roughly pennies for a
short prompt). A full 20-query × 3-runs eval-set is roughly $0.30 –
$1.00 depending on the dispatched agent's default model — the report
prints the actual total derived from observed token counts.

## Limitations

- One eval-set at a time. Batch mode across multiple plugin:skill names
  is not implemented yet.
- Sub-agent skill calls (`isSidechain: true`) do not count — only the
  top-level session.
- The dispatched agent's model is not pinned; cost is estimated using
  the configured `--pricing-model` (Sonnet-4-6 by default). Future
  enhancement: pull per-message model from the JSONL for an exact
  cost.
