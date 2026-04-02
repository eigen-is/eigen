# Fortune-Sheet mouse.ts Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `packages/fortune-sheet/src/core/events/mouse.ts` (5404 lines) into 5 focused modules, decompose the 1685-line `mouseRender` function, and fix broken windows (Chinese comments, `as any`, dead code).

**Architecture:** Extract functions into 5 new files by concern. Convert `mouse.ts` into a barrel re-exporting everything so consumers don't change. Decompose `mouseRender` into named sub-functions within `mouse-drag.ts`.

**Tech Stack:** TypeScript, React (fortune-sheet package)

**Broken windows policy:** While moving code, translate any Chinese comments to English, fix easily-resolvable `as any` casts, and remove dead commented-out code blocks.

---

## File Structure

```
packages/fortune-sheet/src/core/events/
  mouse.ts              → barrel (re-exports only)
  mouse-resize.ts       → NEW: fixPositionOnFrozenCells + 4 resize/freeze handlers
  mouse-wheel.ts        → NEW: handleGlobalWheel + scroll timeouts
  mouse-header.ts       → NEW: handleRowHeaderMouseDown, handleColumnHeaderMouseDown
  mouse-cell.ts         → NEW: handleCellAreaMouseDown, handleCellAreaDoubleClick, handleContextMenu
  mouse-drag.ts         → NEW: mouseRender (decomposed) + handleOverlayMouseMove + handleOverlayMouseUp
```

---

### Task 1: Create `mouse-resize.ts`

Leaf module with no intra-mouse dependencies. Contains `fixPositionOnFrozenCells` (pure utility) and the 4 small handle mousedown functions.

**Files:**
- Create: `packages/fortune-sheet/src/core/events/mouse-resize.ts`

- [ ] **Step 1: Create `mouse-resize.ts`**

Move from `mouse.ts`:
- `fixPositionOnFrozenCells` (L159-191)
- `handleColSizeHandleMouseDown` (L5178-5234)
- `handleRowSizeHandleMouseDown` (L5236-5298)
- `handleColFreezeHandleMouseDown` (L5300-5351)
- `handleRowFreezeHandleMouseDown` (L5353-5404)

Imports needed (subset of mouse.ts imports):
```ts
import {Freezen} from "..";
import {Context} from "../context";
import {cancelActiveImgItem, israngeseleciton} from "../modules";
import {colLocation, rowLocation} from "../modules/location";
import {GlobalCache} from "../types";
```

All 5 functions are `export function`. Fix broken windows in the moved code:
- Remove dead commented-out code blocks (e.g. commented `// //图片 active/cropping` blocks)
- Translate Chinese comments to English (e.g. L5310 `// let mouse = mouseposition...`)

- [ ] **Step 2: Verify typecheck**

Run: `bunx tsc --noEmit -p packages/fortune-sheet/tsconfig.json 2>&1 | head -30`

This will fail because `mouse.ts` still exists with the original code — that's expected. Just verify `mouse-resize.ts` itself has no syntax errors by checking the output mentions no errors in `mouse-resize.ts`.

- [ ] **Step 3: Commit**

```bash
git add packages/fortune-sheet/src/core/events/mouse-resize.ts
git commit -m "refactor(fortune-sheet): extract resize/freeze handlers to mouse-resize.ts"
```

---

### Task 2: Create `mouse-wheel.ts`

Fully independent — no intra-mouse imports.

**Files:**
- Create: `packages/fortune-sheet/src/core/events/mouse-wheel.ts`

- [ ] **Step 1: Create `mouse-wheel.ts`**

Move from `mouse.ts`:
- Module-level state: `mouseWheelUniqueTimeout`, `scrollLockTimeout` (L42-43)
- `handleGlobalWheel` (L45-157)

Imports needed:
```ts
import _ from "lodash";
import {Context} from "../context";
import {GlobalCache} from "../types";
```

Fix broken windows:
- Remove all dead commented-out code (L60-66, L71/78/80/87, L89-90, L94-99, L103, L128-130)
- Translate Chinese comments: L106 `一次滚动三行或三列` → "Scroll three rows or columns at a time", L132 `通过滚动scrollbar来让浏览器自动控制滚动边界` → "Let the browser control scroll boundaries via the scrollbar", L142 same

- [ ] **Step 2: Commit**

```bash
git add packages/fortune-sheet/src/core/events/mouse-wheel.ts
git commit -m "refactor(fortune-sheet): extract wheel handler to mouse-wheel.ts"
```

