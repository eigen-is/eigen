# Help Center

> **TLDR:** The public help center (`/support`) and the blog (`/blog`) are static pages built by `apps/index`, with no backend. Articles are Markdown with Zod-validated frontmatter under `apps/index/src/data/`. A prebuild renders them to JSON, and a postbuild prerenders every route to real HTML that hydrates in place, so the first client render must match the server's. Search is a Pagefind index built from the same JSON. A section is a folder and an article's URL is its file path, so renaming either breaks links.

## The help center is static files

Everything lives in `apps/index` plus three shared pieces in `packages/lib/src/core/`: `getSupportUrl` in `api.ts`, the Pagefind loader in `search/pagefind.ts`, and the palette's `command-palette/providers/help-search.ts`. No `apps/api` code serves it, so there is nothing to deploy or operate beyond the files in `dist/index`.

- `apps/index/src/data/{support,blog}/` holds the content: 15 support sections and about 180 articles.
- `apps/index/scripts/` holds the build steps, with `scripts/lib/` for frontmatter, Markdown and related articles.
- `apps/index/src/components/support/` and `src/routes/support.*` render the pages.

## The build runs in three phases

The `@apps/index` package scripts wire them:

```
prebuild   build-content.ts, build-licenses.ts, build-changelog.ts   Markdown -> validated meta + rendered HTML
build      vite build                                                 routes import the manifests
postbuild  prerender.tsx, build-search-index.ts                       every route -> static HTML; Pagefind index
```

`typecheck` runs the content build first, because the routes import the generated JSON.

## A bad frontmatter field fails the build

`build-content.ts` walks `src/data/{blog,support}`, parses frontmatter with `gray-matter` and validates it against the Zod schemas in `apps/index/scripts/lib/content-types.ts`. A bad or missing required field throws, so a broken article never ships. It extracts media grids and renders Markdown with `markdown-it` and `markdown-it-anchor`.

Per collection it writes one `<slug>.json` body (`{ html, mediaGrids }`) and one `<collection>.manifest.json` with metadata only: title, description, type, category, tags, order, `updated`, cross-sections, the h2/h3 TOC and the resolved `related` list. The output goes to `src/content/.generated/`, which is gitignored: it is a build artifact.

## Manifests load eagerly and bodies lazily

`src/content/manifest.ts` is the read side. The manifests are small, so they are imported eagerly. The bodies are an `import.meta.glob`, so each article body is its own chunk and a visitor downloads only the body they open. `useArticleBody` (`src/content/use-article-body.ts`) returns the page's own body synchronously and lazy-loads any other article the visitor navigates to.

## Every route is prerendered and hydrated in place

`apps/index/scripts/prerender.tsx` boots a Vite SSR server, so the route tree's Vite-only APIs (`import.meta.glob`, `import.meta.env`) resolve. For every route it calls `src/entry-server.tsx`: a TanStack Router on a memory history at that path, `router.load()`, `serverSsr.dehydrate()` and `renderToString(<RouterServer/>)`. The HTML goes into the built shell's `<div id="app">`, followed by the article body as an inline JSON `<script>` and TanStack's dehydration script (`window.$_TSR`). The routes are `/`, `/blog` and every post, `/support` with every section and article, `/licenses` and `/changelog`.

On the client, `mountReactApp` picks `hydrateRoot` when the container already has markup, and `main.tsx` renders `RouterClient` when `$_TSR` is present. The dev server has no bootstrap, so it falls back to a plain `RouterProvider`. Hydration reuses the prerendered DOM instead of rendering twice.

Each page also gets its `<title>`, description and OG tags, and an article page gets a minimal `Article` JSON-LD block. The dehydration script differs per page, so `withInlineScriptHashes` (`vite.security-headers.ts`) writes that page's script hashes into its CSP meta.

## The canonical URL and the sitemap need `DOMAIN`

The prerender builds absolute URLs from the `DOMAIN` environment variable. Without it a page gets no `og:url` or `<link rel="canonical">`, and no `dist/index/sitemap.xml` is written. With it the sitemap lists every route, with `<lastmod>` from `updated` or the post's date.

## The first client render must match the server render

A mismatch makes React throw the prerendered DOM away and render the page again. So:

