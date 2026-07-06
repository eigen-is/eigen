# Help Center

> **TLDR**: A public help center at `/support`, built into the existing `apps/index` app
> beside `/blog` — no new app. Articles are authored in Markdown with typed, validated
> frontmatter and converted to **fully-rendered static HTML at build time**: real content in
> the HTML before any JS runs, so the pages are genuine SEO and marketing surfaces. One
> shared content pipeline serves `/support` and `/blog`, and **the blog migrates onto it** —
> finally giving blog posts crawlable bodies. A browse-by-app landing page leads into per-app
> sections and article pages that **reuse the apps' own `ColumnLayout` / `Column` /
> `Breadcrumb`**, so the inner experience is identical to Drive. Search is client-side via
> **Pagefind** (zero infrastructure). The whole feature is **build-time and static — no
> backend code at all**. A "Help" item in the avatar menu and a `getHelpUrl()` deep-link
> helper wire the product to it.

## Problem statement

Eigen has no help or support content. A new user has nowhere to learn how Mail, Drive, Docs,
or any other app works; there is no public, discoverable documentation; and from inside an
app there is no path to an explanation of what is on screen.

It is also a missed marketing channel. Eigen's only public surfaces today are the landing
page and a two-post blog. Every "how to do X in Eigen" article is a search-engine entry
point — public help doubles as SEO. And the blog itself has effectively **zero body-level
SEO**: it renders Markdown at runtime, so post bodies live in the JS bundle and never reach
the HTML a crawler sees.

The help center solves both: a self-service knowledge base for users, and a growing set of
indexable public pages that market the product.

## Inspirations

| Source | What we take |
|--------|--------------|
| **1Password Support** | Browse-first landing — search bar + category-card grid + a short "popular" list; one icon per card, short action-oriented labels |
| **Stripe Docs** | Craft — a constrained ~70ch reading width, designed states, documentation treated as a product |
| **Linear** | Speed and quiet — instant navigation, minimal chrome, nothing competes with the content |
| **Intercom help centers** | A per-article "last updated" date; collection → article structure |
| **GitHub Docs** | Breadcrumbs, an in-page table of contents, clear product-area segmentation |
| **Astro Starlight / VitePress** | The build-time Markdown→HTML pattern, frontmatter conventions, a build-time static search index |

Deliberately avoided:

- **A separate docs framework** (Docusaurus, Starlight, VitePress) — replicate their proven
  pattern inside Eigen's existing build instead. One stack, one design language.
- **A separate `/support` app** — `apps/index` is already the public surface and already has
  a Markdown build pipeline. A new app means a new port, a new deploy target, and a
  duplicated pipeline.
- **Deep nesting** — two levels only (section → article). Deep hierarchies are the single
  most-cited help-center frustration.
