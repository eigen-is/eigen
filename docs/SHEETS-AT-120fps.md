# Sheets at 120 fps

> **TLDR:** On a 120 Hz Mac the sheets scrollbar moves at 120 fps and the grid at about 60 to 80. The browser doesn't cap it: one canvas draw takes longer than the 8.3 ms a 120 Hz frame has. Three fixes, from cheap to robust: make the draw faster, repaint only the strip a scroll brings into view, and put an oversized canvas in the scroll plane so the compositor scrolls it. The first two are done and bring a scroll frame from 9 ms to 1 or 2, so the grid scrolls at 120 fps. An HTML renderer is not the way there.

## What we measured

Measured on 2026-11-01 in a real Chrome on Reinder's dev drive (`test.eigensheets`, the Production Planning tab, with frozen panes). The viewport was 1681 × 748 at DPR 2, scrolled 15 px per frame from a `requestAnimationFrame` loop.

- Idle, Chrome runs `requestAnimationFrame` every 8.3 ms, so at 120 Hz. Safari caps it at 60 by default, so there the canvas runs at 60 whatever we do.
- One draw (`drawSheet` in `components/Sheet/index.tsx`) took 8.8 ms at the median and 28 ms at worst. While scrolling, 44 % of frames missed, for about 82 fps.
- A draw made about 4,900 `stroke()` calls, 2,300 `fillRect`, 430 `fillText` and 610 save and restore pairs. The canvas calls were about a quarter of the draw time. The rest is our own JS in the passes.

Everything that moves with the grid moves at the main thread's rate. The canvas sits outside the scroller and redraws from the scroll bus (`globalCache.notifyScrollListeners`). The overlays and headers translate from the same bus. Only the scrollbar and the invisible spacer scroll on the compositor.

## Fix 1: a faster draw

Cheap, and it helps every path. Take the low-hanging fruit only: fewer canvas state changes and path flushes, and no work per cell that could be done once per draw. No caches that need invalidating. A draw under about 6 ms holds 120 Hz at this size. A bigger window, a zoom-out or a denser sheet can push it back over.

Done on branch `sheets-120fps`, in two steps. A CPU profile of a scroll led to both.

- **The text measure cache.** `getMeasureText` was a fifth of a scroll frame. It read `renderCtx.font` back on every call, and the browser rebuilds the font string on each read, about 1.8 µs. It also stored a rich-text run under another spelling of the font than it looked it up by, so those runs never hit the cache. And the key left out the text baseline, so a number first measured under another baseline sat a few pixels too high. That is why some numbers in a row did not line up, and why two identical runs could draw different pixels. Now the key is the value, the font and the baseline, and the plain-text callers pass the font they just set.
- **The grid lines as one path.** Each cell stroked its own right and bottom line, about 4,900 strokes a draw. They are now one `Path2D` per pass, stroked once. The grid color is 10 % black, so a corner stroked twice showed as a darker dot at every crossing; the grid is now even.

Draw time per frame, median, headless Chrome at 1700 × 950 and DPR 2:

| Tab | Before | After |
|---|---|---|
| Incurred | 14 ms | 7.4 ms |
| Production Planning | 8.7 ms | 6.7 ms |
| Budget & Hours | 6.5 ms | 4.6 ms |

In Reinder's own Chrome at 120 Hz, Production Planning now scrolls at 111 fps with 7 % of frames missed, against 82 fps and 44 % before. Incurred scrolls at 97 fps. The draw now sits right at the 8.3 ms budget, so fix 2 is what makes 120 fps hold.

The pixel gate compares decoded pixels, not PNG bytes, since Chrome's PNG encoder is not deterministic. Every changed pixel is either a lighter grid corner or text that moved to its row's baseline.

What the profile shows next, none of it a clean quick win: laying out each cell's text (`getCellTextInfo`, 5 %), the border lookup over the visible rect (`forEachInRect`, 4 %), and a save, clip and restore around each cell's text (about 6 %).

## Fix 2: repaint only what a scroll brings into view

A redraw from a scroll copies the canvas onto itself at the scroll delta (`drawImage`) and paints only the strip that came into view. The cost then follows the distance scrolled, not the viewport. `drawMain` already paints a sub-rect per pane (`drawWidth`, `drawHeight`, `offsetLeft`, `offsetTop`) and draws spill from a source outside the area it paints, so a strip fits the painter.

It needs to know that a redraw comes from a scroll alone and that nothing else changed since the last frame. A context change, a resize or a delta that is not a whole device pixel paints in full. Each frozen pane shifts on its own free axes, or a frozen sheet just paints in full at first.