---

### Task 3: Create `mouse-header.ts`

**Files:**
- Create: `packages/fortune-sheet/src/core/events/mouse-header.ts`

- [ ] **Step 1: Create `mouse-header.ts`**

Move from `mouse.ts`:
- `handleRowHeaderMouseDown` (L4322-4761)
- `handleColumnHeaderMouseDown` (L4763-5176)

Imports needed:
```ts
import _ from "lodash";
import {Context, getFlowdata} from "../context";
import {
    cancelActiveImgItem,
    createFormulaRangeSelect,
    createRangeHightlight,
    functionHTMLGenerate,
    israngeseleciton,
    rangeHightlightselected,
    rangeSetValue,
} from "../modules";
import {
    cancelFunctionrangeSelected,
    mergeMoveMain,
    updateCell,
} from "../modules/cell";
import {colLocation, colLocationByIndex, rowLocation, rowLocationByIndex} from "../modules/location";
import {checkProtectionAllSelected} from "../modules/protection";
import {GlobalCache} from "../types";
import {fixPositionOnFrozenCells} from "./mouse-resize";
```

Fix broken windows:
- Translate all Chinese comments (e.g. L4333 `// 图片 active/cropping`, L4359 `// mousedown是右键`, L4361 `// 如果右键在选区内, 停止mousedown处理`, L4381 `// 公式相关`, L4391 `// 公式选区`, etc.)
- Remove dead commented-out code blocks
- The `// @ts-ignore` on L4403, 4465, 4845, 4903 are for `mergeMoveMain` return destructuring — keep these for now (fixing requires typing `mergeMoveMain` return, out of scope)

- [ ] **Step 2: Commit**

```bash
git add packages/fortune-sheet/src/core/events/mouse-header.ts
git commit -m "refactor(fortune-sheet): extract header handlers to mouse-header.ts"
```

---

### Task 4: Create `mouse-cell.ts`

**Files:**
- Create: `packages/fortune-sheet/src/core/events/mouse-cell.ts`

- [ ] **Step 1: Create `mouse-cell.ts`**

Move from `mouse.ts`:
- `handleCellAreaMouseDown` (L193-1189)
- `handleCellAreaDoubleClick` (L1191-1370)
- `handleContextMenu` (L1372-1664)

Imports needed:
```ts
import _ from "lodash";
import {Context, getFlowdata} from "../context";
import {
    cancelActiveImgItem,
    cellFocus,
    createFormulaRangeSelect,
    createRangeHightlight,
    functionHTMLGenerate,
    israngeseleciton,
    rangeHightlightselected,
    rangeSetValue,
} from "../modules";
import {
    cancelFunctionrangeSelected,
    luckysheetUpdateCell,
    mergeBorder,
    mergeMoveMain,
    updateCell,
} from "../modules/cell";
import {colLocation, colLocationByIndex, rowLocation, rowLocationByIndex} from "../modules/location";
import {checkProtectionSelectLockedOrUnLockedCells} from "../modules/protection";
import {normalizeSelection} from "../modules/selection";
import {Settings} from "../settings";
import {GlobalCache} from "../types";
import {getSheetIndex, isAllowEdit} from "../utils";
import {showLinkCard} from "../modules/hyperlink";
import {fixPositionOnFrozenCells} from "./mouse-resize";
```

Fix broken windows:
- Remove massive dead commented-out blocks (L289-314 data drill/hyperlink, L632-988 condition format/data verification/formula generator — hundreds of lines of dead code)
- Translate Chinese comments throughout (L244 `//单元格单击之前`, L258 `//数据验证 单元格聚焦`, L261 `若点击单元格部分不在视图内`, L272 `//mousedown是右键`, L276 `如果右键在选区内`, L316 `// 公式相关`, L318 `// 公式选区`, etc.)
- Keep `// @ts-ignore` on mergeMoveMain destructuring (L414, 1059, 1469, 1522)

- [ ] **Step 2: Commit**

```bash
git add packages/fortune-sheet/src/core/events/mouse-cell.ts
git commit -m "refactor(fortune-sheet): extract cell area handlers to mouse-cell.ts"
```

---

### Task 5: Create `mouse-drag.ts` with decomposed `mouseRender`

The most complex task. Move the 3 remaining functions and decompose `mouseRender` into named sub-functions.

