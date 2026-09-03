# Working Method (multi-step changes)

How feature work runs in this repo. This file is for the **orchestrating session and reviewers** —
an implementer subagent working on one file doesn't need it, and briefs shouldn't ship it.
For project context, architecture, and the critical rules, see [AGENTS.md](../AGENTS.md);
for code style, see [CODE-STANDARDS.md](CODE-STANDARDS.md).

The standard way to run feature work, proven over the sheets xlsx-fidelity program (cycles 0–8)
and the 2026-07 sheet-package cleanup program.
Scale it to the job: a one-line fix needs none of this, a feature needs most of it, a program
of changes needs all of it.

1. **Evidence first, spec sign-off before code** — start multi-step work with an audit pass on
   real data (a gap matrix with measured counts, not assumptions), then a written spec with
   explicit decision points, and get sign-off BEFORE implementing. Local-only artifacts (specs,
   audits, verification screenshots) live in gitignored `docs/superpowers/`.
2. **Own branch per unit of work** — merge `--no-ff` to main only when verified; never push
   without an explicit go. If the main checkout is busy (another session), work from a git
   worktree.
3. **TDD, red first** — a failing test before the implementation, always. Tests pin the
   CONTRACT (full round-trips, output-level assertions), never library internals; they are the
   committed regression net.
4. **Delegate to subagents with complete briefs — keep the controller context small.** The
   orchestrating session plans, briefs, reviews results, and merges; implementation, review,
   and browser verification each run in their OWN subagent so no single context drowns in file
   dumps. Every brief includes: required reading ([AGENTS.md](../AGENTS.md) +
   [CODE-STANDARDS.md](CODE-STANDARDS.md) + 2–3 sibling files in the target dir), exact file
   pointers and encodings, scoped test commands, and the hard rules — stay strictly in scope,
   diagnose failures by reading source (never blind-retry), never `git push`.
5. **Independent review before merge** — a reviewer that did NOT write the code, in two
   stages: spec compliance first, then quality (bugs, edge cases, conventions), held to the
   [Review Standard](#review-standard) below.
6. **Standards audit before merge** — a cold reviewer briefed with nothing but [AGENTS.md](../AGENTS.md),
   [CODE-STANDARDS.md](CODE-STANDARDS.md) and the Review Standard below grades every touched non-test file
   better / neutral / worse, with a finding per slip: comments (why only, one line, neighbour density,
   pre-existing slop in a touched file), philosophy (no single-use helpers, no test-only options on
   production signatures, no casts, `type` over `interface`, one source of truth), and broken windows
   left behind. It asks a different question than step 5 — not "is this right" but "does every touched
   file now meet the written bar" — and finds different things; a "worse" or "neutral with findings"
   blocks the merge until fixed. The mechanical half of that bar is gated for free by
   `bun scripts/check-standards.ts` in `bun run check`.
7. **Real-world verification is mandatory** — drive the running dev app headless against REAL
   documents with a throwaway test user, and read the screenshots: verdicts come from pixels
   plus behavioral probes (scroll, click, reload-persistence), not from data-shape assertions
   alone. Data pipelines verify as closed round-trips with feature counts; pure refactors are
   pixel-gated (byte-identical screenshots before/after); files consumed by external software
   (xlsx, ics, eml, …) get spot-opened in the real consumer. Full recipe — test-user
   conventions, auth cookie injection, upload/convert API, HMR workarounds — in
   [VERIFICATION.md](VERIFICATION.md).
8. **Simplify pass after** — review the whole diff from four angles (reuse, simplification,
   efficiency, altitude), apply what's worth it, and re-gate with the same tests/pixels.
   Per-step reviews catch local issues; this pass catches cross-cutting drift.
9. **Docs in the same cycle** — update the domain doc and any status/backlog before calling the
   work done; record accepted drifts and out-of-scope decisions where the next session will
   look for them.
10. **Design changes go in small rounds** — one or two visual changes at a time, screenshots
   first, a human verdict before merge.

## Review Standard

Applies to every reviewer — subagent, external LLM, or a developer driving one. The goal of review
is code that is clean, easy to read and understand, simple, and stable — and consistent: in
patterns, naming, comment density, how solutions are implemented, and how the UX behaves, the
change must be indistinguishable from the code around it.

- **Brief reviewers cold and unopinionated.** A reviewer reads [AGENTS.md](../AGENTS.md) and
  [CODE-STANDARDS.md](CODE-STANDARDS.md) itself and judges against those written standards,
  not personal taste. Give it the task and the files — never the author's narrative of what was
  already "addressed" or "accepted": inherited framing is how half-fixed problems survive review.
- **Review the blast radius, not the diff.** Trace the changed behavior through code the diff did
  not touch — other apps' entry points, SSE handlers, callers and callees of every changed
  function. Most escaped bugs live in files the diff never opened.
- **Hunt absences, not only mistakes.** A diff review can only judge code that exists. For every
  new seam ask: every cache → who invalidates it (including SSE)? every route → what validates
  and bounds its input, and before which side effects? every fan-out or loop → what bounds it?
  every check-then-create → what closes the race? every "fixed" class of bug → are ALL its
  instances fixed, or only the one that was reviewed?
- **Every touched file comes out better.** Fix broken windows. Remove dead code and duplication.
  Replace hand-rolled logic with the shared components and helpers
  ([SHARED-PRIMITIVES.md](SHARED-PRIMITIVES.md)). No over-engineering. Types come from
  `packages/lib/src/types/[domain].ts` — never redefined, never declared at the wrong layer.
- **Signal over volume, both ways.** Report only genuinely real findings — "clean" is a valid
  verdict — but before merge run one recall-biased pass with the absence checklist above: a cold
  reviewer that over-reports and gets pruned beats a polite one that misses. (2026-07: an outside
  reviewer found ten real issues on a twice-reviewed branch; nearly all were absences, half-fixed
  classes, or bugs outside the diff's blast radius.)
