# Frontend Review: Sheets + Fortune-Sheet Deep Dive

**Scope:** `apps/sheets/`, `packages/fortune-sheet/`
**Reviewed:** 2026-03-18

---

## Critical Issues

### 1. MIME type typo breaks navigation in 3 route files (previous)

`application-eigensheet` (missing trailing `s`) is used instead of `application-eigensheets` in three places. The canonical MIME type is `application/eigensheets` (defined at `packages/lib/src/types/drive.ts:19`); the URL-form is `application-eigensheets`.

- `/apps/sheets/src/routes/index.tsx:11` -- index redirect sends users to `/mime/application-eigensheet`
- `/apps/sheets/src/routes/_auth._sidebar.mime.$mimeType.tsx:81` -- `onAfterAction` navigates to the wrong MIME
- `/apps/sheets/src/routes/_auth._sidebar.shared.$to.tsx:88` -- same issue

The sidebar (`sheets-sidebar.tsx:33,59`) correctly uses `application-eigensheets`. This means: (a) the landing page redirects to a MIME filter that matches nothing, (b) after delete/rename the user lands on an empty view.

**Impact:** The sheets app's default landing view likely shows no files.
**Fix:** Replace `application-eigensheet` with `application-eigensheets` in all three files.

### 2. `validateSearch` drops `uid` parameter -- shared-items detail pane broken (new)

`/apps/sheets/src/routes/_auth._sidebar.shared.$to.tsx:14-16`:
```
validateSearch: (search: Record<string, unknown>) => {
    const pid = typeof search.pid === 'string' ? search.pid : undefined;
    return {pid} as DriveSearchParams;
}
```

`DriveSearchParams` (at `packages/lib/src/types/drive.ts:132-135`) includes both `pid` and `uid`. The validator only extracts `pid` and casts with `as DriveSearchParams`, so `uid` is silently discarded. Yet at line 23, `uid` is destructured from `Route.useSearch()`, and at line 27 it is passed to `usePathInfo(uid || '', ...)`. Since `uid` is always `undefined` after validation, `usePathInfo` receives an empty string as the ownerId when viewing shared-with-me items, which will fail to load the detail pane for files owned by other users.

This same bug exists in the other collab apps (docs, slides, stickies) -- it is a cross-app pattern. But for this review, it affects the sheets shared-items view.

**Impact:** Selecting a shared-with-me item in the detail pane fetches with the wrong ownerId, breaking the preview.
**Fix:** Add `const uid = typeof search.uid === 'string' ? search.uid : undefined;` and include it in the returned object.

### 3. Stale closure in `onPaste` reads outdated `context` (previous, re-analyzed)

`/packages/fortune-sheet/src/components/Workbook/index.tsx:691-787`:

The `onPaste` callback captures `context` in its closure (line 786: `[context, setContextWithProduce]`). Within the handler, lines 743-765 read `context.luckysheet_select_save`, `context.luckysheetfile`, and `context.currentSheetId` directly (not inside the Immer recipe). These reads use the `context` value from when the callback was created. If `context` has changed since the last render (e.g., the user switched sheets or moved the selection), the paste will operate on stale data -- potentially inserting rows at wrong positions or accessing the wrong sheet.

The Eigen clipboard branch (lines 710-733) correctly uses `setContextWithProduce((draftCtx) => ...)`, but the normal paste branch (lines 737-783) reads `context` outside the recipe for row-calculation and then calls `setContextWithProduce` with the stale-computed values.

**Impact:** Paste of multi-row HTML content may miscalculate how many rows to add if state changed between renders.
**Fix:** Move the row-count calculation inside the Immer recipe, reading from `draftCtx` instead of the closed-over `context`.

### 4. `applyOp` crashes if all sheets are hidden (new)

`/packages/fortune-sheet/src/components/Workbook/api.ts:88-95`:

When a remote "hide sheet" op arrives and the hidden sheet is the current sheet, the code filters for visible sheets and takes `[0].id`. If the filter returns an empty array (all sheets hidden -- an edge case that could be produced by a malicious or buggy remote client), this dereferences `undefined[0].id` and throws a TypeError, crashing the workbook.

**Impact:** Remote op can crash the local client.
**Fix:** Guard with `if (shownSheets.length > 0)` before accessing `[0].id`.

---

## Important Issues

### 5. 13 `console.log` calls in production Yjs hook (previous)

`/apps/sheets/src/components/sheets/hooks/use-sheet.ts` -- Lines 38, 46, 51, 64, 84, 94, 101, 105, 119, 154, 158, 197, 206. These log on every connect, every sync, every snapshot flush, every restore. In a multi-user session they produce substantial console noise.

