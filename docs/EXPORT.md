# Document Export and Import

> **TLDR:** One route downloads a doc as docx, PDF or HTML, a sheet as xlsx, PDF or HTML, a deck as PDF or HTML and a drawing as SVG or PDF (`apps/api/src/lib/export/`). Import turns an xlsx into a sheet and a docx into a doc (`lib/import/`). Not obvious from the code: every format but xlsx and SVG is one HTML document, and PDF is that document through WeasyPrint. WeasyPrint fetches only `data:` URIs, through a fetcher of Eigen's own, and every body keeps only `data:` references, so an HTML download fetches nothing either. An import writes nothing until the Worker succeeds, and checks write again last.

A user exports from the file menu of the docs, sheets, slides and drawing editors, or from a Drive item's menu. Import is a row of the same file menu in docs and sheets (**Import docx file…**, **Import xlsx file…**) and replaces the open document. Convert to Sheet and Convert to Document are file actions on an xlsx or docx, and make a new document from it. Every document that exports is a collab document, so its content is the Yjs state stored in its container's `data.db` ([COLLAB.md](COLLAB.md)), and an export renders that state. The heavy work runs in a one-shot transform Worker ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md)).

## A type's format list is both the menu and the gate

`EIGEN_DOC_TYPE_INFO[type].exportFormats` (`packages/lib/src/types/drive.ts`) lists what a type offers, in menu order. The file menu and the drive item menu read it through `exportFormatsFor`. The route checks the same list, and `offers()` in `export-document.ts` narrows each entry to a literal. So a format added to a type without a Worker envelope fails to compile instead of reaching a user as a 400.

Export and import both dispatch on the container type, not the mime type. A mime type is caller-controlled on upload, so a plain file wearing an Eigen mime is a 400 rather than a transform over data it does not have. The export route resolves the file through `SharedDrive`, so the ACL check is the drive's; export is not a `Drive` method.

## The Worker renders and the main thread prepares

`runDocumentExport` is the one main-thread entry. It asks the runner for admission first, so a refused job does not pay for its media. Then `collectExportMedia` (`export/media.ts`) fetches the screen preview of every media child. That is Mount I/O plus the capped thumbnail path, so it stays on the main thread. A docx instead re-encodes each image from its source file as PNG or JPEG in the thumbnail Worker, uncached, so it takes one item at a time and queues no more once the client disconnects. The prep spends from the export's 120 s transform deadline, so an export is one deadline end to end: once it is spent the prep queues no more media and the job fails as a timed-out one does. The xlsx export skips it, because the writer carries cells only.

The one-shot Worker ([DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md)) materializes the captured Yjs blobs, renders, sanitizes and, for docx, converts. `@turbodocx/html-to-docx` and ExcelJS load lazily, so an HTML export evaluates neither. A blob that fails to decode is skipped with a `corrupt-blobs-skipped` warning, as on a live read. WeasyPrint stays on the main thread: it is already a separate process.

| Outcome | Status |
|---|---|
| WeasyPrint not installed, older than 68 or its import past 5 s (PDF only) | 501 naming the minimum and how to install it |
| WeasyPrint past its 60 s timeout, or exits non-zero | 504, or a bare 500 with its traceback in the log |
| Transform runner saturated | 503, never a main-thread fallback |
| Empty deck or empty drawing | 400 |

## A transform route exempts itself from the idle timeout

The response is silent while the job queues and its Worker runs. Queue wait plus the 120 s transform deadline plus 60 s of WeasyPrint can outlast any server-wide `idleTimeout`, which Bun caps at 255 s. So the export, import and convert routes call `server.timeout(request, 0)`. Without it Bun closes the silent connection, which aborts the signal and kills the job mid-transform. `request.signal` still fires on a real disconnect, and the runner then drops the queued job or terminates its Worker.

## Every format but xlsx and SVG is one HTML document

`html` and `pdf-html` render the identical document, so WeasyPrint prints exactly what the HTML download serves. A doc's docx is that HTML fed to `@turbodocx/html-to-docx` without its doctype, because html-to-docx opens the body with an empty paragraph for one. It turns only a top-level page break into a Word page break ([DOCS.md](DOCS.md#html-to-docx-reads-our-page-break-only-as-a-top-level-page-break-div)). There is one document per type to get right, not one per format. A doc's `<title>` keeps the extension (`Report.eigendoc`) while the docx title drops it; that output is pinned in `apps/api/src/test/export/document-export-route.test.ts`.

