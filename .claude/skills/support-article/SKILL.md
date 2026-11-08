---
name: support-article
description: Use when writing, correcting or reviewing an Eigen help-center article under `apps/index/src/data/support/`, and whenever a change alters something a user sees, because the articles describing it are now wrong. That includes a renamed button, menu item or field, a changed menu path, an added, removed or reordered step, a new or changed limit or default, a new setting, or a list an article presents as complete. Also use when a capability ships that no article covers yet, or when an article is reported as inaccurate.
---

# Support article

The help center in `apps/index/src/data/support/` is user-facing and nothing type-checks it. A wrong article is worse than a missing one, since it makes people distrust all of them, so every claim is verified against the code and anything unverifiable is cut.

Prose rules, article types, formatting and frontmatter live in `docs/SUPPORT-STYLE-GUIDE.md`: read it before you write, never from memory, and run its self-check before you hand anything back. Pipeline and content model: `docs/HELP-CENTER.md`.

## Which job is this

| Situation | Do |
|---|---|
| A change altered a label, menu path, step, limit, or a list an article calls complete | **Correct** the affected articles, in the same cycle as the change |
| A new capability belongs to a topic an article already owns | Add **a line or a short section** to that article |
| A new capability is a job of its own | Write **one new article** |
| The feature can't be confirmed in the code | Write **nothing**, and say why |

Corrections are minimal, never a rewrite. Bump `updated:` (today, `YYYY-MM-DD`) only on files you actually changed.

## Read first, in this order

1. `docs/SUPPORT-STYLE-GUIDE.md`: the house style, including the self-check.
2. The three golden exemplars, whose voice, length and structure you match:
   - `apps/index/src/data/support/drive/get-started.md` (an overview).
   - `apps/index/src/data/support/drive/share-a-file.md` (a short how-to).
   - `apps/index/src/data/support/connect/mount-drive-on-your-computer.md` (a longer how-to).
3. `docs/README.md` and `docs/ARCHITECTURE.md`, to find the code that implements the feature. Not `docs/CODE-STANDARDS.md`, which is about code.

## Procedure

1. **Find the articles the change touches.** Grep `apps/index/src/data/support/` for the old label, the feature name and its synonyms, and read the section directory the topic belongs to. A change usually lands in more than one article: the app's `get-started.md` overview, the how-to, and sometimes a `faq` or `connect` guide.
2. **Verify against the real code, before writing a word.** Read the routes, components and hooks that implement it (`apps/<app>/src/`, `packages/ui/src/components/`, `packages/lib/src/core/`; for the Self-hosting section the `eigen` launcher, `apps/api/src/cli/` and `docker/`), and click it through in the running app where you can, for the exact labels, the real steps and the actual behavior. Copy button, menu and field labels **verbatim**, character for character, since they get bolded: **Move to trash** is not "Move to Trash".
3. **Correct, or cut.** Write only what you verified; incomplete is fine, incorrect is not. Never guess, never write "probably", never describe a control you haven't seen in the code. If a whole article can't be verified, don't write it, and report why.
4. **Write it for its reader**, in the style guide's voice and shape: for a user, what they see and click, never how it's built (the style guide bans implementation vocabulary); for the Self-hosting section, the operator who runs the server. A new file is `apps/index/src/data/support/<section>/<slug>.md`, its filename the permanent slug, its frontmatter validated at build time. List the section directory first, so it doesn't overlap an existing article; link to that sibling instead.
5. **Self-check** with the style guide's checklist. For a new article or a frontmatter change, validate the content build: `cd apps/index && bun scripts/build-content.ts`.

Touch only the article files, plus any screenshots they reference where the style guide puts them. Never rename a published file: the slug is its URL.

## Dispatching a writer subagent

One subagent per article, briefed with this skill, the section, the working title, the Diátaxis `type`, the scope and a hint at where the feature lives. Require it back as `status` (`written` | `skipped`), `path`, final `title`, `verifiedClaims` (each naming the file the fact came from), `unverifiedOmitted`, and a `confidence`. A writer that reports no verified claims wrote fiction: read the article before you keep it.
