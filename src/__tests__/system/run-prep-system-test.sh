#!/usr/bin/env bash
#
# Danxbot Pre-Dispatch Prep — System Test
#
# Exercises the prep-verdict route + multi-agent-pick onComplete chain
# end-to-end for each of the four prep verdicts (DX-291 / DX-297):
#
#   - happy path        (combined mode, verdict: "ok") → work dispatch proceeds
#   - separate mode ok                                 → dispatch stops on prep
#   - conflict_on                                       → conflict_on[] stamped on candidate YAML
#   - blocked                                          → status: Blocked + blocked{} stamped
#   - abort                                            → agents.<name>.broken stamped in settings.json
#
# The integration test (src/__tests__/integration/prep-flow.test.ts) is the
# authoritative end-to-end coverage — it drives the real worker prep-verdict
# route through `handlePrepVerdict`, the real multi-agent-pick onComplete
# chain, and asserts each verdict's YAML / settings.json side-effect lands.
# This shell entrypoint is the system-test surface that `make test-system-prep`
# wires into the system test gauntlet alongside the other test-system-* targets.
#
# Cost: free. No Claude API calls — the integration test uses a fake-dispatch
# harness that drives the `onComplete` chain synchronously.
#
# Usage:
#   ./src/__tests__/system/run-prep-system-test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}${CYAN}=== Pre-dispatch prep — system test ===${NC}"
echo -e "${CYAN}→${NC} Driving prep-verdict route via prep-flow integration test"
echo

cd "$PROJECT_ROOT"

# Run the integration test that covers every verdict + every dispatch shape.
# `npx vitest run --reporter=verbose` surfaces individual test names so the
# verdict coverage is visible in CI logs.
if npx vitest run --reporter=verbose src/__tests__/integration/prep-flow.test.ts; then
  echo
  echo -e "${GREEN}${BOLD}✓ Pre-dispatch prep system test PASSED${NC}"
  exit 0
else
  echo
  echo -e "${RED}${BOLD}✗ Pre-dispatch prep system test FAILED${NC}"
  exit 1
fi
