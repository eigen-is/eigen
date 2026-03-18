# Frontend Code Review: Collaborative Apps (Docs, Stickies, Slides, Sheets)

## Summary

The four collaborative apps share a common architecture: Yjs documents synced via WebSocket for real-time collaboration,
Drive-based storage and ACL, and a shared `useCollabDocumentInfo` hook for loading document metadata and permissions.
Each app has its own Yjs integration pattern tailored to its domain (Tiptap for docs, custom Yjs maps/arrays for
stickies/slides, op-based sync for sheets). All four apps follow the project's layout conventions with `AppShell`,
sidebar/fullscreen toggling based on route matching, and centralized hooks in `packages/lib`.

**Code quality overview:**

- **Docs**: Most mature, well-integrated Tiptap + Yjs with clipboard support, media references, and comment threads.
- **Stickies**: Solid Yjs integration with normalization, good drag-and-drop implementation.
- **Slides**: Feature-rich editor with snap lines, presentation mode, clipboard, and z-ordering.
- **Sheets**: Minimal integration layer over fortune-sheet, op-based Yjs sync with snapshot debouncing.

## Architecture Compliance

**Passes (all four apps):**

- Auth guard via `_auth.tsx` with `beforeLoad` redirect.
- `EigenApp` provider stack wrapping the router.
- `AppShell` with sidebar toggling based on route matching.
- `DriveContext` providing `rootPath` and `mountId` to child routes.
- `useCollabDocumentInfo` from `@workspace/lib/collab` for document info/permissions (not direct `useQuery` in apps).
- Media references stored as names (not pathIds) in Yjs, resolved at render time via `MediaResolverProvider`.
- Permission checks (`canRead`, `canWrite`) before rendering editor/board.
- Revision history support via `RevisionHistory` component and `handleRestore`.
- Consistent toolbar pattern with File menu, undo/redo, share button, and read-only mode indicator.

**Notable compliance details:**

- `packages/lib/src/core/collab/hooks/use-collab.ts` centralizes the collab document info hook -- all four apps use
  this rather than making their own queries.
- The `MediaResolverProvider` wrapping pattern is consistently applied: docs (`editor.tsx:74`),
  stickies (`board.tsx:163`), slides (`editor.tsx:88`).
- Sheets does not use `MediaResolverProvider` (correct -- sheets have no embedded media).

## Issues Found

### Critical

1. **Stickies `useBoard` returns stale `yjsDoc` and `undoManager` refs**
   (`apps/stickies/src/components/stickies/hooks/use-board.ts:218-219`)

   The hook returns `docRef.current` and `undoManager.current` directly. Since these are `.current` values read at the
   time the hook's return statement executes, they capture the value at that instant. The `useEffect` that creates the
   `Y.Doc` runs asynchronously after the first render, so on the initial render, `docRef.current` is `null`. The
   returned `yjsDoc` will be `null` on the first render, and components receiving it will see `null` until a re-render
   is triggered by the Yjs observer callbacks.

   This is the same issue in `useDeck` (`apps/slides/src/components/slides/hooks/use-deck.ts:452-453`).

   The problem manifests as: if a user interacts (e.g., adds a card) before the first Yjs observer fires (which
   triggers `setBoard`), the `yjsDoc` will be `null` and the operation silently fails (guarded by `if (!docRef.current)
   return`). This is a race condition window, not a guaranteed failure.

   **Impact:** Low probability in practice (the WebSocket sync callback triggers `setBoard` quickly), but the pattern is
   fragile. A cleaner approach would be to expose `yjsDoc` as state (`useState`) set inside the effect.

### Important

1. **Docs editor creates a new `Y.Doc` on every render when `path` changes, but the WebSocket URL depends on
   `path.id`**
   (`apps/docs/src/components/docs/editor.tsx:51-67`)

   The `yDoc` is created with `useMemo(() => new Y.Doc(), [])` (empty deps -- created once). The `WebsocketProvider`
   effect depends on `[yDoc, path.ownerId, path.mountId, path.id]`. If the user navigates to a different document
   without unmounting the component, the old Y.Doc is reused with a new WebSocket URL. Since `useMemo` has `[]` deps,
   the Y.Doc persists across path changes within the same component instance. The effect will destroy the old provider
   and create a new one pointed at the new document, but the Y.Doc still contains the old document's data until the new
   provider syncs.

   This could briefly flash the previous document's content during navigation between documents. In practice, the
   component likely unmounts and remounts due to the route structure (`/$ownerId/$mountId/$pathId`), but if the route
   params change without unmounting, this would be a visible glitch.

   **Recommendation:** Add `path.id` to the `useMemo` deps for `yDoc`, or better, use a `key` prop on
   `CollaborativeEditor` to force remounting on path change (the parent route component at
   `apps/docs/src/routes/_auth.doc.$ownerId.$mountId.$pathId.tsx` could add `key={pathId}`).

