# Fortune-Sheet mouse.ts Split

Split `packages/fortune-sheet/src/core/events/mouse.ts` (5404 lines, 14 functions) into 5 focused modules.

## File structure

```
core/events/
  mouse.ts              → barrel re-exporting from the 5 modules below
  mouse-wheel.ts        → scroll handling
  mouse-cell.ts         → cell area interaction
  mouse-drag.ts         → drag state machine + overlay move/up
  mouse-header.ts       → row/column header selection
  mouse-resize.ts       → resize/freeze handles + coordinate utility
```

## Module contents

### mouse-wheel.ts (~115 lines)

- `handleGlobalWheel` — mouse wheel scroll with debounce
- Module-level state: `mouseWheelUniqueTimeout`, `scrollLockTimeout`
- No intra-mouse imports

### mouse-cell.ts (~1470 lines)

- `handleCellAreaMouseDown` — cell click with shift/ctrl, formula range selection
- `handleCellAreaDoubleClick` — enter cell editing
- `handleContextMenu` — right-click menu for cells, row/column headers
- Imports `fixPositionOnFrozenCells` from `mouse-resize`

### mouse-drag.ts (~2650 lines)

- `handleOverlayMouseMove` — dispatcher for move events (images, cells, dialogs, then `mouseRender`)
- `handleOverlayMouseUp` — state cleanup on mouse release
- `mouseRender` — private, thin dispatcher calling extracted drag mode handlers:
  - `renderCellSelection` — `luckysheet_select_status` branch
  - `renderFormulaRangeSelect` — `rangestart`, `rangedrag_row_start`, `rangedrag_column_start` branches
  - `renderCellMove` — `luckysheet_cell_selected_move` branch
  - `renderCellExtend` — `luckysheet_cell_selected_extend` branch
  - `renderColResize` — `luckysheet_cols_change_size` branch
  - `renderRowResize` — `luckysheet_rows_change_size` branch
  - `renderColFreezeDrag` — `luckysheet_cols_freeze_drag` branch
  - `renderRowFreezeDrag` — `luckysheet_rows_freeze_drag` branch
- All `render*` functions are private to this file
- Imports `fixPositionOnFrozenCells` from `mouse-resize`

### mouse-header.ts (~855 lines)

- `handleRowHeaderMouseDown` — row header click with shift/ctrl, formula ranges
- `handleColumnHeaderMouseDown` — column header click with shift/ctrl, formula ranges, sorting
- Imports `fixPositionOnFrozenCells` from `mouse-resize`

### mouse-resize.ts (~260 lines)

- `fixPositionOnFrozenCells` — pure utility adjusting mouse coordinates for frozen rows/columns
- `handleColSizeHandleMouseDown` — column width resize activation
- `handleRowSizeHandleMouseDown` — row height resize activation
- `handleColFreezeHandleMouseDown` — column freeze drag activation
- `handleRowFreezeHandleMouseDown` — row freeze drag activation
- No intra-mouse imports (leaf module)

### mouse.ts (barrel)

```ts
export * from "./mouse-wheel";
export * from "./mouse-cell";
export * from "./mouse-drag";
export * from "./mouse-header";
export * from "./mouse-resize";
```

Preserves the existing public API. No changes needed in `events/index.ts` or consumers.

## Broken window fixes (opportunistic)

- Translate Chinese comments to English in code being moved
- Fix easily-resolvable `as any` casts
- Remove dead commented-out code
- No other refactoring — clean split, not a rewrite

## Consumers

Only two files import from mouse.ts:
- `core/events/index.ts` — `export * from "./mouse"` (unchanged)
- `core/test/hooks/cell.test.ts` — `import {handleCellAreaMouseDown} from "../../events/mouse"` (unchanged)

## Verification

- `bun run typecheck` passes
- `bun run lint` passes (or `lint:fix` applied)
- `bun test packages/fortune-sheet/` passes
- All existing exports remain accessible via the same import paths
