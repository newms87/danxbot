#!/usr/bin/env bash
# agent-finalize.sh — Multi-worker dispatch completion (DX-162 / DX-158).
#
# Invoked by an agent at the end of a card dispatch from inside its
# persistent worktree at <repo>/.danxbot/worktrees/<agent-name>/. The
# script squashes the agent branch's WIP into one Conventional Commits
# commit on top of `origin/main`, pushes it (with rebase-loop on push
# race), and resets the agent branch back to a clean `origin/main` for
# the next dispatch.
#
# Usage:
#   bash .danxbot/scripts/agent-finalize.sh <agent-name> <CARD-ID> "<title>" "<bullet 1>" "<bullet 2>" ...
#
# Exit codes:
#   0  — success (squash commit pushed) OR no-op (agent had no commits to push)
#   1  — rebase conflict (`git rebase origin/main` exited non-zero); agent must
#        resolve, run `git rebase --continue`, and re-invoke the script.
#   2  — push race exhausted (5 consecutive non-fast-forward push rejections);
#        agent should comment on the card and signal danxbot_complete with
#        status "needs_help".
#   64 — usage error: missing args, malformed `<CARD-ID>`, or `<title>` contains
#        a newline. Distinct from rebase-conflict (1) so the SKILL routes the
#        agent to a "fix the invocation" path, not a "git rebase --continue"
#        path.
#   65 — wrong branch: invoked from a worktree whose HEAD is not on `<agent>`.
#        Distinct from 1 because the recovery is "investigate the worktree",
#        NOT "git rebase --continue".
#
# Worktree-safety design (do NOT change without reading this paragraph):
# Each agent owns ONE worktree at <repo>/.danxbot/worktrees/<agent>/ with
# branch `<agent>` checked out. The parent repo at <repo>/ may have `main`
# checked out separately, so this script CANNOT do `git checkout main`
# inside the worktree (git refuses — "main is already checked out
# at /path/to/parent"). Instead the script squashes the branch via
# `git reset --soft <merge-base>` and pushes the agent branch's HEAD
# directly to `refs/heads/main` on origin (`git push origin HEAD:main`).
# The squash commit's parent IS origin/main, so the push is a fast-forward
# unless someone else pushed first — in which case we fetch + rebase
# the squash commit onto the new origin/main and retry.

set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "Usage: agent-finalize.sh <agent-name> <CARD-ID> \"<title>\" \"<bullet>\" ..." >&2
  exit 64
fi

agent="$1"
card="$2"
title="$3"
shift 3
bullets=("$@")

# Card id shape — `<PREFIX>-<N>` (e.g. `DX-162`). The id lands inside the
# Conventional Commits scope `feat(<card>):`; an unconstrained value could
# inject parens, spaces, or shell-meta chars into the commit subject and
# break downstream parsers (tracker bots, changelog generators). Reject at
# the gate, exit 64.
if [[ ! "$card" =~ ^[A-Z]+-[0-9]+$ ]]; then
  echo "agent-finalize: invalid card id '$card' — expected '<PREFIX>-N'" >&2
  exit 64
fi

# Title shape — single-line. Multi-line `git commit -m` arguments produce
# an unexpected commit-subject layout that breaks Conventional Commits
# linters and the dashboard's commit-summary renderer. Single-line titles
# are the contract; reject newlines at the gate.
if [[ "$title" == *$'\n'* ]]; then
  echo "agent-finalize: title must be single-line (no embedded newline)" >&2
  exit 64
fi

# 0. Sanity — must be on the agent's branch. The persona block in the
#    dispatch prompt names this branch; if the agent is on the wrong
#    branch the worktree may be wedged AND `git rebase --continue` would
#    be wrong recovery — so the script exits 65, distinct from
#    rebase-conflict (1).
current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$current_branch" != "$agent" ]]; then
  echo "agent-finalize: expected branch '$agent', got '$current_branch'" >&2
  exit 65
fi

# 1. Stage + commit any uncommitted work as a temporary WIP commit. The
#    rebase + squash flatten this back into the single conventional
#    commit so the WIP message itself never lands on origin/main.
if [[ -n "$(git status --porcelain)" ]]; then
  git add .
  git commit -m "WIP: $card"
fi

# 2. Fetch latest origin and rebase the agent branch onto origin/main.
#    `set -e` causes the script to exit non-zero on rebase conflict —
#    the agent reads the script's stderr (which carries git's own
#    conflict report from `git rebase`) and resolves before re-running.
git fetch origin
git rebase origin/main

# 3. Squash all commits the agent branch carries on top of origin/main
#    into ONE commit with a Conventional Commits header + bullet body.
#    `reset --soft` to merge-base preserves the working tree + index
#    contents (everything stays staged), then a single commit produces
#    the squash. If the branch carries zero commits ahead of
#    origin/main (agent ran finalize without making any code changes),
#    skip the squash + push and exit 0 — the calling skill should
#    have detected this earlier and skipped finalize altogether, but
#    defending here keeps a stray invocation from blowing up.
base="$(git merge-base HEAD origin/main)"
head="$(git rev-parse HEAD)"
if [[ "$base" = "$head" ]]; then
  # No commits to push. Emit `NO_OP` (NOT `PUSHED <sha>`) so an agent
  # that captures stdout into `retro.commits[]` doesn't record an
  # unreachable WIP sha as a real commit. The SKILL's Step 7a #5
  # ("No-op safety net") routes on the stderr substring; the stdout
  # token here lets a stricter parser distinguish the no-op from a
  # real push.
  echo "agent-finalize: no commits ahead of origin/main — nothing to push" >&2
  echo "NO_OP"
  exit 0
fi

git reset --soft "$base"
msg_args=(-m "feat($card): $title")
for b in "${bullets[@]}"; do
  msg_args+=(-m "- $b")
done
git commit "${msg_args[@]}"

# 4. Push the squash commit to origin/main with a rebase-loop on race.
#    `git push origin HEAD:main` fast-forwards origin/main to our
#    single squash commit. On non-fast-forward (someone else pushed
#    between our fetch in step 2 and now), refresh origin/main and
#    rebase our single commit on top, then retry. Cap at 5 attempts
#    so a wedged remote doesn't loop forever.
attempts=0
until git push origin HEAD:main; do
  attempts=$((attempts + 1))
  if [[ $attempts -ge 5 ]]; then
    echo "PUSH_RACE_EXHAUSTED" >&2
    exit 2
  fi
  git fetch origin
  git rebase origin/main
done

# 5. Reset the agent branch back to origin/main so the next dispatch
#    starts from a clean state. `git fetch` was already run inside the
#    push loop on every iteration, but post-push the local
#    `origin/main` ref needs to reflect the just-pushed sha.
git fetch origin
git reset --hard origin/main

# 6. Fast-forward `origin/<agent>` to match `origin/main` so the remote
#    agent branch never lags its own pushes (DX-644). The previous
#    dispatch left `origin/<agent>` pointing at WIP commits the squash
#    reset away locally; without this step those refs accumulate every
#    dispatch and a future prep-skill `git push` of the agent branch
#    fails non-fast-forward. `--force-with-lease` refuses to stomp a
#    concurrent push (rare on agent-owned branches but possible).
git push --force-with-lease origin "HEAD:refs/heads/$agent"

echo "PUSHED $(git rev-parse origin/main)"
