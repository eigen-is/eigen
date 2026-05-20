# Authoring Help Center Articles

Help center articles live in `apps/index/src/data/support/` and are published at
`/support` when the `index` app is built. This guide explains how to add and edit them.

## Where files go

- One Markdown file per article: `apps/index/src/data/support/<section>/<slug>.md`.
- The **folder** is the section (`drive`, `mail`, `connect`, …). See the section list
  in `apps/index/src/components/support/sections.ts`.
- The **filename** is the article's permanent slug — its URL is
  `/support/<section>/<slug>`. Never rename a published file; it breaks deep links.
- Images go in `apps/index/public/data/support/media/<section>/<slug>/`.

## Frontmatter

Every article starts with a YAML frontmatter block. It is validated at build time —
a missing or malformed field fails the build.

| Field | Required | Notes |
|-------|----------|-------|
| `title` | yes | The H1, page title, and search result title. |
| `description` | yes | One-sentence answer; meta description and search snippet. |
| `type` | yes | `overview`, `how-to`, `troubleshooting`, `faq`, or `reference`. |
| `category` | no | Groups articles in the section sidebar. |
| `tags` | no | Used for the related-articles fallback. |
| `related` | no | Explicit related article paths, e.g. `[drive/stop-sharing]`. |
| `order` | no | Sort weight within the section (default 100). |
| `updated` | no | `YYYY-MM-DD`; shown on the page. |
| `draft` | no | `true` excludes the article from the build. |

Example:

```yaml
---
title: "Share a file or folder in Drive"
description: "Share Drive items with people and teams, and choose their permission level."
type: how-to
category: Sharing
tags: [sharing, permissions]
related: [drive/stop-sharing]
order: 10
updated: 2026-05-20
---
```

## Writing the body

- Use `##` and `###` headings — they build the on-this-page table of contents.
- Keep paragraphs short; turn sequences into numbered lists.
- Related articles are the explicit `related` list, or — if omitted — the
  same-section articles that share the most `tags`.

## Media

Embed images and video with the media-grid syntax:

```html
<media-grid columns="2">
  <media src="/data/support/media/drive/share-a-file/dialog.webp" type="image" caption="The share dialog" />
</media-grid>
```

## Building and previewing

- `cd apps/index && bun run scripts/build-content.ts` regenerates the content.
- `bun run dev` previews the help center at `http://localhost:3000/support`.
- Search requires a production build (`bun run build`); it does not run under `dev`.
