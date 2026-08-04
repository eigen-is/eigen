# Eigen Support Writing Style Guide

> **TLDR**: House rules for the help-center articles in `apps/index/src/data/support/` — voice, structure,
> frontmatter, en-GB, no em-dashes. Read this before writing or reviewing any support article.

The single source of truth for **how** Eigen Support articles are written. The goal: every article reads as if
one calm, friendly person wrote the whole help center.

**Before writing any article, read, in order:**
1. This guide.
2. [AGENTS.md](../AGENTS.md), for navigating the codebase while you verify features.
3. The three **golden exemplars** (match them; imitation beats instruction):
   - `apps/index/src/data/support/drive/get-started.md` (an **overview**).
   - `apps/index/src/data/support/drive/share-a-file.md` (a short **how-to**).
   - `apps/index/src/data/support/connect/mount-drive-on-your-computer.md` (a longer, more technical **how-to**).

---

## 1. The golden rule: correct, or cut it

Everything else is secondary to this.

- **Verify every claim against the real product.** Read the route, component, or hook that implements the
  feature, and where you can, click through it in the running app. If you cannot confirm a feature exists and
  works the way you're describing, **delete the sentence.** Do not guess, soften, or "probably".
- **Incomplete is fine. Incorrect is not.** A short article covering three things that are true beats a long one
  where one step is wrong. A wrong help article is worse than no article: it makes people distrust all of them.
- **If a whole article can't be verified, don't publish it.** Flag it for review and move on.

## 2. Write for the user, not the engineer

The reader is a normal Eigen user. Assume they can use a computer; do **not** assume they know any jargon.

- **Describe what the user sees and does**, never how it's built. They click buttons and read labels. They don't
  know or care about the implementation.
- **Banned vocabulary** (implementation words that must never appear in a user article): `Yjs`, `mount`,
  `ACL`, `ApiError`, `Eden`, `Elysia`, `SQLite`, `WebSocket`, `SSE`, `Drizzle`, `Home`, `container`, `data.db`.
  WebDAV, IMAP, and CalDAV **are** allowed, because they're real things users configure in other apps.
- You research in the code to get the **facts** right, then write them in **plain language**.

## 3. Voice

