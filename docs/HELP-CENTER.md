# Help Center

> **TLDR:** The public help center (`/support`), the blog (`/blog`) and the About pages (`/about`) are static pages built by `apps/index`, with no backend. Articles are Markdown with Zod-validated frontmatter under `apps/index/src/data/`. A prebuild renders them to JSON, and a postbuild prerenders every route to real HTML that hydrates in place, so the first client render must match the server's. Search is a Pagefind index built from the same JSON. A section is a folder and an article's URL is its file path, so renaming either breaks links.

The help center is where users and the people who run a server read how Eigen works: a section for each app such as Mail or Drive, plus getting started, integrations, account, admin and self-hosting. Every app links to it, and the command palette searches it. Its pages are built with the apps, so every install serves its own copy. This doc covers how it is built and served. How an article is written is [SUPPORT-STYLE-GUIDE.md](SUPPORT-STYLE-GUIDE.md) and the [support-article skill](../.claude/skills/support-article/SKILL.md).

## The help center is static files

Everything lives in `apps/index` plus three shared pieces in `packages/lib/src/core/`: `getSupportUrl` in `api.ts`, the Pagefind loader in `search/pagefind.ts`, and the palette's `command-palette/providers/help-search.ts`. No `apps/api` code serves it, so there is nothing to deploy or operate beyond the files in `dist/index`.

- `apps/index/src/data/{support,blog,about}/` holds the content: one folder per support section, the blog posts and the About pages.
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

`build-content.ts` walks `src/data/{blog,support,about}`, parses frontmatter with `Bun.YAML` and validates it against the Zod schemas in `apps/index/scripts/lib/content-types.ts`. A bad or missing required field throws, so a broken article never ships. It extracts media grids and renders Markdown with `markdown-it` and `markdown-it-anchor`.

An app name written as a ket, such as `eigen|mail⟩`, is set in the mono font wherever the site shows prose, so its letters, bar and ket come from one face. The Markdown keeps the plain text. `renderMarkdown`'s text rule wraps each name in `<span class="ket-name">` and `MediaGrid` does the same for a caption, both through `splitKetNames`. Code spans, code blocks, URLs and attributes stay as written, and heading ids and TOC text come from the tokens, so they keep the plain name. A name in backticks is code: use that only for text that appears on screen as written, such as a browser tab title.

A media block is a fence: an opener line `::: <name> key="value"`, a body and a closing `:::`, read by the `markdownBlocks` plugin. `::: video src="/data/…/clip" caption="…"` has no body and plays a muted loop from `clip.av1.mp4` and `clip.h264.mp4` under `public/`, with `clip.webp` as its poster; a missing file, or a `src` that does not start with `/`, fails the build. `::: carousel` takes one `![alt](src)` image per line and sets each on its own slide with its alt text as the slide's caption; a src with no file ending is a video base path, checked like `::: video`'s, and makes a video slide with the same markup, on a scroll-snap strip that starts at the reading column's left edge and runs to the page's right edge so the next slide peeks in; dots and previous and next buttons sit under it, and its own `caption` goes under the whole block. The strip reaches the page edge through `100cqw`, because the page's scroll area in `SitePage` is a size container. `::: side-by-side` sets two images in two columns that stack on a phone. A caption renders as inline Markdown, so an app name in it is a ket. An unknown name, a missing closing fence or a carousel line that is not one image fails the build with the opener's line. `ArticleContent` wires the carousel's buttons and dots, keeps them in step with the strip's scroll, and starts each looping video, or gives it controls for a reader who prefers reduced motion; in a carousel only the video on the slide its dots mark plays. The prerendered `<video>` has no `autoplay`, so nothing moves for that reader before hydration. `::: carousel autoplay` writes `data-autoplay` on the figure, and `ArticleContent` scrolls it one slide on every 7 s, looping to the first; a tick skips while the carousel matches `:hover, :focus-within`, the tab is hidden or the reader prefers reduced motion. The timer remembers the slide it scrolled to: when the strip shows another at the next tick, the reader moved it, by a button, a dot, a swipe or a key, and autoplay stops for good. A dot's label says "Slide 2 of 3", as a slide can be a film. Enter or Space on the focused strip opens its slide in view in the lightbox, as a click on it does.

