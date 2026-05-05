# Comment / Description / Retro Style

`description`, `comments[].text`, `retro.good`, and `retro.bad` render as markdown in the dashboard's Issues drawer (via `MarkdownEditor`). Use markdown — readers skim formatted content faster than wall-of-prose, and the renderer already pays the parser cost.

## Always use

- **Headers** — `##` for top-level sections in a comment, `###` for sub-sections. Reserve `#` for the comment-style title only when the consumer expects it (`## Code Review`, `## Test Review`, `## Bug Diagnosis`).
- **Fenced code blocks** with language tags — ` ```ts `, ` ```yml `, ` ```bash `, ` ```sql `, ` ```diff `. Multi-line code, command output, YAML snippets, SQL, diffs all belong inside fences. Never leave them as indented prose.
- **Inline code** — file paths (`src/agent/launcher.ts`), symbol names (`spawnAgent`), env vars (`DANXBOT_DISPATCH_TOKEN`), config keys (`overrides.slack.enabled`), CLI flags (`--strict-mcp-config`) all wrap in single backticks.
- **Lists** — `-` for unordered, `1.` for ordered when sequence matters.
- **Tables** for any 2D data (column headers + rows). The drawer renderer handles GFM tables.
- **Bold** (`**…**`) for emphasis on the *one* thing the reader must not miss. Don't bold-spam.
- **Links** — `[label](https://…)` for external refs. Internal issue refs go as plain `ISS-N` text; the drawer auto-links.

## Never do

- Don't escape markdown characters to "play it safe" — `\*`, `\_`, `\#` come out wrong in the renderer.
- Don't paste multi-line code as indented prose without fences — loses syntax highlighting.
- Don't write a wall of prose where a bullet list would say the same thing in half the height.
- Don't repeat the same content as both prose and a list — pick one.
- Don't use ASCII tables; use GFM markdown tables (`|---|---|`).

## Retro fields

`retro.good` and `retro.bad` are free-form markdown strings, NOT bullet lists encoded as a single string. The dashboard renders each as its own `MarkdownEditor` block. Either format works:

```yml
retro:
  good: |
    - Migration ran cleanly on the first try.
    - The fake-claude harness caught the regression locally.
    - Test coverage hit 100% for the new module.
  bad: |
    Spent 30 min chasing a stale dashboard container before realizing
    the backend image was 18h old.
```

Long-form prose, bullet lists, sub-headers — all valid. Pick the shape that reads fastest.
