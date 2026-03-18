# Frontend Review: Collab Apps (Docs, Stickies, Slides, Sheets)

**Scope:** `apps/{docs,stickies,slides,sheets}/`
**Reviewed:** 2026-03-18

## Critical Issues

1. **Slides and Sheets: MIME type strings are singular instead of plural, causing broken navigation**

   The slides app uses `application-eigenslide` (singular) in its route files, but the actual MIME type is
   `application/eigenslides` (plural, defined as `DRIVE_MIME_SLIDES` in `packages/lib/src/types/drive.ts:18`).
   Similarly, sheets uses `application-eigensheet` instead of `application-eigensheets`.

   This means the index redirect, the `onAfterAction` navigations in the drive routes, and the shared routes all
   navigate to a MIME filter URL with the wrong type string. The sidebar links use the correct plural forms, so
   clicking sidebar items works, but the redirect after creating/deleting a document or the initial `/` redirect will
   filter for a non-existent MIME type, showing an empty list.

   - `apps/slides/src/routes/index.tsx:11` -- `'application-eigenslide'` should be `'application-eigenslides'`
   - `apps/slides/src/routes/_auth._sidebar.mime.$mimeType.tsx:81` -- same
   - `apps/slides/src/routes/_auth._sidebar.shared.$to.tsx:88` -- same
   - `apps/sheets/src/routes/index.tsx:11` -- `'application-eigensheet'` should be `'application-eigensheets'`
   - `apps/sheets/src/routes/_auth._sidebar.mime.$mimeType.tsx:81` -- same
   - `apps/sheets/src/routes/_auth._sidebar.shared.$to.tsx:88` -- same

   **Impact:** After the initial login redirect or post-action navigations, users see an empty file list.
   **Fix:** Replace the 6 singular MIME strings with their plural equivalents. Consider importing and deriving these
   from the shared `DRIVE_MIME_*` constants rather than hardcoding strings.
   **Status:** New finding.

2. **Stickies/Slides: revision restore pushes raw JSON into Y.Array instead of Yjs types**

   In `handleRestore`, the `Y.Array` branch does:
   ```
   localType.push(json);
   ```
   where `json` is the result of `tempDoc.getArray(key).toJSON()` -- a plain JS array. For simple arrays of primitives
   (like `columnOrder` or `slideOrder`), this works fine because `Y.Array.push()` accepts an array of primitives. But
   for arrays whose elements are `Y.Map` instances (like the `ops` array in sheets which contains arrays of op objects),
   the raw JSON objects are pushed as plain objects instead of `Y.Map` instances. This differs from the `Y.Map` branch
   which correctly uses `jsonToYType()` to convert values.

   - `apps/stickies/src/components/stickies/board.tsx:108`
   - `apps/slides/src/components/slides/editor.tsx:359`

   Stickies and Slides currently only store primitive strings in their Y.Arrays (`columnOrder` and `slideOrder`), so this
   is not actively broken. But if a Y.Array ever contains nested maps/arrays, the restore will silently produce plain
   objects instead of collaborative Yjs types. The sheets variant (`use-sheet.ts:189`) has the same issue and *does*
   store complex data in its `ops` array.

   **Impact:** Revision restore of sheets `ops` array produces non-Yjs objects that cannot be collaboratively edited.
   For stickies/slides, latent risk only.
   **Fix:** Use `jsonToYType(v)` for each element pushed to Y.Array in the restore logic, consistent with the Y.Map
   branch.
   **Status:** Expanded from previous review (was noted as "duplicated logic" but the actual bug was not identified).

## Important Issues

3. **Stickies `useBoard` and Slides `useDeck` return stale `.current` values from refs**

   Both hooks return `docRef.current` and `undoManager.current` directly at the bottom of the hook. These are snapshot
   reads of the ref at render time. The `useEffect` that creates the `Y.Doc` and `UndoManager` runs after the first
   render, so on the initial render and until a re-render is triggered by Yjs observers, these values are `null`.

   - `apps/stickies/src/components/stickies/hooks/use-board.ts:218-219`
   - `apps/slides/src/components/slides/hooks/use-deck.ts:452-453`

   The consumer code guards against null (e.g., `undoManager?.undo()`, `if (!yjsDoc) return`), so operations simply
   fail silently during the race window. The window closes quickly when the first Yjs observer fires.

   **Impact:** Low probability in practice. User actions before the first Yjs sync event are silently dropped.
   **Fix:** Store the `Y.Doc` and `UndoManager` in `useState` so setting them triggers a re-render, or add a
   `connected`/`ready` boolean state.
   **Status:** Previously identified; analysis unchanged.