A block the page draws itself is a fence with no body whose name the collection's pages draw, such as `::: apps`. `renderMarkdown` takes those names, and the content build passes `apps` for the About pages alone, so the same fence in a blog post or a help article fails the build as an unknown block. It renders a `<p>[BLOCK:name]</p>` marker, and `ArticleContent` swaps it for the node its `blocks` prop holds under that name, the same split as a media grid's `[MEDIAGRID:n]`. The node is React on both sides, so the prerender and the first client render match, and headings around it stay in the Markdown and its table of contents. The node renders outside the prose: each run of Markdown between two blocks gets its own `eigen-prose site-prose` div, so a block keeps the look its own classes give it, and one that wants the prose look wraps itself in it. The lightbox opens for a picture inside the prose, so a picture in a block opens it only when that block wraps itself in prose.

Every picture and film in an article opens bigger on a click in `MediaLightbox`, a dialog with the caption under the media; a picture inside a link or a button does not. A picture or video in a carousel opens with the carousel's slides as its group, which the lightbox pages through with its arrows and the arrow keys; any other picture or film opens alone. A picture's caption there is its alt text, a looping video's its block's caption, and the video plays the source the browser picked, as a muted loop with controls, held still for a reader who prefers reduced motion. A media grid's thumbnail opens the same lightbox, with the whole grid as the group. `ArticleContent` holds the page's one lightbox and opens it from its one delegated click handler, and renders it beside its root, so no click in the portaled dialog comes back to that handler. An arrow key from the film, where it seeks, or one something else already handled does not page.

Per collection it writes one `<slug>.json` body (`{ html, mediaGrids }`) and one `<collection>.manifest.json` with metadata only: title, description, type, category, tags, order, `updated`, cross-sections, the h2/h3 TOC and the resolved `related` list. The output goes to `src/content/.generated/`, which is gitignored: it is a build artifact.

## Manifests load eagerly and bodies lazily

`src/content/manifest.ts` is the read side. The manifests are small, so they are imported eagerly. The bodies are an `import.meta.glob`, so each article body is its own chunk and a visitor downloads only the body they open. `useArticleBody` (`src/content/use-article-body.ts`) returns the page's own body synchronously and lazy-loads any other article the visitor navigates to.

## Every route is prerendered and hydrated in place

`apps/index/scripts/prerender.tsx` boots a Vite SSR server, so the route tree's Vite-only APIs (`import.meta.glob`, `import.meta.env`) resolve. For every route it calls `src/entry-server.tsx`: a TanStack Router on a memory history at that path, `router.load()`, `serverSsr.dehydrate()` and `renderToString(<RouterServer/>)`. The HTML goes into the built shell's `<div id="app">`, followed by the article body as an inline JSON `<script>` and TanStack's dehydration script (`window.$_TSR`). The routes are `/`, `/blog` and every post, `/support` with every section and article, `/about` and every app page, `/licenses` and `/changelog`.

On the client, `mountReactApp` picks `hydrateRoot` when the container already has markup, and `main.tsx` renders `RouterClient` when `$_TSR` is present. The dev server has no bootstrap, so it falls back to a plain `RouterProvider`. Hydration reuses the prerendered DOM instead of rendering twice.

Each page also gets its `<title>`, description and OG tags, and an article page gets a minimal `Article` JSON-LD block. The dehydration script differs per page, so `withInlineScriptHashes` (`vite.security-headers.ts` at the repo root) writes that page's script hashes into its CSP meta. It hashes each script as the browser parses it, NUL as U+FFFD and CR or CRLF as LF, because TanStack's dehydration writes NUL into match ids and a hash of the raw text would block the script.

## The canonical URL and the sitemap need `DOMAIN`

The prerender builds absolute URLs from the `DOMAIN` environment variable. Without it a page gets no `og:url` or `<link rel="canonical">`, and no `dist/index/sitemap.xml` is written. With it the sitemap lists every route, with `<lastmod>` from `updated` or the post's date.

