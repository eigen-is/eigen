# In-Document Search

> **TLDR:** One `⌘F` find bar serves seven surfaces: the five Eigen editors (docs, sheets, slides, stickies, drawings) and Drive's markdown and code editors. Each surface implements a `DocSearchController` over its own live state (the contract is `packages/lib/src/types/doc-search.ts`), and `DocSearchProvider` (`packages/ui/src/components/search/`) owns the session, the keys and the floating `FindReplaceBar`. A match is plain data revealed by id, so the same controller also feeds the palette's `doc:` scope and the `?q=` deep link. Docs, sheets and the Drive editors also replace; slides, stickies and drawings only search. Finding which file holds a term is [SEARCH.md](SEARCH.md).

## A match is plain data, resolvable from its id alone

A `DocSearchMatch` is an `id`, a `label` (the matched text or card title) and an optional `context` ("Sheet1 · B12", "Slide 3"). The id describes itself: `from:to` in docs, `sheetId:r:c` in sheets, the card or element id elsewhere. `reveal` resolves it from the string and never from a cached last search, because the palette and an open bar session interleave calls on the same controller. The comments in `doc-search.ts` spell out every rule of the contract.

## search is pure, and painting is a separate call

`search` never touches the document. `highlightAll` paints and `reveal` scrolls, so the palette can call `search` and then `reveal` with no paint in between. `highlightAll` is only a hint: docs paints from its own installed `prosemirror-search` query and ignores the array.

## reveal tolerates stale ids and never moves focus

Under collaboration a match can vanish between search and reveal, so `reveal` validates, clamps or does nothing, and never throws. It must not move focus while the bar is open, or `Enter` and `⌘G` would stop stepping. It centers the match so the bar can't cover it.

## Replace returns the fresh match list

`replace` and `replaceAll` make the edit and return the post-edit matches, which the provider adopts. It never re-runs `search` after an edit, because sheets' React context is one render behind at that point. The query is passed on every call rather than read from a cached term, for the same interleaving reason as the id. `preserveCase` is its own argument, applied by `applyPreserveCase` (`packages/lib/src/doc-search/`). Replacement text is literal everywhere: no `$1` or `$&` expansion.

A surface sets `canReplace` from its write access. A read-only document gets search only, and `⌥⌘F` opens plain search there.

## The provider owns the session and the keys

A surface wraps its editor in `DocSearchProvider` and passes its controller. `⌘F` opens the bar or refocuses it, `⌥⌘F` opens it in replace mode (`Ctrl+H` works too off macOS, where `⌘H` hides the app), `⌘G` and `⇧⌘G` step, and `Esc` closes. `⌘G` with the bar closed and a query kept reopens it without focusing the input. Every key is off while a dialog is open, because the bar would open unseen behind it. The query debounces 150 ms.

`⌘Z` and `⇧⌘Z` inside the bar's inputs go to the surface's own undo (`onUndo`, `onRedo`), so a replace is undoable without leaving the bar. `barClassName` moves the bar clear of a surface's chrome, and `onOpenChange` lets slides fit the bar into its layered `Escape` (present, edit, bar, deselect). Toolbar buttons and Edit-menu items read `useOptionalDocSearchBar()`, so a read-only surface hides "Find and replace".

## The count stays live while collaborators type

A surface republishes its controller when its document changes, and the provider re-runs the open search so *n of m* stays current. The rerun is throttled, not debounced: slides and stickies republish on every Yjs transaction, and a steady stream of remote edits would reset a debounce forever. The rerun clamps the active index and does not reveal, so a remote edit never yanks the scroll. Because the active match is an index, a remote edit can shift it to another occurrence.

## Every surface paints with the same classes

The highlight classes live in `packages/ui/src/styles/globals.css`, so a match looks the same everywhere. Text runs get `.eigen-search-match`; objects (stickies cards, canvas elements, slide thumbnails) get `.eigen-search-ring`; each has an `-active` variant, and `.eigen-search-flash` is the one-shot reveal pulse.

