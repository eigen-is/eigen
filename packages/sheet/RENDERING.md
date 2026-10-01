# Sheet Rendering Architecture

> **TLDR:** The sheet grid is one HTML5 canvas under a stack of React DOM overlays. The canvas paints cells, gridlines, borders and the cell glyphs, and redraws at most once per animation frame. Everything a user clicks or types into (the headers, the selection, the cell editor, images, cards) is React DOM over the canvas, in pane regions that scroll and clip in step with it. The browser does the scrolling natively, and the workbook surface stays light in dark mode. What the grid's data means, and why its glyphs behave as they do, is in [SHEETS.md](../../docs/SHEETS.md).

These are the rendering notes of `packages/sheet`, Eigen's fork of fortune-sheet. Read them before you change how cells paint, where an overlay lines up with the canvas, or how the grid scrolls. The sections start with the component tree and the technology each layer uses, then walk the layers from the canvas up, and end with scrolling, the z-index stack and the patterns that keep a redraw cheap.

The fork's class and id prefix is `sheet-`. One engine-private class keeps a bare name, `header-arrow` (`ColumnHeader`), and so do the engine's bare ids: `link-text`/`-type`/`-address`/`-cell`/`-sheet`, `searchFormulaListInput`, `checkTextColor`, `checkCellColor`, and the screen-reader nodes `sr-selection`, `sr-sheetFocus`, `shortcut-list`, `shortcuts-heading`. So grepping `sheet-` does not list the whole DOM contract. `sheet-copy-action-table` is a different kind of exception: a clipboard wire format rather than a style hook, and it lives in one constant (`COPY_ACTION_TABLE_MARKER`).

## Component Tree

```
<Workbook>                                      Workbook/index.tsx
  <WorkbookContext.Provider>
    <ModalProvider>                              context/modal.tsx
      <MenuBar>                                 MenuBar/index.tsx          (React + shadcn)
      <FxEditor>                                FxEditor/index.tsx         (React + ContentEditable)
      <Sheet>                                   Sheet/index.tsx
        <canvas>                                                           (HTML5 Canvas: cells, grid, borders)
        <SheetOverlay>                          SheetOverlay/index.tsx     (React DOM overlays)
          <ColumnHeader>                        SheetOverlay/ColumnHeader.tsx
          <RowHeader>                           SheetOverlay/RowHeader.tsx
          selection divs                                                    (blue rectangles)
          resize handles
          freeze lines
          formula range highlights
          <InputBox>                            SheetOverlay/InputBox.tsx   (ContentEditable over canvas)
          <ImgBoxs>                             ImgBoxs/index.tsx
          <LinkEditCard>                        LinkEditCard/index.tsx
          <DropDownList>                        DataVerification/DropdownList.tsx
          cell right-click menu anchor          ContextMenu/useSheetContextMenu.tsx (shared ContextMenuAnchor; column/row anchors live in the headers)
      <SheetTab>                                SheetTab/index.tsx         (React)
        <SheetItem> per sheet                   SheetTab/SheetItem.tsx     (shadcn ContextMenu + DropdownMenu)
      <FilterMenu>                              ContextMenu/FilterMenu.tsx
```

## Rendering Technologies

### Canvas (cell content)

**Files**: `Sheet/index.tsx`, `state/canvas.ts`

The grid itself (cells, text, gridlines, borders, fill colors) is drawn on an HTML5 Canvas 2D context, because thousands of cells as DOM nodes would be far too slow.

- `Sheet/index.tsx` creates a `<canvas>` element sized to the container. On a context change or a scroll it asks for a redraw through `requestAnimationFrame`, so several changes in one frame paint once.
- `state/canvas.ts` holds the `Canvas` facade class (`drawMain()`, `drawRowHeader()`, `drawColumnHeader()`, `drawFreezeLine()`). Per-cell painting lives in `state/render/`: `cellRender` in `cells.ts`, driven by the `collectVisibleCells → renderCells → renderMergedCells` phases.
- Gridlines are stroked paths in the default stroke color (`state/render/types.ts`).
- Cell text is `ctx.fillText()` with font metrics from `getMeasureText()`.
- Cell backgrounds are `ctx.fillRect()` with the cell's fill color.
- Borders use `ctx.setLineDash()` over the 13 border styles of `BORDER_STYLES` (`packages/lib/src/sheets/borders.ts`).
- With frozen rows or columns, `Sheet/index.tsx` draws each pane separately (`drawFrozenBoth()`, `drawFrozenHorizontal()`, `drawFrozenVertical()`), each with its own scroll offset.

