---
name: domain-doc
description: Use when writing, rewriting, extending, shortening or reviewing a domain doc under `docs/` (MAIL.md, CANVAS.md, ACL.md, COLLAB.md and their siblings), including the docs update that closes a feature, adding a gotcha or design decision to a doc, shrinking a doc that grew too long, merging docs that cover one domain, or a claim-by-claim docs review. Not for drafts under `docs/superpowers/`, and not for help-center articles under `apps/index/src/data/support/`, which have the support-article skill.
---

# Domain doc

A domain doc tells a developer, before they touch the code, how one part of Eigen works now and why: the design decisions, invariants and gotchas the code can't say. Model the opening on `docs/CALENDAR.md` and the reference sections on `docs/COLLAB.md`.

**A doc covers a domain, an app or a core function** (SHEETS.md, COLLAB.md, CALDAV.md beside CALENDAR.md); a service with its own protocol (CalDAV, CardDAV, WebDAV) may get a doc next to its app's, as a judgment call. Never a doc per feature or sub-mechanism: new material goes into its domain's doc, and a doc is not split to shorten it. Not domain docs, though the voice rules apply: the backlogs (`ROADMAP*.md`, `*-TODO.md`), the generated `SHARED-PRIMITIVES.md`, the standards and guides (`CODE-STANDARDS.md`, `CODE-EXAMPLES.md`, `REVIEW-STANDARD.md`, `SUPPORT-STYLE-GUIDE.md`, `CONTRIBUTING.md`) and `SELF-HOSTING.md`.

## The shape

```markdown
# Name

> **TLDR:** The concept in plain words: what this is, who or what uses it, where its data lives, and the one idea the design rests on. Then the one or two directories.

An introduction of a few short paragraphs: what the thing is and how it is used, where the data lives and what is the truth, why it is built this way, each term the sections rely on in a plain clause. Last, the few things that surprise people, linked to their sections.

## A heading that states a fact

What, then why, then where. One idea per section.

## See also
```

- The outcome is fixed, the form is not: after the TLDR and introduction a newcomer knows what the domain is, where its data lives, what the truth is and why, told as to a colleague who is a competent developer new to this domain. A small domain may need a clause or two, a large one several paragraphs; an opening that already does this stays. CALENDAR.md's introduction is the upper bound in length and hand-holding.
- The TLDR is one short paragraph that stands alone, never a list of surprises or a table of contents, and opens with the thing in plain words, not a class name or storage detail. The introduction never repeats it and is as long as the model needs, no longer.
- Define Eigen's terms and the domain's jargon (resource, projection, container, stamp, kind), not general ones (SQLite, REST, WebSocket), with one plain clause at first use; no term before its definition. Sections may assume the opening and nothing else. A term the code doesn't use is defined where introduced, or replaced; one another doc defines is linked at first use.
- Headings state facts: "A document lingers after the last unsubscribe", not "Lifecycle"; no "seam" or coined words the doc doesn't define. ACL.md's label headings are its owner's call, not a pattern.
- Every section carries a why; one without is a catalogue: cut it or point at the directory.
- Tables for parallel facts (a value and its effect, a crash point and its repair), bullets for short lists, prose for reasons, a code block only for a contract type or route shape of ten lines at most.
- Name a symbol when the reader will grep for it, otherwise plain words. Point at a directory, not each file. No line numbers (AGENTS.md § Done means).

## Length follows the domain

A doc gets shorter only by cutting narration, repetition, edge cases and code tours, never by moving content elsewhere. It grows with the design, not the fixes: a fix adds a sentence only when it changes a decision or invariant. A section of special case after special case describes a patch; report it ([REVIEW-STANDARD.md](../../../docs/REVIEW-STANDARD.md), *A patch is a finding*). Most domains fit in a few thousand words; search a longer doc for narration and edge cases first. One point per section (two make two sections of the same doc), about five sentences per paragraph, and split a sentence that needs a second read.

## What goes where

| Detail | Belongs in |
|---|---|
| A design decision and its reason, an invariant, a cross-domain seam, a gotcha | The doc |
| The data model: what is stored, where, what is the truth | The introduction |
| Props, columns, routes, config keys, constant values, file tours | Nowhere: point at the defining directory or file |
| Function-by-function narration | Nowhere: the code says it |
| An edge case | Its test; the doc names the test file if the case matters |
| A reason that matters at one line | One terse comment there, if a maintainer could not derive it |
| History ("used to", "previously", "no longer", dates, incidents) | Nowhere: git keeps it |
| A measurement | The doc, once, when a decision rests on it ("a 48 MB snapshot is 1 MB at zstd" is why the codec exists); an example's numbers come from its test, never invented. Otherwise nowhere |
| A stored format a collaborator writes (stickies) | The doc, as a contract: every root, field and default the reader tolerates |
| Open work and known bugs | `docs/ROADMAP.md` |
| What a user sees and clicks | The help center (support-article skill) |
| Another domain's mechanics | That domain's doc, linked |

