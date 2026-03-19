# FE Code Review: Sheets

## Summary

The Sheets frontend is a thin integration layer connecting the forked `packages/fortune-sheet` Workbook component to
Eigen's Drive, collab (Yjs), and routing infrastructure. The app itself is well-structured with proper route guards,
layout integration, and shared UI component usage. However, it has several `as any` casts that break Eden Treaty's
end-to-end type safety, uses `interface` where `type` is required by convention, has an unbounded Yjs ops array that
will grow indefinitely, and contains copy-paste naming from the Docs app. The fortune-sheet package has extensive
hardcoded colors that break dark mode, many `as any` casts in locale lookups, and legacy CSS files still pending
migration.

**Files reviewed:**

**Sheets app (`apps/sheets/src/`):**

- `main.tsx`, `routes/__root.tsx`, `routes/_auth.tsx`, `routes/_auth._sidebar.tsx`
- `routes/_auth._sidebar.mime.$mimeType.tsx`, `routes/_auth._sidebar.shared.$to.tsx`
- `routes/_auth.sheet.$ownerId.$mountId.$pathId.tsx`, `routes/index.tsx`, `routes/login.tsx`
- `components/sheets-sidebar.tsx`, `components/sheets/editor.tsx`
- `components/sheets/hooks/use-sheet.ts`, `components/sheets/toolbar.tsx`
- `css/globals.css`

**Shared (`packages/lib/`):**

- `packages/lib/src/core/collab/hooks/use-collab.ts`
- `packages/lib/src/core/drive/hooks/use-drive.ts` (useCreateSheets)

**Fortune-sheet (`packages/fortune-sheet/`):**

- `src/index.ts`, `src/components/index.ts`
- `src/components/Workbook/index.tsx`, `src/components/Workbook/api.ts`

## Critical Issues

### 1. Yjs ops array grows without bound

**File:** `apps/sheets/src/components/sheets/hooks/use-sheet.ts`, line 138

```typescript
doc.getArray('ops').push([ops]);
```

Every edit pushes ops to the Yjs `Y.Array('ops')`. This array is never truncated, compacted, or cleared. Unlike the
Yjs document state (which benefits from garbage collection via `doc.gc = true` on the server), the ops array is an
append-only log of every operation ever performed. Over a long editing session or across many sessions, this array
grows indefinitely.

New clients joining the document must sync the entire ops array (including all historical ops they don't need, since
the snapshot already captures the current state). This increases initial sync time and memory usage proportionally to
the document's edit history.

**Impact:** Performance degradation over time. Large documents become slow to open as the ops array accumulates
thousands of entries.

**Fix:** Periodically compact the ops array. After flushing a snapshot, the ops array could be cleared since the
snapshot captures the full state. Alternatively, maintain a "high water mark" and skip ops older than the last
snapshot during observation. This requires coordination: remote observers ignore ops older than their initial sync
point, which `readyForOpsRef` partially handles for skipping pre-sync ops but does not handle for very old ops
accumulated before the current session.

### 2. `as any` casts break end-to-end type safety

**File:** `apps/sheets/src/components/sheets/hooks/use-sheet.ts`, lines 76, 176

```typescript
(delta.insert as any[][]).forEach((ops) => {      // line 76
localType.set(k, v as any);                        // line 176
```

**File:** `apps/sheets/src/components/sheets/editor.tsx`, line 46

```typescript
saveSnapshot(data as any);   // line 46
```

CLAUDE.md states: "Never use `as any` -- fix the type at the source." The `data as any` cast on line 46 of
`editor.tsx` is particularly concerning because the `onChange` callback receives `Record<string, any>[]` from the
Workbook but `saveSnapshot` expects `SheetData[]`. The cast hides a potential type mismatch.

**Impact:** Type errors at the Workbook/Sheets integration boundary are silently suppressed. If the Workbook's
`onChange` shape changes, no compile-time error will surface.

**Fix:**

- Line 46: Type the `onChange` callback parameter as `SheetData[]` directly, or cast to the specific type
  (`data as SheetData[]`) rather than `any`.
- Line 76: Type the delta insert as `Op[][]` based on the known push format.
- Line 176: Use a proper type for the Yjs map values being restored.

