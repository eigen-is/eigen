---
name: domain-doc
description: Use when writing, rewriting, extending, shortening or reviewing a domain doc under `docs/` (MAIL.md, CANVAS.md, ACL.md, COLLAB.md and their siblings), including the docs update that closes a feature, adding a gotcha or design decision to a doc, shrinking a doc that grew too long, merging docs that cover one domain, or a claim-by-claim docs review. Not for drafts under `docs/superpowers/`, and not for help-center articles under `apps/index/src/data/support/`, which have the support-article skill.
---

# Domain doc

A domain doc tells a developer how one part of Eigen works now and why it is built that way. They read it before they touch the code. The code answers "what does this function do". The doc answers what the code can't: the design decisions, the invariants, and the gotchas that already bit someone.

**A doc covers a domain, an app or a core function**: SHEETS.md for the sheets app, COLLAB.md for the collab core, CALDAV.md for the CalDAV service beside CALENDAR.md for the calendar app. A service with its own protocol (CalDAV, CardDAV, WebDAV) may have its own doc next to its app's; that is a judgment call, not a rule. Never a doc per feature or per sub-mechanism. New material goes into the doc of the domain it belongs to, and a doc is not split to shorten it: every extra doc is one more place to look and one more to keep in sync.

Read `docs/CALENDAR.md` for the opening and `docs/COLLAB.md` for the reference sections before you write. What to avoid: narration, catalogues and file tours.

Not domain docs: the backlogs (`ROADMAP*.md`, `SHEETS-TODO.md`), the generated `SHARED-PRIMITIVES.md`, the standards and guides (`CODE-STANDARDS.md`, `CODE-EXAMPLES.md`, `REVIEW-STANDARD.md`, `SUPPORT-STYLE-GUIDE.md`, `CONTRIBUTING.md`) and the operator guide `SELF-HOSTING.md`. The voice rules still apply to them.

## The shape

```markdown
# Name

> **TLDR:** The concept in plain words: what this is, who or what uses it, where its data lives, and the one idea the design rests on. Then the one or two directories.

An introduction of a few short paragraphs, for a developer who has never seen this code. What the thing is and how it is used. Where the data lives and what is the truth. Why it is built this way. Each term the sections rely on, in a plain clause the first time it appears. Last, what the sections cover and the few things that surprise people, linked to their sections.

## A heading that states a fact

What, then why, then where. One idea per section.

## See also
```

- The opening is for someone arriving cold. After the title, the TLDR and the introduction under it, a reader who has never opened this code gets the concept: what the domain is, where its data lives, what the truth is and why it is built that way. It reads like a person explaining the thing to a colleague.
- None of this is a form to fill in. Each doc is different and picks its own order and length. A small domain may need a clause or two after the TLDR, a large one several paragraphs, and an opening that already gets the concept across stays as it is. What is fixed is the outcome: a newcomer gets the concept from the first few paragraphs.
- Write for a competent developer who is new to this domain. Define Eigen's own terms and the domain's jargon (resource, projection, container, stamp, kind), not general ones (SQLite, REST, WebSocket). CALENDAR.md's introduction is the upper bound in length and hand-holding.
- The TLDR stands alone and stays short. It is the concept and where the code lives, not a list of surprises and not a table of contents. A TLDR that opens with a class name or a storage detail is rewritten to open with the thing in plain words.
- The TLDR and the introduction never say the same thing twice. The introduction carries the model; the things that are not obvious from the code come at its end, each linked to the section that carries it.
- No term before its definition. A word the reader could not know gets one plain clause where it first appears, or waits until its section. The reference sections may assume the opening. They may not assume anything else.
- Headings state facts: "A document lingers after the last unsubscribe", not "Lifecycle". A heading avoids "seam" and other coined words unless the doc defines them. ACL.md's label headings are its owner's call, not a pattern: a fact heading wins.
- Every section carries a why. A section with no reason in it is a catalogue. Cut it or point at the directory.
- Tables hold parallel facts (values and their effect, a crash point and its repair). Bullets for short lists. Prose for reasons. A code block only for a type or route shape that is the contract, ten lines at most.
- Name a symbol when the reader will grep for it. Otherwise use plain words. Point at a directory, not at every file in it.
- A term the code doesn't use is defined in the sentence that introduces it, or replaced. A term another doc defines is linked at first use.

## Length follows the domain

A doc is as long as its domain needs. It gets shorter only by cutting narration, repetition and code tours, never by moving content to another file. For readability:

- The TLDR is one short paragraph. The introduction under it is as long as the model needs, and no longer.
- Each section makes one point. A section that makes two becomes two sections of the same doc.
- Paragraphs stay short enough to read in one go. A paragraph is one line: no hard wraps.
- Sentences are plain and short. Split one that needs a second read.

## What goes where

| Detail | Belongs in |
|---|---|
| A design decision and its reason, an invariant, a cross-domain seam, a gotcha | The doc |
| The data model in plain words: what is stored, where, and what is the truth | The introduction |
| Props, columns, routes, config keys, every constant's value, file-by-file tours | Nowhere. Point at the directory or the file that defines them |
| Function-by-function narration | Nowhere. The code says it |
| An edge case | The test that pins it. The doc names the test file if the case matters |
| A reason that only matters at one line of code | One terse comment there, if a maintainer could not derive it |
| History: "used to", "previously", "no longer", dates, incidents | Nowhere. Git keeps it |
| A measurement | The doc, once, when a decision rests on it ("a 48 MB snapshot is 1 MB at zstd" is why the codec exists). An example's numbers come from the test that pins it, never invented. Otherwise nowhere |
| A stored format with live user data (stickies) | The doc, as a contract: every root, field and default the reader tolerates |
| Open work and known bugs | `docs/ROADMAP.md` |
| What a user sees and clicks | The help center, via the support-article skill |
| Another domain's mechanics | That domain's doc, linked |