4. **Sheets: 11 `console.log` statements left in production code**

   The `useSheet` hook contains console logging throughout the Yjs sync flow: connection, sync, snapshot parsing,
   flush, restore, and error handling.

   - `apps/sheets/src/components/sheets/hooks/use-sheet.ts` -- lines 38, 46, 51, 64, 94, 101, 105, 119, 158, 184, 197

   **Impact:** Noisy browser console output in production. Some logs include byte counts of snapshot data.
   **Fix:** Remove all `console.log` statements. Keep the `console.error` and `console.warn` calls.
   **Status:** Previously identified; unchanged.

5. **Sheets: snapshot debounce + unreliable `beforeunload` creates a data-loss window**

   After the first flush, snapshots are debounced to 1 second (`use-sheet.ts:164`). If the user closes the tab during
   that window, the `beforeunload` handler attempts a synchronous Yjs transaction. This is unreliable on mobile browsers
   and may be skipped by browsers that throttle background tabs. While ops are synced immediately via Yjs, the snapshot
   used to bootstrap new joiners will be stale.

   - `apps/sheets/src/components/sheets/hooks/use-sheet.ts:116-125` (beforeunload handler)
   - `apps/sheets/src/components/sheets/hooks/use-sheet.ts:161-165` (debounce logic)

   **Impact:** New joiners may see a slightly outdated snapshot (they will catch up via ops replay, but the initial
   render may flash old data).
   **Fix:** Consider `navigator.sendBeacon()` or reducing the debounce interval.
   **Status:** Previously identified; unchanged.

6. **Stickies and Slides: `jsonToYType` utility duplicated verbatim**

   The exact same function appears in both apps:
   - `apps/stickies/src/components/stickies/board.tsx:20-34`
   - `apps/slides/src/components/slides/editor.tsx:62-76`

   **Impact:** Maintenance burden; changes must be made in two places.
   **Fix:** Extract to `packages/lib/src/utils/yjs.ts`.
   **Status:** Previously identified; unchanged.

7. **Stickies, Slides, and Sheets: revision restore logic duplicated across 3 apps**

   Nearly identical `handleRestore` implementations in:
   - `apps/stickies/src/components/stickies/board.tsx:89-113`
   - `apps/slides/src/components/slides/editor.tsx:340-364`
   - `apps/sheets/src/components/sheets/hooks/use-sheet.ts:168-208`

   All three iterate shared keys, clear Y.Map/Y.Array, and repopulate. The sheets version slightly differs (it does
   not use `jsonToYType` for map values, using `v as any` instead, and it has extra logic to update the workbook). The
   core transplant logic should be a shared function.

   **Impact:** Same as issue 6; also makes the Y.Array bug (issue 2) harder to fix consistently.
   **Fix:** Extract `restoreYjsDocument(liveDoc, snapshotState)` into `packages/lib/src/utils/yjs.ts`.
   **Status:** Previously identified; expanded with sheets-specific detail.

8. **Slides: `getTextStyle` uses `vh` units for font size, wrong in editor canvas**

   Font size is `${obj.fontSize / 1080 * 100}vh`, which scales relative to the viewport height. In presentation mode
   (fullscreen), the slide fills the viewport, so this is correct. But in the editor canvas, the slide is constrained
   within a panel (toolbar + status bar + properties panel reduce available height), so text appears at incorrect sizes
   relative to the slide.

   - `apps/slides/src/components/slides/slide-object.tsx:32`

   The same `getTextStyle` is used by `SlideObjectView` (editor) and `ReadOnlySlideObject` (presentation mode).

   **Impact:** Text sizes in the editor do not match presentation mode. If the canvas is 70% of viewport height, text
   is 70% of the expected size relative to the slide.
   **Fix:** Use a container-relative approach: pass the canvas element's actual height and compute font size as a
   proportion of that, or use CSS container query units (`cqh`).
   **Status:** Previously identified; analysis confirmed.

