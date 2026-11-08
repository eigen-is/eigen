# Eigen Support Writing Style Guide

> **TLDR:** House rules for the help-center articles in `apps/index/src/data/support/`: voice, structure, frontmatter, en-US, no em-dashes. Read this before writing or reviewing any support article.

The one source of truth for **how** Eigen Support articles are written, so the whole help center reads as if one calm, friendly person wrote it.

**Before writing any article, read, in order:**
1. This guide.
2. [README.md](README.md), the index of the docs, and [ARCHITECTURE.md](ARCHITECTURE.md), to find the code while you verify features.
3. The three **golden exemplars**, and match them:
   - `apps/index/src/data/support/drive/get-started.md` (an **overview**).
   - `apps/index/src/data/support/drive/share-a-file.md` (a short **how-to**).
   - `apps/index/src/data/support/connect/mount-drive-on-your-computer.md` (a longer, more technical **how-to**).

---

## 1. The golden rule: correct, or cut it

- **Verify every claim against the real product.** Read the route, component or hook that implements the feature, and click through it in the running app where you can. If you cannot confirm a feature exists and works as you describe it, **delete the sentence.** No guessing, softening or "probably".
- **Incomplete is fine. Incorrect is not.** Three true things beat a long article with one wrong step: a wrong article makes people distrust all of them.
- **If a whole article can't be verified, don't publish it.** Flag it for review and move on.

## 2. Write for the user, not the engineer

The reader is a normal Eigen user who can use a computer but knows no jargon. The Self-hosting section is the one exception: its reader is the operator who runs the server, who knows Docker, containers, file paths and commands.

- **Describe what the user sees and does**, never how it's built.
- **Banned vocabulary** (implementation words that never appear in a user article): `Yjs`, `ACL`, `ApiError`, `Eden`, `Elysia`, `SQLite`, `WebSocket`, `SSE`, `Drizzle`, `Home`, `container`, `data.db`. WebDAV, IMAP and CalDAV **are** allowed, since users configure them in other apps. So is "mount", the Admin interface's word for a storage location, so an admin article names the control; in an app article, say "drive".
- Research the code for the **facts**, then write them in **plain language**.

## 3. Voice

