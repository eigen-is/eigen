# Sheet Rendering Architecture

The fork's `fortune-` / `luckysheet-` class and id prefixes became `sheet-` on 2026-08-28. Two engine-private classes predate that convention and keep bare names — `range-selection-modal` (`LinkEditCard`, a `querySelector` target) and `header-arrow` (`ColumnHeader`) — and so do the engine's bare ids: `link-text`/`-type`/`-address`/`-cell`/`-sheet`, `searchFormulaListInput`, `checkTextColor`, `checkCellColor`, and the screen-reader nodes `sr-selection`, `sr-sheetFocus`, `shortcut-list`, `shortcuts-heading`. Grepping `sheet-` therefore does not enumerate the whole DOM contract. `sheet-copy-action-table` is a different kind of exception: a clipboard wire format rather than a style hook, and it lives in one constant (`COPY_ACTION_TABLE_MARKER`).

## Component Tree

```
<Workbook>                                      Workbook/index.tsx
  <WorkbookContext.Provider>
    <ModalProvider>                              context/modal.tsx
      <MenuBar>                                 MenuBar/index.tsx          (React + shadcn)
      <FxEditor>                                FxEditor/index.tsx         (React + ContentEditable)
      <Sheet>                                   Sheet/index.tsx
        <canvas>                                                           (HTML5 Canvas — cells, grid, borders)
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

The actual spreadsheet grid — cells, text, gridlines, borders, fill colors — is drawn on an HTML5 Canvas
2D context. This is what makes rendering thousands of cells performant.

- `Sheet/index.tsx` creates a `<canvas>` element sized to the container
- On context changes or scroll, it calls `requestAnimationFrame` to coalesce redraws
- `state/canvas.ts` contains the `Canvas` facade class (`drawMain()`, `drawRowHeader()`,
  `drawColumnHeader()`, `drawFreezeLine()`); per-cell painting lives in `state/render/` (`cellRender`
  in `cells.ts`, driven by the `collectVisibleCells → renderCells → renderMergedCells` phases)
- **Gridlines**: stroked paths (`#dfdfdf`)
- **Cell text**: `ctx.fillText()` with font metrics from `getMeasureText()`
- **Cell backgrounds**: `ctx.fillRect()` with the cell's fill color
- **Borders**: `ctx.setLineDash()` with 13 border types (hair, dotted, dashed, thick, etc.)
- **Frozen panes**: When rows/columns are frozen, the canvas renders multiple separate panes via
  `drawFrozenBoth()`, `drawFrozenHorizontal()`, `drawFrozenVertical()`, each with different scroll offsets

### React DOM Overlays (interactive elements on top of canvas)

Everything interactive — selection, editing, resize handles, images, comments — is a React DOM div
positioned absolutely over the canvas.

### ContentEditable (cell/formula editing)

`InputBox.tsx` and `FxEditor/index.tsx` use the `ContentEditable` component
(`SheetOverlay/ContentEditable.tsx`) — a native `contentEditable` div for rich-text cell editing.

### Theming: the light-pinned surface

The workbook surface renders pixel-identically in light and dark mode — like the docs page,
the paper does not re-theme, only the app chrome around it (MenuBar, FxEditor, SheetTab,
portaled popups). The Sheet root (`Sheet/index.tsx`, wrapping canvas + headers + overlays)
carries the `.eigen-paper` scope class from `packages/ui/src/styles/globals.css`, which
re-pins the theme tokens the surface consumes to their light values and re-resolves
inherited `color` inside the scope; canvas colors are hardcoded light and
`--sheet-*`/`--app-current-color` are theme-invariant already. In-grid popup cards
(LinkEditCard, the validation hint box) opt back into the theme with `.eigen-paper-chrome`;
Radix-portaled popups escape the scope naturally. The add-row control stays pinned — it sits
directly on the paper with no card behind it (its shadcn `dark:` variants still match inside
the scope, resolving against the pinned tokens: legible and near-light, not bit-exact —
acceptable, it is outside the grid visuals).

