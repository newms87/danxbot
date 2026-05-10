# Per-Repo Settings File

`<repo>/.danxbot/settings.json` is the per-repo runtime state: feature toggles (`overrides.{slack,issuePoller,dispatchApi,ideator,autoTriage}` — three-valued `true|false|null`), masked config display mirrors (NEVER raw secrets), metadata. Lock file `<repo>/.danxbot/.settings.lock` serializes writes. Both gitignored.

**Hot-path reader:** `isFeatureEnabled(ctx, feature)` in `src/settings-file.ts` — never throws, falls back to env default on any failure. **Do NOT bypass in `src/slack/listener.ts`, `src/poller/index.ts`, `src/worker/dispatch.ts`** — direct `readSettings` skips env-default fallback and opens corruption-suppression races.

**Writer-merge invariant:** `display`-only patch never clobbers `overrides`, vice versa. Operator toggles survive every deploy + restart.

> **Sibling tripwire — NOT this file:** `<repo>/.danxbot/CRITICAL_FAILURE` is a separate poller-halt flag (present-or-absent halt signal cleared by human). Don't conflate with three-valued runtime overrides. Contract: `.claude/rules/agent-dispatch.md` "Critical failure flag — poller halt".

**Deep contract** (schema, ownership matrix, why-worker-not-deploy-writes-display, legacy `trelloPoller` migration) → invoke `danxbot:settings-deep` skill BEFORE editing `src/settings-file.ts` or any reader/writer/dashboard handler.
