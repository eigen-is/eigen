#!/usr/bin/env bash
# PreToolUse(Bash): a push needs an explicit go — docs/WORKING-METHOD.md step 2.
set -uo pipefail

cmd=$(jq -r '.tool_input.command // ""')

if printf '%s' "$cmd" | grep -qE '\bgit\b[^;&|]*\bpush\b'; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"git push needs an explicit go from you (docs/WORKING-METHOD.md step 2: merge to main and push only after an explicit go)."}}'
fi
