---
name: changelog
description: Use when adding to, rewriting, polishing or reviewing Eigen's `CHANGELOG.md`, including the entries for a release, a merge that changes what a user or self-hoster sees, a request to make the changelog read human-written or friendlier, or a check that its claims are still true.
---

# Changelog

`CHANGELOG.md` is read by people who use eigen.is and by people who self-host Eigen, and `./eigen update` reads it too. Write every line for someone who has never seen the code.

## What goes in

A change goes in when a user or self-hoster notices it, measured against the last release tag (`git describe --tags --abbrev=0`), not against the last commit:

- A regression introduced and fixed between two tags gets no bullet: nobody on a release ever had it.
- Refactors, moved files, lint rules, test speed, internal renames and review fixes get none.
- Eigen runs on a Linux server in Docker (`docs/SELF-HOSTING.md`); a change seen only on a developer's Mac gets none.

## How a bullet reads

A bullet is the effect alone: what a person sees, does or can rely on now, in one or two sentences. The cause, the fix and where it lives are in the commit, so the bullet holds none of them. "A notification to a large team arrives without stalling the server" is a whole bullet.

- The file's own shape: Keep a Changelog headings (`### Added`, `### Changed`, `### Fixed`), each bullet `- **Label** — text`, no closing full stop, one bullet per line. Never hard-wrap.
- One idea per bullet. Split a bullet that chains clauses with semicolons.
- Short sentences in plain words, present tense: what the person sees or does now. No "is now", no hedges, no em dashes inside the text.
- What a user sees in place of the internals: no type, function, file, field or library names (`isSameFill`, `ApiError(404)`, Yjs, etag). "Saving a form someone else changed meanwhile is refused instead of overwriting their change", not "a stale form gets a 412".
- Name the apps a change touches ("Docs, Sheets, Slides and Vector"), never "every app" unless it is.
- Keep every fact a user can use. Shorten only what says nothing to them.

## Markers `./eigen update` reads

`apps/api/src/cli/update-check.ts` matches substrings: any line containing `(breaking)` makes the update ask first, and any line containing `(full backup)` makes it take a full backup. Write them only on purpose, put them in the label (`**Backups (breaking)**`), and never let either string appear by accident. The first paragraph under a version heading is the intro `./eigen update --check` shows.

## The intro is the GitHub release

`bun run release publish` posts that intro as the whole GitHub release, with a link to the full section ([TESTING.md § A GitHub release says what changed in a few lines](../../../docs/TESTING.md#a-github-release-says-what-changed-in-a-few-lines)). Write it for someone who has never used Eigen: two to five short sentences that name the main things added or changed, in plain words. A note an updater needs (reload open documents, a breaking change) closes it in one sentence. No bullet list and no internal names.

## Every claim is checked

Before a bullet stays, find what backs it: the commit (`git log --since … --until …` around the release date) and the code that does it. A claim you can't back is cut or corrected. Shortcuts, limits, counts and lists ("XLOOKUP, TEXTJOIN and …") are checked one by one. Before a tag, check `[Unreleased]` against `git log` since the last tag: it has missed whole rounds.

## When you hand it back

Report: what you added or changed per section, every factual correction with its evidence (commit or `file:line`), word counts before and after per section, and three before/after sample bullets. Run `bun scripts/check-docs-links.ts` and `bunx --bun @biomejs/biome check CHANGELOG.md` first.

## Common mistakes

| Mistake | Instead |
|---|---|
| A bullet per commit | One bullet per thing a user notices; most commits get none |
| Comparing with the last commit | Compare with the last release tag |
| Rewriting old releases wholesale on a polish pass | Small consistency edits there; the unreleased section gets the real work |
| Trusting the commit message | Check the code; commit messages overclaim |
| `(breaking)` in running text | Only in a label, on purpose |