### 3. `interface` used instead of `type`

**File:** `apps/sheets/src/routes/__root.tsx`, line 14

```typescript
interface MyRouterContext {
    auth: AuthContextType
}
```

**File:** `apps/sheets/src/components/sheets-sidebar.tsx`, line 12

```typescript
interface SheetsSidebarProps {
```

CLAUDE.md requires `type` over `interface` except when methods are needed. Neither of these has methods.

**Fix:** Change to `type MyRouterContext = { auth: AuthContextType }` and
`type SheetsSidebarProps = { ... }`.

## Pattern Violations

### 4. Root component named `DocsRoot` instead of `SheetsRoot`

**File:** `apps/sheets/src/routes/__root.tsx`, lines 18, 61

```typescript
function DocsRoot() {    // line 18
    component: DocsRoot, // line 61
```

This is clearly copy-pasted from the Docs app and never renamed. While it has no runtime impact, it harms
readability and will confuse anyone searching for "Docs" references.

**Fix:** Rename to `SheetsRoot`.

### 5. `flushSnapshot` dependency array is empty but captures `docRef`

**File:** `apps/sheets/src/components/sheets/hooks/use-sheet.ts`, lines 34-49

```typescript
const flushSnapshot = useCallback(() => {
    const doc = docRef.current;
    const pending = pendingSnapshotRef.current;
    if (!doc || !pending) { return; }
    // ...
    doc.transact(() => {
        doc.getMap('state').set('snapshot', pending);
    });
    hasFlushedRef.current = true;
}, []);   // <-- empty deps
```

The empty dependency array is technically correct because it only reads `.current` from refs. However,
`hasFlushedRef.current = true` is a side effect that makes the snapshot saving behavior stateful across calls. The
first call to `saveSnapshot` always flushes immediately (because `hasFlushedRef.current` is `false`), but subsequent
calls are debounced at 1000ms. This is intentional but undocumented.

**Impact:** Not a bug, but the non-obvious "first flush is immediate, rest are debounced" behavior should have a
comment explaining why.

### 6. `onOp` wrapper is unnecessary

**File:** `apps/sheets/src/components/sheets/editor.tsx`, lines 41-43

```typescript
const onOp = useCallback((ops: any[]) => {
    handleOp(ops);
}, [handleOp]);
```

This is a passthrough wrapper that adds no logic. It could be replaced with `handleOp` directly, which is already
a stable `useCallback`.

**Fix:** Pass `handleOp` directly to the `Workbook` component's `onOp` prop.

### 7. `onChange` callback uses `any` cast and `Record<string, any>[]` type

**File:** `apps/sheets/src/components/sheets/editor.tsx`, lines 45-47

```typescript
const onChange = useCallback((data: Record<string, any>[]) => {
    saveSnapshot(data as any);
}, [saveSnapshot]);
```

The `Record<string, any>[]` type annotation discards all type information from the Workbook's `Sheet` type.
Combined with the `as any` cast, this is a double type safety violation.

**Fix:** Import `Sheet` (or `SheetData`) from fortune-sheet and type `data` properly:
`const onChange = useCallback((data: SheetData[]) => { saveSnapshot(data); }, [saveSnapshot]);`

### 8. `useSheet` `flushSnapshot` excluded from useEffect cleanup deps

**File:** `apps/sheets/src/components/sheets/hooks/use-sheet.ts`, line 131

The `useEffect` cleanup at line 121-130 calls `handleBeforeUnload()` which flushes the snapshot, but `flushSnapshot`
is not in the dependency array of the effect. Since `flushSnapshot` has an empty dependency array itself, this is
safe, but it means the cleanup references a stale closure if `flushSnapshot` were ever to gain dependencies.

**Impact:** Currently safe, but fragile.

## Security Concerns

### 9. Snapshot JSON is stored and parsed without size limits

**File:** `apps/sheets/src/components/sheets/hooks/use-sheet.ts`, lines 89-104, 143-148

The snapshot is stored as `JSON.stringify(data)` of the entire sheet state. A malicious collaborator could create a
sheet with millions of cells, causing:

- `JSON.stringify` to produce a multi-gigabyte string
- `JSON.parse` on the receiving end to consume excessive memory

This is client-side only (the server just stores it as an opaque Yjs value), but could cause browser tab crashes for
all collaborators.

**Impact:** Denial of service for other collaborators via memory exhaustion.

**Fix:** Consider adding a size check before `JSON.stringify` (e.g., max cell count), or truncating the snapshot if
it exceeds a threshold.

## Data Integrity

### 10. Remote ops may arrive before workbook is ready

**File:** `apps/sheets/src/components/sheets/hooks/use-sheet.ts`, lines 67-85

The ops observer is set up immediately on the Yjs doc, but ops are only processed when `readyForOpsRef.current` is
true (set after initial sync). If a remote op arrives during the sync phase, it is silently dropped. This is
intentional (the initial sync includes the snapshot), but if a remote op arrives in the narrow window between the
sync completing and `readyForOpsRef` being set to `true` (lines 106-107), it could be missed.

```typescript
wsProvider.on('sync', (isSynced: boolean) => {
    if (!isSynced) return;
    // ... parse snapshot, set initial data ...
    setInitialData(data);         // line 105
    setSynced(true);              // line 106
    readyForOpsRef.current = true; // line 107
});
```

Since the sync callback and the observer both run synchronously in the Yjs event loop, this race is unlikely in
practice. However, if `setInitialData` triggers a React render that processes microtasks, a remote op could slip in.

**Impact:** Very rare -- remote op could be silently dropped during initial load.

### 11. `handleRestore` does not clear the ops array

**File:** `apps/sheets/src/components/sheets/hooks/use-sheet.ts`, lines 160-199

When restoring a revision, the `handleRestore` function replaces the content of `Y.Map('state')` and `Y.Array` types
from the restored document. However, `Y.Array('ops')` will still contain all the historical ops from before the
restore. After the restore, remote clients may try to re-apply stale ops from the ops array.

**Impact:** After a revision restore, remote clients could receive and apply ops that refer to the pre-restore
state, causing state corruption or console errors.

**Fix:** Clear the ops array as part of the restore transaction:

```typescript
doc.transact(() => {
    // ... existing restore logic ...
    doc.getArray('ops').delete(0, doc.getArray('ops').length);
});
```

### 12. `isLocalOpRef` flag is not reset on failed apply

**File:** `apps/sheets/src/components/sheets/hooks/use-sheet.ts`, lines 133-139

```typescript
const handleOp = useCallback((ops: any[]) => {
    const doc = docRef.current;
    if (!doc || ops.length === 0) return;
    isLocalOpRef.current = true;
    doc.transact(() => {
        doc.getArray('ops').push([ops]);
    });
}, []);
```

The `isLocalOpRef` is set to `true` before the transact, and reset to `false` in the observer (line 70). If the
transact throws an exception (e.g., document destroyed), `isLocalOpRef` remains `true`, causing the next remote op
to be silently skipped.

**Impact:** If a local op fails to push, the next incoming remote op is incorrectly treated as local and dropped.

**Fix:** Use try/finally to ensure the flag is reset:

```typescript
isLocalOpRef.current = true;
try {
    doc.transact(() => { doc.getArray('ops').push([ops]); });
} catch (e) {
    isLocalOpRef.current = false;
    throw e;
}
```

## Code Quality

### 13. `SheetData` type is overly loose

**File:** `apps/sheets/src/components/sheets/hooks/use-sheet.ts`, line 7

```typescript
export type SheetData = Record<string, any> & { name: string };
```

This type provides almost no type safety -- it only requires a `name` field and allows any other properties. The
fortune-sheet package has a proper `Sheet` type that includes all the expected fields (id, order, celldata, config,
data, etc.).

**Fix:** Import and use the `Sheet` type from `@workspace/fortune-sheet` core, or extend it:

```typescript
import type { Sheet } from '@workspace/fortune-sheet';
export type SheetData = Sheet;
```

### 14. Empty `onSave` callback in sidebar

**File:** `apps/sheets/src/components/sheets-sidebar.tsx`, lines 87-88

```typescript
onSave={() => {
}}
```

