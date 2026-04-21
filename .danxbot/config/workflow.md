# Danxbot Workflow

## Editing and Testing

1. Edit TypeScript files in `src/`
2. Run `npx vitest run` for unit tests
3. Run `npx tsc --noEmit` for type checking
4. Dashboard: `npm run dashboard:dev` for HMR on port 5173

## Isolate Pure Helpers From `src/poller/index.ts`

Importing anything from `src/poller/index.ts` (or any file that transitively loads `src/config.ts`) in a test hard-requires `DANXBOT_DB_USER` and friends at module-import time — the test fails before any assertion with a confusing "Missing required environment variable" error. Keep pure helpers (rule-file renderers, formatters, classifiers) in their own modules so test files can import them without pulling the config chain.

## Committing

Commit directly to main. Use conventional commit messages prefixed with `[Danxbot]`.
