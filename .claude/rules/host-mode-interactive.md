# Host Mode MUST Be Interactive — Never Use `-p`

## The Invariant

**The entire purpose of host runtime mode is to launch an INTERACTIVE Claude Code terminal.** That is the only reason host mode exists. If you are working on host-mode terminal spawning, dispatch scripts, or the `claude` CLI invocation inside `src/terminal.ts`, the following is non-negotiable:

### `claude -p` is FORBIDDEN in host terminal mode

`claude -p "<prompt>"` is the non-interactive "print" / headless mode — it processes the prompt, streams output, and exits. **This is exactly what host mode must NOT do.** Using `-p` defeats the entire purpose of the feature.

Host-mode terminal requirements:
- The Claude Code TUI renders and stays attached to the terminal
- The user can read the scrollback, see tool calls render live, type follow-ups, and interact with the session
- The process does NOT exit immediately after the first response
- `script -q -f` may wrap the process for log capture, but the inner process must still be an interactive TUI, not `-p`

### Why host vs docker exists

Docker runtime is the headless path (`claude -p` is acceptable there — no TTY, no user). Host runtime is the interactive path. If both modes use `-p`, host mode has no reason to exist. The mode distinction exists SOLELY to support interactivity on the host.

## How to Pass the Prompt Without `-p`

Options to launch interactive `claude` with an initial prompt:
- Pipe prompt via stdin: `claude < prompt.txt` (keeps TUI, seeds initial input)
- Use `claude "<prompt>"` as a positional argument if the CLI supports it
- Boot claude, then use `--resume` to attach to a pre-seeded session

Never fall back to `-p` "because it's simpler." The simplicity is the bug.

## Code Locations

- `src/terminal.ts` — `buildDispatchScript()` builds the bash script that launches `claude` in the terminal tab. This function is the primary place where this rule must be enforced.
- `src/agent/launcher.ts` — routes between headless (`spawnAgent`) and interactive (`spawnInTerminal`) paths based on `openTerminal`.
- `config.isHost` — when `true`, host runtime is active and the terminal must be interactive.

## Mechanical Check Before Every Edit to Terminal Scripts

Before committing any change to `src/terminal.ts` or anything that builds the bash script launched in the Windows Terminal tab:

1. Does the script invoke `claude -p`? → **Violation. Stop.**
2. Does the script run `claude` in a way that exits immediately after one turn? → **Violation. Stop.**
3. Does the user get a live, interactive TUI they can type into? → Required.

If you cannot answer yes to #3, the change is wrong.