## The first client render must match the server render

A mismatch makes React throw the prerendered DOM away and render the page again. So:

- `useMediaQuery` is `useSyncExternalStore` with a desktop `getServerSnapshot`.
- The `Toaster` mounts only after hydration.
- React's auto-emitted `<link rel="preload">` tags are moved into `<head>`, where the browser's React puts them.
- The landing page's first render is deterministic: the `eigen|app⟩` wordmark starts at the first app, and the waitlist and link buttons, the install line and the version label wait for the config. The hero Log in button is in the static HTML as Log in and turns into Enter demo once the config says so.

The comments in `prerender.tsx`, `entry-server.tsx` and `main.tsx` explain each one. Read them before changing the render path.

## A section is a folder and a slug is a file name

`drive/share-a-file.md` is `/support/drive/share-a-file`. Both parts are permanent identifiers: renaming breaks deep links and search ranking. `section` is never a frontmatter field: the folder decides.

`src/components/support/sections.ts` is the display registry: id (the folder name), title, description, icon and color, in display order. An app-backed section takes its icon and brand color from the shared `apps` registry, and an unknown app name throws at build. The Admin section takes `adminApp` from the same registry, which keeps it outside `apps` because only an admin gets a way in. The sections without an app of their own (the folders `getting-started`, `connect`, `account` and `self-hosting`) use the index app's color, Space teal. A section page's article rows wash in its section's color, and an article's breadcrumb names the section with its icon in that color. `connect` is titled Integrations.

The Self-hosting section is written for the person who runs the server, not for its users. It holds the operator's steps from requirements to troubleshooting. [SELF-HOSTING.md](SELF-HOSTING.md) is the technical reference beside the code and links into it rather than repeating them.

## Frontmatter decides listing and related articles

- `crossSections: [other-section]` lists an article on a second section page without changing its canonical URL.
- `related` is explicit when set. Otherwise the build resolves it from shared `tags` within the same section, at most four (`apps/index/scripts/lib/related.ts`).
- `draft: true` drops a support article or a blog post from the build entirely: no page, no list entry, no sitemap entry.
- Section pages sort on `order` alone. `category` is validated and carried in the manifest, but nothing groups by it.
- The blog rides the same pipeline with a smaller schema (`id`, `title`, `description`). Its date comes from the filename prefix.

Prose rules, article types and frontmatter conventions: [SUPPORT-STYLE-GUIDE.md](SUPPORT-STYLE-GUIDE.md). The writer's procedure: the [support-article skill](../.claude/skills/support-article/SKILL.md).

## Search indexes the generated JSON, not the HTML

`build-search-index.ts` feeds Pagefind one `addCustomRecord` per support article from the generated content: title, description and the tag-stripped body, with `section` as a filter. Custom records give exact control over what is indexed and what the excerpt shows, and they don't depend on the prerender's markup. The bundle lands in `dist/index/pagefind/` as plain static files: no infrastructure and no API key.

## The landing and the palette share one loader

The search box on `/support` (`components/support/support-search.tsx`) and the command palette's Help group both go through `packages/lib/src/core/search/pagefind.ts`. It is a lazy `@vite-ignore` import that degrades to no results when the bundle is missing, and it skips the import in dev, where only a 404 can come back. The palette source runs only under the `?` scope or no scope, so the WASM index never loads while the user is narrowed to mail or files. In production every app is same-origin behind Caddy, so `/pagefind` is reachable from any app.

## The apps link to the help center's landing

`getSupportUrl()` resolves the index app's `/support`. The topbar links to it as "Support" with a `LifeBuoy` icon from the signed-in menu, the guest menu and the app switcher's footer, which shows it to every user, guests included, below an admin's "Admin". The Space landing grid ends with an Admin card that only an admin sees (`adminApp`, gated on the same `useIsAdmin` as the switcher's "Admin") and a "Help and support" card in Space teal, the help center's own color (`apps/space/src/routes/_auth.index.tsx`). Neither is in the `apps` list, so neither shows up as an app tile in the switcher. Every link lands on `/support`, and none opens a single article.

