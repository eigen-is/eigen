# Proposal: Images in front of and behind text in Docs

This proposal lets a docs image sit in front of the text or behind it, at a position the user drags it to, the way Google Docs' "In front of text" and "Behind text" and Word's floating pictures work.

**Status:** built, but for the stacking order. The `front` and `behind` layouts, for images and charts, their docx export and their docx import are built, and [DOCS.md § A figure in front of or behind the text sits at an offset from its paragraph](../DOCS.md#a-figure-in-front-of-or-behind-the-text-sits-at-an-offset-from-its-paragraph) and [EXPORT.md § A figure in front of or behind the text is a wrapNone anchor](../EXPORT.md#a-figure-in-front-of-or-behind-the-text-is-a-wrapnone-anchor-at-the-start-of-its-paragraph) describe them. The owner deferred the stacking order (Bring to front, Send to back, `relativeHeight`) and keyboard nudging, and [ROADMAP.md](../ROADMAP.md) keeps a row for each. The build differs from this page where the docs say so: positioned figures lead their paragraph and the caret skips them, a figure in a table cell, a note or a band draws in line, and the docx writes the vertical offset from the paragraph's first line. The docs describe the code; this page keeps the design's reasons.

> **TLDR**: A docs figure already has three layouts: on its own line, wrapped left and wrapped right. This proposal adds two more, `front` and `behind`. A positioned figure stays what it is today, an inline atom inside a paragraph, and gains an offset from that paragraph's top-left corner plus a stacking order. So it moves with its paragraph, the way Word's "Move with text" does: text above it pushes it down, a peer who deletes the paragraph deletes it, and dragging it onto another paragraph re-anchors it there in one undo step. The editor draws it with `position: absolute` inside its paragraph and a z-index above or below the text. The drive preview and the HTML and PDF export use the same CSS, and WeasyPrint draws both layers correctly. docx export writes a `wp:anchor` with `wrapNone`, and the docx reader, which keeps an anchor's wrap left or right and drops the rest, reads its offset and layer too. There is no "fixed position on the page", because the editor has no pages. Nothing here needs a new API route or a database migration: the new attributes live on the figure node in the Yjs fragment. About 10 to 13 working days.

## Goals

1. An image can be placed in front of the text or behind it, anywhere on the paper, by dragging.
2. It moves with its paragraph. Editing text above it keeps it next to the text it belongs to.
3. Overlapping images are ordered with the canvas engine's Arrange actions: Bring to front, Bring forward, Send backward, Send to back.
4. The editor, the drive preview, the HTML and PDF export, and the docx export draw the same picture. A docx made in Word imports its floating images at roughly the place Word shows them.

## Non-goals

- Fixed position on the page (Google Docs' "Fix position on page", Word's page-relative anchors). The editor is one continuous sheet, so there is no page to fix to.
- Positioned images inside table cells. As far as we know, Google Docs allows only inline images in a table cell too. (Recommended; an `appendTransaction` resets one that lands in a cell, § Anchoring.)
- Text wrapping around a positioned image. Wrapping stays the job of the wrap layouts; CSS can't wrap text around an absolutely positioned box.
- Rotation. `ObjectTransform` can rotate, but a rotated image is a second feature with its own docx mapping.
- Page size and margins: a doc has its own ([DOCS.md § A doc stores its page in a page map beside its content](../DOCS.md#a-doc-stores-its-page-in-a-page-map-beside-its-content)). Offsets are relative to the paragraph, so changing a margin moves the images with the text. The clamp to the paper reads the document's setup at drag time.

## Current state

**The page is one sheet with no pages.** The editor draws the doc's page as one long sheet (`apps/docs/src/components/docs/editor.tsx`, [DOCS.md § The page keeps its width](../DOCS.md#the-page-keeps-its-width-and-slides-then-scales-clear-of-a-panel)). Below a width it scales with a CSS `transform` and a negative bottom margin measured from the page's `offsetHeight`. While scaled or shifted the page is a stacking context; unscaled it is not, so a `z-index: -1` child would paint under the white page and vanish.

**docx keeps the wrap, not a position.** The writer (`apps/api/src/lib/export/doc/docx/`) writes a wrapped figure as a floating one-cell table and every other figure inline ([EXPORT.md](../EXPORT.md#a-wrapped-figure-is-a-floating-one-cell-table)), so it writes no `wp:anchor`. Our own reader (`anchorLayout` in `apps/api/src/lib/import/doc/drawings.ts`) turns an anchor wrapped square, tight or through into wrapped left or right, on the side its alignment or offset puts it, and any other anchor into a block figure, aligned if Word aligns it. It keeps the width from `wp:extent` and the alt text, and drops `behindDoc`, the offsets and the stacking order.

## Design

### Model

`layout` gains `front` and `behind`, in `FIGURE_LAYOUTS` (`packages/lib/src/docs/eigendoc/nodes/figure-frame.ts`), which both parse paths validate against:

```ts
export const FIGURE_LAYOUTS = ['block', 'wrap-left', 'wrap-right', 'front', 'behind'] as const;
export type FigureLayout = (typeof FIGURE_LAYOUTS)[number];
```

A positioned figure (`front` or `behind`) uses three new attributes, all `null` on every other figure:

| Attribute | Meaning |
|---|---|
| `offsetX` | Page layout px from the left edge of the anchor paragraph's box. May be negative, into the left margin. |
| `offsetY` | Page layout px from the top edge of the anchor paragraph's box. |
| `index` | Its stacking order within its layer: a fractional-index key, as a canvas element's `index` (`packages/lib/src/vector/fractional-index.ts`). |

The units are the ones `width` already uses: layout pixels measured with `clientWidth`, which a CSS `scale()` does not change ([DOCS.md § A figure stores a media name and a width in page pixels](../DOCS.md#a-figure-stores-a-media-name-and-a-width-in-page-pixels)). So a doc positioned on a scaled-down page stores the same offsets as on a wide one.

`front` and `behind` are two layers. A `front` image is always over the text and a `behind` image always under it. Within a layer the order is the canvas engine's, reused rather than rebuilt: fractional-index keys, sorted, and the four Arrange ops rewrite them through lib's `zOrderKeys` (`packages/lib/src/vector/fractional-index.ts`), typed on `{ id, index }`. Docs applies the result as one ProseMirror transaction that sets `index` on the matched figures, so it is one y-undo step.

A ProseMirror document has a total order, so a figure needs no id. Docs passes `zOrderKeys` each figure's document position as its `id`, and two equal keys (concurrent ops by two peers) tie-break on document position. A pasted copy of a positioned figure keeps its key and lands beside its original in the order, which is what a duplicate on the canvas does too.

A CSS `z-index` is an integer, so the renderers turn the order into ranks. The export renderer and the preview rank each layer's figures in one pass over the JSON before rendering. The editor keeps the ranks in a small ProseMirror plugin that recomputes them when a transaction touches a positioned figure, and hands each node view its rank as a decoration. A `front` image draws at `z-index: 1 + rank`, a `behind` image at `rank - count`, so every `behind` image is negative and the topmost sits at −1.

`alignment` and `caption` are ignored for a positioned figure: no renderer draws its caption, and the panel hides the caption field. The stored caption stays, so switching back to block or wrap brings it back. `width` keeps its meaning, capped at the paper width instead of the text column.

Docs carry no backward-compatibility promise yet, and a layout shift in an existing doc doesn't matter, so the model is free to change. A stored doc without the new attributes reads as `block`. No migration.

### Anchoring

The figure stays an inline atom inside its anchor paragraph. Its place in the text no longer decides where it is drawn, the offsets do. When an image becomes positioned, or is dropped after a drag, the atom moves to the start of its paragraph. Enter at the end of the paragraph then leaves the image where it is, and Enter at the start carries it down with the paragraph, which is what Word does.

| Event | Result |
|---|---|
| Text is added or removed above the paragraph | The image moves with its paragraph. |
| Text reflows inside the paragraph | The image stays put. |
| A peer deletes the paragraph | The image goes with it, as in Word. |
| A peer moves the paragraph | The image follows. |
| The user drags the image over another paragraph | On drop it re-anchors to the paragraph under its top edge. |

Re-anchoring is one transaction: delete the atom, insert it at the start of the new paragraph with offsets recomputed against that paragraph. So it is one y-undo step, and `commentCardId` rides along. A drop first re-reads `getPos()` and drops the commit if a peer deleted the node during the drag.

Any paragraph or heading can anchor. A table cell can't: an `appendTransaction` plugin resets a positioned figure that lands in a cell (by paste or drag) to `block`, so the renderers never meet the case.

### Editor

One function in `packages/lib/src/docs/eigendoc/`, `figureLayoutStyle(attrs)`, maps a positioned figure's attributes to its absolute box with its offsets and z-index. The node view and `renderFigureNode` both call it.

- The containing block is the paragraph. `.eigen-prose p` and the headings get `position: relative`; table cells already have it. Because the export inlines `eigen-prose.css`, the same rule serves the editor, the preview and the export. The export flattens the nested CSS before inlining it (`flattenEigenProseCSS` in `apps/api/src/lib/document/prose-css.ts`), so the new rule has to survive that flattening; a test pins it.
- The ProseMirror root gets `isolation: isolate`, so a `behind` image paints under the text and above the white page in every scale branch.
- The node view's wrapper stays in the flow as a zero-size `inline-block` with `position: relative`, and the absolute box sits inside it at `offsetX`, `offsetY` relative to the paragraph. ProseMirror's `coordsAtPos` reads the wrapper's rect, so the caret stays in the line instead of jumping to the image. The box draws with the z-index of its layer (§ Model). It drops `draggable` and `data-drag-handle`, and a `stopEvent` keeps ProseMirror's native drag from moving the anchor.
- Moving is host-side, with the pattern the figure's resize already uses (`useFigureResize` in `apps/docs/src/components/docs/extensions/figure-frame.tsx`): a pointer drag on the selected image updates a preview offset and commits once on pointer-up. The pointer delta is divided by the page scale.
- The offsets are clamped on commit so the image stays on the paper, margins included.
- The page grows to hold the lowest positioned image. An absolute box does not grow its parent, so after a document change the editor reads the page's `scrollHeight`, which includes the overflow, and sets it as the page's `min-height`. The existing `ResizeObserver` can't do it alone: moving an absolute child doesn't resize the page. Without this an image past the last paragraph would hang off the page, and the scaled branch's negative margin would cut it.
- Arrow keys nudge a positioned image (10 px, Shift for 1 px), and resizing moves to Alt and the arrows. Wrap and block figures keep arrow-key resizing.
- `touch-action: none` goes on the selected image only, so a finger scrolling over an unselected image still scrolls.

**Selecting an image behind text.** A paragraph's box covers a `behind` image, so a click would land in the text. A mousedown plugin checks `document.elementsFromPoint`: if a `behind` image is under the pointer and no line of text is (no line rect of the paragraph contains the point), it selects the image. Clicks on text still place the caret in the text. Alt-click selects the topmost `behind` image under the pointer even over text, for an image fully covered by text. This is how Word and, as far as we know, Google Docs behave: a click on text goes to the text, a click on a bare part of the image selects it.

A `front` image takes the clicks over the text it covers, as in Google Docs.

**Properties panel.** The Layout row gets two more toggles (in front of text, behind text) and, for a positioned figure, an Arrange row. The canvas apps' Arrange UI is already shared and is reused as is: `ZOrderButtons` for the panel (`packages/ui/src/components/properties-panel/z-order.tsx`), `ObjectContextMenu`'s `onArrange` for the image's context menu (`packages/ui/src/components/context-menu/object-context-menu.tsx`), and `useZOrderHotkeys` for ⌘[ and ⌘] (with ⇧ to back or front). Phones get no panel, so on a phone a positioned image shows and can be dragged, but its layout can't be changed. That matches the wrap layouts today.

### Renderers

- **Preview, HTML and PDF.** `renderFigureNode` writes the absolute box with the same offsets and z-index. A probe on WeasyPrint 68.1 drew `z-index: -1` under the text and `z-index: 1` over it, both relative to a `position: relative` paragraph. The export `.page` and the drive preview's host (`packages/ui/src/components/drive/file-preview.tsx`) get `isolation: isolate`, and the preview's host gets `overflow: hidden`.
- **PDF pages.** In the PDF the anchor paragraph can land near the bottom of a page. WeasyPrint does not carry an absolute box over to the next page; the probe showed it cut at the sheet edge. This is accepted for now and written down in the help center. Per-document page setup may make it worth more work later.
- **docx export.** Each positioned figure becomes a `wp:anchor` with `wrapNone`, `behindDoc="1"` for `behind`, `allowOverlap="1"`, `relativeHeight` from the rank (unsigned, as OOXML requires; `behindDoc` keeps the two layers apart), `positionH relativeFrom="column"` and `positionV relativeFrom="paragraph"`, with `posOffset` at 9525 EMU per pixel. Our paragraph-relative offsets map one to one. The docx writer (`apps/api/src/lib/export/doc/docx/`, [EXPORT.md](../EXPORT.md#a-docs-docx-is-written-from-its-json-with-the-editors-css-values)) emits the anchor directly.
- **docx import.** The docx reader reads each `wp:anchor` itself (`anchorLayout` in `apps/api/src/lib/import/doc/drawings.ts`). Today a square, tight or through wrap becomes wrapped left or right, and every other anchor a block figure at its anchor paragraph, aligned by its `positionH`. The mapping it grows into:

  | Word anchor | Eigen figure |
  |---|---|
  | `wrapNone` + `behindDoc="1"` | `behind` |
  | `wrapNone` | `front` |
  | `wrapSquare` / `wrapTight` / `wrapThrough`, left or right | `wrap-left` / `wrap-right` |
  | `wrapTopAndBottom` | `block` |
  | `positionH` relative to `column` | `offsetX` as is |
  | `positionH` relative to `page` or `margin` | `offsetX` converted with the section's `w:pgMar` |
  | `positionV` relative to `paragraph` or `line` | `offsetY` as is |
  | `positionV` relative to `page` or `margin` | `offsetY = 0` on the anchor paragraph |
  | `wp:extent` cx | `width`, for every image |

  A vertical offset relative to the page can't be converted without laying the document out. Word keeps the anchor paragraph near the image (dragging an image in Word moves its anchor), so `offsetY = 0` puts it close to where Word shows it, and it keeps its layer. An anchor in a header or a footer stays as it is: a band holds no floating picture (`readDrawing`).
- **Search** indexes text only and needs nothing. **Copy and paste** inside docs keeps the attributes through the serialized HTML. The cross-app eigen clipboard payload drops them, so a positioned image pasted into another app arrives as a plain image.

## Phasing and effort

| Phase | Work | Size | Days |
|---|---|---|---|
| 1 | Spike: check the caret beside the zero-size wrapper and the click-through test, before the rest of phase 1 | S | 1 |
| 1 | Schema, `FIGURE_LAYOUTS`, `figureLayoutStyle`, serialization of the new attributes | S | 0.5 |
| 1 | Node view: absolute box, move, re-anchor, clamp, page growth, hit-testing behind text, nudging, the table-cell rule | L | 4–6 |
| 1 | Panel toggles; the rank plugin; the shared Arrange buttons, menu items and hotkeys wired in | S | 1 |
| 1 | Preview and HTML/PDF export CSS and isolation | S | 1 |
| 2 | docx export anchors, in the docx writer | S | 0.5–1 |
| 3 | Anchors through the docx import rewrite and `descr` | S | 1 |
| all | Tests, DOCS.md, EXPORT.md, help center | | 1–1.5 |

Total about 10 to 13 days. Phase 1 is useful on its own; phases 2 and 3 add docx.

Tests pin the contract: schema round trips of every layout through `renderHTML` and `parseHTML` (including `<figure>` markup from other apps), the re-anchor transaction as one undo step, the table-cell reset, the docx anchor XML, and imports of a Word-made docx with a behind image, a page-relative image and an image in a footnote. The editor gestures (drag, click behind text, Alt-click, nudge at a scaled page) are verified in the browser.

## Risks

- **Selecting behind text.** The line-rect test decides between the caret and the image on every mousedown over a `behind` image. If it guesses wrong, text becomes hard to click. Verified in the browser on real documents before it ships.
- **The caret next to an invisible atom.** The atom takes no space in the line. The caret at the start of the anchor paragraph must still behave. Checked in the browser in phase 1.
- **Editor and PDF disagree.** The PDF's page breaks have no counterpart in the editor, so an image near a page end can be cut.

## Related

- The docx writer (`apps/api/src/lib/export/doc/docx/`) and reader (`apps/api/src/lib/import/doc/`), described in [EXPORT.md](../EXPORT.md): phases 2 and 3 here build on them.

## Decisions

1. Move with paragraph is the only mode. (Owner, 2026-10-06.)
2. Z-order reuses the canvas engine's: fractional-index keys, the four Arrange ops, ⌘[ and ⌘]. (Owner, 2026-10-06.)
3. An image may extend into the page margins, up to the paper edge. Word and Google Docs both allow this, and the common use of a behind image (a letterhead, a watermark, a background) needs it. (Recommended; the owner leaned towards inside the margins with no strong opinion.)
4. Selecting a behind image: click on a bare part of it, plus Alt-click over text. (Recommended.)
5. docx import of a page-relative vertical position keeps the layer and puts the image at the top of its anchor paragraph. (Recommended.)
6. A positioned image shows no caption. (Owner, 2026-10-06.)
