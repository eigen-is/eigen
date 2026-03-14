# Fortune-Sheet Rendering Architecture

## Component Tree

```
<Workbook>                                      Workbook/index.tsx
  <WorkbookContext.Provider>
    <ModalProvider>                              context/modal.tsx
      <Toolbar>                                 Toolbar/index.tsx          (React + shadcn)
      <FxEditor>                                FxEditor/index.tsx         (React + ContentEditable)
      <Sheet>                                   Sheet/index.tsx
        <canvas>                                                           (HTML5 Canvas — cells, grid, borders)
        <SheetOverlay>                          SheetOverlay/index.tsx     (React DOM overlays)
          <ColumnHeader>                        SheetOverlay/ColumnHeader.tsx
          <RowHeader>                           SheetOverlay/RowHeader.tsx
          <ScrollBar x>                         SheetOverlay/ScrollBar/index.tsx
          <ScrollBar y>
          selection divs                                                    (blue rectangles)
          resize handles
          freeze lines
          formula range highlights
          <InputBox>                            SheetOverlay/InputBox.tsx   (ContentEditable over canvas)
          <FilterOptions>                       FilterOption/index.tsx
          <ImgBoxs>                             ImgBoxs/index.tsx
          <NotationBoxes>                       NotationBoxes/index.tsx     (React + arrow canvas)
          <LinkEditCard>                        LinkEidtCard/index.tsx
          <DropDownList>                        DataVerification/DropdownList.tsx
      <SheetTab>                                SheetTab/index.tsx         (React)
        <SheetItem> per sheet                   SheetTab/SheetItem.tsx
        <ZoomControl>                           ZoomControl/index.tsx
      <ContextMenu>                             ContextMenu/index.tsx      (React + shadcn DropdownMenu)
      <FilterMenu>                              ContextMenu/FilterMenu.tsx
      <SheetTabContextMenu>                     ContextMenu/SheetTab.tsx
      <SheetList>                               SheetList/index.tsx
      backdrop div (z-1003)
```

## Rendering Technologies

### Canvas (cell content)

**Files**: `Sheet/index.tsx`, `core/canvas.ts`

The actual spreadsheet grid — cells, text, gridlines, borders, fill colors — is drawn on an HTML5 Canvas
2D context. This is what makes rendering thousands of cells performant.

- `Sheet/index.tsx` creates a `<canvas>` element sized to the container
- On context changes or scroll, it calls `requestAnimationFrame` to coalesce redraws
- `core/canvas.ts` contains the `Canvas` class with methods like `drawMain()`, `renderCell()`, etc.
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
- Resize cursor handle (`.fortune-cols-change-size` / `.fortune-rows-change-size`)
- Freeze drag handle at the freeze boundary
- Filter dropdown arrow icon (ColumnHeader only, lucide `CircleChevronDown`)

Scroll position is synced imperatively (not via React state) for performance.

### 3. Cell Selection — The Blue Rectangle (React DOM)

**File**: `SheetOverlay/index.tsx`

The selection box is a React div overlay, not drawn on canvas.

- **Focus cell**: `.luckysheet-cell-selected-focus` — `z-index: 14`, light blue bg + blue border
- **Selection range(s)**: `.luckysheet-cell-selected` — one div per range in
  `context.luckysheet_select_save`, `z-index: 15`, with 4 border divs + center handle
- **Copy indicator**: dashed blue border, `z-index: 18`
- **Move indicator**: `.fortune-cell-selected-move`, `z-index: 16`
- **Extend indicator**: `.fortune-cell-selected-extend`, `z-index: 16`

Each selection div has 8 resize handles (corners + midpoints) for drag-resizing the selection.

Positioned with `left_move` / `top_move` / `width_move` / `height_move` from the selection state.

### 4. Cell Editor — InputBox (ContentEditable)

**File**: `SheetOverlay/InputBox.tsx`

When you double-click or type into a cell, InputBox appears:
- A ContentEditable div positioned at the cell's location
- `z-index: 19` when editing, `-1` when hidden
- Scaled with `transform: scale(zoomRatio)`, origin top-left
- Renders `FormulaSearch` dropdown and `FormulaHint` tooltip below when editing formulas

### 5. Formula Bar — FxEditor (React)

**File**: `FxEditor/index.tsx`

Always visible above the grid. Contains:
- `NameBox` — shows current cell address (e.g., "A1")
- Function icon (`FunctionSquare` from Lucide)
- ContentEditable for formula/value editing
- Uses Tailwind styling, standard React layout (not overlay)

### 6. Filter Indicators (React DOM)

**File**: `FilterOption/index.tsx`

Small divs positioned over filtered column header cells:
- Shows chevron (no filter) or filled filter icon (active filter)
- Absolutely positioned with freeze-aware offset calculations
- Class: `.luckysheet-filter-options`

