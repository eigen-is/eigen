# Frontend Review: Sheets + Fortune-Sheet Deep Dive

**Scope:** `apps/sheets/`, `packages/fortune-sheet/`, `packages/lib/src/core/collab/`
**Reviewed:** 2026-03-19

---

## Architecture Overview

The sheets subsystem consists of three layers:

1. **`apps/sheets/`** (~1,100 LOC) -- Thin TanStack Router app providing sidebar, routing, file management, and auth
   guard. Follows standard Eigen app patterns (AppShell, DriveLayout, DriveContext, sidebar sections, login redirect).

2. **`packages/fortune-sheet/`** (~143,000 LOC) -- Forked spreadsheet UI with canvas rendering, Immer-based state
   management, and formula evaluation. The Eigen fork has migrated several components to shadcn/Tailwind, but the core
   engine (`core/events/`, `core/modules/`) retains upstream legacy code.

3. **Yjs integration** (`apps/sheets/src/components/sheets/hooks/use-sheet.ts`, ~210 LOC) -- Bridges fortune-sheet's
   `onOp`/`applyOp` API with a Y.Doc over WebSocket. Op-based sync: each edit produces patches (via Immer
   `produceWithPatches`), which are converted to `Op[]` by `patchToOp()`, pushed to a `Y.Array('ops')`, and applied on
   remote clients via `opToPatch()` + Immer `applyPatches()`. A `Y.Map('state')` stores a periodic JSON snapshot for new
   joiners.

### Key data flow

```
Local edit --> Immer produceWithPatches --> patchToOp(patches) --> onOp(ops)
  --> Y.Array('ops').push([ops]) --> WebSocket --> remote Y.Array observer
  --> opToPatch(ops) --> Immer applyPatches(ctx, patches) --> canvas redraw
```

### File storage

`.eigensheets` files are Drive folders containing a `data.db` SQLite file that stores the Yjs document state. The collab
server (`apps/api/src/lib/collab/`) handles WebSocket connections and persistence.

---

## Critical Issues

### 1. Stale closure in `onPaste` reads outdated `context`

**File:** `/packages/fortune-sheet/src/components/Workbook/index.tsx:691-787`