## Layer-by-Layer Breakdown

### 1. Canvas Layer (bottom)

The cell grid. Renders:
- Cell values and formatting (font, color, alignment)
- Gridlines between cells
- Cell borders (styled: solid, dashed, dotted, etc.)
- Cell background fills
- Merge cells
- Freeze pane separator lines (`drawFreezeLine()`)

Not interactive — all mouse events are handled by the overlay.

### 2. Column & Row Headers (React DOM)

**Files**: `SheetOverlay/ColumnHeader.tsx`, `SheetOverlay/RowHeader.tsx`

React divs, NOT canvas. They render:
- Header labels (A, B, C... / 1, 2, 3...)
- Hover highlight (semi-transparent overlay, `z-index: 11`)
- Selected column/row highlight (light blue, `z-index: 10`)
- Resize cursor handle (`.sheet-cols-change-size` / `.sheet-rows-change-size`)
- Freeze drag handle at the freeze boundary
- Column-header hover dropdown arrow (ColumnHeader only, lucide `ChevronDown` in a `.header-arrow`
  span; opens the column context menu). The autofilter buttons are NOT here — they're canvas-painted
  (see § Filter Buttons)

Headers are NOT scroll containers. They share the body-overlay pane region model one axis
at a time (see § Scrolling): each header holds `OverlayRegion` viewports derived by
`computeColumnHeaderRegions` / `computeRowHeaderRegions` (freeze.ts) — with a freeze, a
band pinned to the freeze-time scroll plus a bus-translated main band whose clip cuts the
hover/selected highlights (and their bottom/right border) at the freeze boundary, in
lockstep with the canvas pane draw. Selected highlights render into every region (passive,
clipped per pane); the hover highlight and resize handle render into the single region
containing the hovered column/row. Only the freeze drag handle stays on a plain
bus-translated wrapper (`translateX(-scrollLeft)` / `translateY(-scrollTop)`), keeping its
viewport-pinning `+scroll` pattern because freeze drags reposition it imperatively in live
content coordinates. The hit-test reads the live offset from `globalCache`.

### 3. Cell Selection — The Blue Rectangle (React DOM)

**File**: `SheetOverlay/index.tsx`

The selection box is a React div overlay, not drawn on canvas.

- **Focus cell**: `.sheet-cell-selected-focus` — `z-index: 14`, light blue bg + blue border
- **Selection range(s)**: `.sheet-cell-selected` — one div per range in
  `context.selections`, `z-index: 15`, with 4 border divs + center handle
- **Copy indicator**: dashed blue border, `z-index: 18`
- **Move indicator**: `.sheet-cell-selected-move`, `z-index: 16`
- **Extend indicator**: `.sheet-cell-selected-extend`, `z-index: 16`

Each selection div has 8 resize handles (corners + midpoints) for drag-resizing the selection.

Positioned with `left_move` / `top_move` / `width_move` / `height_move` from the selection state.

### 4. Cell Editor — InputBox (ContentEditable)

**File**: `SheetOverlay/InputBox.tsx`

When you double-click or type into a cell, InputBox appears:
- A ContentEditable div positioned at the cell's location
- `z-index: 19` when editing; when not editing it is hidden via `opacity: 0` +
  `pointer-events: none` (it must stay focusable at the cell position — keyboard input
  flows through it after every cell click)
- Renders `FormulaSearch` dropdown (typed candidate list) and `FormulaHint` card
  (post-commit signature/argument help). Both wrap `SheetOverlay/FormulaPopup`,
  which uses Radix `Popover` with a virtual anchor at the input's bounding rect
  to portal out of InputBox's `z-19` stacking context — landing at `z-1010`
  above the overlay stack.
- The autocomplete keyboard + insertion path (Enter/Tab commit, ArrowUp/Down
  navigation, Escape dismiss, click-to-insert) lives in
  `hooks/useFormulaAutocomplete`, shared with FxEditor. It composes
  `@workspace/ui/hooks/use-suggestions` (the generic chat suggest hook).