### 7. Images (React DOM + `<img>`)

**File**: `ImgBoxs/index.tsx`

- Active image: `z-index: 300`, with resize handles (8-point) and control buttons (Crop, Restore, Delete)
- Inactive images: `z-index: 200`, just `<img>` in a bordered div
- All dimensions scaled by `zoomRatio`
- ID: `luckysheet-modal-dialog-activeImage` (queried by `core/modules/image.ts`)

### 8. Comments (React DOM + Canvas arrow)

**File**: `NotationBoxes/index.tsx`

- Comment box: yellow div (`rgb(255,255,225)`) with black border, ContentEditable text
- Arrow: `<canvas>` element draws a connector line from cell to comment box
- Normal: `z-index: 100`, editing: `z-index: 200`
- 8 resize handles + 4 move indicators when editing
- Box IDs: `comment-box-{r}{c}` (queried by `core/modules/comment.ts`)

### 9. Hyperlink Editor (React DOM)

**File**: `LinkEidtCard/index.tsx`

Three modes:
1. **Read-only toolbar**: shows link text + copy/edit/delete buttons, positioned near cell
2. **Edit form**: text input + type select + address input + OK/Cancel
3. **Range selection modal**: cell range input for internal links

Positioned absolutely near the active cell. Class: `.fortune-link-modify-modal` (queried by
`core/modules/hyperlink.ts`).

### 10. Data Verification Dropdown (React DOM)

**File**: `DataVerification/DropdownList.tsx`

- Simple list of values with checkmarks
- `z-index: 10000` (highest in the app)
- Absolutely positioned at the validated cell
- Uses shadcn-style Tailwind classes (`bg-background`, `hover:bg-accent`)

### 11. Context Menus (React + shadcn)

**Files**: `ContextMenu/index.tsx`, `ContextMenu/FilterMenu.tsx`, `ContextMenu/SheetTab.tsx`

- Cell right-click menu: uses shadcn `DropdownMenu` with standard menu items
- Filter menu: custom rendering with select/deselect checkboxes, color filter submenu
- Sheet tab menu: rename, delete, hide, show, color options
- Backdrop div at `z-index: 1003` captures outside clicks

### 12. Toolbar (React + shadcn)

**File**: `Toolbar/index.tsx`

Pure React UI — no overlays:
- Uses `Toolbar` from `@workspace/ui`
- `TooltipButton` components with Lucide/SVG icons
- shadcn `DropdownMenu` for formatting submenus
- Tailwind styling

### 13. Sheet Tabs + Zoom (React)

**Files**: `SheetTab/index.tsx`, `SheetTab/SheetItem.tsx`, `ZoomControl/index.tsx`

Bottom bar:
- Sheet tabs with drag-and-drop reordering
- Scroll buttons (ChevronsLeft/Right) when tabs overflow
- ZoomControl with +/- buttons and preset dropdown
- Add sheet button, all-sheets list button

## Scrolling

**File**: `SheetOverlay/ScrollBar/index.tsx`

Uses native browser scroll:
- Two scrollbar divs (x-axis and y-axis) with inner divs sized to full content
- `onScroll` event updates `globalCache.scrollLeft` / `globalCache.scrollTop`
- Scroll state lives in `globalCache` (NOT React context) to avoid re-rendering
- Canvas redraws triggered via `globalCache.notifyScrollListeners()`
- Headers sync scroll position imperatively

## Zoom

**File**: `ZoomControl/index.tsx`, applied throughout

- Stored in `context.zoomRatio` (range 0.1 to 4.0)
- Canvas: font sizes and row/column dimensions scaled
- InputBox: `transform: scale(zoomRatio)` with `transform-origin: left top`
- Images: width/height multiplied by `zoomRatio`
- Presets: 10%, 30%, 50%, 70%, 100%, 150%, 200%, 300%, 400%

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
| 100 | Comments + arrows (normal) | NotationBoxes |
| 200 | Images (inactive) / Comments (editing) | ImgBoxs / NotationBoxes |
| 300 | Active image (with resize handles) | ImgBoxs |
| 1003 | Context menu backdrop | Workbook |
| 10000 | Data verification dropdown | DataVerification/DropdownList |

## Key Performance Patterns

1. **Canvas for cells**: Thousands of cells rendered efficiently on canvas, not as DOM nodes
2. **rAF coalescing**: Multiple state changes in one frame produce a single canvas repaint
3. **Scroll in globalCache**: Scroll position stored outside React to avoid full tree re-renders
4. **Imperative header sync**: Column/row headers sync scroll via listeners, not React state
5. **Overlay architecture**: Only interactive elements (selection, editing, images) are React DOM