**Files:**
- Create: `packages/fortune-sheet/src/core/events/mouse-drag.ts`

- [ ] **Step 1: Create `mouse-drag.ts` with decomposed mouseRender**

Move from `mouse.ts`:
- `mouseRender` (L1666-3350) — decompose into dispatcher + named functions
- `handleOverlayMouseMove` (L3352-3620)
- `handleOverlayMouseUp` (L3622-4320)

Imports needed:
```ts
import _ from "lodash";
import {Context, getFlowdata} from "../context";
import {
    cancelPaintModel,
    israngeseleciton,
    onCellsMove,
    onCellsMoveEnd,
    onFormulaRangeDragEnd,
    onImageMove,
    onImageMoveEnd,
    onImageResize,
    onImageResizeEnd,
    rangeDrag,
    rangeHightlightselected,
} from "../modules";
import {getFrozenHandleLeft, getFrozenHandleTop, scrollToFrozenRowCol} from "../modules/freeze";
import {mergeMoveMain} from "../modules/cell";
import {colLocation, rowLocation} from "../modules/location";
import {checkProtectionSelectLockedOrUnLockedCells} from "../modules/protection";
import {pasteHandlerOfPaintModel} from "../modules/selection";
import {Settings} from "../settings";
import {GlobalCache} from "../types";
import {getSheetIndex} from "../utils";
import {onDropCellSelect, onDropCellSelectEnd} from "../modules/dropCell";
import {handleFormulaInput, rangeDragColumn, rangeDragRow} from "../modules/formula";
import {onRangeSelectionModalMove, onRangeSelectionModalMoveEnd} from "../modules/hyperlink";
import {onSearchDialogMove, onSearchDialogMoveEnd} from "../modules/searchReplace";
import {fixPositionOnFrozenCells} from "./mouse-resize";
```

**mouseRender decomposition** — extract each drag-mode branch into a named function:

```ts
/** Cell selection drag (luckysheet_select_status) */
function renderCellSelection(
    ctx: Context, globalCache: GlobalCache, e: MouseEvent,
    container: HTMLDivElement
) { /* L1716-1865 logic */ }

/** Formula range drag */
function renderFormulaRangeDrag(
    ctx: Context, e: MouseEvent, cellInput: HTMLDivElement,
    scrollX: HTMLDivElement, scrollY: HTMLDivElement,
    container: HTMLDivElement, fxInput?: HTMLDivElement | null
) { /* L2109-2138 — calls rangeDrag/rangeDragRow/rangeDragColumn */ }

/** Cell extend / fill handle drag */
function renderCellExtend(
    ctx: Context, e: MouseEvent,
    scrollX: HTMLDivElement, scrollY: HTMLDivElement, container: HTMLDivElement
) { /* L2327-2328 — calls onDropCellSelect */ }

/** Column width resize drag */
function renderColResize(
    ctx: Context, e: MouseEvent,
    scrollX: HTMLDivElement, container: HTMLDivElement
) { /* L2329-2350 */ }

/** Row height resize drag */
function renderRowResize(
    ctx: Context, e: MouseEvent,
    scrollY: HTMLDivElement, container: HTMLDivElement
) { /* L2351-2372 */ }

/** Column freeze handle drag */
function renderColFreezeDrag(
    ctx: Context, e: MouseEvent, container: HTMLDivElement
) { /* L2373-2403 */ }

/** Row freeze handle drag */
function renderRowFreezeDrag(
    ctx: Context, e: MouseEvent, container: HTMLDivElement
) { /* L2404-2435 */ }
```