9. **Slides: no loading indicator before Yjs sync completes**

   Unlike the docs app which shows `<EigenLoader/>` until `connected` is true (`editor.tsx:69-71`), the slides app
   renders the full editor immediately. The `useDeck` hook starts with empty state (`{slides: {}, objects: {},
   slideOrder: []}`) and the UI shows "No slides yet" until the sync callback fires and populates the deck.

   - `apps/slides/src/components/slides/hooks/use-deck.ts:23` (empty initial state)
   - `apps/slides/src/components/slides/editor.tsx:492-494` ("No slides yet" fallback)

   Stickies has a similar issue, using `visibility: hidden` as a workaround when `columnOrder.length <= 1`
   (`board.tsx:176`).

   **Impact:** Brief flash of "No slides yet" / hidden content before sync completes, which could confuse users
   on slow connections.
   **Fix:** Add a `synced` state flag in `useDeck` and `useBoard`, show `<EigenLoader/>` until synced.
   **Status:** Previously identified; unchanged.

10. **Docs: `editorRef.current = editor` assigned during render**

    - `apps/docs/src/components/docs/editor.tsx:270`

    This is a side effect during render. The `editor` value from `useEditor` is written to a ref so that async
    callbacks (`handleImageUpload`, `handleEigenImagePaste`) can access the latest instance. In React 19 strict mode,
    render functions may be called twice, and side effects during render are discouraged.

    **Impact:** No functional bug in practice, but violates React conventions and could break with future
    React strict mode enforcement.
    **Fix:** Move to `useEffect(() => { editorRef.current = editor; }, [editor])`.
    **Status:** Previously identified; unchanged.

11. **Slides: `handleDragOver` always shows copy cursor even when read-only**

    - `apps/slides/src/components/slides/slide-canvas.tsx:81-84`

    The `handleDragOver` callback unconditionally calls `e.preventDefault()` and sets `dropEffect = 'copy'`. When the
    user is in read-only mode, `onDropImage` is not passed, so the actual drop is correctly blocked. But the cursor
    provides misleading visual feedback that a drop will succeed.

    **Fix:** Check `onDropImage` existence in `handleDragOver` before allowing the drop effect.
    **Status:** Previously identified; unchanged.

12. **Slides: `duplicateSlide` callback depends on `[deck]`, defeating memoization**

    - `apps/slides/src/components/slides/hooks/use-deck.ts:218`

    `useCallback` for `duplicateSlide` depends on `deck`, the full state object that changes on every Yjs observer
    event. The callback is effectively recreated every render. It reads `deck.slides` and `deck.objects` to clone
    a slide's content, but could instead read from the Yjs doc directly.

    The same applies to `moveObjectUp`, `moveObjectDown`, `moveObjectToFront`, `moveObjectToBack` (lines 311, 330,
    349, 368), and `deleteSlide` (line 175) which all depend on `deck.objects` or `deck.slideOrder`.

    **Impact:** Unnecessary re-renders of child components receiving these callbacks.
    **Fix:** Read from `docRef.current` Yjs maps directly instead of the derived `deck` state.
    **Status:** Previously identified; expanded scope.

## Minor Issues

13. **All four apps: root component named `DocsRoot` in stickies, slides, and sheets**

    The `__root.tsx` component function is named `DocsRoot` in all four apps, clearly copy-pasted from docs.
    - `apps/stickies/src/routes/__root.tsx:18`
    - `apps/slides/src/routes/__root.tsx:18`
    - `apps/sheets/src/routes/__root.tsx:18`

    **Fix:** Rename to `StickiesRoot`, `SlidesRoot`, `SheetsRoot`.
    **Status:** Previously identified; unchanged.

14. **All four apps: `interface MyRouterContext` instead of `type`**

    All `__root.tsx` files use `interface` (e.g., `apps/docs/src/routes/__root.tsx:14`), violating the project's
    "type over interface" rule.

    **Status:** Previously identified; unchanged.