**Impact:** Log noise in production, potential minor performance cost for large snapshot logging.
**Fix:** Remove all `console.log`/`console.warn` calls. Keep `console.error` for actual errors (lines 84, 154, 206).

### 6. `DocsRoot` function name -- copy-paste artifact (previous)

`/apps/sheets/src/routes/__root.tsx:18` -- The root component function is named `DocsRoot`, and the route component at line 61 references `DocsRoot`. This was clearly copy-pasted from the docs app.

**Impact:** Developer confusion when navigating code.
**Fix:** Rename to `SheetsRoot`.

### 7. `interface` instead of `type` (previous)

`/apps/sheets/src/routes/__root.tsx:14-16` -- `interface MyRouterContext` violates the project rule "always `type` over `interface` -- except when methods are needed."

`/apps/sheets/src/components/sheets-sidebar.tsx:12` -- `interface SheetsSidebarProps` same issue.

**Impact:** Code style inconsistency.
**Fix:** Change both to `type ... = { ... }`.

### 8. Unbounded Y.Array growth for ops (previous, expanded)

`/apps/sheets/src/components/sheets/hooks/use-sheet.ts:145` -- Every local edit pushes ops to `doc.getArray('ops')`. This array is never compacted. Over a long editing session the Yjs document grows monotonically. New joiners must process the entire op history during initial sync. Snapshots are saved periodically, but old ops are never pruned.

The snapshot-on-first-flush pattern (lines 161-165) means the very first edit triggers an immediate flush, and subsequent edits debounce at 1 second. But after restoring from a revision, the ops array still contains all pre-restore operations, which are now semantically invalid against the new state.

**Impact:** Memory growth proportional to session length; slow initial sync for large documents; potential inconsistencies after revision restore.
**Fix:** After flushing a snapshot, clear the ops Y.Array (or periodically compact it). After `handleRestore`, ops from before the restore should be discarded.

### 9. `isLocalOpRef` flag not resilient to rapid local edits (previous, re-confirmed)

`/apps/sheets/src/components/sheets/hooks/use-sheet.ts:73-75`:

```
if (isLocalOpRef.current) {
    isLocalOpRef.current = false;
    return;
}
```

`handleOp` sets `isLocalOpRef.current = true` at line 143 before pushing to the Y.Array. The observer checks this flag. If two local ops fire synchronously before the observer runs, only the first one gets skipped. The second local op would be re-applied as if it were remote.

In practice, `doc.transact()` batching prevents this in most cases, but it is a theoretical correctness issue for any code path that calls `handleOp` twice without yielding.

**Impact:** Possible double-application of local operations under specific timing conditions.
**Fix:** Use a counter instead of a boolean, incrementing on each local op push and decrementing in the observer.

### 10. `filter-by-condition` renders dead hidden DOM (previous)

`/packages/fortune-sheet/src/components/ContextMenu/FilterMenu.tsx:481-531`:

The `filter-by-condition` menu item renders a `<div>` with `display: "none"` containing unfinished template placeholders (`luckysheet-\${menuid}-bycondition`). This is dead DOM from the upstream fork -- the feature was never implemented.

**Impact:** Wasted DOM nodes, confusing code, broken template literals.
**Fix:** Remove the entire hidden div block. If the filter-by-condition feature is wanted, implement it properly.

### 11. `onKeyPress` is deprecated React event (new)

`/packages/fortune-sheet/src/components/SheetOverlay/index.tsx:882`:
```
onKeyPress={(e) => e.stopPropagation()}
```

`onKeyPress` was deprecated in React 17 and removed in some newer React DOM implementations. This event handler on the bottom add-row control should use `onKeyDown` instead.

**Impact:** May not fire in future React versions; no functional impact currently.
**Fix:** Replace with `onKeyDown`.

### 12. 20 `eslint-disable-next-line react-hooks/exhaustive-deps` suppressions (new)

Across 10 component files in fortune-sheet:
- `FxEditor/index.tsx`: 3
- `SheetOverlay/index.tsx`: 3
- `SheetOverlay/InputBox.tsx`: 3
- `DataVerification/DropdownList.tsx`: 2
- `Workbook/index.tsx`: 2
- `Sheet/index.tsx`: 2
- Others: 5

Each suppression indicates a useEffect/useMemo/useCallback that intentionally omits dependencies. While most of these are legitimate (e.g., only re-running when selection changes, not when the data they read changes), they create a maintenance hazard. Anyone modifying these hooks must carefully verify whether the omitted dependency was intentional.

The most concerning is `SheetOverlay/index.tsx:494` where `cellValue()` is called inside an effect that only depends on `context.sheetFocused`, but `cellValue` reads from `context.luckysheet_select_save` and `context.luckysheetfile` -- the stale value is intentional (capture on focus change) but fragile.