Like the writing on [reindernijhoff.net](https://reindernijhoff.net): **warm, plain, concrete and honest**, explaining *why*, not just *what*, with no marketing gloss. Where the blog is first person, telling a story, help articles are **second person, present tense and imperative** ("Click **Save**."), because the reader is trying to get something done.

- **Second person, present tense, active voice.** "Drive keeps a copy", not "a copy is kept".
- **Short sentences, one idea each, paragraphs of two to four sentences.**
- **Plain words**: "use", "turn off", "open", not "utilize", "disable", "navigate to".
- **A little warmth, no chattiness.** A friendly aside is welcome; jokes, emoji and exclamation marks are not.
- **Explain the why in one line when it helps**: "App passwords keep working when two-factor is on, and you can revoke one without changing your main password."
- **Lead with the reader's goal.** No "Welcome to…" preamble: the first sentence says what they'll achieve.

### Banned filler words

Cut on sight: **simply, just, easily, quickly, of course, obviously, seamless, powerful, robust, leverage, utilize**.

### Avoid the em dash

No em dashes (—): they are a tell of machine-written text, and a sentence that reaches for one is doing too much. Rewrite, in roughly this order:

- **Split it into two sentences**, usually the best fix: "Deleted files aren't gone right away. They go to the Trash."
- **A comma** for a short aside or a joined clause.
- **A colon** to introduce a list or an explanation, including after a bold lead-in label.
- **Brackets** for a true aside you could lift out of the sentence.

Hyphens in compound words ("two-factor", "read-only") are fine.

### Do / don't

| Don't | Do |
|---|---|
| "Simply navigate to the Integrations page and you can easily generate a powerful app password." | "Open the **Integrations** page and click **Generate**." |
| "The file's ACL is updated when you share it." | "The people you add can open the file straight away." |
| "Users are able to restore deleted items." | "You can restore anything you've deleted." |
| "This will allow you to seamlessly mount your drive — files sync automatically." | "Your drive appears in Finder like a normal folder." |

## 4. Structure: one article, one job (Diátaxis)

Every article is exactly **one** [Diátaxis](https://diataxis.fr) type, matching its frontmatter `type`. Split a step-by-step how-to from a long conceptual explanation.

| `type` | Job | Shape |
|---|---|---|
| `overview` | Orient a newcomer to an app or area | What it's for, the few main things you can do, links to the key how-tos. **Not** an exhaustive step list. Used for every "Get started with …". |
| `how-to` | Get one task done | A short intro, then **numbered steps** from the entry point to the finished state. One task per article. |
| `troubleshooting` | Fix a specific problem | **Bold the symptom**, then give the cause and the fix. Group several symptoms in one article only if they share a theme. |
| `faq` | Answer common short questions | Each question as an H2, with a tight answer below. |
| `reference` | Look something up | Tables and lists. Terse, complete, scannable. |

**Article shape (all types):**

- The page renders the frontmatter `title` as the H1. **Don't repeat it as a `#` heading** in the body.
- Open with one or two sentences that state what the reader will achieve or learn.
- Use `##` and `###` headings only (the on-this-page menu is built from `h2`/`h3`), in **sentence case** ("Connect on macOS", not "Connect On macOS").
- The on-this-page menu appears once an article has **two or more headings**, counting both `##` and `###`.

## 5. Formatting conventions

- **UI labels in bold, copied exactly**, character for character, as verified in the code: buttons, menu items, fields and options, such as **New**, **Share**, **Editor**, **Save**, **Move to trash**. Menu paths use an arrow: **Go → Connect to Server**.
- **Numbered lists** for steps in order, **bullet lists** where order doesn't matter.
- **`code` font** for what the user types and literal values: URLs, file names, addresses, settings keys. A fenced block for anything multi-line and for commands.
- **Links use descriptive text**, never "click here". In-product pages link by their real route, for example `[Integrations](/space/services)`. Cross-link related articles with `related` in frontmatter ([§ 7](#7-frontmatter)).
- **A callout** for an important note, tip or warning, at most one or two per article. Blank lines inside the `<div>` let Markdown render the paragraph:

  ```html
  <div class="eigen-callout">

  An **Unrestricted** link still requires the other person to sign in to Eigen. It isn't open to the public web.

  </div>
  ```
- **Screenshots**, when they help, in a media grid of one to three columns. Put the image files in `apps/index/public/data/support/media/<section>/<slug>/`; each `src` is their served path under `/data/support/media/…`:

  ```html
  <media-grid columns="2">
    <media src="/data/support/media/drive/share-a-file/share-dialog.webp" type="image" caption="The Share dialog" />
    <media src="/data/support/media/drive/share-a-file/general-access.webp" type="image" caption="General access" />
  </media-grid>
  ```

## 6. Mechanics

- **American English** (en-US): "color", "organize", "center", "canceled". Proper nouns, protocol names, HTTP reason phrases and third-party quotes stay verbatim (`401 Unauthorized`, WebDAV, Google Workspace).
- **Three exceptions to en-US**: dates in prose are day-month-year ("5 January 2026", never "January 5, 2026") while the frontmatter `updated` stays `YYYY-MM-DD`, units are metric, and currency is the euro.
- **Product names are capitalized**: Eigen and the apps (Drive, Mail, Docs, Sheets, Slides, Calendar, Contacts, Chat, Stickies, Space). Generic nouns stay lowercase ("your files", "a folder", "the document").
- Call the product **Eigen** and the apps by name ("in Drive", "open Mail"). "Your Eigen Drive" is fine occasionally; usually just "Drive".
- **Oxford comma.** Spell out one to nine in prose; digits for 10 and up, and always for UI values and sizes.

## 7. Frontmatter

Every article starts with this block, validated at build time, so an invalid one fails the build:

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
updated: 2026-08-04                     # today's date, YYYY-MM-DD. Never copy this literally.
---
```

- **`description`**: one plain sentence, the article's subtitle in lists and its search and meta description, saying what the article gives the reader.
- **`crossSections`** lists an article in more places without changing its URL:
  - Each app's **"Get started"** sets `crossSections: [getting-started]`.
  - Each **external-client setup** guide lives under `connect` and is cross-listed into its app (`[mail]`, `[calendar]`, `[drive]`).
- **`related`**: leave it off to auto-match by shared tags within the section, or set explicit slugs.
- **`draft`**: `draft: true` keeps an article out of the build; omitted, it publishes.
- **File name = permanent slug**: the URL is `/support/<section>/<slug>`. Never rename a published file: it breaks deep links.

## 8. Self-check before you hand the article back

Run through this for every article; it mirrors sections 1 to 7:

- [ ] **Every claim** is verified against real code or the running app; anything unverifiable was cut.
- [ ] The article does **one job**, matching its `type`.
- [ ] Second person, present tense, short sentences, active voice.
- [ ] **No banned implementation words** and no banned filler words.
- [ ] **No em dashes (—)**: sentences are split or re-punctuated with commas, colons or brackets.
- [ ] UI labels are **bold and exact**.
- [ ] The intro states the goal in one or two sentences, with no "Welcome to…".
- [ ] Links are descriptive, and in-product routes are correct.
- [ ] American English, product names capitalized, dates in prose day-month-year.
- [ ] Frontmatter is complete and valid (`type` in the enum, `updated` as `YYYY-MM-DD`).
- [ ] It reads like the three exemplars.

If anything is unchecked, fix it or cut it. When in doubt, leave it out.