15. **Docs sidebar and Sheets sidebar: `interface` instead of `type`**

    - `apps/docs/src/components/docs/docs-sidebar.tsx:12` -- `interface DocsSidebarProps`
    - `apps/sheets/src/components/sheets-sidebar.tsx:13` -- `interface SheetsSidebarProps`
    - `apps/slides/src/components/slides-sidebar.tsx:17` -- `interface SlidesSidebarProps`

    **Status:** Previously identified; added slides-sidebar.

16. **Stickies: `any` type assertions throughout Yjs code**

    Pervasive `as Y.Map<any>`, `as Y.Array<any>` casts in `use-board.ts`, `use-drag-and-drop.ts`,
    `normalize-board.ts`, `card-settings-dialog.tsx`, `column-settings-dialog.tsx`. Yjs's type system makes this
    somewhat unavoidable, but a typed wrapper would improve safety.

    **Status:** Previously identified; unchanged.

17. **Stickies: `CardSettingsDialog` initial state from props without reset on prop change**

    - `apps/stickies/src/components/stickies/card-settings-dialog.tsx:23-25`

    `useState(cardTitle)`, `useState(cardDescription)`, and `useState(cardColor)` capture props at mount time. If
    another collaborator edits the card while the dialog is open, or if the same dialog is reused for a different card,
    the local state will not update.

    **Fix:** Use a `key` prop on `CardSettingsDialog` tied to `cardId`, or use `useEffect` to sync state when props
    change.
    **Status:** Previously identified; unchanged.

18. **Stickies: `ColumnSettingsDialog` has the same stale-state problem**

    - `apps/stickies/src/components/stickies/column-settings-dialog.tsx:18`

    `useState(columnTitle)` captures the title at mount time. If the column is renamed by another collaborator while
    the dialog is open, the input shows stale data.

    **Status:** New finding; analogous to issue 17.

19. **Slides: `SortableSlide` has unused `isDragOverlay` prop**

    - `apps/slides/src/components/slides/slide-panel.tsx:99`

    The parameter is declared but always passed as `false` (line 52). The overlay uses a different element entirely
    (lines 86-91).

    **Status:** Previously identified; unchanged.

20. **Docs: dynamic import of `chatApi` in comment creation**

    - `apps/docs/src/components/docs/comment-dialog.tsx:43`

    `const {chatApi} = await import("@workspace/lib/api")` adds async overhead to every comment creation. Likely done
    to break a circular import.

    **Status:** Previously identified; unchanged.

21. **Stickies: `normalizeBoard` runs on every Yjs observer callback**

    - `apps/stickies/src/components/stickies/hooks/use-board.ts:105`

    `normalizeBoard(doc)` is called inside `updateReactState`, which runs on every deep observation of tasks, columns,
    and columnOrder. Since `normalizeBoard` itself modifies the Yjs doc (deleting duplicate task references, adopting
    orphan tasks), calling it from an observer can trigger recursive observer calls. Yjs suppresses infinite recursion
    within a transaction, but this pattern creates unnecessary work on every keystroke or minor update.

    The same applies to `normalizeDeck` in slides (`use-deck.ts:83`).

    **Fix:** Only normalize on sync or when specific structural changes are detected, not on every observer callback.
    **Status:** New finding.

22. **Stickies: `CardSettingsDialog` delete uses `return` inside `for...of` loop to skip columns**

    - `apps/stickies/src/components/stickies/card-settings-dialog.tsx:53`

    Inside the transact block's `for...of` loop, `if (!(columnMapValue instanceof Y.Map)) return;` uses `return`
    instead of `continue`. This exits the entire `transact` callback early if any column entry is not a `Y.Map`,
    potentially leaving the task in `tasksMap` without being removed.

    **Impact:** If any column value is corrupt, the card delete fails to remove the card from `tasksMap`.
    **Fix:** Replace `return` with `continue`.
    **Status:** New finding.