### React DOM Overlays (interactive elements on top of canvas)

Everything interactive (selection, editing, resize handles, images) is a React DOM element positioned absolutely over the canvas.

### ContentEditable (cell/formula editing)

`InputBox.tsx` and `FxEditor/index.tsx` use the `ContentEditable` component (`SheetOverlay/ContentEditable.tsx`), a native `contentEditable` div for rich-text cell editing.

### Theming: the light-pinned surface

The workbook surface renders the same in light and dark mode. Like the docs page, the paper does not re-theme; only the app chrome around it does (MenuBar, SheetTab, portaled popups). The Sheet root (`Sheet/index.tsx`, wrapping canvas, headers and overlays) and the formula bar (`FxEditor`) carry the `.eigen-paper` scope class from `packages/ui/src/styles/globals.css`. It re-pins the theme tokens the surface reads to their light values and re-resolves inherited `color` inside the scope. Canvas colors are hardcoded light, and `--sheet-*` and `--app-current-color` do not change with the theme.

In-grid popup cards (LinkEditCard, the validation hint card) opt back into the theme with `.eigen-paper-chrome`. Radix-portaled popups leave the scope by themselves. The add-row control stays pinned, because it sits directly on the paper with no card behind it. Its shadcn `dark:` variants still match inside the scope and resolve against the pinned tokens, so it is legible and near-light rather than exactly light, which is acceptable outside the grid.

## Layer-by-Layer Breakdown

### 1. Canvas Layer (bottom)

The cell grid. It paints cell values and formatting (font, color, alignment), gridlines, styled cell borders, background fills, merged cells and the freeze separator lines (`drawFreezeLine()`).

It is not interactive. The overlay handles every mouse event.

### 2. Column & Row Headers (React DOM)

**Files**: `SheetOverlay/ColumnHeader.tsx`, `SheetOverlay/RowHeader.tsx`

The headers are React divs, not canvas. They render:

- the labels (A, B, C… and 1, 2, 3…);
- the hover highlight (semi-transparent, `z-index: 11`) and the selected column or row highlight (light blue, `z-index: 10`);
- the resize handle (`.sheet-cols-change-size` / `.sheet-rows-change-size`);
- the freeze drag handle at the freeze boundary;
- in the column header only, the hover dropdown arrow (lucide `ChevronDown` in a `.header-arrow` span), which opens the column context menu. The autofilter buttons are canvas paint instead ([§ 6](#6-filter-buttons-canvas)).

Headers are not scroll containers. They use the body overlays' pane region model ([§ Scrolling](#scrolling)) one axis at a time: each header holds `OverlayRegion` viewports derived by `computeColumnHeaderRegions` / `computeRowHeaderRegions` (`freeze.ts`). With a freeze there is a band pinned to the freeze-time scroll and a main band that translates from the scroll bus. The main band's clip cuts the hover and selected highlights, and their bottom or right border, at the freeze boundary, in step with the canvas pane draw. Selected highlights render into every region, clipped per pane. The hover highlight and the resize handle render only into the region that holds the hovered column or row. The freeze drag handle alone stays on a plain wrapper translated from the bus (`translateX(-scrollLeft)` / `translateY(-scrollTop)`), with its `+scroll` pinning, because a freeze drag moves it imperatively in live content coordinates. The hit test reads the live offset from `globalCache`.

### 3. Cell Selection: The Blue Rectangle (React DOM)

**File**: `SheetOverlay/index.tsx` (the boxes in `SheetOverlay/OverlayVisuals.tsx`)

The selection box is a React div overlay, not canvas paint.

- **Focus cell**: `.sheet-cell-selected-focus`, `z-index: 14`, light blue background and blue border.
- **Selection range(s)**: `.sheet-cell-selected`, one div per range in `context.selections`, `z-index: 15`.
- **Copy indicator**: dashed blue border, `z-index: 18`.
- **Move indicator**: `.sheet-cell-selected-move`, `z-index: 16`.
- **Extend indicator**: `.sheet-cell-selected-extend`, `z-index: 16`.

Each selection div carries four invisible move bands on its edges and the fill handle at its bottom-right corner. Their sizes are named once in `SheetOverlay/index.css` (`--sheet-grab-band`, `--sheet-grab-band-out`, `--sheet-fill-grab`) and pinned by `src/test/components/SheetOverlay/selection-hit-targets.test.ts`. Why a painted glyph outranks them is in [SHEETS.md § A glyph outranks the selection handles](../../docs/SHEETS.md#a-glyph-outranks-the-selection-handles).

Positioned with `left_move` / `top_move` / `width_move` / `height_move` from the selection state.

### 4. Cell Editor: InputBox (ContentEditable)

**File**: `SheetOverlay/InputBox.tsx`

A double-click or a typed key on a cell shows InputBox:

- A ContentEditable div positioned at the cell.
- `z-index: 19` while editing. When not editing it is hidden with `opacity: 0` and `pointer-events: none`. It must stay focusable at the cell position, because keyboard input flows through it after every cell click.
- It renders the `FormulaSearch` dropdown (the list of candidates while typing) and the `FormulaHint` card (signature and argument help). Both wrap `SheetOverlay/FormulaPopup`, a Radix `Popover` anchored to a fixed-position copy of the input's rect, so it portals to the body on the popover's `z-50`, outside InputBox's `z-19` stacking context.
- The autocomplete keys and insertion (Enter and Tab commit, ArrowUp and ArrowDown move, Escape dismisses, a click inserts) live in `hooks/useFormulaAutocomplete`, shared with FxEditor. It builds on `@workspace/ui/hooks/use-suggestions`, the generic suggest hook chat uses too.

### 5. Formula Bar: FxEditor (React)

**File**: `FxEditor/index.tsx`

Always visible above the grid. It holds:

- `NameBox`, which shows the current cell address (such as "A1");
- a `ContentEditable` for formula and value editing, with the same `FormulaSearch` dropdown and `FormulaHint` card as InputBox.

It is standard React layout with Tailwind, not an overlay.

### 6. Filter Buttons (Canvas)

**File**: `state/render/filter-ui.ts` (`drawFilterUI`, called from `drawMain` in `state/canvas.ts`)

The autofilter range border and the per-column buttons are painted on the canvas in every `drawMain` pass, so freeze pinning and clipping match the cells underneath.

- The glyphs follow Google's (a lazy `Path2D`): a bare strainer when idle, a filled green funnel when the column has an active filter, and a green wash on hover.
- Geometry comes from `filterOptions.items` (`createFilterOptions` in `state/modules/filter.ts`) and the shared `FILTER_BUTTON_WIDTH`/`FILTER_BUTTON_HEIGHT`, the values the mousedown hit test reads too ([SHEETS.md § Painter and hit test read one rect](../../docs/SHEETS.md#painter-and-hit-test-read-one-rect)).

### 7. Images (React DOM + `<img>`)

**File**: `ImgBoxs/index.tsx`

- The active image sits at `z-index: 20` and wears the shared `ObjectTransform` ring (`packages/ui/src/components/transform/`) for resize and rotate.
- An inactive image sits at `z-index: 19`: an `<img>` in an `overflow-hidden` div.
- ID: `sheet-modal-dialog-activeImage` (queried by `state/modules/image.ts`).

### 8. Comments

Comments anchor to cells via `commentCardIds` on `Cell` and use the shared Eigen comment cards ([SHEETS.md § Comments are Eigen comment cards](../../docs/SHEETS.md#comments-are-eigen-comment-cards)).

### 9. Hyperlink Editor (React DOM)

**File**: `LinkEditCard/index.tsx`

Three modes:

1. **Read-only toolbar**: link text plus copy, edit and unlink buttons. The only absolutely positioned one, anchored near the active cell.
2. **Edit form**: text input, type select and address input, in a centered shared `Dialog` (`@workspace/ui/components/dialog`).
3. **Range picker**: `CellRangeDialog`, opened through `useDialog().showNonModalDialog` so the grid stays clickable while a range is picked.

Modes 2 and 3 are portaled shared dialogs, not positioned cards, so there is no class for the grid to query. The card's state lives in `ctx.linkCard` and is driven from `state/modules/hyperlink.ts`.

### 10. Data Verification Dropdown (Canvas glyph + React DOM menu)

**Files**: `state/render/cells.ts` (`renderDropdownChevron`), `DataVerification/DropdownList.tsx`

The chevron is canvas paint; where it is drawn and why is in [SHEETS.md § A list chevron is painted on every cell its rule covers](../../docs/SHEETS.md#a-list-chevron-is-painted-on-every-cell-its-rule-covers). The menu is a portaled shadcn `DropdownMenu` (checkbox items for a multi-select rule, plain items otherwise) on shadcn's default `z-index: 50`, not a bespoke high z-index. Its trigger div is a pure anchor: invisible, `pointer-events: none`, positioned on the focus cell by `cellFocus`. The canvas hit test in `state/events/mouse-cell.ts` opens the menu.

### 11. Context Menus (React + shadcn)

**Files**: `ContextMenu/useSheetContextMenu.tsx`, `ContextMenu/FilterMenu.tsx`, `SheetTab/SheetItem.tsx`

- Cell, row-header and column-header right-click menus: `useSheetContextMenu(area)` builds each menu from shadcn `DropdownMenu` items on the shared `@workspace/ui` singleton context menu (`useContextMenu` and `ContextMenuAnchor`, anchored at the cursor). The cell anchor renders in `SheetOverlay`, the row and column anchors in their headers.
- The filter menu (`FilterMenu.tsx`) is the one bespoke panel left: select and deselect checkboxes and a color filter submenu, mounted by `Workbook`.
- The sheet tab menu (`SheetItem.tsx`) offers rename, delete, hide, show and color. The same items render through a shadcn `ContextMenu` (tab right-click) and a `DropdownMenu` (the chevron on the active tab).
- The shadcn and Radix portals dismiss on an outside click, so there is no separate backdrop div.

### 12. MenuBar (React + shadcn)

**Files**: `MenuBar/index.tsx`, `MenuBar/edit-menu.tsx`, `MenuBar/view-menu.tsx`, `MenuBar/insert-menu.tsx`, `MenuBar/format-menu.tsx`, `MenuBar/data-menu.tsx`, `MenuBar/CustomBorder.tsx`

Plain React UI with no overlays: a menu bar in Google Sheets' style (Edit, View, Insert, Format, Data), with a shadcn `DropdownMenu` per top-level menu, a shadcn `Popover` for `CustomBorder` (the border style picker) and Tailwind styling.

Any `DropdownMenuSubContent` rendered inside `cellArea` needs the `sheet-mousedown-cancel` class. Radix portals the submenu out of the DOM, but React's synthetic events still bubble across the portal. Without the class, `cellArea`'s mousedown guard misses the menu items and the selection jumps to the cell under the popup.

### 13. Sheet Tabs (React)

**Files**: `SheetTab/index.tsx`, `SheetTab/SheetItem.tsx`

The bottom bar: sheet tabs with drag-and-drop reordering, scroll buttons (ChevronsLeft and ChevronsRight) when the tabs overflow, the add-sheet button and the all-sheets list button.

## Scrolling

**File**: `SheetOverlay/index.tsx`, the `.sheet-cell-area` element

Scrolling is the browser's own. `cellArea` (`overflow: auto`, holding a full-size `ch_width × rh_height` spacer) is the single scroll surface, so the browser handles the wheel, trackpad momentum, the keyboard (PageUp, PageDown, arrows, Home, End), touch and the scrollbar. There is no custom wheel or touch handler.

- `cellArea`'s `onScroll` writes `globalCache.scrollLeft` / `globalCache.scrollTop` and calls `globalCache.notifyScrollListeners()`. Scroll state lives in `globalCache`, not in React context, so a scroll tick re-renders nothing.
- The bus has three kinds of subscriber: the canvas redraw (`Sheet`, coalesced per animation frame), the headers' freeze-handle `transform` wrappers (`ColumnHeader` / `RowHeader`), and one `transform` per pane region (`OverlayRegion`, body and header regions alike).
- A programmatic scroll (back to top, restoring a sheet's position on a switch, following the selection, a freeze reset) writes `cellArea.scrollLeft/scrollTop`, and the native `scroll` event then syncs the bus.
- `overscroll-behavior: none` turns off the macOS rubber-band bounce, which the canvas, redrawn per animation frame, can't follow. It also stops the scroll from chaining to the page.
- The mouse hit test reads `ctx.scrollLeft/scrollTop`, which `setContextWithProduce` syncs from `globalCache` at the top of every recipe.

**The body overlay layer.** The body overlays (selection box, cell editor, presence, fill handle, formula range visuals, search highlights, images, link and validation cards) do not scroll natively. They live in a `position: sticky` layer (`.sheet-cell-overlay-layer`), the first child of `cellArea`: a 0×0 anchor pinned to the scrollport origin at compositor speed. It holds up to four pane region viewports (`OverlayRegion`) that mirror how the canvas draws frozen panes: main, frozen-rows band, frozen-columns band and corner. Each region is a `position: absolute` div at a fixed viewport rect with `overflow: hidden`. The rects come from the freeze config (`computeOverlayRegions` in `state/modules/freeze.ts`) and change only when the freeze config or the row and column sizes change. Inside each region a content div restores the content-coordinate origin and translates from the scroll bus on its free axes only: main `(-sx, -sy)`, rows band `(-sx, ·)`, columns band `(·, -sy)`, the corner pinned. It is the header mechanism applied per pane, locked to the canvas redraw, so nothing drifts and a scroll does no React work.

- **Passive rectangles** (selection boxes, the focus box, formula range selections and highlights, search highlights, presence, the copy, move and extend indicators, all in `OverlayVisuals`) render into every region in pure content coordinates. Each region's clip shows exactly its part, so they clip under frozen panes in step with the canvas. The headers apply the same model one axis at a time ([§ 2](#2-column--row-headers-react-dom)). Previews positioned imperatively (move and extend, the formula range selection) are written to every copy through `querySelectorAll`. The header resize handles get the same treatment, region-aware, in `renderColResize` / `renderRowResize`, which use frozen-band coordinates when the resized column or row is frozen.
- **Stateful singletons** are never duplicated. The cell editor (InputBox) and the validation dropdown trigger render only into the region that holds their anchor cell, clipped. So editing a frozen cell keeps the editor pinned under the pane, and an editor whose cell scrolls under a band clips at the boundary, as in Excel. Popup chrome (the validation hint card, LinkEditCard) pins with its anchor's pane but never clips. The resize and freeze drag lines span panes and live in an unclipped wrapper on the main transform. With no freeze there is exactly one unclipped main region.
- The `sheet-cell-flow` spacer (which sets the scroll range and holds the add-row control at the bottom, pinned via `left: scrollLeft`) and the cell context-menu anchor stay direct children of `cellArea`.

**Hit testing.** The layer carries `z-index: 1`, so its content sits above the full-size cell-flow spacer that follows it. Each region's translated content div is its own stacking context, so the children's z-indexes (8 to 30) order them only among themselves. The region divs are `pointer-events: none`. Interactive overlay elements turn it back on with `pointer-events: auto` (selection handles, images, the open editor, drag lines, the validation trigger and hint, the link card), and everything else falls through to `cellArea`. The InputBox that is not editing sits at `z-index: -1` and is hidden with `opacity: 0` and `pointer-events: none`, so the cell input stays focusable at the cell position without painting over the grid or swallowing clicks on the focus cell.

## Z-Index Stack

| Z-Index | Element | Component |
|---------|---------|-----------|
| (canvas) | Cell grid | Sheet |
| 8 | Copy selection handle border | SheetOverlay |
| 10 | Selected column/row highlight | ColumnHeader / RowHeader |
| 11 | Hover highlight | ColumnHeader / RowHeader |
| 14 | Focus cell (primary selection) | SheetOverlay |
| 15 | Selection range boxes | SheetOverlay |
| 16 | Move / extend indicators | SheetOverlay |
| 18 | Copy selection borders (dashed) | SheetOverlay |
| 19 | Cell editor (InputBox) | SheetOverlay/InputBox |
| 19 | Images (inactive) | ImgBoxs |
| 20 | Active image (with resize handles) | ImgBoxs |
| 50 | Data verification dropdown (portaled shadcn) | DataVerification/DropdownList |

The SheetOverlay, InputBox and ImgBoxs values live inside `.sheet-cell-overlay-layer` (`z-index: 1`), in per-pane region viewports whose translated content divs are each a stacking context ([§ Scrolling](#scrolling)). So they order those elements only among themselves within a pane, and across panes the region clip rects do not overlap. The layer as a whole sits above the canvas and the cell-flow spacer. The header values (10 and 11 for the highlights, 12 for the resize handle, 20 for the freeze handle) are likewise scoped to each header region wrapper. Across wrappers, DOM order decides: the passive regions, then the hover region, then the freeze-handle wrapper on top.

## Key Performance Patterns

1. **Canvas for cells**: thousands of cells drawn on a canvas, not as DOM nodes.
2. **Frame coalescing**: several state changes in one frame produce one canvas repaint.
3. **Scroll in globalCache**: the scroll position lives outside React, so a scroll re-renders nothing.
4. **Header transform**: the column and row headers translate from the scroll bus, locked to the canvas redraw, instead of scrolling as containers of their own.
5. **Overlay architecture**: only interactive elements (selection, editing, images) are React DOM.
