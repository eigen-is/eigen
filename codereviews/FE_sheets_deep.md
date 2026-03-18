# Deep Code Review: Sheets App + Fortune-Sheet Package

## Summary

The Sheets ecosystem consists of a thin app layer (`apps/sheets/`, ~400 lines across 9 source files) and a
substantial forked spreadsheet engine (`packages/fortune-sheet/`, ~142,000 lines across 150+ files). The app layer
is well-structured and follows Eigen conventions. The fortune-sheet package has received significant cleanup work --
all `export default` usages are gone, toolbar and several dialog components are migrated to shadcn, and the icon
system has been replaced with Lucide -- but a large amount of work remains: 1,740 lines of legacy CSS across 5
files, 327 `luckysheet-*` class name references in components, 70 `@ts-ignore` directives in core, and 43
`as any` casts in components.

The package is only used by `apps/sheets/` and should be moved into it. The existing FORTUNE-SHEETS-TODO.md and
CLEANUP-NOTES.md documents are thorough and accurate -- this review largely confirms their findings and adds
new issues.

---

## Fortune-Sheet Package Analysis

### Current State

**What it is**: A full React spreadsheet engine forked from the open-source fortune-sheet project (which itself was
a React port of luckysheet). It includes a core engine (~42K lines: modules, events, canvas renderer, formula
parser), React UI components (~8K lines), and a formula parser (~5K lines, plus ~5K lines of tests).

**How much has been modified**: Substantial. The UI layer has been heavily reworked:
- Icon system replaced: `SVGDefines.tsx` (1,254 lines of inline SVG symbols) replaced with Lucide icons via
  `icon-map.tsx` (273 lines)
- Toolbar fully migrated to `@workspace/ui` shared components (`SharedToolbar`, `TooltipButton`, `DropdownMenu`)
- Several dialog components migrated to shadcn (`ConditionRules`, `FormatSearch`, `FormulaSearch`, `SearchReplace`,
  `SplitColumn`, `LocationCondition`, `DataVerification`)
- Modal system rewritten to use shadcn `Dialog` (`context/modal.tsx`)
- Custom hooks (`useDialog`, `useAlert`) built on shadcn primitives
- FilterMenu bottom buttons migrated to shadcn `Button`
- All `export default` eliminated
- Chinese labels in `ImgBoxs` replaced with English text and Lucide icons
- Accessibility additions: screen reader regions, `aria-label` attributes, keyboard navigation
- Yjs/collaboration support added via external `use-sheet.ts` hook in the app layer
- Eigen clipboard integration added to `Workbook/index.tsx`
- Scroll performance optimized: scroll state moved out of React context into `globalCache` with
  `requestAnimationFrame` coalescing

The **core engine** (`core/` directory, ~42K lines) has been left largely untouched from the upstream fork,
with some targeted fixes.

### Code Quality Issues

#### Dead/Commented-Out Code

1. **`/packages/fortune-sheet/src/components/Workbook/index.tsx:165`** -- TODO comment with no implementation:
   `// TODO setCellValue(draftCtx, d.r, d.c, expandedData, d.v);`
   The line below it does a simpler assignment. It is unclear whether setCellValue was needed for formatting.

2. **`/packages/fortune-sheet/src/components/FxEditor/index.tsx:126-212`** -- Large blocks of commented-out
   jQuery/luckysheet code (formula search up/down arrows, F4 key handling). ~90 lines of dead code.

3. **`/packages/fortune-sheet/src/components/SheetOverlay/index.tsx:380-389`** -- Commented-out useEffect for
   cell input focus.

4. **`/packages/fortune-sheet/src/components/SheetOverlay/index.tsx:842-845`** -- Commented-out dropdown list div.

5. **`/packages/fortune-sheet/src/components/SheetTab/index.tsx:122-125`** -- Commented-out drop placeholder.

6. **`/packages/fortune-sheet/src/components/ContextMenu/FilterMenu.tsx:481-531`** -- The `filter-by-condition`
   menu item renders a hidden div (`display: "none"`) with string template placeholders
   (`luckysheet-\${menuid}-bycondition`) -- this feature is unfinished and renders dead DOM.

#### Console Logging

**`/apps/sheets/src/components/sheets/hooks/use-sheet.ts`** -- 13 `console.log` calls left in production code.
These are debug traces (`[sheet] flushSnapshot`, `[sheet] connecting to`, etc.) that should be removed or
converted to a debug-only logger.

#### Type Safety

- **43 `as any` casts** across 15 component files. Worst offenders:
  - `Workbook/index.tsx` (in paste handler, context access)
  - `ContextMenu/index.tsx` (6 casts, mostly `(rightclick as any)[dir]` for dynamic locale keys)
  - `DataVerification/index.tsx` (6 casts)
  - `ConditionFormat/index.tsx` and `ConditionRules.tsx` (5 combined)
