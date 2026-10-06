# Docs

> **TLDR:** Docs is Eigen's word processor: rich text on an A4 page that several people edit at once. A doc is a `.eigendoc` collab document whose truth is ProseMirror content held in a Yjs fragment, and one schema defines that content for the editor and for every server renderer. The schema is `packages/lib/src/docs/eigendoc/`, and the editor is `apps/docs/src/components/docs/`.

The editor is TipTap, a React wrapper around ProseMirror, the editing toolkit that models a document as a tree of nodes (paragraphs, headings, lists, tables, task lists, code blocks, images) carrying marks (bold, color, font, comment). An image is a `figure` node. The app around it is a Drive-style file list plus one editor route, `/doc/$ownerId/$mountId/$pathId`.

On disk a doc is a container, a Drive folder named like a file (`Notes.eigendoc`), like every collab document ([COLLAB.md](COLLAB.md)). Its `data.db` holds the Yjs state, and the truth inside it is the `XmlFragment` named `default`, which y-prosemirror (the Yjs binding for ProseMirror) keeps in step with the editor. The same container holds the doc's images in `media/`, its comment threads in `chat/` and `comments.db` ([COMMENTS.md](COMMENTS.md)), and its version history.

The server never runs the editor, yet it renders the doc for the drive preview, the export formats and the search index, and writes it on a docx import. It reads the fragment as ProseMirror JSON (`readEigendocFromDoc`, [DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md)) and renders it with the same schema the editor uses. That shared schema is the one idea the app rests on: what the editor can write, the server can read.

A figure names its image, and never holds bytes or a URL. The name is a file in the container's `media/` folder, resolved to a URL at render ([MEDIA-REFERENCES.md](MEDIA-REFERENCES.md)). A pending name, `pending:<uuid>`, stands in for an image whose upload has not landed yet. A panel is one of the right-side panes: comments, activity, and the figure and table properties.

The sections cover the schema, figures, the page and its panels, comments, the clipboard, and what keeps content inside the page. Three things in them surprise people:

