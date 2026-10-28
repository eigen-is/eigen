---
name: changelog
description: Use when adding to, rewriting, polishing or reviewing Eigen's `CHANGELOG.md`, including the entries for a release, a merge that changes what a user or self-hoster sees, a request to make the changelog read human-written or friendlier, or a check that its claims are still true.
---

# Changelog

`CHANGELOG.md` is read by people who use eigen.is and by people who self-host Eigen, and `./eigen update` reads it too. Write every line for someone who has never seen the code. The `[0.4.0]` section is the model: match its shape and voice, and write a little tighter than it.

## What goes in

One bullet per thing a person notices since the last release tag (`git describe --tags --abbrev=0`), not since the last commit, so most commits get none. That leaves out:

- a regression introduced and fixed between two tags, since nobody on a release had it
- refactors, renames, lint rules, cast counts, tests, check timings and review fixes, since nobody outside the repo sees them
- what only a developer's Mac shows, since Eigen runs on Linux in Docker ([SELF-HOSTING.md](../../../docs/SELF-HOSTING.md))

A self-hoster's change goes in when they can see it on their server, in plain words and with the number they can check, as 0.4.0's **Server memory** bullet does.

## How a bullet reads

A reader skims, so a bullet gives the effect and stops:

- **Shape**: Keep a Changelog headings (`### Added`, `### Changed`, `### Fixed`), each bullet `- **Label** — text`, one line, no hard wrap, no closing full stop. Bullets sit grouped by app within a section.
- **Length**: one or two short sentences, three at most. 0.4.0 averages 29 words a bullet; stay under that, and split or cut one past 40.
- **Label**: what the reader looks for, such as **Formulas in Sheets** or **Paths in Drive**. Never a bare app name repeated down the list, since four bullets labelled **Sheets** tell a skimmer nothing.
- **Words**: present tense, plain, about what a person sees or does. No "is now", no hedges, no em dash inside the text, no type, function, file, field or library names. "Saving a form someone else changed meanwhile is refused instead of overwriting their change", not "a stale form gets a 412".
- **Apps**: name the ones a change touches ("Docs, Sheets, Slides and Vector"), never "every app" unless it is.

Keep every fact a reader can act on: a menu path, a shortcut, a limit, a loss. Cut what doesn't change what they do:

- the how and the why, which live in the commit
- a qualifier for a rare case ("even within the same second", "also when its numbers have a format of their own")
- a second example, and a sentence that restates the first one's consequence
- what a person already expects, and what didn't change ("still adds one person at a time")

Merge bullets a reader would see as one change, such as two fixes to the same path bar. A Word, Excel or PowerPoint round trip keeps its own bullet, as in 0.4.0.

## Markers `./eigen update` reads

`apps/api/src/cli/update-check.ts` matches substrings: a line containing `(breaking)` makes the update ask first, and one containing `(full backup)` makes it take a full backup. Put them in a label on purpose (`**Backups (breaking)**`), never in running text, where they would fire by accident. A commit that changes how a document's own database stores data, a container database migration, marks its `[Unreleased]` bullet with `(full backup)`, since `./eigen update` on the main channel reads `[Unreleased]` too and takes a Full backup before such an update.

## The intro is the GitHub release

`bun run release publish` posts the paragraph under the version heading as the whole GitHub release ([TESTING.md § A GitHub release says what changed in a few lines](../../../docs/TESTING.md#a-github-release-says-what-changed-in-a-few-lines)), and `./eigen update --check` shows it. Write it at release time, for someone who has never used Eigen: two to five plain sentences naming the main changes, no list and no internal names. A note an updater needs, such as reloading open documents, closes it in one sentence. Until the release, `[Unreleased]` has no intro, and that note is the first `### Changed` bullet.

## Every claim is checked

Commit messages overclaim, and they speak from the code's side: "refreshes the owner's access list" is not the list the person you shared with sees. So back each bullet with the code that does it, check shortcuts, limits, counts and lists one by one, and make sure a claim holds for every case it names. Before a tag, check `[Unreleased]` against `git log` since the last tag, since it has missed whole rounds.

On a polish pass, `[Unreleased]` gets the real work and released sections get small consistency edits only.

## When you hand it back

Run `bun scripts/check-docs-links.ts` and `bunx --bun @biomejs/biome check CHANGELOG.md`. Report the character count before and after, what you merged or cut and why, and every claim you corrected, with its evidence (a commit or `file` and symbol).