- **Runtime Markdown rendering** (the blog's current approach) — bodies must be in the HTML
  for SEO and for Pagefind, which indexes built HTML.
- **Hosted search** (Algolia DocSearch) — Pagefind is zero-infra and self-hosted, matching
  Eigen's ethos.
- **AI "ask a question" search, ticketing, live chat, article comments** — out of scope.

## Goals

1. **Public, discoverable help** — every Eigen app has help content, readable without an account.
2. **Markdown authoring** — a `.md` file with typed frontmatter is the entire authoring workflow.
3. **Real static HTML at build time** — content is in the HTML before JS runs; genuine SEO/marketing surfaces.
4. **One pipeline for `/support` and `/blog`** — the blog migrates onto it and gains crawlable bodies.
5. **Inner pages identical to the apps** — section and article pages reuse `ColumnLayout` / `Column` / `Breadcrumb`.
6. **Zero-infrastructure search** — Pagefind over the built HTML.
7. **Contextual** — stable slugs and a `getHelpUrl()` helper let any app deep-link into help.

## Non-goals (v1)

- A complete article library for all apps — v1 ships the **system + seed content + an
  authoring guide**; the library is filled in incrementally.
- **An article feedback widget ("was this helpful?")** — deferred. It is the only part of the
  feature that would need a backend; leaving it out keeps v1 **fully static, with no backend
  code**. A future version can add it as a public, rate-limited endpoint mirroring the waitlist.
- In-product help *panels or overlays* — contextual help is a deep link to the help center,
  not an embedded widget.
- Versioned documentation and translations — English-only, single version (project scope).
- Personalised / account-aware help — the help center is fully public and static.
- AI/chat support, ticketing, live chat, article comments.
- A full contextual-link rollout across every app — v1 establishes the helper and a few examples.

## Information architecture

The primary axis is the **app** — the way users think ("I have a problem in Mail"). Two
levels, never deeper.

URLs:

```
/support                          Help center landing — search + browse-by-app grid
/support/[section]                Section landing — that section's articles
/support/[section]/[article]      An article
```

Sections — the top-level areas:

| Section | Covers |
|---------|--------|
| `getting-started` | Cross-cutting onboarding — first sign-in, the workspace, an apps overview |
| `mail` `drive` `docs` `sheets` `slides` `calendar` `contacts` `chat` `stickies` | Per-app help — the app-specific help |
| `connect` | Cross-cutting — using Eigen from external apps over open protocols: WebDAV (Drive), IMAP/SMTP (Mail), CalDAV (Calendar) |
| `account` | Cross-cutting — profile, password & 2FA, notifications, appearance |
| `admin` | Organisations & teams, users, storage & quotas, security, server settings |

- The **section is the directory** an article's file lives in; the **slug is the filename**.
  `src/data/support/drive/share-a-file.md` → `/support/drive/share-a-file`. The filename is a
  permanent identifier — renaming it breaks deep links and search ranking, so it is treated
  as fixed.
- An optional `category` field groups articles inside a section's sidebar (Drive → "Sharing",
  "Uploading"). It is a label, not a URL segment — URLs stay two levels deep.
- The **`connect` section** documents Eigen's open-protocol access (mounting Drive over
  WebDAV, using external mail and calendar clients). It is genuine help and also a marketing
  surface — it advertises Eigen's no-lock-in story.

Article types — every article declares one in `type`:

| Type | Purpose | JSON-LD |
|------|---------|---------|
| `overview` | Orient a new user to an app or area | `Article` |
| `how-to` | Accomplish one specific task — numbered steps | `HowTo` |
| `troubleshooting` | Diagnose and fix something going wrong | `Article` |
| `faq` | Short answers to common questions, visible on the page | `FAQPage` |
| `reference` | Explain what options and terms mean | `Article` |

`type` drives a small badge on cards. v1 emits a single `Article` JSON-LD schema for every
article page; the per-type schemas in the table above (`HowTo`, `FAQPage`) are a fast-follow.

## Content model

Markdown files live beside the blog's, under a per-section folder; media matches the blog's
existing `public/` split:

```
apps/index/src/data/support/
  getting-started/
    welcome-to-eigen.md
  drive/
    share-a-file.md
    stop-sharing.md
  connect/
    mount-drive-on-your-computer.md
    use-another-mail-app.md
    use-another-calendar-app.md
apps/index/public/data/support/media/
  drive/share-a-file/permissions.webp
```

Frontmatter — validated against a Zod schema at build time; **a malformed or missing
required field fails the build**:

```yaml
---
title: "Share a file or folder in Drive"          # required
description: "Share Drive items with people and teams, and choose their permission level."
type: how-to                                       # overview | how-to | troubleshooting | faq | reference
category: Sharing                                  # optional — sidebar grouping within the section
tags: [sharing, permissions, links]                # for the related-article fallback + filtering
related: [drive/stop-sharing]                      # optional — explicit related-article paths
order: 20                                          # sort weight within the section/category
updated: 2026-05-12                                # shown on the page, fed to sitemap <lastmod>
draft: false                                       # true = excluded from the production build
---
```

- `title` and `description` are required and do double duty: the `<h1>`, the `<title>`, the
  meta description, the Open Graph / Twitter card, and the search snippet. Write `description`
  as a real one-sentence answer.