- **70 `@ts-ignore` directives** in core/ (16 in mouse.ts, 10 in paste.ts, 10 in formula.ts)
- **`css.d.ts`** declares `*.css` modules with empty types -- needed until all CSS imports are removed

#### Legacy CSS Class Names

**327 `luckysheet-*` class name references** across 23 component files. As documented in CLEANUP-NOTES.md,
many of these are DOM selectors used by core/ code and cannot be freely renamed. The highest concentrations:
- `SheetOverlay/index.tsx`: 39 references
- `SheetOverlay/index.css`: 70 references
- `ContextMenu/index.css`: 31 references
- `FxEditor/index.tsx`: 26 references
- `ImgBoxs/index.tsx`: 22 references

#### Remaining CSS Files (1,740 lines total)

| File | Lines | Imported By |
|------|-------|-------------|
| `SheetOverlay/index.css` | 956 | `SheetOverlay/index.tsx` |
| `SheetTab/index.css` | 280 | `SheetTab/index.tsx` |
| `ContextMenu/index.css` | 282 | `ContextMenu/index.tsx`, `ContextMenu/SheetTab.tsx` |
| `LinkEidtCard/index.css` | 182 | `LinkEidtCard/index.tsx` |
| `SheetOverlay/ScrollBar/index.css` | 40 | `ScrollBar/index.tsx` |

#### Naming Issues

- **`LinkEidtCard/`** -- typo in directory name (should be `LinkEditCard/`). Documented in CLEANUP-NOTES.md
  as deferred.
- **`FxEditor/NameBox.tsx`** -- The file was cleaned up and now exports `NameBox` correctly. The audit doc
  mentioned a `LocationBox` mismatch that has been fixed.

### Architecture Issues

**State Management**: The package uses a single monolithic `Context` object (defined in `core/context.ts`, 694
lines, with ~100+ fields) managed via Immer's `produceWithPatches`. Every state change runs through
`setContextWithProduce` in Workbook/index.tsx, which:
1. Applies the mutation recipe
2. Generates JSON patches (for undo history)
3. Filters patches
4. Pushes to undo list
5. Emits ops for Yjs sync

This is a functional pattern but creates a performance bottleneck: every interaction (mouse move during selection,
typing, scrolling) produces a full context update. The `noHistory` fast-path (line 270-275) mitigates this for
mouse-move operations by skipping patch generation, but the fundamental pattern of a single state atom means
every consumer re-renders on every change.

**Global scroll optimization**: Scroll state was correctly moved to `globalCache` (outside React) with
`requestAnimationFrame` coalescing via `scrollListeners`. This is a good pattern that prevents the context
re-render problem for the most frequent operation.

**Core module sizes**: Several core modules are excessively large:
- `events/mouse.ts`: 5,434 lines
- `modules/formula.ts`: 3,550 lines
- `modules/dropCell.ts`: 3,036 lines
- `modules/selection.ts`: 2,332 lines
- `events/paste.ts`: 2,064 lines
- `core/canvas.ts`: 2,191 lines

These are inherited from the upstream fork and would benefit from splitting, but this is low priority since
the core is functional.

### Yjs Integration Quality

The Yjs integration lives in `apps/sheets/src/components/sheets/hooks/use-sheet.ts` (218 lines), NOT inside
fortune-sheet itself. This is a clean architectural choice -- the spreadsheet engine is unaware of Yjs, and
the hook bridges between them.

**How it works**:
1. Creates a `Y.Doc` with a `state` Y.Map (for snapshots) and an `ops` Y.Array (for incremental operations)
2. On WebSocket sync, reads the snapshot to initialize the workbook
3. Local edits fire `onOp` -> push ops to Y.Array -> Yjs broadcasts to peers
4. Remote ops arrive via Y.Array observation -> `workbookRef.current.applyOp(ops)`
5. Snapshots are debounced (1s after first flush) and flushed on `beforeunload`

**Potential issues**:
1. **Race condition on late joiners**: If a user joins between op #N and the next snapshot save, they
   initialize from the last snapshot and miss ops that occurred after that snapshot but before they joined.
   The ops Y.Array grows unboundedly -- there is no compaction or op-to-snapshot reconciliation.
2. **No conflict resolution**: Two users editing the same cell simultaneously will both push ops. The last
   writer wins at the cell level, but intermediate states may flash on screen.
3. **Snapshot size growth**: The full sheet JSON is stored as a single Y.Map string value. For large sheets,
   this becomes expensive to serialize/deserialize.
4. **`isLocalOpRef` flag**: The local-op-skip mechanism (line 73-75) uses a boolean ref, but if two local ops
   fire in quick succession before the observer runs, the second might not be flagged correctly. In practice,
   `doc.transact()` batches mitigate this.