**Impact:** Maintenance risk; potential for stale reads if code is modified.
**Fix:** Document each suppression with a comment explaining why the dependency is intentionally omitted.

### 13. Chinese comments remain in context.ts, patch.ts, and CSS files (previous, updated count)

Core files still contain Chinese comments:
- `core/context.ts`: ~40 Chinese comments (field-level: "复制粘贴", "筛选", "选区拖动替换", etc.)
- `core/context.ts:319-358`: Entire Chinese locale blocks for `optionLabel_zh` and `optionLabel_zh_tw`
- `core/utils/patch.ts`: 4 Chinese comments ("撤消增表", "正常增表", "撤销删表", "正常删表")
- CSS files: 3 Chinese comments in `ContextMenu/index.css` and `SheetOverlay/index.css`

The project rule is "English everywhere."

**Impact:** Code style violation; harder to understand for non-Chinese-speaking contributors.
**Fix:** Translate all Chinese comments to English.

---

## Minor Issues

### 14. `onSave` no-op callback (previous)

`/apps/sheets/src/components/sheets-sidebar.tsx:87-88`:
```
onSave={() => {}}
```

`DriveCreateSheets` declares `onSave` as optional (`onSave?: (newPath: string) => void` at `packages/ui/src/components/layout/drive/drive-create-sheets.tsx:11`). The empty callback should be omitted.

**Fix:** Remove the `onSave` prop.

### 15. DriveContext duplication across 5 apps (previous)

`/apps/sheets/src/routes/__root.tsx:9-12` defines `DriveContext` identically to docs, slides, stickies, and drive apps. All five create the same context with `{rootPath: null, mountId: DEFAULT_MOUNT_ID}`.

**Impact:** Unnecessary code duplication.
**Fix:** Consider extracting to `@workspace/ui` or `@workspace/lib` as a shared context.

### 16. `editor.tsx` wraps `handleOp` in unnecessary extra callback (new)

`/apps/sheets/src/components/sheets/editor.tsx:41-43`:
```
const onOp = useCallback((ops: any[]) => {
    handleOp(ops);
}, [handleOp]);
```

This creates a wrapper function that does nothing but forward arguments. `handleOp` is already a stable `useCallback`. It can be passed directly as `onOp={handleOp}`.

Similarly, `onChange` at line 45-47 wraps `saveSnapshot` with an unnecessary `as any` cast.

**Impact:** Unnecessary allocation; `as any` hides the type mismatch between `Record<string, any>[]` and `SheetData[]`.
**Fix:** Pass `handleOp` directly. Fix the type signature of `saveSnapshot` to accept `Record<string, any>[]` or properly type the `SheetData` type.

### 17. `LinkEidtCard` directory typo (previous)

`/packages/fortune-sheet/src/components/LinkEidtCard/` -- "Eidt" should be "Edit". The import at `SheetOverlay/index.tsx:37` already uses the corrected name `LinkEditCard` for the export, but the directory path retains the typo.

**Fix:** Rename directory to `LinkEditCard/` and update all imports.

### 18. Remaining CSS: 5 files totaling ~1,740 lines (previous, counts re-verified)

| File | Lines | Imported By |
|------|-------|-------------|
| `SheetOverlay/index.css` | ~957 | `SheetOverlay/index.tsx` |
| `ContextMenu/index.css` | ~282 | `ContextMenu/index.tsx`, `ContextMenu/SheetTab.tsx` |
| `SheetTab/index.css` | ~280 | `SheetTab/index.tsx` |
| `LinkEidtCard/index.css` | ~182 | `LinkEidtCard/index.tsx` |
| `SheetOverlay/ScrollBar/index.css` | ~40 | `ScrollBar/index.tsx` |

Progress since FORTUNE-SHEETS-TODO.md was written: `Workbook/index.css`, `DataVerification/index.css`, and `SearchReplace/index.css` have all been deleted. 5 files remain.

### 19. 81 `@ts-ignore` directives across 22 files (previous, updated count)

Previous review counted 70. Actual count is 81 across 22 files. Worst offenders:
- `core/events/mouse.ts`: 16
- `core/events/paste.ts`: 10
- `core/modules/formula.ts`: 10
- `core/modules/cell.ts`: 8
- `core/modules/toolbar.ts`: 6
- `core/locale/index.ts`: 5
- `core/modules/cursor.ts`: 4

These are in the core engine (untouched from upstream) and are low-priority for cleanup.

### 20. 36 `as any` casts in component files (previous, updated count)