23. **Slides: presentation mode navigation uses `onContextMenu` for going back**

    - `apps/slides/src/components/slides/editor.tsx:391-397`

    Right-click navigates to the previous slide. This is unconventional and not discoverable. There is no keyboard
    navigation (arrow keys) in presentation mode.

    **Impact:** Users familiar with presentation software expect arrow keys and may not discover right-click navigation.
    **Fix:** Add arrow key handlers (Left = previous, Right/Space = next, Escape = exit).
    **Status:** New finding.

24. **Slides: presentation mode does not exit fullscreen when `Escape` is pressed from hotkey**

    - `apps/slides/src/components/slides/editor.tsx:154-155`

    The `Escape` hotkey sets `setIsPresenting(false)` but does not call `document.exitFullscreen()`. The browser's
    native Escape handling may exit fullscreen separately, but the state desynchronizes: `isPresenting` becomes false
    while still in fullscreen, or fullscreen exits while `isPresenting` is still true.

    The `onClick` handler at line 388 does call `document.exitFullscreen()` when exiting at the end, but the Escape
    hotkey does not.

    **Fix:** In the Escape handler, check `document.fullscreenElement` and call `document.exitFullscreen()` if needed.
    **Status:** New finding.

25. **Docs: `useEditor` dependency array only contains `[handleCommentClick]`**

    - `apps/docs/src/components/docs/editor.tsx:268`

    The `useEditor` hook is configured with extensions that reference `yDoc`, `provider`, `auth.user`, and
    `mediaFolderId`, but the dependency array is `[handleCommentClick]`. Tiptap's `useEditor` recreates the editor
    when deps change. If `handleCommentClick` is stable (it is, via `useCallback` with empty deps at line 124),
    the editor is never recreated, which is correct for the collaboration setup. However, if `access.canWrite` changes
    (e.g., ACL update while the document is open), the `editable` option will not update because the editor is not
    recreated.

    **Impact:** If write permission is revoked while the document is open, the editor remains editable until the
    component remounts.
    **Fix:** Call `editor.setEditable(access.canWrite)` in a `useEffect` when `access.canWrite` changes.
    **Status:** New finding.

26. **Sheets: `useSheet` does not provide undo/redo support**

    Unlike docs (Tiptap has built-in collab undo), stickies, and slides (both create `Y.UndoManager`), sheets has no
    undo/redo integration. The fortune-sheet toolbar includes undo/redo buttons, but they operate on fortune-sheet's
    internal undo stack which is not synced with Yjs.

    **Impact:** Undo/redo may produce inconsistent state between collaborators.
    **Status:** New finding; may be intentional due to fortune-sheet architecture limitations.

## Observations

- **Architecture compliance is solid across all four apps.** All use `useCollabDocumentInfo` from `@workspace/lib/collab`,
  `MediaResolverProvider` wrapping (where applicable), `AppShell` + `DriveContext`, and the shared `RevisionHistory`
  component. No app makes direct `useQuery`/`useMutation` calls.

- **Docs is the most mature app.** It has proper sync waiting (EigenLoader), clipboard support (copy/paste images
  between documents), comment threads, and a well-structured Tiptap extension system.

- **Stickies has good conflict resolution.** The `normalizeBoard` function handles duplicate task references and orphan
  tasks, which is a real concern in collaborative Kanban boards with concurrent drag-and-drop.

- **Slides has a rich feature set.** Snap lines, z-ordering, multi-select, clipboard integration, background images,
  and presentation mode. The `useObjectDrag` hook is well-designed with canvas-relative coordinate conversion.

- **Sheets has the thinnest integration layer.** It delegates almost everything to fortune-sheet, with Yjs providing
  op-based sync. This is appropriate given the complexity of the spreadsheet engine.

- **All four apps share the same sidebar/drive-list pattern** for browsing documents, including shared-by-me and
  shared-with-me views. The routes are nearly identical across apps (with appropriate MIME type filters).

- **The `WebsocketProvider` configuration is consistent**: `resyncInterval: 5000` and `connect: true` in all four
  apps. No app shows connection status (connected/disconnected/reconnecting) in the UI.

- **No accessibility attributes (ARIA)** are present on the interactive elements in stickies (drag handles, cards) or
  slides (canvas objects, thumbnails). The drag-and-drop implementations rely entirely on mouse events.