- The side panels overlay the page instead of taking room from it, and the page slides and scales to stay clear ([§ The page keeps its width](#the-page-keeps-its-width-and-slides-then-scales-clear-of-a-panel)).
- A figure stores its width in the page's own pixels, so the on-screen scale never leaks into the document ([§ A figure stores a name and a width](#a-figure-stores-a-media-name-and-a-width-in-page-pixels)).
- Undo reverts only this tab's edits ([§ Undo is the Yjs binding's](#undo-is-the-yjs-bindings-and-reverts-only-this-tabs-edits)).

## One schema serves the editor and every server renderer

`getDocExtensions` (`packages/lib/src/docs/eigendoc/extensions.ts`) is the schema. The drive preview (`apps/api/src/lib/preview/eigendoc-render.ts`), the export (`apps/api/src/lib/export/doc/transform.ts`) and the docx import (`apps/api/src/lib/import/doc/from-docx.ts`) all build from it, so a node the editor writes is a node the server can parse and render. A node only one side knew would vanish from every preview and export.

The editor leaves out the schema's `figure` and `comment` and adds `Figure` and `CommentMark` (`apps/docs/src/components/docs/extensions/`), which extend the lib nodes with the node view and the click, menu and decoration behavior. The stored shape stays the lib's, because an extension adds behavior, not attributes.

The code block exists only when the caller passes `lowlight`, the syntax highlighter. The preview and the export pass one. The docx importer passes none, so its schema has no code block, and a test fixture that writes a stored doc's code block must build its schema with `lowlight` too.

## Undo is the Yjs binding's and reverts only this tab's edits

The schema turns TipTap's own undo off (`undoRedo: false`), and y-prosemirror's undo plugin takes its place. It tracks only the changes this tab made, so ⌘Z never takes back a collaborator's typing. The toolbar reads its undo and redo state from that plugin (`yUndoPluginKey`).

## A figure stores a media name and a width in page pixels

A figure is an inline, atomic node (`packages/lib/src/docs/eigendoc/nodes/figure.ts`): it sits in a paragraph, its contents are not editable, and it can be dragged. Its durable reference is `mediaName`. `src` is only for an external image, and the export strips that ([EXPORT.md](EXPORT.md#the-sanitizer-keeps-only-data-references-because-weasyprint-fetches)). The other attributes are `alt`, `caption`, `alignment`, `layout` (block, or wrapped left or right), `commentCardId` and `width`.

A figure stores its width and never its height, so the height always follows the image's own ratio. The width is in the page's layout pixels, measured with `clientWidth` on the page element, which a CSS `scale()` does not change. So a doc edited on a narrow, scaled-down page stores the same width as on a wide one. The node view (`apps/docs/src/components/docs/extensions/figure.tsx`) sets the width on the image's first load, capped at the text column (half of it for a wrapped image), and resizing clamps between 100 px and that cap.

## An image renders from a pending name until its upload lands

An insert, a drop or a pasted image file writes the figure with the pending name `startUpload` returns, so the image shows on the next frame. When the upload settles, `swapFigureMediaName` rewrites every figure still holding that name to the real one, or removes the figure if the upload failed. A figure whose name never resolves shows `ImagePlaceholder`. The mechanics, and the sweep that clears a pending name a closed tab left behind, are in [MEDIA-REFERENCES.md](MEDIA-REFERENCES.md#a-new-upload-renders-from-a-pending-name).

## One page setup sizes every page a doc is drawn on

Every doc is an A4 page with 2 cm margins. One `PageSetup` in millimetres describes it (`DEFAULT_PAGE_SETUP`, `packages/lib/src/docs/eigendoc/page.ts`), and every surface derives its page from it: the editor's page and its layout math, browser print, quick look, the Drive thumbnail, the HTML export, the PDF and the docx. Each takes the unit it needs: pixels at 96 dpi for layout math (`pagePx`), a width and padding for a page box on screen (`pageBoxStyle`), a stylesheet for a page that also prints (`pageStylesheet`) and twips for the docx (`pageTwips`). One value means no surface can disagree with another, so what prints is what the editor shows.

On screen the margins are the page box's padding. On paper the `@page` rule draws them, so the page must drop its padding and width in print, or the margins print twice. `pageStylesheet(setup, selector)` holds all three rules: the `@page` rule, the selector's width and padding, and the print reset. The editor renders it for `[data-document]` in a `<style>`, which also matches the clone browser print makes, and the export embeds it for `.page`. Quick look and the thumbnail never print, so they keep `pageBoxStyle` inline.

File → **Page setup…** shows the page in a dialog whose controls are all disabled. A doc carries no page of its own: page size and margins per document is a [ROADMAP](ROADMAP.md) row.

## The page keeps its width and slides, then scales, clear of a panel

The page is centered in a scroll box. Its width never changes, so a line breaks in the same place on every screen, and the drive preview and the HTML export lay the doc out at the same width ([EXPORT.md](EXPORT.md#every-format-but-xlsx-and-svg-is-one-html-document)).

A panel is an absolute overlay on the right of the scroll box, so opening one never reflows the page. Only the text column has to stay clear of it: the page's right margin may tuck under. Below `PANEL_CLEAR_WIDTH_PX` the page slides left by its overlap with the panel, and scales down only once the space left of the page runs out. A screen narrower than the page scales it too. The scale is a CSS transform with a negative bottom margin that gives back the space the transform frees.

Laying the panel out as a flex sibling, the way sheets and slides do, would end the scroll box at the panel's edge. But the page would then re-center in the narrower box and jump on every open and close, which the slide-then-scale math exists to prevent.

## A side panel ends left of the page's scrollbar

The overlay sits in a wrapper with a stable scrollbar gutter (`scrollbar-gutter: stable`) and `overflow: hidden`. That gutter is as wide as the scroll box's scrollbar but draws none, and an absolute child ends where the gutter starts. So the panel stops left of the page's scrollbar, which stays visible and draggable, and its left edge lands where the slide math (`PANEL_INTRUSION_PX`) assumes it is. The wrapper ignores the pointer and the panel takes it back, so clicks around the panel reach the page. An overlay scrollbar has no gutter, so the panel still covers one.

## The properties panels follow the selection, on desktop only

Selecting a figure or a table opens its properties panel, for a user who can write, in the slot the comments and activity panels use. An open comments or activity panel keeps the slot, and moving the caret out of the figure or table closes the properties panel. A phone shows no right-side panels: comments and activity open as a pane that hides the editor ([COMMENTS.md](COMMENTS.md#the-pane-hides-the-editor-never-unmounts-it)), and the properties panels have no phone form.

## A comment anchors on text as a mark and on a figure as an attribute

A comment's card id rides the `comment` mark on text and the `commentCardId` attribute on a figure, because the Yjs binding keeps a mark only on text. `nodeCommentCardId` reads either form. The decorations, the image's own menu and its corner mark are in [COMMENTS.md](COMMENTS.md#each-app-anchors-a-card-in-its-own-content).

## A docs copy writes image items, and a paste places them one by one

A copy whose selection holds a figure writes the eigen clipboard payload: one image item per figure whose file resolves, beside ProseMirror's own HTML and the plain text. A selection with no resolvable figure writes no payload and leaves the copy to ProseMirror. The payload is what lets another app (slides, sheets, a drawing) place the image ([CLIPBOARD.md](CLIPBOARD.md)).

On paste, a payload with an image item is placed item by item: a figure from another document's `media/` is re-uploaded into this one first and is skipped if that fails. A docs copy of text plus an image therefore pastes the image alone ([ROADMAP](ROADMAP.md)).

## Pasted content is fitted to the page

Content wider than the text column would overflow the page and the export. So `transformPastedHTML` caps every pasted image and table at the text column's width, and maps common desktop fonts onto the bundled families ([TYPOGRAPHY.md](TYPOGRAPHY.md#foreign-fonts-map-onto-the-bundled-ones)). A table resized or pasted past the column is scaled back after every change by `TableWidthClamp` (`apps/docs/src/components/docs/extensions/table-width-clamp.ts`), which shrinks every column by the same factor with a 25 px floor.

## A font is stored as its name

The `textStyle` mark stores a font's name, and renders it as a CSS stack. A doc that still holds a stack is collapsed to names by `normalizeFontFamilyMarks` when an editor with write access opens it, outside the undo history. The reasons are in [TYPOGRAPHY.md](TYPOGRAPHY.md#docs-and-the-canvas-store-a-font-name-never-a-css-stack).

## See also

- [COLLAB.md](COLLAB.md): the collab document, the socket and the `loaded` gate the editor waits on
- [DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md): how the server reads and writes a doc
- [MEDIA-REFERENCES.md](MEDIA-REFERENCES.md): media names and pending uploads
- [COMMENTS.md](COMMENTS.md): comment cards, threads and anchors
- [CLIPBOARD.md](CLIPBOARD.md): the eigen clipboard payload and each app's paste ladder
- [EXPORT.md](EXPORT.md) and [PREVIEWS.md](PREVIEWS.md): export, docx import and the drive preview
- [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md): the find bar
- [TYPOGRAPHY.md](TYPOGRAPHY.md): fonts