Previous review counted 43. Actual count is 36 across 11 files. Worst offenders:
- `icon-map.tsx`: 9 (all in the `SVGIcon` function mapping legacy icon names)
- `ContextMenu/index.tsx`: 6 (dynamic locale key access)
- `DataVerification/index.tsx`: 6
- `ConditionFormat/index.tsx`: 3
- `LocationCondition/index.tsx`: 3

### 21. 327 `luckysheet-*` class name references (previous, confirmed)

Count confirmed at 327 across 23 component files. Many are required by the core engine which uses `document.querySelector` / `getElementById` for DOM manipulation (canvas rendering, cell positioning). These cannot be removed without auditing `core/` usage. The heaviest files:
- `SheetOverlay/index.css`: 70
- `SheetOverlay/index.tsx`: 39
- `ContextMenu/index.css`: 31
- `FxEditor/index.tsx`: 26
- `InputBox.tsx`: 25
- `ImgBoxs/index.tsx`: 22

### 22. `SheetTab/index.tsx:105` renders legacy icon markup (new)

```
<i className="iconfont luckysheet-iconfont-caidan2"/>
```

This references a Chinese icon font class (`luckysheet-iconfont-caidan2`) that may not be loaded in the Eigen build, since the icon system was migrated to Lucide. If no iconfont CSS is imported, this renders as an invisible empty element.

**Impact:** Potentially invisible menu icon on the sheet tab bar.
**Fix:** Replace with a Lucide icon component (e.g., `<Menu size={14}/>`).

### 23. `css.d.ts` still needed (previous, status confirmed)

`/packages/fortune-sheet/src/css.d.ts` declares `*.css` modules. Still needed because 5 CSS files remain with direct imports. Cannot be deleted yet.

---

## Observations

### Architecture strengths

- **Clean separation of Yjs from spreadsheet engine:** The `use-sheet.ts` hook bridges between Yjs and fortune-sheet's `onOp`/`applyOp` API without the engine knowing about collaboration. This is architecturally sound and makes it possible to use the spreadsheet engine standalone.

- **Op-based sync is correct for the use case:** Compared to syncing full JSON snapshots, the op-based approach (`patchToOp` / `opToPatch` in `core/utils/patch.ts`) provides granular conflict handling. The patch-to-op translation correctly handles special operations (insert/delete rows/columns, add/delete sheets, merge cells) by emitting structured ops rather than raw patches.

- **Scroll performance optimization is well-implemented:** Moving scroll state to `globalCache` with `requestAnimationFrame` coalescing (in `SheetOverlay/index.tsx:177-214`) and scroll listeners (in `Workbook/index.tsx:71-81`) avoids the React re-render bottleneck for the highest-frequency user interaction.

- **App layer is compact and correct:** The sheets app at ~400 lines across 14 files follows Eigen patterns precisely -- AppShell, auth guards, DriveLayout, shared hooks. The toolbar cleanly separates File menu (left) from collaboration controls (right).

- **Revision history integration:** The `handleRestore` function in `use-sheet.ts:168-208` correctly handles Yjs state restoration by creating a temp doc, applying the update, and merging key-by-key into the live doc. This preserves WebSocket connectivity during restore.

### What the FORTUNE-SHEETS-TODO.md gets right

The TODO document at `docs/FORTUNE-SHEETS-TODO.md` is thorough and accurate. Key points confirmed by this review:
- CSS file inventory and line counts are correct (minus the 3 already deleted)
- The `LinkEidtCard` typo, `NameBox` export fix, and dead CSS file deletions are all accurately tracked
- The phased priority order is sensible
- The `export default` elimination has been completed as the TODO indicated

### What the previous review gets right

The previous review's findings are largely confirmed:
- MIME type typo (critical) -- verified
- Console logging (13 calls) -- verified
- DocsRoot naming -- verified
- DriveContext duplication -- verified, affects 5 apps
- Type safety counts were close (previous said 43 `as any`, actual is 36; previous said 70 `@ts-ignore`, actual is 81)
- The Yjs sync analysis (race conditions, unbounded ops, snapshot size) is accurate
- The recommendation to move fortune-sheet to `apps/sheets/src/` is sound

### New findings not in the previous review

1. `validateSearch` drops `uid` -- critical for shared-items (issue #2)
2. `applyOp` crash when all sheets hidden (issue #4)
3. `onKeyPress` deprecation (issue #11)
4. 20 exhaustive-deps suppressions (issue #12)
5. Legacy icon font reference in SheetTab (issue #22)
6. Unnecessary callback wrapper in editor.tsx (issue #16)
7. Updated `@ts-ignore` count (81 vs 70)
8. Updated `as any` count (36 vs 43)