A doc's page comes from its page setup ([DOCS.md](DOCS.md#one-page-setup-sizes-every-page-a-doc-is-drawn-on)): the HTML's screen page and the PDF's `@page` from `pageStylesheet` (in `PRINT_EXTRAS`, `export/doc/transform.ts`), and the docx's page size and margins from `pageTwips`. So all three match the editor's A4 page and its 2 cm margins.

The document is self-contained, because WeasyPrint and a downloaded file have no app to fetch from. Fonts are WOFF2 files base64'd into `@font-face` rules (`export/fonts.ts`). A doc imports `eigen-prose.css` as text and flattens it at load: WeasyPrint does not read CSS nesting, so nesting is expanded, `.dark` rules are dropped and theme variables become values, so no `var()` survives. The font weights come from `font-weights.css`, rounded to the nearest multiple of 100 because WeasyPrint accepts no other weight: headings and table headers print at 500 and bold at 600.

The doc node renderers (`export/doc/render.ts`) are pure and shared with the preview. The module holds the backend's one lowlight, so the main thread imports it lazily. A figure resolves its media name to a `data:` URI; a missing image renders no `<img>`, and an external `src` is stripped by the sanitizer. So a figure with only an external `src` exports empty, with no warning, an open [ROADMAP](ROADMAP.md) row. A task item is rendered by hand, because the static renderer drops `checked`.

## The doc renderers write the DOM the editor holds