- `section` is **not** a field — it is the folder. Nothing derivable is repeated in frontmatter.
- **Related articles**: the explicit `related` list when set; otherwise the articles with the
  most shared `tags` within the same section. Resolved at build time.
- **Media**: the blog's existing `<media-grid>` syntax (parsed by `parse-media-grids.ts`) is
  shared — grids render as static markup with a hydrated lightbox island. Plain `![alt](src)`
  images are also supported and render as standard `<img>`, styled responsively by the
  shared `eigen-prose` stylesheet. `alt` text is required; `loading="lazy"` and explicit
  `width`/`height` are a fast-follow.

## Rendering architecture

One shared content pipeline in `apps/index`, serving two **collections** — `blog` and
`support`:

```
 src/data/{blog,support}/**/*.md  +  public/data/**/media/**
        |
        |  (1) content build  (prebuild)
        |      parse · validate frontmatter (Zod) · render Markdown->HTML (markdown-it)
        |      · extract ##/### headings -> TOC · resolve related articles
        v
 build artifacts (gitignored):  per-collection manifest (metadata only)
                                + one rendered-HTML file per article
        |
        |  (2) vite build          routes consume the manifest + rendered HTML
        v
        |  (3) prerender  (postbuild)
        |      render each route to FULL static HTML (shell + content)
        |      + per-page <title>/description/canonical/OG + JSON-LD + sitemap.xml
        v
 dist/index/**/*.html  --(4) Pagefind-->  static search index
```

- **(1) Content build** renders Markdown to HTML **at build time** with `markdown-it` (simple,
  fast, synchronous — well suited to a build script). It emits, per collection, a small
  **metadata manifest** (every article's frontmatter + TOC + resolved related list — no
  bodies) and **one rendered-HTML file per article**. Both are gitignored build artifacts.
- **(2) Vite build** — the React routes import the manifest **and** the per-article HTML
  **eagerly**. The bodies resolve synchronously, keeping the build-time prerender and the
  client hydration in lockstep (no async loader data to rehydrate). At v1's article count
  the bundle cost is negligible; a lazy glob with loader-data dehydration is a fast-follow
  if the library grows into the hundreds.
- **(3) Prerender** extends today's `post-build.ts`. Instead of only swapping `<title>`/OG
  tags, it renders **each route to full static HTML** — shell and article body — and writes
  it to that route's `index.html`. It also emits `sitemap.xml` and per-page JSON-LD.
- **(4) Pagefind** runs last, indexing the built HTML into a sharded static index.

**Static-first, then hydrated.** The index app moves from `createRoot` (an empty mount) to
`hydrateRoot` (prerendered content). The browser paints the real HTML before any JS; the
client then hydrates it **in place** — it is not overwritten. Content is fully present with
JS disabled, which is what makes these real SEO surfaces. The rule that keeps hydration
clean: the build-time HTML and the first client render must be identical, so article content
stays deterministic (no `Date.now()` or `window`-dependent rendering in content). Interactive
islands — search, the TOC, the media lightbox — render the same initial state on both sides,
then light up on interaction.

**Prerequisite — `useMediaQuery` must be prerender-safe.** Today
`packages/lib/src/core/media/hooks/use-media-query.ts` reads `window.matchMedia()` in a
`useState` initialiser. That throws when there is no `window` (the build) and would cause a
hydration mismatch (the client initialiser would return the real value, differing from the
prerendered default). The fix: rewrite it with **`useSyncExternalStore`** and a
`getServerSnapshot` that returns the desktop default. This is a small, single-hook change:
`useSyncExternalStore` uses the server snapshot during the index app's hydration (no
mismatch) and still reads the real value synchronously on the client-only apps (no
first-render flash, no regression).

## UX

### The help center shell

