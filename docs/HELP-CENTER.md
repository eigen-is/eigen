# Help Center

> **TLDR**: The public help center (`/support`) and the blog (`/blog`) are static pages built by `apps/index`.
> Articles are Markdown with typed frontmatter under `src/data/`, rendered to HTML by a prebuild step and turned
> into real static pages by a postbuild prerender. Search is Pagefind, built in the same postbuild.
> Inside the apps, articles are reachable from the topbar Support link and the command palette `?` scope.

## Where it lives

Everything is in `apps/index` plus two small shared bits. There is no backend: no `apps/api` code, nothing to
deploy or operate beyond the static files.

- `apps/index/src/data/{support,blog}/**` — the content (13 support sections, ~120 articles).
- `apps/index/scripts/` — the build steps, with `scripts/lib/` for frontmatter, markdown and related articles.
- `apps/index/src/components/support/` + `src/routes/support.*` — the pages.
- `packages/lib/src/core/` — `api.ts` (`getSupportUrl`), `search/pagefind.ts`, and the palette's
  `command-palette/providers/help-search.ts`.

## Build pipeline

Three phases wired through the `@apps/index` package scripts:

```
prebuild   bun scripts/build-content.ts      md -> validated meta + rendered HTML
build      vite build                        routes import the manifests
postbuild  bun scripts/prerender.tsx         each route -> full static HTML + sitemap.xml
           bun scripts/build-search-index.ts Pagefind index -> dist/index/pagefind
```

**`build-content.ts`** walks `src/data/{blog,support}`, parses frontmatter with `gray-matter`, validates it
against the Zod schemas in `scripts/lib/content-types.ts` (a bad or missing required field throws and fails the
build), extracts media grids, and renders Markdown with `markdown-it` + `markdown-it-anchor`. Per collection it
writes one `<slug>.json` body file (`{ html, mediaGrids }`) and one `<collection>.manifest.json` holding metadata
only: title, description, type, category, tags, order, `updated`, the h2/h3 TOC and the resolved `related` list.
Output goes to `src/content/.generated/`, which is gitignored — it is a build artifact, never committed.
`typecheck` runs the content build first, because the routes import the generated JSON.

`src/content/manifest.ts` is the read side. Manifests are imported eagerly (they are small); bodies are an
`import.meta.glob` so each article body is its own lazy chunk. `useArticleBody` (in `src/content/`) returns the
page's own body synchronously and lazy-loads any other article the visitor navigates to.

## Prerender

`scripts/prerender.tsx` boots a Vite SSR server so the route tree's Vite-only APIs resolve, then for every route
calls `src/entry-server.tsx`: a TanStack Router built on a **memory history** at that path, `router.load()`,
`serverSsr.dehydrate()`, `renderToString(<RouterServer/>)`. The rendered HTML is spliced into the built shell's
`<div id="app">`, together with the article body as an inline JSON `<script>` and TanStack's dehydration script
(`window.$_TSR`).

On the client, `mountReactApp` picks `hydrateRoot` when the container already has markup, and `main.tsx` renders
`RouterClient` when `$_TSR` is present (the dev server has no bootstrap, so it falls back to a plain
`RouterProvider`). Hydration is in place, so the prerendered DOM survives.

Per page the prerender also writes the `<title>`, description, OG tags, a `<link rel="canonical">`, and — for
article pages — a minimal `Article` JSON-LD block. It finishes by writing `dist/index/sitemap.xml`, with
`<lastmod>` from `updated`/`date`.

Hydration is the constraint that shapes the code: the first client render must match the server render exactly.
`useMediaQuery` is `useSyncExternalStore` with a desktop `getServerSnapshot`, the `Toaster` mounts only after
hydration, React's auto-emitted `<link rel="preload">` tags are hoisted into `<head>`, and the landing page's
first render is deliberately deterministic. The comments in `prerender.tsx`, `entry-server.tsx` and `main.tsx`
explain each one — read them before changing the render path.

## Content model

- **A section is a directory** under `src/data/support/`; the **slug is the filename**.
  `drive/share-a-file.md` → `/support/drive/share-a-file`. Both are permanent identifiers — renaming breaks deep
  links and search ranking. `section` is never a frontmatter field.
- `src/components/support/sections.ts` is the display registry: id (must match the folder), title, description,
  icon and colour. App-backed sections pull their icon and brand colour from the shared `apps` registry, so an
  unknown app name throws at build.
- `crossSections: [other-section]` lists an article on a second section page without changing its canonical URL.
- `related` is explicit when set, otherwise resolved at build time from shared `tags` within the same section
  (`scripts/lib/related.ts`, max 4).
- `draft: true` drops the article from the build entirely.
- The blog rides the same pipeline with a smaller schema (`id`, `title`, `description`); its date comes from the
  filename prefix.

For prose rules, article types and frontmatter conventions see [SUPPORT-STYLE-GUIDE.md](SUPPORT-STYLE-GUIDE.md);
for the per-article writer template see [SUPPORT-WRITER-PROMPT.md](SUPPORT-WRITER-PROMPT.md).

## Search

`build-search-index.ts` feeds Pagefind one `addCustomRecord` per support article, built from the generated
content JSON (title + description + tag-stripped body, with `section` as a filter). The bundle is written to
`dist/index/pagefind/` and served as plain static files. No infrastructure, no API key.

Two consumers share one loader (`packages/lib/src/core/search/pagefind.ts`, a lazy `@vite-ignore` import that
degrades to no results when the bundle is absent): the search box on the `/support` landing
(`components/support/support-search.tsx`), and the command palette's Help group
(`command-palette/providers/help-search.ts`). The palette source only fires under the `?` scope or no scope, so
the WASM index is never loaded while the user is narrowed to mail or files. In production every app is
same-origin behind Caddy, so `/pagefind` is reachable from any app.

## In-app entry

`getSupportUrl()` in `packages/lib/src/core/api.ts` resolves the index app's `/support`. It is wired into both
topbar dropdowns (signed-in and guest) as a "Support" item with a `LifeBuoy` icon, as a plain `<a href>` cross-app
link. The index app's signed-in redirect to `/space/` lives in a `useEffect` inside `routes/index.tsx`, so it is
route-scoped and `/support/*` and `/blog/*` are reachable while signed in without any exemption logic.

## Known drifts and open items

- **No bespoke help-center shell.** `routes/support.tsx` wraps the whole tree in the shared `AppShell`
  (`appName="support"`), which already provides `LayoutContext`. The proposal's separate public shell and the
  section-nav sidebar were dropped; landing, section and article pages are each a single flex `Column`, with the
  article page keeping the TOC in a sticky gutter at `xl` and up. Deliberate.
- **Pagefind indexes the generated JSON, not the built HTML.** Custom records give exact control over what is
  indexed and what the excerpt shows, and remove the dependency on the prerender's markup.
- **`/` is prerendered too.** The proposal scoped the prerender to `/blog` and `/support`; as built it covers the
  landing page, `/licenses` and `/changelog` as well.
- **`getHelpUrl(section, slug)` was never built.** There is no contextual deep-link helper and no `?` "Learn
  more" links in the apps — only the section-less `getSupportUrl()`. Still open.
- The `category` frontmatter field is parsed and carried in the manifest but nothing groups by it yet; section
  pages sort on `order` alone.
