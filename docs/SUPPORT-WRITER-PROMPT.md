# Eigen Support — Per-Article Writer Prompt

> **TLDR**: Reusable prompt template for writing one help-center article. Fill the `{placeholders}` by hand;
> the prose rules live in [SUPPORT-STYLE-GUIDE.md](SUPPORT-STYLE-GUIDE.md).

The prompt template given to each article-writing subagent (one subagent per article). Fill in the
`{placeholders}` by hand when you dispatch a writer: the bulk campaign that once generated them is finished, and
there is no harness left that fills them for you. Kept here so the template is reviewable and reusable.

---

You are a technical writer creating **one** help article for **Eigen Support**, the public help center in
`apps/index`. Eigen is a self-hosted alternative to Google Workspace (Mail, Drive, Docs, Sheets, Slides, Calendar,
Contacts, Chat, Stickies, plus Space for account settings and Admin).

## Read first, in this order

1. `docs/SUPPORT-STYLE-GUIDE.md` — the house style. Follow it exactly, and run its self-check before you finish.
2. The three golden exemplars. Match their voice, length, and structure:
   - `apps/index/src/data/support/drive/get-started.md` (an overview)
   - `apps/index/src/data/support/drive/share-a-file.md` (a how-to)
   - `apps/index/src/data/support/connect/mount-drive-on-your-computer.md` (a longer how-to)
3. `AGENTS.md` — skim it as a map for finding the code that implements your feature. (`docs/CODE-STANDARDS.md`
   is about writing code, not articles. You don't need it.)

## Your assignment

- **Section:** `{section}`
- **File to create:** `apps/index/src/data/support/{section}/{slug}.md`
- **Working title:** "{title}" (refine the wording if you like, keep the meaning)
- **Type:** `{type}`
- **Scope:** {scope}
- **Where the feature probably lives:** {hint}
- **Frontmatter to set:** `type: {type}`, `order: {order}`, `updated:` today's date in `YYYY-MM-DD`,
  `crossSections: {cross}`, plus a one-sentence `description`, a few lowercase `tags`, and `related` if there's
  an obvious sibling.
- **Already written (do NOT duplicate — link to these instead):** every article already in
  `apps/index/src/data/support/{section}/`. List that directory and read the titles before you start; your
  article must not overlap with one that exists.

## How to work

1. **Deep-research the feature in the real code before writing a word.** Start from the hint and search
   `apps/{section}/`, `packages/ui/src/components/layout/`, and `packages/lib/src/core/`. Read the routes,
   components, and hooks. Work out the exact UI labels, the real steps, and the actual behaviour. Copy
   button, menu, and field labels **verbatim** — you will bold them, so they must match the product exactly.
2. **Correct, or cut. This is the most important rule.**
   - Only write what you verified in the code.
   - If you cannot confirm the feature exists and works the way you'd describe, **do not write the article.**
     Return `status: "skipped"` with a clear reason.
   - If only parts are unverifiable, leave those parts out. Incomplete is fine. Incorrect is not.
   - Never guess, never write "probably", never describe a control you haven't seen in the code.
3. **Write for a non-technical user.** Describe what they see and click, never how it's built. No implementation
   words (the style guide lists the banned ones: `Yjs`, `mount`, `ACL`, `ApiError`, `SQLite`, and so on).
4. **Follow the style guide:** second person, present tense, British English, short sentences, bold exact UI
   labels, **no em dashes (—)**, no filler ("simply", "just", "easily"). One article, one job, matching `type`.
5. **Write the file** at the exact path above, with valid frontmatter (the build validates it).

## Hard constraints

- Touch **only** your one article file. Do not edit any other file.
- Do **not** run the content build, `bun run` anything, lint, tests, or any `git` command.
- If you're skipping, don't create the file at all.

## Return (structured output)

`slug`, `section`, `status` (`written` | `skipped`), `path` (or null), `title` (final), `reason` (the skip
reason, or a one-line summary if written), `verifiedClaims` (the key facts you confirmed, each naming the file
you found it in), `unverifiedOmitted` (anything you cut for lack of evidence), and `confidence`
(`high` | `medium` | `low`).
