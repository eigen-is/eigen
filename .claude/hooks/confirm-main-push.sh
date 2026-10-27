#!/usr/bin/env bash
# PreToolUse(Bash): a push to main or of a tag waits for the owner's go; develop and branches pass.
set -uo pipefail

cmd=$(jq -r '.tool_input.command // ""')
printf '%s' "$cmd" | grep -qE '\bgit\b[^;&|]*\bpush\b' || exit 0

push=$(printf '%s' "$cmd" | grep -oE '\bgit\b[^;&|]*\bpush\b[^;&|]*')
branch=$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --abbrev-ref HEAD 2>/dev/null)
targets_main=$(printf '%s' "$push" | grep -qE '(^|[[:space:]:+])(refs/heads/)?main([[:space:]]|$)|--tags|--follow-tags|--all|--mirror|refs/tags/|[[:space:]]v[0-9]' && echo 1)
# A bare `git push` or `git push origin` pushes the current branch.
bare=$(printf '%s' "$push" | grep -qE '\bpush([[:space:]]+-[^[:space:]]+)*([[:space:]]+[^-[:space:]][^[:space:]]*)?[[:space:]]*$' && echo 1)

if [ -n "$targets_main" ] || { [ -n "$bare" ] && [ "$branch" = main ]; }; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"A push to main or of a tag needs the owner'\''s explicit go (AGENTS.md: main moves only on his word)."}}'
fi