A lightweight public shell in `apps/index` — the help center's analogue of `AppShell`. It
renders a **public header** (the Eigen logo, "Help Center", a search trigger, and a "Sign
in" / "Open Eigen" link) and the content area. It does **not** include the app topbar — no
avatar, app switcher, or notification bell; the help center is public and unauthenticated.

The shell also **provides `LayoutContext`**. `ColumnLayout` and `Column` read `isMobile`
from it via `useLayout()`; `AppShell` is its usual provider. The help center shell supplies
the same context — `isMobile`/`isTablet` from the (now prerender-safe) media hooks, the rest
as inert defaults — so `ColumnLayout` / `Column` / `Breadcrumb` are **reused unchanged** and
the inner pages are pixel-identical to the apps.

### Landing — `/support`

A marketing-style page: a search hero, a browse-by-app card grid, and a short popular list.
This is the public front door, so it is full-width and centred — not the column layout.

```
+--------------------------------------------------------------------+
|  eigen · Help Center                      [search]      [ Sign in ]|
+--------------------------------------------------------------------+
|                                                                    |
|                      How can we help?                              |
|             +------------------------------------------+           |
|             |  (search)  Search help articles...       |           |
|             +------------------------------------------+           |
|                                                                    |
|   Browse by app                                                    |
|   +----------+  +----------+  +----------+  +----------+            |
|   |   Mail   |  |  Drive   |  |   Docs   |  | Calendar |            |
|   +----------+  +----------+  +----------+  +----------+            |
|   +----------+  +----------+  +----------+  +----------+            |
|   | Contacts |  |   Chat   |  |  Sheets  |  |  Slides  |   ...      |
|   +----------+  +----------+  +----------+  +----------+            |
|                                                                    |
|   Getting started   ·   Connecting external apps   ·   Account     |
|                                                                    |
|   Popular articles                                                 |
|   ->  Getting started with Eigen                                   |
|   ->  Mount your Drive on your computer                             |
|   ->  Share a file or folder in Drive                              |
+--------------------------------------------------------------------+
```

### Section and article pages — `ColumnLayout`

Once browsing, the experience matches the apps exactly. Both page types are built from
`ColumnLayout` + `Column`, each `Column`'s `toolbar` rendered in the standard `h-12`,
`px-4 border-b` bar, with a shadcn `Breadcrumb` (`BreadcrumbPage` = `text-foreground
font-normal`) — the same components Drive uses.

**Section page** — `/support/drive` — a two-column layout: a section nav and the article list
grouped by `category`.

```
+--------------------------------------------------------------------+
|  eigen · Help Center                      [search]      [ Sign in ]|
+---------------+----------------------------------------------------+
| Drive         |  Help Center › Drive                               |   <- h-12 toolbar bar
+---------------+----------------------------------------------------+
| > Drive       |  Sharing                                           |
|   Mail        |   ->  Share a file or folder                       |
|   Docs        |   ->  Stop sharing a file                          |
|   ...         |  Uploading                                         |
|               |   ->  Upload files and folders                     |
+---------------+----------------------------------------------------+
```

**Article page** — `/support/drive/share-a-file` — three columns: section nav, the article,
and an auto-generated "on this page" TOC.

```
+--------------------------------------------------------------------+
|  eigen · Help Center                      [search]      [ Sign in ]|   help center shell header
+---------------+------------------------------------+---------------+
| Drive         |  Help Center › Drive › Sharing     | On this page  |   h-12 toolbar bar
+---------------+------------------------------------+---------------+   (identical to a Drive toolbar)
| SHARING       |                                    | Overview      |
| > Share a file|  Share a file or folder            | Permission l. |
|   Stop sharing|  Updated 12 May 2026 · How-to       | Shared links  |
| UPLOADING     |                                    |               |
|   Upload files|  To share a Drive item, open its   |               |
|   Folders     |  menu and choose Share. ...         |               |
|               |      (~70ch reading column)        |               |
|               |                                    |               |
|               |  ## Permission levels              |               |
|               |  ...                               |               |
|               |  --------------------------------- |               |
|               |  Related                           |               |
|               |  ->  Stop sharing a file           |               |
+---------------+------------------------------------+---------------+
```

The article column is a `Column width="flex"` with the `Breadcrumb` as its `toolbar`; the nav
and TOC columns are `width="260px"`. Every `Column` toolbar lands in the same `h-12` bar, so
the three toolbar bars align across the top exactly as Drive's list and detail toolbars do.
The content is a ~70ch reading column with the build-rendered HTML, the `updated` date and
`type` badge under the title, and related articles at the end. The TOC column is omitted for
articles with fewer than two `##` headings. On mobile, `ColumnLayout`'s `mobileColumn` shows
the article column; the section nav and TOC collapse behind toolbar buttons — the same
secondary-column behaviour the apps use.

### Search — Pagefind

Pagefind indexes the built HTML after the prerender pass and emits a sharded WASM index
served as plain static files — no backend, no API key. The landing search box and a
`Cmd+K`-style dialog query it client-side; only the index shards a query touches are
downloaded, so search stays fast as the library grows to hundreds of articles.

This is deliberately separate from the command palette (`PROPOSAL_COMMAND_PALETTE.md`) —
that is an authenticated, in-app feature searching a user's own data, mounted in the app
topbar. The help center's search is public and serves help articles only; the two share no UI.

## Contextual help

- **Avatar menu** — a "Help" item (icon `LifeBuoy`) is added to `UserDropdown` *and*
  `GuestUserDropdown` in `packages/ui/src/components/layout/app/topbar.tsx`, using a new
  `getSupportUrl()` helper alongside the existing `getSpaceAppUrl()` etc. in
  `packages/lib/src/core/api.ts`. It is an `<a href>` cross-app link, matching how Profile
  and Settings already navigate.
- **Deep-link helper** — `getHelpUrl(section, slug)` in `packages/lib` builds
  `/support/[section]/[slug]`. v1 wires a few example `?` "Learn more" links in high-value
  spots (e.g. the Drive share dialog → `drive/share-a-file`); a full rollout is a fast-follow.
- **Redirect exemption** — `/support/*` must be reachable by signed-in users. The index app
  redirects authenticated users away from its landing page to `/space/`; that redirect must
  be scoped so it does not cover `/support/*` (nor `/blog/*`).

## Blog migration

The blog moves onto the shared pipeline:

- Its posts become a collection (`blog`) processed by the same content build — bodies are
  **rendered to HTML at build time**, so blog posts finally have crawlable content (today
  they do not).
- Runtime `react-markdown` and the eager `import.meta.glob('*.md', { query: '?raw' })` loader
  are removed; the `<media-grid>` component is reused unchanged.
- Blog frontmatter aligns to the shared schema (`summary` → `description`); the post date
  stays derived from the filename prefix (a small per-collection rule in the build).
- `/blog` URLs and routes are unchanged.

## Why this fits Eigen

- **Reuses the public surface** — `apps/index` already serves the root domain and already
  has a Markdown build pipeline; the help center extends it rather than adding an app.
- **Reuses the layout system** — `ColumnLayout` / `Column` / `Breadcrumb` from
  `@workspace/ui` (already a dependency of `apps/index`); inner pages are the apps' real
  components, not lookalikes.
- **No backend at all** — the entire feature is build-time and static; nothing new to
  deploy, operate, or secure on the server.
- **Typed and validated** — frontmatter is a Zod-validated schema; the build fails on bad content.
- **One pipeline, no divergence** — `/support` and `/blog` share one renderer; fixing the
  blog's SEO is a consequence, not extra work.
- **Self-hosted ethos** — Pagefind keeps search zero-infrastructure.

## File structure

```
apps/index/
  scripts/
    build-content.ts          # (1) content build — both collections (replaces generate-blog-meta.ts)
    post-build.ts             # (3) prerender pass — extended: full-HTML render + JSON-LD + sitemap + Pagefind
  src/
    data/support/[section]/*.md          # help articles
    content/                  # shared content loader — manifest + eager per-article HTML
      manifest.ts
    components/support/
      support-shell.tsx       # public shell — header + LayoutContext provider
      support-landing.tsx     # search hero + app grid + popular
      support-section.tsx     # 2-column ColumnLayout
      support-article.tsx     # 3-column ColumnLayout
      support-breadcrumb.tsx  # thin wrapper over the @workspace/ui Breadcrumb
      article-toc.tsx · support-search.tsx
    routes/
      support.index.tsx · support.$section.tsx · support.$section.$article.tsx
  public/data/support/media/**           # article media

packages/lib/src/core/
  media/hooks/use-media-query.ts         # CHANGED — useSyncExternalStore (prerender-safe)
  api.ts                                 # ADD getSupportUrl(), getHelpUrl(section, slug)

packages/ui/src/components/layout/app/
  topbar.tsx                             # CHANGED — "Help" item in both dropdowns

docs/SUPPORT-STYLE-GUIDE.md              # article authoring guide (style, frontmatter, media, build)
```

## Phased implementation

| Phase | Scope | Effort | Depends on |
|-------|-------|--------|------------|
| 1 | **Shared content pipeline** — content build (parse, validate, render, TOC, related, manifest), prerender pass (route → full HTML, `hydrateRoot`), `useMediaQuery` prerender fix, **blog migrated onto it** | M | — |
| 2 | **Help center pages** — public shell, landing, section + article (`ColumnLayout`), `/support` routes + redirect exemption, avatar-menu "Help" link, seed content (getting-started, Drive, Mail, and the `connect` section) | M | 1 |
| 3 | **Search** — Pagefind index step, landing search box + `Cmd+K` dialog | S | 2 |
| 4 | **Contextual help** — `getHelpUrl` helper, example `?` links, authoring guide (`docs/SUPPORT-STYLE-GUIDE.md`) | S | 2 |

Phase 1 is the foundation and the only phase that touches existing non-help code (the blog,
the index app's render entry, the shared `useMediaQuery` hook). The whole feature stays
within `apps/index` plus two small shared-package changes — URL helpers in `packages/lib`
and a "Help" menu item in `packages/ui`; there are **no `apps/api` changes**. Phases 3 and 4
are independent of each other.

## Resolved questions

The design questions raised while drafting this proposal — all now decided.

1. **Prerender mechanism** — a route-by-route `renderToString` with a TanStack Router memory
   history. The extended `post-build.ts` enumerates every route path from the content
   manifests (`/`, `/blog` and each post, `/support`, each section, each article); for each
   it builds the router with a memory history at that path, awaits route loading, renders the
   app with `renderToString`, and writes the HTML into that route's `index.html`. This relies
   only on TanStack Router's existing memory-history support — no adoption of TanStack Start.
2. **Home page prerender** — v1 prerenders the `/blog` and `/support` route trees only; `/`
   stays a client-rendered SPA (`createRoot`). Scoping the prerender this way keeps those
   routes provider-free, so the auth/query provider tree never has to be made SSR-safe.
   Prerendering `/` for landing-page SEO is a fast-follow.
3. **Markdown processor** — `markdown-it`: simple, synchronous, and well suited to a build
   script. Revisit only if a plugin need (e.g. richer admonitions) arises.

## Key decisions

- **In `apps/index`, not a new app** — reuse the public surface and its build pipeline.
- **Build-time rendering, not runtime** — content in the HTML; real SEO; Pagefind works.
- **One pipeline, blog migrated** — no divergence; the blog gains crawlable bodies.
- **Reuse `ColumnLayout` / `Column` / `Breadcrumb`** — inner pages identical to the apps; the
  help center shell provides `LayoutContext` so the components are reused unchanged.
- **`useMediaQuery` made prerender-safe** — a shared `useSyncExternalStore` fix; benefits all apps.
- **Pagefind** — zero-infrastructure client-side search.
- **No backend — the feature is fully static** — there is no `apps/api` code; an article
  feedback widget is deferred specifically to keep v1 build-time-only.
- **Section = directory, slug = filename** — permanent identifiers; no `slug` frontmatter field.