### 5. Formula Bar — FxEditor (React)

**File**: `FxEditor/index.tsx`

Always visible above the grid. Contains:
- `NameBox` — shows current cell address (e.g., "A1")
- `ContentEditable` for formula/value editing, with the shared `FormulaSearch` dropdown +
  `FormulaHint` card (same autocomplete path as InputBox)
- Uses Tailwind styling, standard React layout (not overlay)

### 6. Filter Buttons (Canvas)

**File**: `state/render/filter-ui.ts` (`drawFilterUI`, called from `drawMain` in `state/canvas.ts`)

The autofilter range border and per-column buttons are painted on the canvas inside every `drawMain`
pass, so freeze-region pinning and clipping match the cells underneath (not React DOM):
- Google-style glyphs (lazy `Path2D`): a bare strainer when idle, a filled green funnel when the column
  has an active filter, with a green wash on hover
- Geometry comes from `filterOptions.items` (`createFilterOptions` in `state/modules/filter.ts`) plus the
  shared `FILTER_BUTTON_WIDTH`/`FILTER_BUTTON_HEIGHT` constants — the same values the mousedown hit-test
  reads, so the drawn button and its click target stay aligned. The tick box and the data-verification
  list chevron follow the same split (see § Data Verification Dropdown)

### 7. Images (React DOM + `<img>`)

**File**: `ImgBoxs/index.tsx`

- Active image: `z-index: 20`, an 8-point resize-handle frame with a `selection-handle` outline
- Inactive images: `z-index: 19`, an `<img>` in an `overflow-hidden` div
- ID: `sheet-modal-dialog-activeImage` (queried by `state/modules/image.ts`)

### 8. Comments