A figure is an inline node, so it renders as a `span.figure` with a `span.figcaption`, which a paragraph can hold. A `<figure>` inside a `<p>` closes it in every HTML parser, the sanitizer's and WeasyPrint's, and the paragraph split around it gains margins the editor never draws. `span.figure` parses back with its caption and layout; the old `<figure>` rule stays. Both draw from the shared `.figure` box ([DOCS.md](DOCS.md#the-node-view-and-the-export-draw-one-figure-box)).

`withTrailingBreaks` (`export/doc/render.ts`) gives every paragraph and heading the `<br>` ProseMirror's `addTextblockHacks` gives it in the editor: one that is empty, or ends in a non-text node or a newline. Without it an empty paragraph is 0 px tall in the export and a line tall in the editor. The export and the preview both run it.

## The docx writes a figure's margin inside its paragraph's spacing

In the editor a paragraph's own margins collapse with its neighbours', and a figure's 0.75em margin sits inside the paragraph and never collapses. Word and LibreOffice collapse adjacent spacing to the larger, as CSS does, and have no inside margin. So `to-docx.ts` carries the figure's margin as an inset on its paragraphs, and `withInsets` writes the whole gap on the inset paragraph's side: the neighbour's inset, the two spacings collapsed, its own inset. The pieces a figure splits a paragraph into share its margins, the first taking the one above and the last the one below. A paragraph that holds only a wrapped figure keeps its line, as the editor's trailing break does.

A list item that holds a wrapped figure ends in a clearing break (`w:br w:clear="all"`) on a single-spaced Spacer paragraph, so the next item starts below the float, as in the editor. On an exact-height Spacer, LibreOffice ignores the clear. The cases are pinned in `apps/api/src/test/export/doc-docx.test.ts`.

## WeasyPrint fetches only data: URIs

PDF is the HTML document through WeasyPrint, run by `export/weasyprint-render.py` through its Python API rather than its CLI. That script hands WeasyPrint a URL fetcher that opens `data:` URIs and refuses everything else: http(s), `file:`, a plain or relative path, any other scheme. Export embeds every resource it needs as a `data:` URI, so any other reference came from a collaborator's CRDT string, and WeasyPrint would fetch it from the API host while it renders. WeasyPrint's default fetcher opens every one, from a nested `<image href>` in a `data:` SVG to an `<a rel="attachment">`, whose response, or the server file a plain path names, it embeds in the PDF. The fetcher is the boundary for the PDF; the sanitizer is not relied on for it, and `export-pdf-ssrf.test.ts` renders raw hostile bodies to prove it.

- `htmlToPdf` runs the script with the Python that imports WeasyPrint 68 or later: the one the `weasyprint` launcher's shebang names (a pip venv's, Homebrew's own, through `env` or `env -S` too), else `python3`. A pip launcher whose venv path is long or holds a space starts `#!/bin/sh`, so it counts as naming none. When neither imports a recent enough one, a PDF export answers 501. The probe is cached; a spawn that finds the cached interpreter gone, as after a Homebrew upgrade, probes once more. An import that runs past 5 s is killed, because the export routes set no request timeout, and is not cached, so the next export probes again.
- It runs under `python -I`, so a module in the working directory or on `PYTHONPATH` cannot load in its place. That also drops the user site, so a `pip install --user` WeasyPrint is not found: install it system-wide, in a venv or from the OS package.
- The script subclasses `URLFetcher`, which WeasyPrint 68 introduced, rather than pass `allowed_protocols={'data'}`: 68.0 takes the text before `://` as the scheme, so it refuses every `data:` URI.
- The Docker image pins WeasyPrint 70.0 from PyPI in a venv at `/opt/weasyprint`, so it renders with the engine development does. `docker/api/weasyprint-requirements.txt` pins every dependency by hash, for the amd64 and arm64 wheels, and its first line is the command that regenerates it. The build renders a one-line PDF through `weasyprint-render.py`, so a system library the image lacks fails the build instead of every PDF export. Debian 13 ships 62.3, which ignores flex `align-items` and width on the `.figure` box and prints a centred figure left-aligned, its caption squeezed beside it.
- The document has no base URL, so a relative link stays relative in the PDF instead of becoming a `file://` URL of the server's working directory.

## The sanitizer keeps only data: references, because a browser fetches

`sanitizeExportHtml` (`export/sanitize.ts`) is DOMPurify plus one rule. Every CSS `url(`, every `src`, `poster` and `background`, and every SVG `href` must open a `data:` URI with no fragment. A `url(` may also be fragment-only (`#id`), a reference into the same document, and so may an `href` on the elements that reference with one: `use`, the gradients, `pattern`, `filter`, `textPath` and `mpath`. An `image` or `feImage` loads its `href` as a file, so a fragment there names the document itself. `srcset` is dropped. A `url(` that opens anything else costs the whole attribute it is in, and in a `<style>` element the statement it is in. So do `@import`, the string forms of `image-set()`, `image()`, `cross-fade()` and `element()`, which fetch with no `url(`, and `attr()`, which can read an attribute as a URL: WeasyPrint fails the whole export on `attr(name url)`.

A browser that opens an HTML download fetches what the document names, from the reader's machine, which tells whoever wrote the reference who read it. A preview body is live DOM in the drive hero, the same beacon at every viewer ([PREVIEWS.md](PREVIEWS.md)). So the restriction runs inside the Worker on every assembled body, and every format inherits it. A `data:` URI passes as it came, whatever its type or payload: a browser fetches nothing from an SVG drawn as an image, librsvg draws one from its bytes, and WeasyPrint's fetcher opens nothing but `data:`. The exception is a fragment. Firefox loads a `data:` SVG named with one (`mask:url(data:…#m)`, `fill="url(data:…#p)"`, `<pattern href="data:…#g">`) as a document, not an image, and fetches what that document names, such as its `@import`. So a `data:` URI holding a `#` is refused wherever it stands. A real one never has one: export media is base64, and a `#` in a percent-encoded payload ends it anyway.

- The rule reads the `url(` token, in any case, never a `url(…)` pair. A quoted URL can hold a `)` or a quote, so a pair regex ends early on `url('http://host/a)')` and the CSS parser fetches it. It is the same refusal `eml-preview.ts` makes for a message's CSS.
- Every attribute value is scanned, not only `style`: an SVG `fill`, `filter`, `mask`, `clip-path` or `marker-*` is CSS too.
- Backslashes go from `style` and `<style>` text before the scan. A CSS escape spells `url(` or `@import` invisibly to a regex (`\75 rl(`), but not to the parser that fetches. Any other attribute holding both a backslash and a `(` is dropped: an escape spells `url(` (`\75 rl(`) or a fragment (`url(data:…\23 p)`), and every fetch needs the literal `(` that opens a function.
- `<a href>` keeps its target, because docs and sheets carry real links and a browser follows one only on a click. A link is not inert to WeasyPrint: one with `rel="attachment"` is fetched and embedded in the PDF, which only the fetcher stops. jsdom names an SVG `<a>` in lowercase and an HTML one in uppercase, so the check ignores case.
- DOMPurify drops every `<use>`. A profile that admits `<svg>` keeps one whose every `href` is fragment-only, because matplotlib draws its text with `<use href="#glyph">`; any other `<use>` goes. Written as XML (`toXmlDocument`: SVG media and a drawing's own SVG), a `<use>` also needs every target to exist and hold no `<use>` of its own. Each reference draws its target again, so nested ones multiply: 1.2 KB of six levels of ten runs WeasyPrint into its 60 s kill. One level is what glyphs need, and it ends every cycle.
- Only the whitespace a URL or CSS parser trims counts as whitespace. A non-breaking space before `#` or `data:` makes a relative path of the rest.
- Every token pattern runs in one pass, because a collaborator's string sizes the scan. Two whitespace runs that could trade characters around an empty match cost their square: 256 KB of spaces after a `url(` costs 26 s.
- The hooks are added and removed around each synchronous call, so they never leak to another DOMPurify user.
- A media preview serves an SVG as uploaded. A docx carries it as a part of its own, and WeasyPrint and librsvg draw its every `<use>`, so the Worker takes every `image/svg+xml` media item through `sanitizeExportMedia` before any arm embeds it, and writes it as XML, without the characters XML can't hold; a file with no `<svg>` in it is dropped. The main thread hands over the inlined bytes as they are, because sanitizing a big drawing holds jsdom for seconds. Every format takes any size: the export deadline, sharp's pixel limit and the PNG fallback's timeout bound the work. A docx's PNG fallback is drawn in the transform Worker from the sanitized XML its `svgBlip` carries, so the docx shows what the PDF shows. One librsvg cannot read leaves the docx, its caption staying, and so does one it cannot draw within the thumbnail Worker's 30 s. That timeout is sharp's own, because `Worker.terminate()` does not stop libvips: a 310-byte filter chain held the one transform slot for 90 s. sharp reads physical units (`in`, `cm`, `mm`, `pt`, `pc`) at 72 dpi, so the figure's size scales a side the root `<svg>` gives in one by 96/72, the size the HTML export draws.

Previews pass the same function the exact set of their own preview URLs ([PREVIEWS.md](PREVIEWS.md)). The tests are in `apps/api/src/test/export/export-pdf-ssrf.test.ts`.

## A sheet export recalcs, and xlsx carries cells only

Export is the one read that recalcs a workbook nobody computed ([SHEETS.md § The editor computes on write](SHEETS.md#the-editor-computes-on-write-the-server-only-what-nobody-computed)), so an import whose recalc failed still exports values. A recalc failure exports the replayed values with a `recalc-failed` warning. A legacy workbook whose recalc outlasts the 120 s deadline fails the export, an accepted residual.

`to-xlsx.ts` reverses the importer with the same library. A merge's border perimeter is folded onto its master by `mergedBorderSides`, because ExcelJS keeps one style across a merge. Webpage links pass `resolveWebLink`, the editor's gate. Internal links are written in Excel's own `location` form. Floating images are dropped, an open [ROADMAP](ROADMAP.md) row. The class-styled HTML and the round-trip drifts: [SHEETS.md](SHEETS.md).

## Canvas pages are the boxes the live canvas draws

A deck's HTML and PDF and a drawing's PDF are pages of compositor layers (`export/canvas/render.ts`), which the canvas previews share. It restates no geometry: `layerBoxCss`, `layerInnerHtml` and `backgroundCss` come from `packages/lib`, and each layer gets the box `element-layer.tsx` gives it live. So what a user sees is what prints. A page holds the scene at 1:1 and scales it once, because a layer's body is authored in scene pixels. A non-text layer sits in an `overflow="visible"` `<svg>`, because roughjs overshoots its box.

`canvasHtmlDocument` (`export/canvas/transform.ts`) wraps all three, with one `@page` rule, font block and reset, so they cannot drift. It embeds `canvas-text.css` for the list and link rules an inline style cannot reach.

Before layout, `sanitizeSceneHtml` filters every text box to `LIGHT_EDITOR_TAGS` (`packages/lib/src/core/html.ts`), the set the canvas mounts a body with. A `<table>` or `<style>` a peer wrote would otherwise be invisible live yet print. The document cannot forbid `<style>` instead, because it carries its own `@font-face` block.

## A deck prints each frame at half scale

A frame is the page: 1920 by 1080, and an overhanging element is clipped as the canvas clips it. The page renders at 0.5, 960 by 540 px, because a 1920 px `@page` is a 20-inch sheet. The HTML download wraps each page in a `.page-fit` box that scales it to the viewport, so a deck reads on a phone, with a `@media` ladder first for a browser that cannot divide `100cqw` by a length. The PDF keeps the pages unscaled, because WeasyPrint has no viewport. The `.page-fit` rules mirror `packages/ui/src/styles/globals.css`, since a standalone file cannot import it.

## A drawing downloads its own SVG and prints as layers

The `svg` arm is `sceneToSvg` (`packages/lib/src/vector`) with the used `@font-face` blocks spliced in. The sanitizer allows `<foreignObject>` as an HTML integration point, or it would drop the rich-text `<div>`. The result is re-serialized as XML, because an XML parser reads an `.svg` and one unclosed `<br>` from a text box would blank the drawing.

The `pdf` arm is a single compositor page sized to the content plus 10 px on each side, the margin `sceneToSvg` leaves for roughjs's overshoot. Rich text prints because it is an HTML div; WeasyPrint ignores `<foreignObject>`. A transparent drawing prints on white paper, because WeasyPrint has no canvas behind the page. The page is capped at 19,200 px a side (`MAX_PDF_PAGE_PX`, `export/weasyprint.ts`), the PDF's 200-inch limit, so a far-out element cannot make WeasyPrint lay out an unbounded sheet. Artwork past it is cut off. A sheet's PDF page has the same cap, and a taller sheet continues on the next page.

## WeasyPrint dictates how a layer references its paint

A gradient (`fill="url(#…)"`) or an image clip (`clip-path="url(#…)"`) stays an SVG attribute pointing at the element's own `<defs>`. WeasyPrint resolves `url(#id)` only within the same `<svg>`.

An arrow's shaft is hidden under its label by a `<mask>`, because WeasyPrint ignores `clip-rule="evenodd"`. WeasyPrint applies a mask after drawing a node's children, so the reference goes on each shaft `<path>`, never a wrapping `<g>`. See `labelMask` and `maskShaft` in `packages/lib/src/vector/kinds/arrow-render.ts`.

## An import writes nothing until the Worker succeeds

`importIntoDocument` replaces an open document (`/import`, `/import-from-drive`) and `convertToDocument` (`/convert`) creates one beside the source, both in `import/import-document.ts`. The Worker converts bytes only and never sees an owner, mount or path. So a failed transform creates no document and mutates no Yjs state, and its 400 or 413 crosses the boundary unchanged. An xlsx comes back as snapshot JSON, committed without parsing; a docx as a ready Yjs update plus images.

The route checks write before it buffers, but the job can queue for minutes, long enough for a share to be revoked. So `importIntoDocument` checks write again as the last await before the synchronous Yjs write, and a revoked writer gets a 403. `convertToDocument` needs no recheck, because `SharedDrive.create` checks write. It takes no abort signal either: a page reload must not kill a minute of conversion, and the file appears through the drive SSE refresh.

## Zip guards run before the parser inflates anything

The upload bound limits compressed bytes, while ExcelJS and mammoth inflate the whole package, and an out-of-memory inside them cannot be caught. So `import/zip-size-guard.ts` checks the sizes the central directory declares, then inflates every entry once and discards the chunks, because a forged directory can declare a small size. A sheet also has a cell cap, which fires only after ExcelJS loads; that is part of why the Worker runs one job at a time.

## An imported sheet is stored as computed

The Worker runs `recalcSheets` and encodes the snapshot as computed, so no later read recalcs it. A recalc failure stores the parsed values uncomputed with a warning, and the first export recalcs them. The importer keeps three rules:

- `ct.fa` is always paired with `ct.t`, `'General'` when Excel reports no number format. Without an `fa`, date serials and percents render as raw numbers.
- A formula cell's `f` keeps its leading `=` (`=SUM(A1:A3)`), the form a sheet stores; the xlsx writer strips it.
- Internal links in `location` form are read from the raw worksheet XML, because ExcelJS drops them on read.

## A docx import replaces the document

`from-docx.ts` converts through mammoth, sanitizes with DOMPurify and parses with the eigendoc schema. A Word page break splits its paragraph on the way in ([DOCS.md](DOCS.md#a-word-page-break-splits-its-paragraph-on-import)). `writeEigendocUpdateToYjs` clears the fragment first, so an import replaces rather than appends. The images are written after the commit under deterministic names (`image-0.png`, …), so a repeat import overwrites them instead of failing after the content committed.

## Contacts and calendar export splice stored bytes

`POST /contacts/:ownerId/export` concatenates the stored vCards and `POST /calendar/:ownerId/export` splices the stored VCALENDAR lines. There is no renderer, Worker or sanitizer, because the stored bytes are already the format. See [CONTACTS.md](CONTACTS.md#import-replays-each-card-through-the-carddav-put) and [CALENDAR.md](CALENDAR.md#export-splices-the-stored-lines).

## See also

- [SHEETS.md](SHEETS.md): the sheets HTML and the xlsx round-trip drifts
- [DOCUMENT-TRANSFORMS.md](DOCUMENT-TRANSFORMS.md): the runner, its limits and the Worker boundary
- [CANVAS.md](CANVAS.md): the scene and the arrow label
- [PREVIEWS.md](PREVIEWS.md): the previews that share these renderers