The `onPaste` callback captures `context` in its dependency array (line 786: `[context, setContextWithProduce]`). Within
the handler, lines 743-765 read `context.luckysheet_select_save`, `context.luckysheetfile`, and `context.currentSheetId`
*outside* the Immer recipe. These reads use the `context` value from the render when the callback was last created. If
`context` changed between renders (e.g., user switched sheets, moved selection, another collaborator's op arrived), the
paste calculates `rowToBeAdded` from stale data.

The Eigen clipboard branch (lines 710-733) correctly uses `setContextWithProduce((draftCtx) => ...)`, but the normal
HTML-table paste branch (lines 737-783) reads from the closed-over `context`:

```typescript
const maxRow = trList.length + context.luckysheet_select_save![0].row[0];
const rowToBeAdded = maxRow - context.luckysheetfile[
    getSheetIndex(context, context!.currentSheetId! as string) as number
].data!.length;
```

Since `onPaste` re-creates on every `context` change, the staleness window is small but not zero -- any concurrent state
update between the paste event and the most recent render will use the old snapshot.

**Impact:** Paste of multi-row HTML content may miscalculate how many rows to add, or access the wrong sheet index.
**Fix:** Move the row-count calculation inside the Immer recipe, reading from `draftCtx` instead of the closed-over `context`.

### 2. `deleteSheet` sets `currentSheetId` to `undefined as string` when no visible sheets remain

**File:** `/packages/fortune-sheet/src/core/modules/sheet.ts:178-184`

```typescript
if (id === ctx.currentSheetId) {
    const shownSheets = _.cloneDeep(ctx.luckysheetfile).filter(
        (singleSheet) => _.isUndefined(singleSheet.hide) || singleSheet.hide !== 1
    );
    const orderSheets = _.sortBy(shownSheets, (sheet) => sheet.order);
    ctx.currentSheetId = orderSheets?.[0]?.id as string;  // <-- undefined as string if empty
}
```

If all remaining sheets are hidden (or the only sheet was just deleted), `orderSheets` is empty, and
`orderSheets[0]?.id` is `undefined`. The `as string` cast silently produces `undefined` typed as `string`. Any
subsequent code that uses `currentSheetId` (like `getSheetIndex(ctx, ctx.currentSheetId)`) will search for an id of
`undefined`, returning `null`/`undefined` and cascading into crashes.

By contrast, the `applyOp` hide-sheet handler at `Workbook/api.ts:96` correctly guards with `if (sorted.length > 0)`
before accessing the array.

**Impact:** Deleting the last visible sheet crashes the workbook.
**Fix:** Add a guard: if no visible sheets remain, either prevent the deletion or handle the empty state explicitly. At
minimum, check `orderSheets.length > 0` before assignment.

### 3. Unbounded `Y.Array('ops')` growth

**File:** `/apps/sheets/src/components/sheets/hooks/use-sheet.ts:137-139`

Every local edit pushes ops to `doc.getArray('ops')` via:

```typescript
doc.transact(() => {
    doc.getArray('ops').push([ops]);
});
```

The ops array is *never* compacted or cleared. Over a long editing session the Yjs document grows monotonically. New
joiners must receive and process the entire Y.Array delta during initial sync, even though a full snapshot exists in
`Y.Map('state')`. The snapshot is debounced at 1 second (line 156), but old ops are never pruned.

After `handleRestore` (line 160-199), the snapshot is replaced with restored data, but the ops array still contains all
pre-restore operations that are now semantically invalid against the restored state. If a new joiner arrives before the
next snapshot flush, they would apply the restored snapshot and then attempt to replay stale ops from the array
observer.

**Impact:** Memory growth proportional to total session lifetime; slow initial sync for long-lived documents; potential
state corruption after revision restore.
**Fix:** After flushing a snapshot, clear the ops Y.Array (or replace it). After `handleRestore`, clear the ops array as
part of the restore transaction.

---

## Important Issues

### 4. `isLocalOpRef` flag not resilient to rapid local edits

**File:** `/apps/sheets/src/components/sheets/hooks/use-sheet.ts:69-75, 136`

```typescript
// In handleOp:
isLocalOpRef.current = true;
doc.transact(() => { doc.getArray('ops').push([ops]); });

// In observer:
if (isLocalOpRef.current) {
    isLocalOpRef.current = false;
    return;
}
```

The flag is a boolean, but it guards a push to a Y.Array whose observer fires asynchronously. If two local ops are
emitted synchronously (e.g., from `setContextWithProduce` calling two recipes in sequence, or a paste that inserts rows
*and* fills cells), the second `handleOp` call sets the flag to `true` again, but the observer only unsets it once. The
second local op would then be re-applied as a remote op.

In practice, `doc.transact()` batching often prevents this since both pushes would be in separate transactions with
separate observer notifications. But it is a correctness issue for any code path that calls `handleOp` twice before
yielding to the event loop.

**Impact:** Possible double-application of local operations under specific timing conditions.
**Fix:** Use a counter instead of a boolean: increment on each local push, decrement in the observer.

### 5. `onKeyPress` deprecated React event

**File:** `/packages/fortune-sheet/src/components/SheetOverlay/index.tsx:882`

```typescript
onKeyPress={(e) => e.stopPropagation()}
```

`onKeyPress` was deprecated in React 17 and may be removed in future React DOM versions. This handler on the bottom
add-row control should use `onKeyDown` instead.

**Impact:** May not fire in future React versions; no functional impact currently.
**Fix:** Replace with `onKeyDown`.

### 6. `filter-by-condition` renders dead hidden DOM with broken template literals

**File:** `/packages/fortune-sheet/src/components/ContextMenu/FilterMenu.tsx:481-531`

The `filter-by-condition` menu item renders a `<div>` with `display: "none"` containing unfinished template
placeholders. The class names use literal `\${menuid}` strings (escaped dollar signs) rather than actual template
interpolation:

```tsx
<div className="luckysheet-\${menuid}-bycondition" style={{display: "none"}}>
    <div className="luckysheet-flat-menu-button luckysheet-mousedown-cancel"
         id="luckysheet-\${menuid}-selected">
```

This is dead DOM from the upstream fortune-sheet fork -- the feature was never implemented.

**Impact:** Wasted DOM nodes, confusing code, broken template literals that produce nonsensical class names.
**Fix:** Remove the entire hidden div block. If the filter-by-condition feature is needed, implement it properly.

### 7. 20 `eslint-disable-next-line react-hooks/exhaustive-deps` suppressions

Across 10 component files in fortune-sheet:

- `SheetOverlay/InputBox.tsx`: 3
- `SheetOverlay/index.tsx`: 3
- `FxEditor/index.tsx`: 3
- `Workbook/index.tsx`: 2
- `Sheet/index.tsx`: 2
- `DataVerification/DropdownList.tsx`: 2
- `ConditionFormat/ConditionRules.tsx`: 1
- `DataVerification/index.tsx`: 1
- `FxEditor/NameBox.tsx`: 1
- `NotationBoxes/index.tsx`: 1
- `ScrollBar/index.tsx`: 1

Each suppression indicates a `useEffect`/`useMemo`/`useCallback` that intentionally omits dependencies. While many are
legitimate (e.g., only re-running when a specific trigger changes), they create a maintenance hazard. Anyone modifying
these hooks must verify whether the omitted dependency was intentional.

**Impact:** Maintenance risk; potential for stale reads if code is modified.
**Fix:** Document each suppression with a comment explaining why the dependency is intentionally omitted.

### 8. Chinese comments remain in core files

The project rule is "English everywhere." Significant Chinese comments remain in:

| File                                | Approximate count | Examples                                              |
|-------------------------------------|-------------------|-------------------------------------------------------|
| `core/context.ts`                   | ~71               | Field comments: `// 坐标选区鼠标选择`, `// 提醒弹窗`, `// 数据验证规则` |
| `core/modules/conditionalFormat.ts` | ~68               | Block comments: `// 选区 包含 条件格式应用范围 全部`                |
| `core/modules/dropCell.ts`          | ~193              | Extensive algorithm comments                          |
| `core/events/mouse.ts`              | ~146              | Event handling comments                               |
| `core/events/paste.ts`              | ~76               | Paste logic comments                                  |
| `core/modules/selection.ts`         | ~55               | Selection algorithm comments                          |
| `core/modules/dataVerification.ts`  | ~75               | Validation rule comments                              |
| `core/locale/zh.ts`, `zh_tw.ts`     | ~6,044            | Locale strings (expected)                             |
| `core/utils/patch.ts`               | 4                 | `// 撤消增表`, `// 正常增表`, `// 撤销删表`, `// 正常删表`            |
| CSS files                           | 3                 | `ContextMenu/index.css`, `SheetOverlay/index.css`     |
| **Total (excl. locale files)**      | **~700**          |                                                       |

**Impact:** Code style violation; harder to understand for non-Chinese-speaking contributors.
**Fix:** Translate all Chinese comments to English. Locale files (`zh.ts`, `zh_tw.ts`) are expected to contain Chinese
and should be excluded.

### 9. 81 `@ts-ignore` directives across 22 files (zero `@ts-expect-error`)

Worst offenders in the core engine:
| File | Count |
|------|-------|
| `core/events/mouse.ts` | 16 |
| `core/events/paste.ts` | 10 |
| `core/modules/formula.ts` | 10 |
| `core/modules/cell.ts` | 8 |
| `core/modules/toolbar.ts` | 6 |
| `core/locale/index.ts` | 5 |
| `core/modules/cursor.ts` | 4 |
| `core/api/cell.ts` | 3 |
| `core/canvas.ts` | 2 |
| Component files (7 files) | 9 |

These are overwhelmingly in the core engine inherited from the upstream fortune-sheet fork. The project has zero
`@ts-expect-error` directives, which would be the preferred alternative since they fail when the suppressed error is
fixed.

**Impact:** Type errors are silently suppressed; `@ts-ignore` does not fail when the underlying issue is fixed, so
cleanup opportunities are missed.
**Fix:** Low priority for core engine files. For the 9 in component files, migrate to `@ts-expect-error` and fix the
underlying types where possible.

### 10. 81 `as any` casts across 29 files

Breakdown:

- Test files: ~30 (acceptable in tests)
- Formula parser: ~5 (external library types)
- Component files: ~36
- Context/core: ~10

Most concerning in component code:
| File | Count | Nature |
|------|-------|--------|
| `icon-map.tsx` | 9 | Legacy SVG icon name mapping |
| `ContextMenu/index.tsx` | 6 | Dynamic locale key access |
| `DataVerification/index.tsx` | 6 | Form state handling |
| `ConditionFormat/index.tsx` | 3 | Color/rule data |
| `LocationCondition/index.tsx` | 3 | Select value handling |

In the sheets app itself, there are 3 `as any` casts (excluding auto-generated `routeTree.gen.ts`):

- `use-sheet.ts:76` -- `(delta.insert as any[][])` (Yjs delta typing)
- `use-sheet.ts:176` -- `localType.set(k, v as any)` (Y.Map value)
- `editor.tsx:46` -- `saveSnapshot(data as any)` (unnecessary, hides `Record<string,any>[]` vs `SheetData[]` mismatch)

**Impact:** Type safety erosion. The `editor.tsx:46` cast is particularly concerning as it hides a type mismatch between
fortune-sheet's `onChange` callback signature and `useSheet`'s `saveSnapshot` parameter type.
**Fix:** Fix `SheetData` type to align with fortune-sheet's `Sheet` type, eliminating the need for the cast. For
fortune-sheet component casts, address incrementally.

---

## Minor Issues

### 11. `DocsRoot` function name -- copy-paste artifact

**File:** `/apps/sheets/src/routes/__root.tsx:18,61`

The root component function is named `DocsRoot`, clearly copy-pasted from the docs app.

**Fix:** Rename to `SheetsRoot`.

### 12. `interface` instead of `type` in 2 places

- `/apps/sheets/src/routes/__root.tsx:14` -- `interface MyRouterContext`
- `/apps/sheets/src/components/sheets-sidebar.tsx:12` -- `interface SheetsSidebarProps`

Project rule: "always `type` over `interface` -- except when methods are needed."

**Fix:** Change both to `type ... = { ... }`.

### 13. `onSave` no-op callback

**File:** `/apps/sheets/src/components/sheets-sidebar.tsx:87-88`

```typescript
onSave={() => {}}
```

`DriveCreateSheets` declares `onSave` as optional. The empty callback should be omitted.

**Fix:** Remove the `onSave` prop.

### 14. Unnecessary callback wrapper in `editor.tsx`

**File:** `/apps/sheets/src/components/sheets/editor.tsx:41-47`

```typescript
const onOp = useCallback((ops: any[]) => {
    handleOp(ops);
}, [handleOp]);

const onChange = useCallback((data: Record<string, any>[]) => {
    saveSnapshot(data as any);
}, [saveSnapshot]);
```

`onOp` wraps `handleOp` in an identity function. `handleOp` is already a stable `useCallback`; it can be passed
directly. `onChange` adds an `as any` cast that hides the type mismatch.

**Fix:** Pass `handleOp` directly as `onOp`. Fix the type signature of `saveSnapshot` to accept the correct type.

### 15. `DriveContext` duplication across 5 apps

**File:** `/apps/sheets/src/routes/__root.tsx:9-12`

Defines `DriveContext` identically to docs, slides, stickies, and drive apps. All five create the same context with
`{rootPath: null, mountId: DEFAULT_MOUNT_ID}`.

**Fix:** Extract to `@workspace/lib` or `@workspace/ui` as a shared context.

### 16. `LinkEidtCard` directory typo

**File:** `/packages/fortune-sheet/src/components/LinkEidtCard/`

"Eidt" should be "Edit". The import at `SheetOverlay/index.tsx:37` already uses the corrected export name
`LinkEditCard`, but the directory path retains the typo.

**Fix:** Rename directory to `LinkEditCard/` and update all imports.

### 17. Legacy icon font reference in SheetTab

**File:** `/packages/fortune-sheet/src/components/SheetTab/index.tsx:105`

```html
<i className="iconfont luckysheet-iconfont-caidan2"/>
```

References a Chinese icon font class that may not be loaded in the Eigen build, since the icon system was migrated to
Lucide.

**Fix:** Replace with a Lucide icon component (e.g., `<Menu size={14}/>`).

### 18. Remaining CSS: 5 files totaling ~1,740 lines

| File                               | Lines | Imported By                                         |
|------------------------------------|-------|-----------------------------------------------------|
| `SheetOverlay/index.css`           | 956   | `SheetOverlay/index.tsx`                            |
| `ContextMenu/index.css`            | 282   | `ContextMenu/index.tsx`, `ContextMenu/SheetTab.tsx` |
| `SheetTab/index.css`               | 280   | `SheetTab/index.tsx`                                |
| `LinkEidtCard/index.css`           | 182   | `LinkEidtCard/index.tsx`                            |
| `SheetOverlay/ScrollBar/index.css` | 40    | `ScrollBar/index.tsx`                               |

Progress since `FORTUNE-SHEETS-TODO.md` was written: `Workbook/index.css`, `DataVerification/index.css`, and
`SearchReplace/index.css` have all been successfully deleted. 5 files remain.

### 19. 327 `luckysheet-*` class name references

Count confirmed at ~327 across component files. Many are required by the core engine which uses
`document.querySelector`/`getElementById` for DOM manipulation (canvas rendering, cell positioning). These cannot be
removed without auditing `core/` usage. Low priority.

### 20. `SheetData` type is effectively `Record<string, any> & { name: string }`

**File:** `/apps/sheets/src/components/sheets/hooks/use-sheet.ts:7`

```typescript
export type SheetData = Record<string, any> & { name: string };
```

This is an extremely permissive type that provides almost no type safety. The fortune-sheet package exports a proper
`Sheet` type from `core/types.ts` with well-defined fields (`id`, `name`, `data`, `celldata`, `config`, `order`, `hide`,
etc.). Using `Record<string, any>` means the `saveSnapshot`, `initialData`, and `onChange` callbacks lose all type
information.

**Fix:** Import and use the `Sheet` type from `@workspace/fortune-sheet` instead of the ad-hoc `SheetData`.

---

## Resolved Issues (from previous review)

The following issues from the previous review have been addressed:

1. **MIME type typo** (`application-eigensheet` -> `application-eigensheets`) -- Fixed in `index.tsx`,
   `mime.$mimeType.tsx`, and `shared.$to.tsx`. All three now correctly use `application-eigensheets`.

2. **`validateSearch` dropping `uid`** -- Fixed in `shared.$to.tsx:15-17`. Now correctly extracts both `pid` and `uid`.

3. **13 `console.log` calls in `use-sheet.ts`** -- Cleaned up. Only 2 `console.error` and 1 `console.warn` remain (
   appropriate for actual error conditions).

4. **`applyOp` crash when all sheets hidden** -- Fixed. Guard `if (sorted.length > 0)` added at `Workbook/api.ts:96`.

5. **Chinese strings in `ImgBoxs`** (`裁剪`, `恢复原图`, `删除`) -- Replaced with English (`Crop`, `Restore original`,
   `Delete`) and Lucide icons.

---

## Strengths

### Clean Yjs/engine separation

The `use-sheet.ts` hook bridges between Yjs and fortune-sheet's `onOp`/`applyOp` API without the engine knowing about
collaboration. This is architecturally sound and makes the spreadsheet engine usable standalone.

### Op-based sync is correct for the use case

The `patchToOp` / `opToPatch` translation in `core/utils/patch.ts` correctly handles special operations (insert/delete
rows/columns, add/delete sheets, merge cells) by emitting structured ops rather than raw patches. This provides granular
conflict handling that full JSON snapshots cannot.

### Scroll performance optimization

Moving scroll state to `globalCache` with `requestAnimationFrame` coalescing (in `Sheet/index.tsx:224-237`) and scroll
listeners (in `Workbook/index.tsx:71-81`) avoids React re-render bottlenecks for the highest-frequency user interaction.

### Compact app layer

The sheets app at ~400 lines of authored code (excluding generated files) follows Eigen patterns precisely: AppShell,
auth guards, DriveLayout, shared hooks. The toolbar cleanly separates File menu (left) from collaboration controls (
right).

### Revision history integration

The `handleRestore` function in `use-sheet.ts:160-199` correctly handles Yjs state restoration by creating a temp doc,
applying the update, and merging key-by-key into the live doc. This preserves WebSocket connectivity during restore.

### Solid test coverage for core engine

The fortune-sheet package includes test suites for API operations (`cell.test.ts`, `merge.test.ts`, `range.test.ts`,
`rowcol.test.ts`, `sheet.test.ts`, `workbook.test.ts`), hooks (`cell.test.ts`, `comment.test.ts`, `sheet.test.ts`),
toolbar operations, formula parsing, and patch utilities. This covers the most critical mutation paths.

### Progressive migration from legacy to modern UI

The FORTUNE-SHEETS-TODO.md accurately tracks the migration state. Components like `ConditionRules`, `FormatSearch`,
`SearchReplace`, `FormulaSearch`, `SplitColumn`, `LocationCondition`, and `Toolbar` have been successfully migrated to
shadcn components. The phased approach is pragmatic.

---

## Coverage Analysis

| Area                   | Status                                                              |
|------------------------|---------------------------------------------------------------------|
| Yjs sync integration   | Reviewed: `use-sheet.ts`, op flow, snapshot lifecycle               |
| Fortune-sheet Workbook | Reviewed: `Workbook/index.tsx`, `api.ts`, context, state management |
| Sheet rendering        | Reviewed: `Sheet/index.tsx`, canvas draw flow, scroll optimization  |
| Paste handling         | Reviewed: `onPaste` stale closure, eigen clipboard integration      |
| Sheet management       | Reviewed: `core/modules/sheet.ts` add/delete/change/update          |
| Patch system           | Reviewed: `core/utils/patch.ts` patchToOp, opToPatch, filterPatch   |
| App routes             | Reviewed: all 8 route files                                         |
| Sidebar                | Reviewed: `sheets-sidebar.tsx`                                      |
| Context/types          | Reviewed: `context/index.ts`, `core/context.ts`, `core/types.ts`    |
| Chinese comments       | Audited: ~700 instances across ~30 core files (excl. locale)        |
| Type safety            | Audited: 81 `@ts-ignore`, 81 `as any`, zero `@ts-expect-error`      |
| CSS migration          | Audited: 5 files remaining out of original 8                        |
| Legacy class names     | Audited: ~327 `luckysheet-*` references across 23 files             |

---

## Relevant Files

- `/apps/sheets/src/components/sheets/hooks/use-sheet.ts` -- Yjs integration hook
- `/apps/sheets/src/components/sheets/editor.tsx` -- Main editor component
- `/apps/sheets/src/components/sheets/toolbar.tsx` -- File menu and collaboration toolbar
- `/apps/sheets/src/routes/__root.tsx` -- Root layout with DocsRoot naming issue
- `/apps/sheets/src/routes/_auth.sheet.$ownerId.$mountId.$pathId.tsx` -- Sheet editor route
- `/packages/fortune-sheet/src/components/Workbook/index.tsx` -- Core workbook with state management
- `/packages/fortune-sheet/src/components/Workbook/api.ts` -- Imperative API including `applyOp`
- `/packages/fortune-sheet/src/components/Sheet/index.tsx` -- Canvas rendering + scroll
- `/packages/fortune-sheet/src/core/utils/patch.ts` -- Op/patch translation
- `/packages/fortune-sheet/src/core/modules/sheet.ts` -- Sheet add/delete/change
- `/packages/fortune-sheet/src/core/context.ts` -- Context type with Chinese comments
- `/packages/fortune-sheet/src/components/ContextMenu/FilterMenu.tsx` -- Dead DOM block
- `/packages/lib/src/core/collab/hooks/use-collab.ts` -- Shared collab hooks
- `/docs/SHEETS.md` -- Architecture documentation
- `/docs/FORTUNE-SHEETS-TODO.md` -- Migration audit and TODO