## Rewriting or merging a doc

1. **List the claims**: every design decision, invariant and gotcha of the old doc (every doc, when merging), one line each. This list must not lose anything.
2. **Check each against the code**, and a claim with only, every, never or instead against the path that makes the quantifier true. Never drop a claim silently: a what you can't confirm in a few greps stays out and your report lists it as unverified; a contradicted claim becomes the corrected fact or a ROADMAP row. A why stays unless the code contradicts it. A narrowed quantifier ("every host" becomes "docs and sheets") says what the excluded path does now, or gets a ROADMAP row. A listed limitation gets a ROADMAP row or a stated reason it is accepted. A wrong doc is worse than a short one.
3. **Write the model in your own words** first; if you can't say it plainly, read more code. The TLDR and introduction come from it, not from the claim list.
4. **Write the TLDR and introduction**, then a section per claim that needs one, merging claims that share a reason. A sentence the introduction takes from a section is cut there.
5. **Home every claim** per the table. A reason survives even when its what goes: grep the code for each dropped why (the reason, not the symbol) and, if absent, add a one-line comment in the same commit. Your report to the caller, not only the commit message, lists each dropped why with its home (`file:line`, doc § or test name), and cites the doc § for every sentence the commit message says the doc now contains.
6. **Run the checklist.**

Editing one section follows the same steps; the TLDR and introduction change only when one of their claims does. A doc receiving moved material runs the whole checklist. A renamed heading breaks its anchor and prose citations: grep `docs/`, `AGENTS.md` and `.claude/` for `NAME.md#old-anchor`, and `apps/ packages/ docker/ scripts/` for `NAME.md § Old heading`, skipping `.claude/worktrees/` and `docs/superpowers/`, and fix every hit. After rewording a claim, grep `docs/ROADMAP*.md` for prose quoting the old one.

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

The greps flag candidates: read every hit ("later ones" or `will-change` is fine, "will be added later" is not).

```bash
# every #anchor resolves: prints each link whose heading is gone (bash, since zsh rejects the patterns)
bash <<'EOF'
grep -oE '\]\(([A-Za-z0-9_./-]*\.md)?#[^)]+\)' AGENTS.md .claude/skills/*/SKILL.md $(find docs -name '*.md' -not -path 'docs/superpowers/*') | while IFS= read -r hit; do
  src=${hit%%:*}; link=${hit#*](}; link=${link%)}; doc=${link%%#*}; target=$src; [ -n "$doc" ] && target=$(dirname "$src")/$doc
  grep -E '^#{1,6} ' "$target" | sed -E 's/^#+ //' | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9 _-]//g; s/ /-/g' | grep -qxF -- "${link#*#}" || echo "$src -> $link"
done
EOF
```

- Read only the title, TLDR and introduction as a newcomer: is the concept clear, is any term used before its clause? Every claim there has a section or is fully said there, and an opening that counts its claims ("four things") is recounted after every edit.
- Sections never talk about the doc ("here", "above", "below", "see this doc"); they link to another doc or to a section by heading, and only the introduction says what the sections cover. A rewrite owns the whole file, so every hit is fixed.
- Present tense, short simple English. No slop em-dashes (a dramatic pause, stacked asides, a dash doing a colon's or full stop's job), no "Note that", "robust", "seamlessly", no hard wraps or line numbers.
- Every named path exists and both link checks print nothing. A symbol named with a path is grepped in that file; one without has its definition in exactly one file of a repo grep, or gets its path.
- A new doc gets its line in the `docs/README.md` index and its row in `docs/ARCHITECTURE.md`.

## Common mistakes

Opening with the first surprise instead of the model (a surprise lands only once the reader knows normal). Compressing a catalogue instead of cutting it: six files in six clauses is still a file tour. Compressing a gotcha until it no longer says what breaks. Keeping inherited claims unchecked: an inherited only or every is the likeliest to be wrong. Bold lead-ins on every bullet: bold one key rule per section at most.
