---
name: domain-doc
description: Use when writing, rewriting, extending, shortening or reviewing a domain doc under `docs/` (MAIL.md, CANVAS.md, ACL.md, COLLAB.md and their siblings), including the docs update that closes a feature, adding a gotcha or design decision to a doc, shrinking a doc that grew too long, or a claim-by-claim docs review. Not for drafts under `docs/superpowers/`, and not for help-center articles under `apps/index/src/data/support/`, which have the support-article skill.
---

# Domain doc

A domain doc tells a developer how one part of Eigen works now and why it is built that way. They read it before they touch the code. The code answers "what does this function do". The doc answers what the code can't: the design decisions, the invariants, and the gotchas that already bit someone.

Read the two exemplars before you write: `docs/COLLAB.md` (1,500 words) and `docs/ACL.md` (1,900 words). Don't copy ACL.md's em-dashes: they predate the rule. What to avoid is MAIL.md (8,500) and CANVAS.md (9,900) before their rewrite: `git show 0cd4d14ab^:docs/MAIL.md` and `git show c4eda8702^:docs/CANVAS.md`.

Not domain docs, so not held to this budget: the backlogs (`ROADMAP*.md`, `SHEETS-TODO.md`), the generated `SHARED-PRIMITIVES.md`, the standards and guides (`CODE-STANDARDS.md`, `CODE-EXAMPLES.md`, `REVIEW-STANDARD.md`, `SUPPORT-STYLE-GUIDE.md`, `CONTRIBUTING.md`) and the operator guide `SELF-HOSTING.md`. The voice rules still apply to them.

## The shape

```markdown
# Name

> **TLDR:** What it is, where it lives (one or two directories), and the two to four things that are not obvious from the code.

## A heading that states a fact

What, then why, then where. One idea per section.

## See also
```

- The TLDR stands alone. A reader who stops there knows what the domain is, where its code lives and what will surprise them. It is not a table of contents.
- Headings state facts: "A document lingers after the last unsubscribe", not "Lifecycle".
- Every section carries a why. A section with no reason in it is a catalogue. Cut it or point at the directory.
- Tables hold parallel facts (values and their effect, a crash point and its repair). Bullets for short lists. Prose for reasons. A code block only for a type or route shape that is the contract, ten lines at most.
- Name a symbol when the reader will grep for it. Otherwise use plain words. Point at a directory, not at every file in it.
- A term the code doesn't use is defined in the sentence that introduces it, or replaced.

## The budget

Measured on the exemplars. Words, not lines: a paragraph is one line.

| Unit | Budget | Exemplars | MAIL and CANVAS before rewrite |
|---|---|---|---|
| Whole doc | aim for 1,500 to 3,000, longer when the domain needs it | 1,496 and 1,857 | 8,533 and 9,916 |
| TLDR | 100 words max | 68 and 108 | |
| Section, any heading level | 300 words max | 272 and 306 | 1,375 and 2,692 |
| Paragraph | 150 words max | 139 and 187 | 411 and 2,680 |
| Sentence | aim under 20 words, split anything over 35 | average 18 (ACL) | average 32 and 36 |

**One topic, one doc. Never split a doc** or move a topic into a new file to meet the budget: every extra doc is one more place to look and one more to keep in sync. Shrink by cutting narration, catalogues and file tours. A long doc that says only what the code can't is fine. A doc past 3,000 words, or a section or paragraph within 5% of its cap, gets a line in the report on what was cut and why the rest stays.

## What goes where

| Detail | Belongs in |
|---|---|
| A design decision and its reason, an invariant, a cross-domain seam, a gotcha | The doc |
| Props, columns, routes, config keys, every constant's value, file-by-file tours | Nowhere. Point at the directory or the file that defines them |
| Function-by-function narration | Nowhere. The code says it |
| An edge case | The test that pins it. The doc names the test file if the case matters |
| A reason that only matters at one line of code | One terse comment there, if a maintainer could not derive it |
| History: "used to", "previously", "no longer", dates, incidents | Nowhere. Git keeps it |
| A measurement | The doc, once, when a decision rests on it ("a 48 MB snapshot is 1 MB at zstd" is why the codec exists). Otherwise nowhere |
| Open work and known bugs | `docs/ROADMAP.md` |
| What a user sees and clicks | The help center, via the support-article skill |
| Another domain's mechanics | That domain's doc, linked |

## Shrinking an overgrown doc

1. **List the claims first.** Walk the old doc and write down every design decision, invariant and gotcha, one line each. This list is what you must not lose.
2. **Check each claim against the code.** Find the line that makes it true. A claim with only, every, never or instead is checked against the code path that makes the quantifier true, not just the happy path. A claim you can't confirm in a few greps stays out, or goes in your report as unverified. A wrong doc is worse than a short one.
3. **Write the TLDR**, then one section per claim that needs one. Merge claims that share a reason.
4. **Give every claim a home** from the table above, and verify the home of every reason. A reason survives even when its "what" goes. For every why you drop from the doc, grep the code for the reason (not the symbol). If it is absent, add a one-line comment in the same commit. The report lists each dropped why with its home as `file:line`, doc §, or test name.
5. **Measure.** Run the checklist.

Editing one section follows the same steps. The section and paragraph budgets apply, and the TLDR changes only when one of its claims does. A doc that receives moved material runs the whole checklist too. Renaming a heading breaks its anchor and its prose citations: grep `docs/`, `AGENTS.md` and `.claude/` for `NAME.md#old-anchor`, and `apps/ packages/ docker/ scripts/` for `NAME.md § Old heading`, skipping `.claude/worktrees/` and `docs/superpowers/`, and fix every hit.

## Checklist before you commit

```bash
f=docs/NAME.md
wc -w < $f                                                                  # aim 1,500 to 3,000
awk '/^#/{if(n)print n; n=0; next}{n+=NF}END{print n}' $f | sort -n | tail -1  # section, 300 max
awk -v RS= '!/^\|/{print NF}' $f | sort -n | tail -1                        # paragraph, 150 max
grep -nE '—|used to|previously|no longer' $f                                # expect nothing
bun scripts/check-docs-links.ts                                             # files exist, not anchors
# every #anchor resolves: prints each link whose heading is gone
grep -oE '\]\(([A-Za-z0-9_./-]*\.md)?#[^)]+\)' AGENTS.md docs/*.md .claude/skills/*/SKILL.md | while IFS= read -r hit; do
  src=${hit%%:*}; link=${hit#*](}; link=${link%)}; doc=${link%%#*}; target=$src; [ -n "$doc" ] && target=$(dirname "$src")/$doc
  grep -E '^#{1,6} ' "$target" | sed -E 's/^#+ //' | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9 _-]//g; s/ /-/g' | grep -qxF -- "${link#*#}" || echo "$src -> $link"
done
```

- The TLDR is under 100 words and makes sense alone.
- Every heading states a fact. Every section has a why.
- Present tense. Short sentences in simple English. No em-dashes, no "Note that", "robust", "seamlessly".
- No hard line breaks inside a paragraph.
- Every path you name exists and both link checks print nothing.
- A new doc gets its line in the AGENTS.md index and its row in `docs/ARCHITECTURE.md`.

## Common mistakes

- Compressing the catalogue instead of cutting it. Six files in six clauses is still a file tour.
- Cutting the why and keeping the what. The what is in the code. The why is not.
- Keeping claims from the old doc unchecked because they were already there. An inherited only or every is the likeliest to be wrong.
- Bold lead-ins on every bullet. Bold one key rule per section at most.