## Rewriting or merging a doc

1. **List the claims first.** Walk the old doc (every doc, when merging) and write down every design decision, invariant and gotcha, one line each. This list is what you must not lose.
2. **Check each claim against the code.** Find the line that makes it true. A claim with only, every, never or instead is checked against the code path that makes the quantifier true, not just the happy path. A what you can't confirm in a few greps stays out, and your report lists it as unverified: never cut a claim silently. A claim the code contradicts is never dropped silently: the doc states the corrected fact, or a ROADMAP row names the gap. A why stays unless the code contradicts it. When the check narrows an inherited quantifier ("every host" becomes "docs and sheets"), the doc says what the excluded path does now, or the gap gets a ROADMAP row. A wrong doc is worse than a short one. A limitation the old doc listed gets a ROADMAP row or a stated reason it is accepted.
3. **Write the model in your own words** before the TLDR. If you cannot say it plainly, read more code. The TLDR and the introduction come from this, not from the list of claims.
4. **Write the TLDR and the introduction**, then one section per claim that needs one. Merge claims that share a reason. When the introduction takes over a sentence from a section, cut it there: move facts, never repeat them.
5. **Give every claim a home** from the table above, and verify the home of every reason. A reason survives even when its "what" goes. For every why you drop from the doc, grep the code for the reason (not the symbol). If it is absent, add a one-line comment in the same commit. Your report to the caller, not only the commit message, lists each dropped why with its home as `file:line`, doc §, or test name. The report also cites the doc § for every sentence the commit message says the doc now contains.
6. **Check.** Run the checklist.

Editing one section follows the same steps, and the TLDR and introduction change only when one of their claims does. A doc that receives moved material runs the whole checklist too. Renaming a heading breaks its anchor and its prose citations: grep `docs/`, `AGENTS.md` and `.claude/` for `NAME.md#old-anchor`, and `apps/ packages/ docker/ scripts/` for `NAME.md § Old heading`, skipping `.claude/worktrees/` and `docs/superpowers/`, and fix every hit. After rewording a claim, grep `docs/ROADMAP*.md` for prose that quotes the old one.

## Checklist before you commit

```bash
f=docs/NAME.md
grep -nE 'used to|previously|no longer' $f                                  # expect nothing
grep -n '—' $f                                                              # judge each: slop dashes go, a plain single aside may stay
grep -nE 'showed|was a|turned every' $f                                     # fix narration: say why it is so now
grep -nE 'kept for|later|not built|will' $f                                 # deferred work: a ROADMAP row instead
grep -nE 'here|above|below|this doc' $f                                     # a section talks about the doc: cut it
bun scripts/check-docs-links.ts                                             # files exist, not anchors
```

The greps flag candidates, not errors. Read every hit: "later ones" or `will-change` is fine where "will be added later" is not.

```bash
# every #anchor resolves: prints each link whose heading is gone (bash, since zsh rejects the patterns)
bash <<'EOF'
grep -oE '\]\(([A-Za-z0-9_./-]*\.md)?#[^)]+\)' AGENTS.md .claude/skills/*/SKILL.md $(find docs -name '*.md' -not -path 'docs/superpowers/*') | while IFS= read -r hit; do
  src=${hit%%:*}; link=${hit#*](}; link=${link%)}; doc=${link%%#*}; target=$src; [ -n "$doc" ] && target=$(dirname "$src")/$doc
  grep -E '^#{1,6} ' "$target" | sed -E 's/^#+ //' | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9 _-]//g; s/ /-/g' | grep -qxF -- "${link#*#}" || echo "$src -> $link"
done
EOF
```

- Read only the title, the TLDR and the introduction, as a newcomer who has never seen this code. Can you say what the thing is, where its data lives and why it is built that way? Is any term used before its clause?
- The TLDR is one short paragraph and makes sense alone. The introduction does not repeat it. Every claim in either has a section that carries it, or is fully said in the introduction. An opening that counts its claims ("four things") is recounted after every edit.
- Every heading states a fact. Every section has a why.
- The sections never talk about the doc: no "here", "above", "below" or "see this doc". They state facts and link to other docs, or to a section by heading. Only the introduction may say what the sections cover. A rewrite owns the whole file, so every hit in it is fixed.
- Present tense. Short sentences in simple English. No slop em-dashes (dramatic pause, stacked asides, a dash doing a colon's or full stop's job), no "Note that", "robust", "seamlessly".
- No hard line breaks inside a paragraph.
- Every path you name exists, and both link checks print nothing. A symbol named with a path is grepped in that file. A symbol named without one must have its definition in exactly one file of a repo grep, or it gets its path.
- A new doc gets its line in the AGENTS.md index and its row in `docs/ARCHITECTURE.md`.

## Common mistakes

- Opening with the first surprise instead of the model. A surprise only lands when the reader knows what normal looks like.
- Splitting a doc, or starting a new one for a feature, instead of cutting narration.
- Compressing the catalogue instead of cutting it. Six files in six clauses is still a file tour.
- Cutting the why and keeping the what. The what is in the code. The why is not.
- Compressing a gotcha until it no longer says what breaks.
- Keeping claims from the old doc unchecked because they were already there. An inherited only or every is the likeliest to be wrong.
- Bold lead-ins on every bullet. Bold one key rule per section at most.