### Should It Move to apps/sheets?

**Current situation**: `@workspace/fortune-sheet` is in `packages/` (shared packages area) but is only consumed
by `apps/sheets/`. No other app imports it. The CLEANUP-NOTES.md already recommends moving it.

**Analysis**:
- `bun.lock` confirms only `apps/sheets` and the root `package.json` reference it
- It imports from `@workspace/lib` and `@workspace/ui`, which are available to apps too
- It is not and will never be a generic reusable package -- it is deeply customized for Eigen
- Keeping it in `packages/` implies it is a shared library, which is misleading

**Recommendation: Move it.** The path would be `apps/sheets/src/fortune-sheet/`. Benefits:
1. Makes the dependency explicit and reduces cognitive load
2. Eliminates the workspace package indirection
3. Colocates all sheets code in one place
4. The `@workspace/fortune-sheet` import alias becomes unnecessary
5. Simplifies the build -- one fewer package to typecheck independently

**Migration path**:
1. Move `packages/fortune-sheet/src/` to `apps/sheets/src/fortune-sheet/`
2. Update imports in `apps/sheets/` from `@workspace/fortune-sheet` to relative paths
3. Move `packages/fortune-sheet/package.json` dependencies into `apps/sheets/package.json`
4. Remove `packages/fortune-sheet/` entirely
5. Update `tsconfig.json` path mappings

### Refactoring Recommendations (Prioritized)

#### Phase 1 -- Quick Wins

1. **Remove console.log statements from `use-sheet.ts`** -- 13 debug traces in production code
2. **Fix MIME type typo** -- `application-eigensheet` (missing `s`) used in three route files (see Sheets App
   issues below). This may cause the index redirect and `onAfterAction` navigations to show no content.
3. **Fix `LinkEidtCard` directory name** -- rename to `LinkEditCard`, update all imports
4. **Delete `css.d.ts`** once all CSS files are removed (not yet -- 5 remain)

#### Phase 2 -- CSS Migration

5. **Migrate `ScrollBar/index.css`** (40 lines) -- smallest, low risk
6. **Migrate `LinkEidtCard/index.css`** (182 lines) -- self-contained component
7. **Migrate `ContextMenu/index.css`** (282 lines) -- shared by 2 components
8. **Migrate `SheetTab/index.css`** (280 lines) -- tab area styling
9. **Migrate `SheetOverlay/index.css`** (956 lines) -- largest, most complex, needs core/ ID audit first

#### Phase 3 -- Package Relocation

10. **Move fortune-sheet from `packages/` to `apps/sheets/src/`**

#### Phase 4 -- Type Safety

11. **Eliminate `as any` casts in components** (43 across 15 files)
12. **Address `@ts-ignore` directives in core** (70 across 14 files)
13. **Replace native form elements in CustomSort** -- native `<input type="checkbox/radio">` and `<select>`
    with shadcn equivalents

---

## Sheets App Analysis

### Architecture Compliance

The sheets app follows Eigen patterns well:

| Pattern | Status | Notes |
|---------|--------|-------|
| AppShell wrapper | Yes | `__root.tsx` uses `AppShell` with conditional sidebar |
| Auth guard | Yes | `_auth.tsx` with `beforeLoad` redirect |
| DriveLayout | Yes | `_auth._sidebar.mime.$mimeType.tsx` uses shared `DriveLayout` |
| Shared hooks | Yes | Uses `useCollabDocumentInfo`, `useMimeContent`, `usePathInfo`, etc. |
| EigenApp provider | Yes | `main.tsx` wraps with `EigenApp` |
| File-based routing | Yes | TanStack Router with proper route tree |
| No direct useQuery | Yes | All data fetching through `@workspace/lib` hooks |

### Issues Found

#### Critical

1. **MIME type typo in 3 route files** -- `application-eigensheet` instead of `application-eigensheets`:
   - `/apps/sheets/src/routes/index.tsx:12` -- index redirect uses `application-eigensheet`
   - `/apps/sheets/src/routes/_auth._sidebar.mime.$mimeType.tsx:81` -- onAfterAction uses `application-eigensheet`
   - `/apps/sheets/src/routes/_auth._sidebar.shared.$to.tsx:88` -- onAfterAction uses `application-eigensheet`

   The sidebar correctly uses `application-eigensheets` (line 33 and 59 of `sheets-sidebar.tsx`). This mismatch
   means: (a) the index page redirects to a MIME filter that may not match any files, (b) after file operations
   the user is navigated to a non-functional view.

   The MIME type constant in `packages/lib/src/types/drive.ts:19` is `application/eigensheets` (with slashes
   for DB, hyphens for URLs). The correct URL form is `application-eigensheets`.