Anchored in the writing on [reindernijhoff.net](https://reindernijhoff.net): **warm, plain, concrete, and
honest**. It explains *why*, not just *what*, and never reaches for marketing gloss. We keep that warmth but make
one change for documentation.

The blog is **first person** ("I built…", telling a story). Help articles are **second person, present tense, and
imperative** ("Click **Save**."), because the reader is trying to get something done, not read a story.

Concretely:

- **Second person, present tense, active voice.** "You" is the reader. "Drive keeps a copy", not "a copy is kept".
- **Short sentences. One idea each. Paragraphs of two to four sentences.** Momentum over density.
- **Plain words.** Prefer the common word ("use", "turn off", "open") over the fancy one ("utilise", "disable",
  "navigate to").
- **A little warmth, no chattiness.** A friendly aside is welcome. Jokes, emoji, and exclamation marks are not.
  That's the blog voice, not the docs voice.
- **Explain the why in one line when it helps.** "App passwords keep working when two-factor is on, and you can
  revoke one without changing your main password." One clause of *why* turns a step into understanding.
- **Lead with the reader's goal.** No "Welcome to…" preamble. The first sentence says what they'll achieve.

### Banned filler words

Cut these on sight. They add nothing and quietly overpromise: **simply, just, easily, quickly, of course,
obviously, seamless, powerful, robust, leverage, utilise**.

### Avoid the em dash

Don't use em dashes (—). They're one of the clearest tells of machine-written text, and a sentence that reaches
for one is usually trying to do too much. Rewrite instead, in roughly this order of preference:

- **Split it into two sentences.** Usually the best fix. "Deleted files aren't gone right away. They go to the
  Trash."
- **Use a comma** for a short aside or a joined clause.
- **Use a colon** to introduce a list or an explanation, including after a bold lead-in label.
- **Use brackets** for a true aside you could lift out of the sentence.

Hyphens in compound words ("two-factor", "read-only") are fine. The ban is on the em dash as sentence punctuation.

### Do / don't

| Don't | Do |
|---|---|
| "Simply navigate to the Integrations page and you can easily generate a powerful app password." | "Open the **Integrations** page and click **Generate**." |
| "The file's ACL is updated when you share it." | "The people you add can open the file straight away." |
| "Users are able to restore deleted items." | "You can restore anything you've deleted." |
| "This will allow you to seamlessly mount your drive — files sync automatically." | "Your drive appears in Finder like a normal folder." |

## 4. Structure: one article, one job (Diátaxis)

Every article is exactly **one** [Diátaxis](https://diataxis.fr) type, matching its frontmatter `type`. Don't mix
a step-by-step how-to with a long conceptual explanation. Split them.

| `type` | Job | Shape |
|---|---|---|
| `overview` | Orient a newcomer to an app or area | What it's for, the few main things you can do, links to the key how-tos. **Not** an exhaustive step list. Used for every "Get started with …". |
| `how-to` | Get one task done | A short intro, then **numbered steps** from the entry point to the finished state. One task per article. |
| `troubleshooting` | Fix a specific problem | **Bold the symptom**, then give the cause and the fix. Group several symptoms in one article only if they share a theme. |
| `faq` | Answer common short questions | Each question as an H2, with a tight answer below. |
| `reference` | Look something up | Tables and lists. Terse, complete, scannable. |

**Article shape (all types):**

- The H1 is the frontmatter `title`, and the page renders it for you. **Don't repeat it as a `#` heading** in the
  body.
- Open with a short intro, one or two sentences, that states what the reader will achieve or learn. No
  throat-clearing.
- Use `##` and `###` headings only (the on-this-page menu is built from `h2`/`h3`). Write headings in **sentence
  case** ("Connect on macOS", not "Connect On macOS").
- The on-this-page menu appears once an article has **two or more headings** in total, counting both `##` and
  `###`. Anything longer than a few paragraphs usually gets there on its own.

## 5. Formatting conventions

- **UI labels in bold, copied exactly.** Buttons, menu items, fields, and options as they literally appear:
  **New**, **Share**, **Editor**, **Save**, **Move to trash**. The label must match the product character for
  character, which is why you verify it in the code. Menu paths use an arrow: **Go → Connect to Server**.
- **Numbered lists** for steps that happen in order. **Bullet lists** for sets where order doesn't matter.
- **`code` font** for things the user types or literal values: URLs, file names, addresses, settings keys. Use a
  fenced block for anything multi-line or for commands.
- **Links use descriptive text**, never "click here". Link to in-product pages with their real route, for example
  `[Integrations](/space/services)`. Cross-link related articles with `related` in frontmatter (below).
- **Callout** for an important note, tip, or warning. Use it sparingly, at most one or two per article:

  ```html
  <div class="eigen-callout">

  An **Unrestricted** link still requires the other person to sign in to Eigen. It isn't open to the public web.

  </div>
  ```

  (Blank lines inside the `<div>` let Markdown render the paragraph.)
- **Screenshots**, when they help, via a media grid (one to three columns). Put the image
  files in `apps/index/public/data/support/media/<section>/<slug>/`; each `src` is their
  served path under `/data/support/media/…`:

  ```html
  <media-grid columns="2">
    <media src="/data/support/media/drive/share-a-file/share-dialog.webp" type="image" caption="The Share dialog" />
    <media src="/data/support/media/drive/share-a-file/general-access.webp" type="image" caption="General access" />
  </media-grid>
  ```

## 6. Mechanics

- **British English** (en-GB), matching the product UI ("Organisations", "colour", "organise"). Keep proper nouns
  and protocol or error names as they are (`401 Unauthorized`, `WebClient`).
- **Product names are capitalised**: Eigen, and the apps (Drive, Mail, Docs, Sheets, Slides, Calendar, Contacts,
  Chat, Stickies, Space). Generic nouns stay lowercase ("your files", "a folder", "the document").
- Refer to the product as **Eigen** and the apps by name ("in Drive", "open Mail"). "Your Eigen Drive" is fine
  occasionally; usually just "Drive".
- **Oxford comma.** Numbers one to nine are spelled out in prose; use digits for 10 and up, and always for UI
  values and sizes.
- **Dates** (frontmatter `updated`) are `YYYY-MM-DD`.

## 7. Frontmatter

Every article starts with this block (validated at build time, so an invalid one fails the build):

```yaml
---
title: "Share a file or folder"        # The H1 and browser title. Sentence case.
description: "Give other people access to a file or folder in Drive…"  # One plain sentence. Shown in lists and as the meta description.
type: how-to                            # overview | how-to | troubleshooting | faq | reference
category: Sharing                       # Optional. A short grouping label.
tags: [drive, sharing, permissions]     # Lowercase. Used for related-article matching.
related: [drive/get-started]            # Optional. Explicit related-article slugs (<section>/<file>).
crossSections: [getting-started]        # Optional. Extra sections to also list this article under.
order: 20                               # Lower sorts first within the section. "Get started" is about 10.
updated: 2026-08-04                     # today's date, YYYY-MM-DD — never copy this literally.
---
```

- **`description`** is a single, plain sentence. It's the article's subtitle in lists and its search and meta
  description, so make it say what the article gives the reader.
- **`crossSections`** lists an article in more places without changing its URL. Two standing patterns:
  - Each app's **"Get started"** sets `crossSections: [getting-started]`.
  - Each **external-client setup** guide is authored under `connect` and cross-listed into its app
    (`[mail]`, `[calendar]`, `[drive]`).
- **`related`**: leave it off to auto-match by shared tags within the section, or set explicit slugs to control it.
- **`draft`**: set `draft: true` to keep an article out of the build. Omit it to publish (it defaults to off).
- **File name = permanent slug.** The filename is the article's slug, and its URL is `/support/<section>/<slug>`.
  Never rename a published file: it breaks deep links.

## 8. Self-check before you hand the article back

Run through this for every article. It mirrors the rules above:

- [ ] **Every claim** is verified against real code or the running app. Anything unverifiable was cut.
- [ ] The article does **one job**, matching its `type`.
- [ ] Second person, present tense, short sentences, active voice.
- [ ] **No banned implementation words**, and no banned filler words.
- [ ] **No em dashes (—).** Sentences are split or re-punctuated with commas, colons, or brackets.
- [ ] UI labels are **bold and exact**.
- [ ] The intro states the goal in one or two sentences, with no "Welcome to…".
- [ ] Links are descriptive, and in-product routes are correct.
- [ ] British English, with product names capitalised.
- [ ] Frontmatter is complete and valid (`type` in the enum, `updated` as `YYYY-MM-DD`).
- [ ] It reads like the three exemplars.

If anything is unchecked, fix it or cut it. When in doubt, leave it out.