Then `mouseRender` becomes a thin dispatcher (~40 lines):
```ts
function mouseRender(
    ctx: Context, globalCache: GlobalCache, e: MouseEvent,
    cellInput: HTMLDivElement, scrollX: HTMLDivElement, scrollY: HTMLDivElement,
    container: HTMLDivElement, fxInput?: HTMLDivElement | null
) {
    const rect = container.getBoundingClientRect();
    // Auto-scroll logic (L1676-1709)
    ...
    // Single-select early return (L1711-1714)
    if (ctx.rangeDialog?.singleSelect) return;

    if (ctx.luckysheet_select_status) {
        renderCellSelection(ctx, globalCache, e, container);
    } else if (ctx.formulaCache.rangestart) {
        renderFormulaRangeDrag(ctx, e, cellInput, scrollX, scrollY, container, fxInput);
    } else if (ctx.formulaCache.rangedrag_row_start) {
        rangeDragRow(ctx, e, cellInput, scrollX.scrollLeft, scrollY.scrollTop, container, fxInput);
    } else if (ctx.formulaCache.rangedrag_column_start) {
        rangeDragColumn(ctx, e, cellInput, scrollX.scrollLeft, scrollY.scrollTop, container, fxInput);
    } else if (ctx.luckysheet_rows_selected_status) {
        // commented-out row selection drag — no-op
    } else if (ctx.luckysheet_cols_selected_status) {
        // commented-out column selection drag — no-op
    } else if (ctx.luckysheet_cell_selected_move) {
        // commented-out cell move — no-op
    } else if (ctx.luckysheet_cell_selected_extend) {
        renderCellExtend(ctx, e, scrollX, scrollY, container);
    } else if (ctx.luckysheet_cols_change_size) {
        renderColResize(ctx, e, scrollX, container);
    } else if (ctx.luckysheet_rows_change_size) {
        renderRowResize(ctx, e, scrollY, container);
    } else if (ctx.luckysheet_cols_freeze_drag) {
        renderColFreezeDrag(ctx, e, container);
    } else if (ctx.luckysheet_rows_freeze_drag) {
        renderRowFreezeDrag(ctx, e, container);
    }
}
```

Fix broken windows:
- Remove massive commented-out code blocks throughout (L1892-2108 condition format/data verification, L2139-2236 rows/cols selected status, L2237-2326 cell move, L2436-3350 chart/image/crop/formula range operations)
- Translate Chinese comments: L1711 `判断选区坐标功能是否为单选模式`, L1715 `拖动选择`, L1845 `判断当前是不去选择整行`, L1855 `判断当前是不是去选择整列`, L2330 `调整列宽拖动`, L2351 `调整行高拖动`, L2373 `调整列冻结`, L2404 `调整行冻结`, etc.
- In `handleOverlayMouseUp`: translate L3729 `数据窗格主体`, L3735 `格式刷`, L3739 `单次 格式刷`, L3758 `行标题窗格主体`, L3762 `列标题窗格主体`, L3988 `改变行高`, L4089 `改变列宽`, L4198 `列冻结拖动结束`, L4252 `行冻结拖动结束`, L4316 `选区下拉`
- Remove dead commented-out blocks in `handleOverlayMouseMove` (L3370-3586) and `handleOverlayMouseUp` (L3651-3986)

- [ ] **Step 2: Commit**

```bash
git add packages/fortune-sheet/src/core/events/mouse-drag.ts
git commit -m "refactor(fortune-sheet): extract drag/overlay handlers to mouse-drag.ts, decompose mouseRender"
```

---

### Task 6: Convert `mouse.ts` to barrel and verify

**Files:**
- Modify: `packages/fortune-sheet/src/core/events/mouse.ts`

- [ ] **Step 1: Replace `mouse.ts` with barrel**

Replace the entire contents of `mouse.ts` with:

```ts
export * from "./mouse-wheel";
export * from "./mouse-cell";
export * from "./mouse-drag";
export * from "./mouse-header";
export * from "./mouse-resize";
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (no errors)

If there are import errors, fix them in the relevant new file.

- [ ] **Step 3: Run lint**

Run: `bun run lint:fix`

Fix any lint issues in the new files.

- [ ] **Step 4: Run tests**

Run: `bun test packages/fortune-sheet/`
Expected: All existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/fortune-sheet/src/core/events/mouse.ts
git commit -m "refactor(fortune-sheet): convert mouse.ts to barrel re-exporting split modules"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full check**

Run: `bun run check`
Expected: lint + typecheck + test all pass.

- [ ] **Step 2: Verify line counts**

Run: `wc -l packages/fortune-sheet/src/core/events/mouse*.ts`

Verify:
- `mouse.ts` is ~6 lines (barrel)
- `mouse-resize.ts` is ~200-260 lines
- `mouse-wheel.ts` is ~70-90 lines (after dead code removal)
- `mouse-header.ts` is ~700-855 lines
- `mouse-cell.ts` is ~700-900 lines (after dead code removal)
- `mouse-drag.ts` is ~800-1000 lines (after dead code removal and decomposition)

The total should be significantly less than 5404 due to dead commented-out code removal.

- [ ] **Step 3: Commit any remaining fixes**

If any fixes were needed, commit them.
