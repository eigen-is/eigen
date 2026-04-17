<!--
Thanks for opening a PR!

**Heads up: for new features or larger changes, please open an issue first** instead of a PR.
The codebase moves fast and feature PRs often need a rebase or a rethink before they can land.
Small fixes — bugs, typos, UI tweaks — are very welcome as PRs directly.

Want to take over a whole area (a full app, or a cross-cutting concern)? Email reinder@eigen.is
rather than opening a PR. See docs/CONTRIBUTING.md for details.

Reminders:
- One concern per PR. Split unrelated changes into separate PRs.
- Run `bun run check` (lint + typecheck + test) before pushing.
- Enable "Allow edits from maintainers" so I can help land your PR.
- See docs/CONTRIBUTING.md and AGENTS.md before writing code.
-->

## What

<!-- What does this PR do? One or two sentences. -->

## Why

<!-- Why is this change needed? Link a related issue if there is one. -->

Closes #

## How to test

<!-- Steps for a reviewer to verify this works. Include setup if non-obvious. -->

## Checklist

- [ ] One concern per PR
- [ ] `bun run check` passes locally (lint + typecheck + test)
- [ ] New code lives in the right layer (see AGENTS.md: hooks in `packages/lib/`, shared UI in `packages/ui/`, app-specific in `apps/`)
- [ ] New code follows all rules from `CODE-STANDARDS.md`
- [ ] Relevant docs in `docs/` (and `AGENTS.md` if architecture changed) are updated
- [ ] "Allow edits from maintainers" is enabled on this PR