Done on branch `sheets-120fps`, frozen panes included (`state/render/frame.ts`, [RENDERING.md](../packages/sheet/RENDERING.md)). The frame is a list of layers in paint order: the panes of cells, the headers, then the freeze lines. Each pane of cells is now clipped to its own rect, so the panes paint apart and each one can move on its own axes. A frozen pane's spilled text or merge now stops at the freeze line, as it does in Excel and Google Sheets.

Two things the work turned up:

- **`forEachInRect` counted the border map on every call.** It chose between walking the rect and walking the map by counting the map with `for...in`, which collects every key of a large map before the first step. One full draw called it a few times; a scroll frame of strips calls it a dozen, and it took two thirds of the frame. A rect up to 100,000 cells is now walked cell by cell, so the canvas always walks it, in one order.
- **A clip changes antialiasing.** Skia antialiases a glyph or a rounded stroke that a clip cuts a shade differently at the cut than when it draws it whole. So a repaint under a clip is not byte-identical to a whole frame: an edge pixel of a letter, a list chevron or a filter funnel can come out off by up to about 90 of 255, a few pixels at most, until the next whole frame, which any edit or resize draws. Painting the repaint on a scratch canvas and copying it over was tried and was worse: the copy back shifted large areas by one or two shades.

The pixel gate: a whole frame, one scroll step, then a whole frame at the same place, compared pixel by pixel, from four start positions and six steps on five tabs. Every step matches within 32 of 255; the 1 to 6 pixels per run beyond that in longer runs are the clip cuts above.

Draw time per scroll frame, median, in Reinder's Chrome at 120 Hz:

| Tab | Fix 1 | Fix 2 | Frame rate |
|---|---|---|---|
| Production Planning, 15 px down a frame | 7.5 ms | 1.0 ms | 119 fps, 1 % missed |
| Production Planning, diagonal | | 2.2 ms | 120 fps |
| Incurred, 15 px down a frame | 8.5 ms | 1.1 ms | 119 fps |
| Incurred, diagonal | | 1.9 ms | 120 fps |

With the draw at 1 to 2 ms, fix 3 is no longer needed for 120 fps on these sheets. It would still help a scrollbar drag, which jumps further than half the canvas a frame and draws whole frames.

## Fix 3: an oversized canvas in the scroll plane

The robust fix. The canvas becomes a child of `.sheet-cell-area`, placed with `position: absolute` at content coordinates, and larger than the viewport by a margin on each side. The compositor then scrolls the bitmap at 120 Hz without the main thread. The main thread redraws and moves the canvas in one frame, only when the view nears the canvas edge or the content changes. A draw can take 11 ms, or 30, and the scroll stays smooth, as long as the margin covers what the user scrolls in that time.

- **Margin.** A fast trackpad flick moves 25 to 50 px a frame, so about 256 px a side covers two or three late frames. At the measured viewport that is 2.2 times the area: 4,386 × 2,520 device pixels, about 44 MB, within Safari's limit of 16.7 M pixels per canvas. A scrollbar drag outruns any margin and shows a blank edge for a frame or two, as a browser's own tiles do. Fix 2 keeps the redraw that moves the canvas cheap.
- **Frozen panes and headers** become `position: sticky` canvases inside the scroller. The frozen-rows band is sticky on top and scrolls on x natively. The frozen-columns band is sticky on the left and scrolls on y. The corner is sticky on both. The column and row headers work the same way. Each band is oversized on its free axis only.
- **The overlays must move too, or it gets worse.** If only the canvas moves on the compositor, the selection, the editor, images and presence still move at the main thread's rate and drift off their cells during a scroll. So the `OverlayRegion` model moves into the scroll plane with the canvas. The main region's content becomes plain absolute children of the scroller, without the translate. The band and corner regions go inside their sticky bands. The bands are opaque and stack above the main region, so stacking order replaces today's region clip. The scroll bus stays for hit tests and the add-row control.

It touches `Sheet/index.tsx`, `SheetOverlay/index.tsx`, `OverlayRegion`, the headers and `computeOverlayRegions`, and needs a pixel gate on frozen panes. Size M to L.

## Why not an HTML renderer

An HTML grid with virtual scrolling and frozen panes is doable, and the panes would even be the easy part: the four `OverlayRegion` viewports could hold the cells. But it is a rewrite of every paint path. Seven of the 13 border styles have no CSS form, spill and borders over merges must match to the pixel, and row heights are measured through canvas `measureText`, so the browser's own line breaks would disagree with ours. A normal scroll would be smooth. A scrollbar drag or a jump replaces 1,000 to 6,000 cells per frame, which drops frames at 4K and shows blank strips. The gains, accessibility, DOM assertions in tests and one cell look shared with the export, are each cheaper to get beside the canvas: a hidden `role="grid"` mirror of the visible cells, a test hook on `collectVisibleCells`, and pure cell-style code shared by the painter and the export.