#### Important

2. **Excessive console logging in `use-sheet.ts`** -- 13 console.log/warn/error calls for routine operations
   (connecting, syncing, flushing snapshots). These should be removed or gated behind a debug flag.

3. **`__root.tsx` function named `DocsRoot`** (`/apps/sheets/src/routes/__root.tsx:18`) -- Copy-paste artifact
   from the docs app. Should be renamed to `SheetsRoot` for clarity.

4. **DriveContext defined in `__root.tsx`** (`/apps/sheets/src/routes/__root.tsx:9-12`) -- This creates a
   `DriveContext` with a `DriveContextType` from `@workspace/lib`. Other apps (docs, stickies, slides) likely
   have the same pattern duplicated. Consider whether this should be a shared pattern in `@workspace/ui`.

5. **`interface` usage** (`/apps/sheets/src/routes/__root.tsx:14-16`) -- `interface MyRouterContext` violates
   the "always `type` over `interface`" rule from CLAUDE.md.

#### Minor

6. **`onSave` empty callback** (`/apps/sheets/src/components/sheets-sidebar.tsx:88`) -- `onSave={() => {}}`
   is a no-op prop passed to `DriveCreateSheets`. If it is optional in the component, it should be omitted.

7. **Unused import** (`/apps/sheets/src/routes/_auth._sidebar.shared.$to.tsx:7`) -- `EigenLoader` is imported
   and used, but `useContext` from `'react'` is also imported (used). However, `uid` is destructured from
   `Route.useSearch()` at line 24 but `uid` is not declared in `validateSearch` at line 14-16 -- the search
   params type only declares `pid`. This means `uid` will always be `undefined` from the validated search,
   though it may work via raw URL params.

8. **Hardcoded `defaultValue="1"` in context menu inputs** -- The insert row/column inputs in
   `ContextMenu/index.tsx` default to "1" but this is not localized.

### Component Quality

The app components are clean and well-structured:

- **`editor.tsx`** (84 lines) -- Clean composition of fortune-sheet Workbook with toolbar items. Good use of
  `useCallback` and `useMemo` to prevent unnecessary re-renders. The `TOOLBAR_ITEMS` config is a clean
  declarative pattern.

- **`toolbar.tsx`** (111 lines) -- Well-structured File menu with proper state management for dialogs.
  Uses shared components (`DriveCreateSheets`, `DriveDeleteItem`, `DriveRenameItem`, `RevisionHistory`,
  `DocumentModeButton`). Clean separation of left/right toolbar items.

- **`use-sheet.ts`** (218 lines) -- Solid Yjs integration hook. Proper cleanup on unmount (disconnect,
  destroy doc, clear refs). The debounced snapshot saving with `beforeunload` flush is well-designed.
  The `handleRestore` function for revision history correctly handles both Y.Map and Y.Array types.

- **`sheets-sidebar.tsx`** (95 lines) -- Standard sidebar following the pattern from other apps.

---

## Overall Recommendations

### Priority 1: Fix Bugs
1. **Fix the MIME type typo** (`application-eigensheet` -> `application-eigensheets`) in 3 route files.
   This is likely causing broken navigation in production.

### Priority 2: Clean Up Noise
2. Remove 13 `console.log` statements from `use-sheet.ts`
3. Rename `DocsRoot` to `SheetsRoot` in `__root.tsx`
4. Change `interface MyRouterContext` to `type MyRouterContext`

### Priority 3: Move Fortune-Sheet
5. Move `packages/fortune-sheet/` into `apps/sheets/src/fortune-sheet/`. The package is only used by the
   sheets app, and keeping it in `packages/` misleadingly implies it is a shared library.

### Priority 4: Continue CSS Migration
6. Follow the phased plan in `docs/FORTUNE-SHEETS-TODO.md` -- it is thorough and accurate. Start with the
   smallest files (`ScrollBar/index.css` at 40 lines, `LinkEidtCard/index.css` at 182 lines) and work up
   to `SheetOverlay/index.css` (956 lines). The CLEANUP-NOTES.md warning about `luckysheet-*` DOM selectors
   is critical -- always check core/ before removing any class name.

### Priority 5: Type Safety
7. Systematically replace `as any` casts in component files (43 total). Many are in locale key access
   patterns (`(rightclick as any)[dir]`) that could be fixed with proper locale types.

### On the Core Engine
The core engine (`core/` directory, ~42K lines) has significant technical debt (70 `@ts-ignore`, 5,434-line
mouse handler, 3,550-line formula module) but it **works**. Refactoring it is high-risk, low-reward relative
to the UI layer cleanup. The existing documentation in `CLEANUP-NOTES.md` and `RENDERING.md` is excellent
and provides the necessary context for anyone who needs to touch core/ in the future.