- `useMediaQuery` is `useSyncExternalStore` with a desktop `getServerSnapshot`.
- The `Toaster` mounts only after hydration.
- React's auto-emitted `<link rel="preload">` tags are moved into `<head>`, where the browser's React puts them.
- The landing page's first render is deterministic.

The comments in `prerender.tsx`, `entry-server.tsx` and `main.tsx` explain each one. Read them before changing the render path.

## A section is a folder and a slug is a file name

`drive/share-a-file.md` is `/support/drive/share-a-file`. Both parts are permanent identifiers: renaming breaks deep links and search ranking. `section` is never a frontmatter field: the folder decides.

`src/components/support/sections.ts` is the display registry: id (the folder name), title, description, icon and color, in display order. An app-backed section takes its icon and brand color from the shared `apps` registry, and an unknown app name throws at build. The sections without an app of their own (Getting started, Integrations, Account, Admin and Self-hosting) use the index app's color.

The Self-hosting section is written for the person who runs the server, not for its users. It holds the operator's steps from requirements to troubleshooting. [SELF-HOSTING.md](SELF-HOSTING.md) is the technical reference beside the code and links into it rather than repeating them.

## Frontmatter decides listing and related articles

- `crossSections: [other-section]` lists an article on a second section page without changing its canonical URL.
- `related` is explicit when set. Otherwise the build resolves it from shared `tags` within the same section, at most four (`apps/index/scripts/lib/related.ts`).
- `draft: true` drops a support article from the build entirely.
- Section pages sort on `order` alone. `category` is validated and carried in the manifest, but nothing groups by it.
- The blog rides the same pipeline with a smaller schema (`id`, `title`, `description`). Its date comes from the filename prefix.

Prose rules, article types and frontmatter conventions: [SUPPORT-STYLE-GUIDE.md](SUPPORT-STYLE-GUIDE.md). The writer's procedure: the [support-article skill](../.claude/skills/support-article/SKILL.md).

## Search indexes the generated JSON, not the HTML

`build-search-index.ts` feeds Pagefind one `addCustomRecord` per support article from the generated content: title, description and the tag-stripped body, with `section` as a filter. Custom records give exact control over what is indexed and what the excerpt shows, and they don't depend on the prerender's markup. The bundle lands in `dist/index/pagefind/` as plain static files: no infrastructure and no API key.

## The landing and the palette share one loader

The search box on `/support` (`components/support/support-search.tsx`) and the command palette's Help group both go through `packages/lib/src/core/search/pagefind.ts`. It is a lazy `@vite-ignore` import that degrades to no results when the bundle is missing, and it skips the import in dev, where only a 404 can come back. The palette source runs only under the `?` scope or no scope, so the WASM index never loads while the user is narrowed to mail or files. In production every app is same-origin behind Caddy, so `/pagefind` is reachable from any app.

## The apps link to the help center's landing

`getSupportUrl()` resolves the index app's `/support`. The topbar links to it as "Support" with a `LifeBuoy` icon from the signed-in menu, the guest menu and the app switcher's footer, which shows it to every user, guests included, below an admin's "Admin". The Space landing grid ends with a muted "Help and support" card (`apps/space/src/routes/_auth.index.tsx`), outside the `apps` registry so it never shows up as an app tile. Every link lands on `/support`, and none opens a single article.

The index app sends a signed-in visitor on to `/space/` from a `useEffect` in `routes/index.tsx`. The redirect belongs to that one route, so `/support/*` and `/blog/*` stay reachable while signed in with no exemption logic.

## The help center uses the shared app shell

`routes/support.tsx` wraps the whole tree in the shared `AppShell` (`appName="support"`), which already provides `LayoutContext`. There is no separate public shell and no section sidebar. The landing, section and article pages are each a single flex `Column`, and an article keeps its TOC in a sticky gutter at `xl` and up.

## See also

- [SUPPORT-STYLE-GUIDE.md](SUPPORT-STYLE-GUIDE.md): how articles are written
- [SEARCH.md](SEARCH.md): the command palette's other search sources
- [SELF-HOSTING.md](SELF-HOSTING.md): the operator reference the Self-hosting section pairs with