## Each surface searches its own model

- Docs, and Drive's markdown editor in WYSIWYG mode, share `useProseMirrorSearchController` (`packages/ui/src/components/search/`). It lives in `packages/ui` because two apps use it.
- Drive's code editor, and the markdown editor in source mode, use `useCodeMirrorSearchController` (`apps/drive/src/components/editor/`), which matches with `buildSearchRegex`.
- Sheets adapts the engine's `collectMatches` (`packages/sheet`), which scans every visible tab in display order with one match per cell. The adapter is `apps/sheets/src/components/sheets/hooks/use-search-controller.ts`.
- Stickies scans the column titles and the visible cards only, because a card the board's filter hides has no element for `reveal` to scroll to. `reveal` scrolls to the card and flashes it.
- Slides and drawings share `useCanvasDocSearch` (`packages/ui/src/components/vector/hooks/`). It lives with the canvas engine because any canvas host mounts it.

## A canvas match is an element, and the host reveals it

`searchScene` walks each element kind's `searchText` frame by frame, then in z-order inside a frame. The search index uses the same order, so the two agree on what a canvas says. A match id is the element id, and `reveal` hands the host the element, because what revealing means differs per host. The drawing app selects it and pans it to the center at the current zoom. Slides labels each match with its slide through `contextOf`, activates that slide, and rings the rail thumbnail of every slide that holds a match, because most hits sit on slides the canvas is not showing.

## A ?q= link opens the bar with focus in the document

A `?q=` term on an editor route opens the bar pre-filled, paints all matches and reveals the first, with focus left in the document. `useLatchedDocSearchTerm` (`packages/ui/src/hooks/use-latched-doc-search-term.ts`) latches the term once and strips it from the URL. It latches because the editor mounts the provider only after collab sync, and a strip timed to that mount would race it and wipe the term first. A palette file hit carries its query into an editor this way. A mail hit carries `?q=` too, and the mail app highlights the message body instead.

## The palette reads the same controller

`DocSearchProvider` publishes its controller through `usePaletteDocSearch` as `ctx.docSearch`, present only while an editor is open. The provider in `packages/lib/src/core/command-palette/providers/doc-search.ts` lists up to 6 hits under **In Document**. A hit never becomes the Top Hit, because its title is the matched text and would take `Enter` from a typed file name. The palette searches with every option off, the bar's defaults, so its count matches the bar's.

Choosing a hit calls `revealFromPalette` on the published `DocSearchSession`. It adopts the palette's query into the bar, paints all matches and reveals the chosen one at its index, with focus left in the document.

## Comment threads are searched on the server

A comment thread is an embedded chat the client never loads in bulk. So docs and stickies publish a second capability, `DocCommentSearch` (`ctx.docCommentSearch`), backed by `CommentIndex.searchComments` (`apps/api/src/lib/chat/comment-index.ts`) at `GET /collab/:ownerId/:mountId/:pathId/comments/search`. It ranks over `comments_fts`, which holds the newest part of each thread ([COMMENTS.md](COMMENTS.md#search-reads-a-recomputed-tail-of-each-thread)). A match id is the thread's `chatName`.

The palette caches the call in TanStack Query keyed by `docKey`, the open document's `ownerId:mountId:pathId`, because on a shared document that owner differs from `ctx.ownerId`. Hits show under **In Comments** in the `doc:` scope only, never in the unscoped palette. Each app pairs the shared `useDocCommentSearchHalf` with its own `reveal`: stickies maps the chat name to its card and opens it, docs opens the comments panel and scrolls to the thread.

## See also

- [SEARCH.md](SEARCH.md): which file contains a term, across mail and Drive
- [COMMENTS.md](COMMENTS.md): the cards and threads behind `DocCommentSearch`
- [INLINE-EDITING.md](INLINE-EDITING.md): the Drive markdown and code editors that host the bar
- [CANVAS.md](CANVAS.md): the element kinds and their `searchText`