The index app sends a signed-in visitor on to `/space/` from a `useEffect` in `routes/index.tsx`. The redirect belongs to that one route, so `/support/*` and `/blog/*` stay reachable while signed in with no exemption logic. It is an effect, not a router `beforeLoad`, because the landing is prerendered and `AuthProvider` doesn't block there, so a `beforeLoad` only ever sees a signed-out visitor.

## The public site uses the shared app shell

Every route of `apps/index` wraps its page in the shared `AppShell` with an `appName`: `support`, `blog`, `about`, `changelog`, `licenses`, and an empty one for the landing page, where the top bar shows the bare `eigen` wordmark. `routes/support.tsx` does it once for the whole Support tree. There is no separate public shell and no section sidebar.

`components/site-page.tsx` (`SitePage`) is the frame inside it: one scrolling column with the footer after the content, so a short page's footer rests at the bottom. A Support page passes its section's color, which sets `--app-current-color` for the rows and the table of contents. `components/site-footer.tsx` is the one-line footer, drawn by `SitePage` and never by a page: the build's version label linking to the changelog, then Support, Blog, Changelog, GitHub, Sponsor and Licenses. `components/reading-layout.tsx` (`ReadingLayout`) is the grid of a reading page: an optional left gutter and the column, centered. Blog posts, the changelog and the Support section and article pages read in it. The gutter goes below 76rem.

Log in is in the shared `Topbar` in `packages/ui`, not in this app. It shows on every signed-out top bar, the login pages included, and reads `demoMode` from `/p/config` to name itself Enter demo. It is a quiet `LogIn` icon link with a tooltip, like the bar's other icons, because the landing page's hero carries the prominent Log in button. `LoginButton` waits only for the session, not for the config, so it is the one part of the top bar the prerender does not contain. On a demo server it can first read Login, then Enter demo, when the config arrives. `AuthProvider` starts with `isLoading` true, on the server and in the first client render, so that what waits for the session matches the prerender.

The breadcrumb (`components/article-breadcrumb.tsx`) sits in the column's toolbar, the bar the apps keep their location in, such as Support › Sheets › the article's title, or Blog › the post's title; a post's date is under its title. `SitePage` lays the toolbar out on the same `site-reading` grid as the page, so the trail starts on the container's edge. Each crumb links up the tree in the plain breadcrumb style, and the last one names the page itself, truncated when it is long.

The table of contents (`components/article-toc.tsx`, `ArticleToc`) fills the left gutter in a `.site-panel`, the muted panel the landing blocks use too. It lists the h2 headings of an article, or the releases of the changelog with their short dates under the label Versions. It sticks while the page scrolls, as `ReadingLayout` sticks the whole gutter, marks the last entry whose heading passed the line a third down the screen, also once on load for a page opened at a `#section`, and draws nothing for fewer than two entries. An `IntersectionObserver` reports the crossings, so there is no scroll listener and no search for the element that scrolls. A last section too short to reach that line never marks its entry; that is accepted, as the alternative reads the scroller's position on every scroll. The CSS way, `scroll-target-group` with `:target-current`, replaces the observer once Firefox and Safari ship it.

## The changelog is built from CHANGELOG.md

`build-changelog.ts` renders `CHANGELOG.md` with the same Markdown pipeline as the articles. It drops everything before the first version heading, because the page draws its own title, and wraps each release in a section with a head of version and date (`Unreleased` has none). A bullet's bold label becomes a lead that starts the entry, and the text after it starts with a capital letter and ends with a period when it ends in no punctuation. It also writes the list of versions that `ArticleToc` shows. Its output is `src/content/.generated/changelog.json`, a `ChangelogBody` that is an article body plus `versions`. The page and the prerender read the same file, so the whole changelog is in the static HTML.

## The blog overview and covers