The upstream built-in comment system (NotationBoxes + `state/modules/comment.ts`) was fully
removed. Comments now anchor to cells via `commentCardIds?: string[]` on `Cell` and use
the shared Eigen comment infrastructure — see [`docs/SHEETS.md` § Comments](../../docs/SHEETS.md#comments)
and [`docs/COMMENTS.md`](../../docs/COMMENTS.md).

### 9. Hyperlink Editor (React DOM)

**File**: `LinkEditCard/index.tsx`

Three modes:
1. **Read-only toolbar**: shows link text + copy/edit/delete buttons, positioned near cell
2. **Edit form**: text input + type select + address input + OK/Cancel
3. **Range selection modal**: cell range input for internal links

Positioned absolutely near the active cell. Class: `.sheet-link-modify-modal` (queried by
`state/modules/hyperlink.ts`).

### 10. Data Verification Dropdown (Canvas glyph + React DOM menu)

**Files**: `state/render/cells.ts` (`renderDropdownChevron`), `DataVerification/DropdownList.tsx`

- The **chevron** is canvas paint, drawn unconditionally on every cell a `dropdown` rule covers —
  from `cellRender` and from `nullCellRender`, because most validated cells in a real workbook are
  empty. Like the other cell affordances (comment triangle, tick box, filter button) it is always on,
  which makes it freeze-correct for free and visible to keyboard users and read-only viewers
- Geometry is `dropdownChevronRect` in `state/modules/data-verification.ts` — the same function the
  mousedown hit-test reads, so glyph and click target cannot drift; narrower than
  `DROPDOWN_CHEVRON_MIN_WIDTH` and the glyph is dropped rather than filling the cell
- Colour is the cell's own `fc` at 55% alpha, not a flat grey — validated cells sit on dark fills
- The **menu** is a portaled shadcn `DropdownMenu` (checkbox items for multi-select validations, plain
  items otherwise) on shadcn's default `z-index: 50`, not a bespoke high z-index
- Its trigger div is a pure anchor: invisible, `pointer-events: none`, positioned on the focus cell by
  `cellFocus`. The canvas hit-test in `state/events/mouse-cell.ts` is what opens the menu

### 11. Context Menus (React + shadcn)

**Files**: `ContextMenu/useSheetContextMenu.tsx`, `ContextMenu/FilterMenu.tsx`, `SheetTab/SheetItem.tsx`

- Cell / row-header / column-header right-click menus: `useSheetContextMenu(area)` builds each
  menu from shadcn `DropdownMenu` items on the shared `@workspace/ui` singleton context menu
  (`useContextMenu` + `ContextMenuAnchor`, anchored at the cursor). The cell anchor renders in
  `SheetOverlay`, the row/column anchors in their headers
- Filter menu (`FilterMenu.tsx`): the remaining bespoke panel — select/deselect checkboxes,
  color filter submenu; mounted by `Workbook`
- Sheet tab menu (`SheetItem.tsx`): rename, delete, hide, show, color options — the same items
  rendered through a shadcn `ContextMenu` (tab right-click) and a `DropdownMenu` (chevron on
  the active tab)
- Outside clicks are dismissed by the shadcn/Radix portals — there is no separate backdrop div

### 12. MenuBar (React + shadcn)

**Files**: `MenuBar/index.tsx`, `MenuBar/edit-menu.tsx`, `MenuBar/view-menu.tsx`,
`MenuBar/insert-menu.tsx`, `MenuBar/format-menu.tsx`, `MenuBar/data-menu.tsx`,
`MenuBar/CustomBorder.tsx`

Pure React UI — no overlays. Google-Sheets-style menu bar (Edit / View / Insert / Format / Data):
- shadcn `DropdownMenu` for each top-level menu
- shadcn `Popover` for `CustomBorder` (border style picker)
- Tailwind styling
- `sheet-mousedown-cancel` must be on any `DropdownMenuSubContent` rendered inside
  `cellArea`. Radix portals the submenu out of the DOM, but React synthetic events still
  bubble across the portal — without the class, `cellArea`'s mousedown guard misses the
  menu items and selection jumps to the cell underneath the popup.

### 13. Sheet Tabs (React)

**Files**: `SheetTab/index.tsx`, `SheetTab/SheetItem.tsx`

Bottom bar:
- Sheet tabs with drag-and-drop reordering
- Scroll buttons (ChevronsLeft/Right) when tabs overflow
- Add sheet button, all-sheets list button

## Scrolling

**File**: `SheetOverlay/index.tsx` — the `.sheet-cell-area` element

Native browser scroll. `cellArea` (`overflow:auto`, holding a full-size `ch_width × rh_height`
spacer) is the single scroll surface — the browser handles wheel, trackpad (momentum),
keyboard (PageUp/Down, arrows, Home/End), touch, and the scrollbar. There is no custom wheel
or touch handler.

- `cellArea`'s `onScroll` writes `globalCache.scrollLeft` / `globalCache.scrollTop` and calls
  `globalCache.notifyScrollListeners()`. Scroll state lives in `globalCache` (NOT React
  context) to avoid re-rendering every consumer on each tick.
- Bus subscribers: the rAF-coalesced canvas redraw (`Sheet`), the headers' freeze-handle
  `transform` wrappers (`ColumnHeader` / `RowHeader`), and one `transform` per pane region
  (`OverlayRegion` — body and header regions alike).
- Programmatic scroll (back-to-top, sheet-switch restore, selection auto-follow, freeze reset)
  writes `cellArea.scrollLeft/scrollTop`; the native `scroll` event then re-syncs the bus.
- `overscroll-behavior: none` disables the macOS rubber-band bounce (the rAF canvas can't
  follow an elastic overscroll) and stops scroll-chaining to the page.
- Mouse hit-testing reads `ctx.scrollLeft/scrollTop`, which `setContextWithProduce` lazily
  syncs from `globalCache` at the top of every recipe.

**Body overlay layer**: the body overlays (selection box, cell editor, presence, fill handle,
formula-range visuals, search highlights, images, link/validation cards) do NOT scroll
natively. They live in a `position: sticky` layer (`.sheet-cell-overlay-layer`) that is the
first child of `cellArea` — a 0×0 anchor pinned to the scrollport origin at compositor speed —
holding up to four **pane region viewports** (`OverlayRegion`) that mirror how the canvas
draws frozen panes: main, frozen-rows band, frozen-cols band, corner. Each region is a
`position: absolute` div at its fixed viewport rect with `overflow: hidden`; rects derive from
the freeze config (`computeOverlayRegions` in `state/modules/freeze.ts`) and change only when
the freeze config or row/col metrics change. Inside each region a content div restores the
content-coordinate origin and translates from the scroll bus on its free axes only — main
`(-sx, -sy)`, rows band `(-sx, ·)`, cols band `(·, -sy)`, corner pinned — the header transform
mechanism generalized per pane, locked to the rAF canvas redraw (no drift, no per-scroll React
work).

- **Passive rectangles** (selection boxes, focus box, formula-range selects/highlights, search
  highlights, presence, copy/move/extend indicators — `OverlayVisuals`) render into every
  region in pure content coordinates; each region's clip shows exactly its portion, so they
  clip below frozen panes in lockstep with the canvas. This replaces the old per-element
  `fix*StyleOverflowInFreeze` clamps (computed at React render, one frame stale during pure
  scrolling — now deleted); the headers apply the same model one axis at a time via
  `computeColumnHeaderRegions` / `computeRowHeaderRegions` (see § 2). Imperatively positioned
  previews (move/extend, formula range select) are written per copy via `querySelectorAll`;
  the header resize handles get the same treatment region-aware in `renderColResize` /
  `renderRowResize` (frozen-band coordinates when the resized column/row is frozen).
- **Stateful singletons** are never duplicated: the cell editor (InputBox) and the validation
  dropdown trigger render into the single region containing their anchor cell, clipped —
  editing a frozen cell keeps the editor pinned under the pane, and an editor whose cell
  scrolls under a band clips at the boundary, like Excel. Popup chrome (validation hint box,
  LinkEditCard) pins with its anchor's pane but never clips; the pane-spanning resize/freeze
  drag lines live in an unclipped wrapper on the main transform. With no freeze configured
  there is exactly one unclipped main region.
- The `sheet-cell-flow` spacer (which defines the scroll range and holds the bottom
  add-row control, pinned via `left: scrollLeft`) and the cell context-menu anchor stay direct
  children of `cellArea`.

Hit-testing: the layer carries `z-index: 1` so its content sits above the later full-size
cell-flow spacer sibling (each region's translated content div is an atomic stacking context,
so the children's z-indexes 8–30 order them only among themselves). The region divs are
`pointer-events: none`; interactive overlay elements re-enable themselves with
`pointer-events: auto` (selection handles, images, open editor, drag lines, validation
trigger/hint, link card) and everything else falls through to `cellArea`. The not-editing
InputBox (`z-index: -1`, which used to sink below the canvas) is hidden with `opacity: 0` +
`pointer-events: none`, keeping the cell input focusable at the cell position without painting
over the grid or swallowing focus-cell clicks.

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

The SheetOverlay / InputBox / ImgBoxs values live inside `.sheet-cell-overlay-layer`
(`z-index: 1`) in per-pane region viewports whose translated content divs are atomic stacking
contexts (see § Scrolling), so they order those elements only among themselves within a pane;
across panes the region clip rects are disjoint. The layer as a whole sits above the canvas
and the cell-flow spacer. The header values (10/11 highlights, 12 resize handle, 20 freeze
handle) are likewise atomic per header region wrapper — DOM order stands in across wrappers
(passive regions, then the hover region, then the freeze-handle wrapper on top).

## Key Performance Patterns

1. **Canvas for cells**: Thousands of cells rendered efficiently on canvas, not as DOM nodes
2. **rAF coalescing**: Multiple state changes in one frame produce a single canvas repaint
3. **Scroll in globalCache**: Scroll position stored outside React to avoid full tree re-renders
4. **Header transform**: Column/row headers translate from the scroll bus, locked to the canvas redraw (not a separate scroll container)
5. **Overlay architecture**: Only interactive elements (selection, editing, images) are React DOM