2. **Sheets: excessive `console.log` statements left in production code**
   (`apps/sheets/src/components/sheets/hooks/use-sheet.ts` -- lines 38, 46, 47, 51, 64, 94, 101, 105, 119, 158, 197)

   The `useSheet` hook contains 11 `console.log` statements used for debugging the Yjs sync flow. These will produce
   noisy output in production browser consoles.

3. **Sheets: snapshot debouncing creates a data loss window**
   (`apps/sheets/src/components/sheets/hooks/use-sheet.ts:161-165`)

   After the first flush, subsequent snapshots are debounced with a 1-second timer. If the user closes the tab within
   that 1-second window and the `beforeunload` handler fails (which is unreliable across browsers, especially on
   mobile), the last snapshot is lost. The ops themselves are synced immediately via Yjs, so the data is recoverable
   by replaying ops, but the snapshot used to initialize new joiners will be stale.

   **Recommendation:** Consider using `navigator.sendBeacon()` as a more reliable unload mechanism, or reducing the
   debounce window.

4. **Stickies and Slides: duplicated `jsonToYType` utility function**
   (`apps/stickies/src/components/stickies/board.tsx:20-34` and
   `apps/slides/src/components/slides/editor.tsx:62-76`)

   The same recursive JSON-to-Yjs-type conversion function is duplicated verbatim in both apps. This should be
   extracted into a shared utility in `packages/lib`.

5. **Stickies and Slides: duplicated revision restore logic**
   (`apps/stickies/src/components/stickies/board.tsx:89-113`,
   `apps/slides/src/components/slides/editor.tsx:340-364`,
   `apps/sheets/src/components/sheets/hooks/use-sheet.ts:168-208`)

   All three apps implement nearly identical logic for restoring a Yjs document from a revision snapshot:
   create a temp doc, apply the update, iterate over shared keys, and transplant the data. This should be a shared
   utility function.

6. **Slides: no write permission check on drag/drop of objects**
   (`apps/slides/src/components/slides/slide-canvas.tsx:72-79`)

   The `handleDrop` callback for image drops checks `onDropImage` existence but the parent only passes `onDropImage`
   when `canWrite` is true (`editor.tsx:461`). However, the `handleDragOver` at line 81-84 always calls
   `e.preventDefault()` and sets `dropEffect = 'copy'`, giving the user visual feedback that a drop will work even when
   read-only. The drop itself is correctly blocked (no `onDropImage`), but the cursor feedback is misleading.

7. **Slides: `useDeck` does not handle WebSocket disconnection/reconnection gracefully**
   (`apps/slides/src/components/slides/hooks/use-deck.ts:65-123`)

   The `WebsocketProvider` is configured with `resyncInterval: 5000` and `connect: true`, which handles reconnection at
   the Yjs level. However, there is no UI indication of connection status (connected/syncing/disconnected). The docs app
   at least shows `<EigenLoader/>` until `connected` is true
   (`apps/docs/src/components/docs/editor.tsx:69-71`). Stickies and Slides render immediately without waiting for sync,
   which could show an empty board/deck while the initial sync is in progress.

   Actually, stickies and slides both have the `initializeDefaultBoard`/`initializeDefaultDeck` call inside the `sync`
   callback, so they do wait for sync before initializing. But the UI renders `board.columnOrder.length > 1` check with
   `visibility: hidden` as a workaround (`apps/stickies/src/components/stickies/board.tsx:176`). There is no loading
   spinner during the sync phase for stickies/slides.

8. **Docs: `editorRef.current = editor` is assigned during render**
   (`apps/docs/src/components/docs/editor.tsx:270`)

   The line `editorRef.current = editor` is a side effect during render, which is not recommended in React 19 strict
   mode. The `editor` value comes from `useEditor` and is assigned to a ref so that async callbacks
   (`handleImageUpload`, `handleEigenImagePaste`) can access the latest editor instance. A safer pattern would be to use
   `useEffect` to update the ref.

### Minor

1. **All four apps: `DocsRoot` function name reused**

   The root route component in stickies (`__root.tsx:18`), slides (`__root.tsx:18`), and sheets (`__root.tsx:18`) is
   named `DocsRoot` -- clearly copy-pasted from the docs app. Should be `StickiesRoot`, `SlidesRoot`, `SheetsRoot`
   respectively for clarity.

2. **All four apps: `interface MyRouterContext` instead of `type`**

   All `__root.tsx` files use `interface MyRouterContext` (e.g., `apps/docs/src/routes/__root.tsx:14`), violating the
   "type over interface" rule. Likely inherited from TanStack Router boilerplate.

3. **Docs sidebar: `interface DocsSidebarProps` instead of `type`**
   (`apps/docs/src/components/docs/docs-sidebar.tsx:16`)

   Uses `interface` instead of `type`.