The overview lists the posts newest first from the build-time manifest, so every row is in the prerendered HTML. Every post is the same list row, with a line between rows, and each date hangs in the left gutter. A post may set `cover` in its frontmatter, a path under `public/` such as `/data/blog/media/<folder>/<image>.webp`. `BlogCover` crops it to a 16:9 frame from the top, under the title on the post page. A post without `cover` shows none. A post page ends with a pager to the older and the newer post.

## The landing page

`routes/index.tsx` is the landing page: the `EigenCyclingLogo` wordmark with the pitch, centered above the buttons, and three blocks along the bottom (`components/landing-blocks.tsx`), each a sentence over `Badge` tags that name its protocols or formats. The wordmark cycles through the enabled apps from an effect, so the prerender and the first client render are the same. The buttons are Login, the waitlist button and the admin's `landing.links`, and the install line under the blocks, a `CodeBlock` with a copy button, shows only when `landing.showInstall` is on ([SERVER-SETTINGS.md](SERVER-SETTINGS.md)). The Login button is in the static HTML. The rest come from `/p/config` and appear after load. A demo server shows the Enter demo button and a line about the demo instead of the pitch.

## The About pages

`/about` is an overview and `/about/<app>` one page per app, a third collection beside the blog and Support, in `src/data/about/` ([proposals/PROPOSAL_ABOUT_PAGES.md](proposals/PROPOSAL_ABOUT_PAGES.md)). The apps are the shared `apps` registry without Space, in its order, and then Admin (`adminApp`) as the eleventh app page and the last row, for the person who runs the server, so with the overview the section has twelve pages; an app's slug is its name in lower case (`aboutApps`). Nothing on the site links the section yet: the footer has no About and the landing page's line of apps is plain text, so a visitor reaches the pages by URL and an indexer through the sitemap. An app page takes its app from its file name, so `sheets.md` is `/about/sheets`, and a file named after no app throws at build. `index.md` is the overview, and its `rows` frontmatter holds one line for each of the apps, no more and no fewer; an app page that sets `rows` throws. The frontmatter is strict: the order comes from the registry, so a field such as `order` or `draft` is refused.

An About page says what an app does and never lists what it doesn't, not even "yet". A gap goes in the help center, in the known-gaps article ([known-gaps.md](../apps/index/src/data/support/self-hosting/known-gaps.md)) and the app's own articles.

A help link sits on the words of its sentence that name what the article explains, such as `You can [share a folder](/support/drive/share-a-file) with someone outside the team.`, never as the article's title in parentheses, and a sentence links one article once. The gutter links the app's whole help section, so a page need not link every article.

A file whose name starts with `_` is not a page. `_technical.md` is the note for the reader's technical person, two lines with the install command and a link to the self-hosting guide, and no heading. The build renders it once and appends it to every About page's HTML after the render, in an `<aside class="site-panel">`, so it ends the body and nothing in it reaches the table of contents.

An app page's gutter holds, under the table of contents, a small box for each of Eigen's three principles the app holds to, zero to three: the principle's title as on the landing page, a line on how, such as "Syncs with the calendar on your phone.", its tags and a link to the help article that explains it. `appPrinciples` in `about-apps.ts` is the one typed map of them, beside `aboutApps`, and `principles` there names the three. The build checks each `article` against the help articles it built, so a mistyped slug fails it. An app the map leaves out, such as Chat or Stickies, gets no boxes. Under the boxes, and on a page without them too, one quiet line, such as All Mail help articles →, links the app's whole help section, whose id is the app's slug. The landing page's three blocks take their tags from the same map, each block from the apps it names. Below 76rem the gutter is gone, so the boxes and that line show a second time under the body and its technical note, in a row that wraps, as the overview places its blocks: `AboutPage` draws that copy itself and hides it from 76rem up, as the blog list does its dates.

`ReadingLayout` sticks the whole gutter, the table of contents with the boxes under it, at most a screen high. On a short screen the table of contents scrolls within itself and gives up its height first, since a scroll container's minimum height in a flex column is zero, so the boxes stay in view and never cover it. On a very short screen the last box can run past the bottom; that is accepted.