This is an empty callback that does nothing. If `onSave` is optional in the `DriveCreateSheets` component, it should
not be passed at all.

**Fix:** Remove the `onSave` prop or implement the intended behavior.

### 15. `useRootFolder` call with empty string when user is null

**File:** `apps/sheets/src/routes/__root.tsx`, line 21

```typescript
const {data: root} = useRootFolder(user?.id || '', mountId);
```

When `user` is null (pre-auth), this calls `useRootFolder('')` which will make an API call with an empty ownerId.
The query should be disabled when there is no user.

**Impact:** Unnecessary API call that will fail.

**Fix:** Add `enabled: !!user?.id` to the hook, or check if the hook already handles this internally.

### 16. Duplicate `ToolbarLeftItems` and `ToolbarRightItems` props

**File:** `apps/sheets/src/components/sheets/editor.tsx`, lines 49-55

```typescript
const leftItems = useMemo(() => (
    <ToolbarLeftItems path={path} canWrite={canWrite} onAccessDialogOpen={onAccessDialogOpen} onRestore={handleRestore}/>
), [path, canWrite, onAccessDialogOpen, handleRestore]);

const rightItems = useMemo(() => (
    <ToolbarRightItems path={path} canWrite={canWrite} onAccessDialogOpen={onAccessDialogOpen} onRestore={handleRestore}/>
), [path, canWrite, onAccessDialogOpen, handleRestore]);
```

Both components receive `onRestore` but only `ToolbarRightItems` uses it (via `RevisionHistory`).
`ToolbarLeftItems` accepts `onRestore` in its type but never uses it.

**Impact:** Unused prop creates confusion about where restore functionality lives.

**Fix:** Remove `onRestore` from `ToolbarLeftItems`'s props type and the call site.

## Architecture

### 17. Fortune-sheet package has extensive hardcoded colors breaking dark mode

**Files:** Multiple files in `packages/fortune-sheet/src/components/`:

- `SheetOverlay/FormulaSearch/index.tsx` (lines 21, 24-25)
- `SheetOverlay/FormulaHint/index.tsx` (lines 18, 29, 61, 85-86, 96-97)
- `DataVerification/index.tsx` (lines 224, 226, 254, 259, 305, 358, 373, 396, 463, 500, 566)
- `LocationCondition/index.tsx` (line 143)
- `SplitColumn/index.tsx` (lines 67, 70, 131)

Examples: `border-[#d4d4d4]`, `bg-[#f5f5f5]`, `text-[#222]`, `text-[#444]`, `text-[#666]`, `border-[#e1e4e8]`,
`border-[#ebebeb]`, `border-[#dfdfdf]`, `text-[#535353]`.

CLAUDE.md requires theme tokens (`text-muted-foreground`, `bg-muted`, `border`) instead of hardcoded colors.

**Impact:** Dark mode is broken in all affected components. Formula hints, data verification dialogs, location
conditions, and split column dialogs render with light-mode colors on dark backgrounds.

**Fix:** Replace hardcoded color classes with theme tokens as documented in FORTUNE-SHEETS-TODO.md Phase 1 (item 5).

### 18. Five legacy CSS files remain in fortune-sheet

**Files:**

- `packages/fortune-sheet/src/components/SheetOverlay/index.css` (957 lines)
- `packages/fortune-sheet/src/components/SheetTab/index.css` (281 lines)
- `packages/fortune-sheet/src/components/ContextMenu/index.css` (283 lines)
- `packages/fortune-sheet/src/components/LinkEidtCard/index.css` (183 lines)
- `packages/fortune-sheet/src/components/SheetOverlay/ScrollBar/index.css` (size unknown)

These CSS files contain extensive hardcoded colors (`#fff`, `#ccc`, `#0188fb`, etc.) and `luckysheet-*` class names
from the original LuckySheet project. This is tracked in FORTUNE-SHEETS-TODO.md but bears mentioning as it affects
the overall Sheets dark mode story.

### 19. Fortune-sheet `Workbook/api.ts` uses `as any` for dynamic API dispatch

**File:** `packages/fortune-sheet/src/components/Workbook/api.ts`, lines 354-355