4. **Sheets sidebar: `interface SheetsSidebarProps` instead of `type`**
   (`apps/sheets/src/components/sheets-sidebar.tsx:13`)

   Uses `interface` instead of `type`.

5. **Stickies: `any` type assertions throughout Yjs code**

   Pervasive `as Y.Map<any>`, `as Y.Array<any>` casts across `use-board.ts`, `use-drag-and-drop.ts`,
   `normalize-board.ts`, `card-settings-dialog.tsx`, `column-settings-dialog.tsx`. While Yjs's type system makes this
   somewhat unavoidable, a typed wrapper (e.g., `getYjsMap<T>(doc, key)`) would improve safety.

6. **Slides: `deck` dependency in `duplicateSlide` callback**
   (`apps/slides/src/components/slides/hooks/use-deck.ts:218`)

   `useCallback` for `duplicateSlide` depends on `[deck]`, meaning it is recreated on every deck state update. Since
   `deck` is the full state object that changes on every Yjs observer event, this callback is effectively never memoized.
   The `deck.slides` and `deck.objects` lookups inside could instead read from the Yjs doc directly (via `docRef`).

7. **Slides: `SortableSlide` component has unused `isDragOverlay` prop**
   (`apps/slides/src/components/slides/slide-panel.tsx:99`)

   The `isDragOverlay` parameter is declared but never passed as `true` from any call site.

8. **Stickies: `CardSettingsDialog` initial state from props without reset on prop change**
   (`apps/stickies/src/components/stickies/card-settings-dialog.tsx:25-26`)

   `useState(cardTitle)` and `useState(cardDescription)` capture the initial value from props. If the card is edited
   by another collaborator while the dialog is open, the local state will not update. This is a minor UX issue for
   collaborative editing.

9. **Docs: `comment-dialog.tsx` uses dynamic import for `chatApi`**
   (`apps/docs/src/components/docs/comment-dialog.tsx:43`)

   `const {chatApi} = await import("@workspace/lib/api")` is a dynamic import used inside a mutation callback. This
   is likely done to avoid a circular dependency or to reduce initial bundle size, but it adds async overhead to every
   comment creation. If bundle size is not a concern, a static import would be simpler.

10. **Slides: `getTextStyle` uses `vh` units for font size**
    (`apps/slides/src/components/slides/slide-object.tsx:33`)

    Font size is calculated as `${obj.fontSize / 1080 * 100}vh`. This works in presentation mode (fullscreen) but in
    the editor canvas, the slide is not viewport-height-sized -- it is constrained by the canvas wrapper. Text will
    appear at the wrong size relative to the slide canvas in the editor. The canvas uses percentage-based positioning
    for objects, so the text size should ideally also scale with the canvas container, not the viewport.

    On closer inspection, the editor view uses the same `getTextStyle` via `SlideObjectView`, so text sizes in the
    editor will be wrong if the canvas height differs from the viewport height (which it always does because of the
    toolbar and status bar).

11. **Sheets: `useSheet` effect has `workbookRef` in dependency array**
    (`apps/sheets/src/components/sheets/hooks/use-sheet.ts:138`)

    The `useEffect` depends on `workbookRef`, which is a `useRef` and its identity is stable across renders. However,
    `workbookRef` is a prop passed in from the parent, and ref objects are indeed stable, so this is harmless but
    unnecessary in the dep array.

## Recommendations

1. **Extract shared Yjs utilities** -- `jsonToYType` and the revision restore logic are duplicated across 3 apps.
   Create `packages/lib/src/utils/yjs.ts` with:
    - `jsonToYType(value: unknown): unknown`
    - `restoreYjsDocument(doc: Y.Doc, state: Uint8Array): void`

2. **Add connection status indicators** -- Stickies and Slides render without waiting for Yjs sync. Add a loading state
   (or at minimum a syncing indicator) between WebSocket connection and first sync completion.

3. **Fix font size scaling in Slides** -- Replace `vh`-based font sizing with container-relative sizing. Consider using
   CSS `container-query` units or calculating the scale factor from the canvas container size.

4. **Remove the 11 `console.log` statements** from `use-sheet.ts`.

5. **Rename `DocsRoot`** to the appropriate app name in stickies, slides, and sheets root routes.

6. **Consider adding a `key` prop** to collaborative editor components based on `pathId` to ensure clean remounting
   when navigating between documents of the same type.

7. **Address the stale ref pattern** in `useBoard` and `useDeck` by either:
    - Using `useState` for the Y.Doc (triggers re-render when set), or
    - Adding a `connected`/`synced` state flag that triggers re-render after the doc is ready.

8. **Evaluate `useCallback` dependencies** -- Several callbacks in `useDeck` depend on the full `deck` state object,
   defeating memoization. Refactor to read from `docRef.current` directly where possible.