The overview reads in the reading column too, with the table of contents of its h2s in the gutter and no boxes under it. Its body places a row for every app, in registry order, at `::: apps`; a row links to its app's page only once that page exists. Under the body and its technical note, last on the page as on the landing page, come the landing page's three blocks (`PrincipleBlocks`), stacked until 76rem and three across from there. From 76rem up the blocks reach over both gutters through `.site-reading-wide`, a negative margin of one gutter and one gap a side, so they stand as wide as the wide container and line up with the landing page's blocks; the column is centred in the grid, so they stay centred. Below 76rem the column already spans the page, less the shell's padding, and they stay in it. An app page ends with Previous and Next across the app pages. Both show the admin's landing links under the title, the same buttons as the landing page.

The About pages say the same on every server, so their `<link rel="canonical">` always names `https://eigen.is/about...`, whatever `DOMAIN` is. Their `og:url`, JSON-LD and sitemap entry use `DOMAIN` like every other page.

## Filming the demo

The videos and stills on the About pages are filmed, not drawn: the capture tool in `apps/index/capture/` seeds the Tuimel demo world ([DEMO_MODE.md](DEMO_MODE.md)) and records the personas' screens in it. So a retake after a design change is one command, and every picture shows the product as it is. The tool has its own `package.json` and `bun.lock` with `playwright-core`, like `packages/formula/benchmark`, so the workspace install never pulls it in. It runs on the owner's Mac, not in CI.

```
cd apps/index/capture && bun install && bun run capture [scene…]
```

With no names it films every scene. A run wipes `/tmp/eigen-capture`, seeds a fresh data root there with a known persona password (`EIGEN_DEMO_PERSONA_PASSWORD`), starts an API on 8690 and a vite on 36xx for each app the scenes need, beside a dev stack on the usual ports, and stops them all at the end, on Ctrl-C too. Start it outside the macOS sandbox, where the API's SQLite fails with `SQLITE_IOERR_VNODE`, and natively on Apple silicon (`arch -arm64`), since Chrome under Rosetta runs about ten times slower ([verify-in-browser skill](../.claude/skills/verify-in-browser/SKILL.md)). It needs system Chrome, an ffmpeg with `libsvtav1` and `libx264`, and `cwebp`.

A scene is one plain object in `capture/scenes/`, listed in `SCENES`: its output name, video or still, theme, viewport, the apps and personas it needs, a `setup` that runs before the camera rolls and a `run` that drives one page per persona. A take looks natural because each persona acts like a person: a drawn arrow follows an eased path of real mouse events, so hover states show on the way, text is typed one key at a time with an uneven rhythm, and a short `Bun.sleep` leaves a pause to read. Setup opens the document first, so a film starts on a ready screen, and a loop ends where it began, such as with an undo of the edit it showed. A take that crosses into another app, such as Mail opening a converted quote in Sheets, opens that app's editor once in setup, because vite builds an app's modules on its first visit and that films as seconds of white page. A mail's body renders in an iframe, so a scene waits on the message's heading, not its text.

A video records Chrome's screencast frames with their own timestamps and encodes them at a steady 30 fps into an AV1 and an H.264 mp4, the two files `::: video` reads, with the first frame as its webp poster. A scene with `composite: 'side-by-side'` films every persona's page and joins them with a thin grey seam, cut to one start. A still is one screenshot through `cwebp`, with no drawn arrow unless its scene sets `pointer`, such as one that points at an open menu. A still has the films' 16:9 shape, 1600×900 or 1280×720 for the overview's rows, so a carousel that mixes stills and films keeps one height; a side-by-side pair is wider. Everything is made under `/tmp/eigen-capture` and moves into `apps/index/public/data/about/media/` only once a scene's files are all done, so a failed take leaves the site's media as they were. The overview's rows read `row-<app>.webp` from there.

## See also

- [SUPPORT-STYLE-GUIDE.md](SUPPORT-STYLE-GUIDE.md): how articles are written
- [SEARCH.md](SEARCH.md): the command palette's other search sources
- [SELF-HOSTING.md](SELF-HOSTING.md): the operator reference the Self-hosting section pairs with