```typescript
if (typeof (api as any)[name] === "function") {
    (api as any)[name](draftCtx, ...args);
}
```

The `batchCallApis` method uses dynamic dispatch with `as any` to call arbitrary API methods by name string.

**Impact:** No type safety on API call arguments in batch operations. Typos in API names only fail at runtime.

**Fix:** Type `name` as `keyof typeof api` and use a type-safe dispatch pattern.

### 20. Fortune-sheet has ~40 `as any` casts for locale lookups

**Files:** `packages/fortune-sheet/src/components/ContextMenu/index.tsx`,
`DataVerification/index.tsx`, `ConditionFormat/index.tsx`, `ConditionFormat/ConditionRules.tsx`,
`LocationCondition/index.tsx`

Pattern: `(rightclick as any)[dir]`, `(dataVerification as any)[v]`, `(conditionformat as any)[v]`

These casts are needed because the locale objects are typed as specific interfaces but accessed with dynamic keys.

**Fix:** Type the locale objects with an index signature `Record<string, string>` or use a typed lookup helper.

## Positive Patterns

- **Clean route structure**: Proper auth guards (`_auth.tsx`), sidebar layout (`_auth._sidebar.tsx`), and full-screen
  editor route (`_auth.sheet.$ownerId.$mountId.$pathId.tsx`)
- **Shared UI adoption**: Toolbar uses `DriveCreateSheets`, `DriveDeleteItem`, `DriveRenameItem`, `RevisionHistory`,
  `DocumentModeButton`, and `DriveAccessDialog` from the shared UI library
- **Op-based Yjs sync**: The ops-through-Y.Array pattern avoids full-document snapshot conflicts, enabling granular
  collaborative editing
- **Debounced snapshot saving**: The 1-second debounce with immediate first flush and `beforeunload` flush prevents
  data loss while minimizing Yjs transactions
- **Proper `useCallback`/`useMemo`**: The editor component correctly memoizes toolbar items and callbacks to avoid
  unnecessary Workbook re-renders
- **CSS overrides use theme variables**: The `css/globals.css` file uses `var(--color-border)` and
  `var(--color-background)` for toolbar and formula bar styling, properly integrating with the theme system
- **`SharedDrive.createSheets` override exists**: New sheets can be created on team drives without 404 errors
- **Data hooks live in `packages/lib`**: `useCollabDocumentInfo`, `useCreateSheets`, `useRootFolder` are all in the
  shared library as required by CLAUDE.md

## Recommendations

| Priority | Issue | Description                                                                 |
|----------|-------|-----------------------------------------------------------------------------|
| **P0**   | #1    | Implement ops array compaction to prevent unbounded growth                  |
| **P0**   | #11   | Clear ops array during revision restore to prevent state corruption         |
| **P1**   | #2    | Replace `as any` casts with proper types in `use-sheet.ts` and `editor.tsx` |
| **P1**   | #12   | Add try/finally around `isLocalOpRef` flag set/reset                        |
| **P1**   | #13   | Replace loose `SheetData` type with fortune-sheet's `Sheet` type            |
| **P1**   | #17   | Replace hardcoded colors with theme tokens in fortune-sheet components      |
| **P2**   | #3    | Change `interface` to `type` in `__root.tsx` and `sheets-sidebar.tsx`       |
| **P2**   | #4    | Rename `DocsRoot` to `SheetsRoot`                                           |
| **P2**   | #6    | Remove unnecessary `onOp` wrapper callback                                  |
| **P2**   | #7    | Type `onChange` parameter properly instead of `Record<string, any>[]`       |
| **P2**   | #9    | Consider snapshot size limits for DoS prevention                            |
| **P2**   | #14   | Remove empty `onSave` callback                                              |
| **P2**   | #15   | Guard `useRootFolder` against empty user ID                                 |
| **P2**   | #16   | Remove unused `onRestore` prop from `ToolbarLeftItems`                      |
| **P2**   | #18   | Continue fortune-sheet CSS migration per FORTUNE-SHEETS-TODO.md             |
| **P2**   | #19   | Type `batchCallApis` dispatch safely                                        |
| **P2**   | #20   | Add typed locale lookup helper to eliminate `as any` casts                  |
