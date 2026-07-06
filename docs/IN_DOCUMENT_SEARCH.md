# In-Document Search

## TLDR

Every eigendoc editor (docs, sheets, slides, stickies) has a `⌘F` find bar that searches **inside
the open document** — jump to a card, a cell, a heading. Each app implements one small
`DocSearchController` contract over its own live state; a shared `DocSearchProvider` owns the find
session (query, options, matches, active index), the keybinds, and the floating `FindReplaceBar`.
Matches are **plain serialisable data** (`id` + `label` + `context`) revealed by id, never closures —
so the same controller also feeds the command palette `doc:` scope and the `?q=` deep link. Docs and
sheets additionally support **replace** (`⌥⌘F`). Comment threads on a board are searched server-side
through a separate `DocCommentSearch` capability backed by `comments.db`'s `comments_fts`. Core
contract in `packages/lib/src/types/doc-search.ts`; the bar in
`packages/ui/src/components/layout/search/`.

This is **finding a location inside the document you already have open**. Finding *which* document
contains a term (drive-wide body search) is a different system — see
[PROPOSAL_SEARCH.md](PROPOSAL_SEARCH.md).

## The Controller Contract

Each eigendoc app implements `DocSearchController` once over its live state (the ProseMirror tree,
the workbook, the Y.Doc board). It is the single notion of "a match" shared by the find bar, the
palette `doc:` scope, and the `?q=` landing.

```typescript
type DocSearchOptions = { matchCase: boolean; wholeWord: boolean; regex: boolean };

type DocSearchMatch = {
    id: string;        // self-describing — resolvable from the string alone
                       //   (`${from}:${to}`, `${sheetId}:${r}:${c}`, a card id)
    label: string;     // the matched text or card title
    context?: string;  // where it is: "To do" / "Sheet1 · B12" / "Slide 3"
};

type DocSearchController = {
    search(query: string, opts: DocSearchOptions): DocSearchMatch[];  // PURE — no side effects
    highlightAll(matches: DocSearchMatch[]): void;                    // paint all; [] clears
    reveal(matchId: string): void;                                    // scroll-to + flash

    // v1.5 — replace (docs + sheets only; slides/stickies leave these unset)
    canReplace?: boolean;
    replace?(matchId, query, replacement, opts, preserveCase): DocSearchMatch[];
    replaceAll?(query, replacement, opts, preserveCase): { replaced: number; matches: DocSearchMatch[] };
};
```

Rules baked into the contract:

- **`search` is pure** — it never touches the document. Painting and scrolling are separate calls, so
  the palette can call `search()` and then `reveal(id)` with no `highlightAll()` in between.
- **Match ids are self-describing.** `reveal` resolves an id from the string alone, never via a cached
  last-search lookup — the palette and an open bar session interleave calls on the same controller.
- **`highlightAll` is a paint hint.** Some surfaces ignore its array: docs paints from its own installed
  `prosemirror-search` query rather than these ids. The asymmetry is intended.
- **`reveal` tolerates stale ids** (validate / clamp / no-op, never throw) and **must not move focus**
  while a bar session is open — that would break `Enter` / `⌘G` stepping. It centres the match so the
  bar can't cover it.
- **Replace returns the fresh post-edit match list**, which the provider *adopts* — it never re-runs
  `search()` after an edit (a React context is one render behind then). The query is explicit on every
  replace method; `preserveCase` is a separate arg. Replacement strings are **literal** on every
  surface — no `$1` / `$&` expansion.

## The Find Bar

`DocSearchProvider` (`packages/ui/.../layout/search/doc-search-provider.tsx`) owns the find session
and renders the floating `FindReplaceBar`. A surface wraps its editor subtree in the provider and
passes its `controller`.

- **Keybinds:** `⌘F` open (or re-focus + select when already open), `⌘G` / `⇧⌘G` next / previous match,
  `Esc` close, `⌥⌘F` open in replace mode (falls back to plain search when the surface is read-only).
- **Debounce:** 150 ms on the query before re-searching.
- **Live under collaboration:** the provider re-runs the open session's search whenever the controller
  identity changes, so the *n of m* count stays live while a collaborator types. The active match is
  tracked by index and reveal is best-effort — under remote edits it may drift to a different
  occurrence.
- **Undo/redo routing:** `⌘Z` / `⇧⌘Z` inside the bar's inputs route to the surface's own undo (passed as
  `onUndo`/`onRedo`), so a Replace stays undoable without leaving the bar.
- **Placement:** the bar floats top-right of the wrapped subtree; a surface passes `barClassName` offsets
  to clear its own chrome. `onOpenChange` lets a surface with a layered `Escape` (slides:
  present → edit → bar → deselect) defer its default action to the bar-close.
- **Chrome entry points:** `useDocSearchBar()` (and the null-safe `useOptionalDocSearchBar()`) expose
  `open()` / `openReplace()` / `canReplace` to toolbar buttons (`find-in-document-button.tsx`, the `⌕`
  cluster) and Edit-menu items — so read-only surfaces hide "Find and replace".

## Match Highlighting

Highlight visuals are single-sourced in `packages/ui/src/styles/globals.css`, so every surface looks
the same:

| Class | Role |
|---|---|
| `.eigen-search-match`, `.eigen-search-match-active` | inline text-run highlight (docs, sheets, slides) |
| `.eigen-search-ring`, `.eigen-search-ring-active` | object-outline highlight (stickies cards) |
| `.eigen-search-flash` | one-shot reveal pulse (the `eigen-search-ring-flash` keyframe) |

## Per-App Controllers

| App | Controller | Strategy | Replace |
|---|---|---|---|
| Docs | `apps/docs/src/components/docs/use-doc-search-controller.ts` | ProseMirror walk; paints via `prosemirror-search` decorations; `reveal` sets a text selection + scrolls | ✓ |
| Sheets | `apps/sheets/src/components/sheets/hooks/use-search-controller.ts` | adapter over `packages/sheet` `collectMatches`, iterating **all tabs**; `reveal` reuses scroll-and-select | ✓ |
| Slides | `apps/slides/src/components/slides/hooks/use-slides-doc-search.ts` | in-memory scan of the deck | — |
| Stickies | `apps/stickies/src/components/stickies/hooks/use-stickies-doc-search.ts` | Y.Doc scan of `tasks` / `columns`; `reveal` scrolls to + flashes the card | — |

Slides and stickies leave the replace members unset and stay search-only; no v1 caller changes shape.

## The `?q=` Deep Link

A `?q=` term on any eigendoc route opens the bar pre-filled, highlights all matches, and reveals the
first — with **focus staying in the document** (the bar input is not focused on this path).
`useLatchedDocSearchTerm(q)` (`packages/ui/src/hooks/use-eigen-doc-editor-route.ts`) latches the term
once and strips `q` from the URL. This is the shape a palette drive/mail hit uses to carry its query
into the opened document (mail highlights the message body instead of a find bar).

## Command Palette Integration (`doc:` scope)

`DocSearchProvider` publishes its controller to the palette via `usePaletteDocSearch` — it becomes
`ctx.docSearch`, present only while an eigendoc is open. The `doc:` scope's provider
(`packages/lib/src/core/command-palette/providers/doc-search.ts`) maps `controller.search(q)` to
`doc-hit` results under an **In Document** section (capped at 6, excluded from Top-Hit candidates so a
matched fragment can't hijack `Enter` from a typed file name). The palette searches with the bar's
default options (all-false) so its counts stay truthful; the option toggles live on the bar.

`Enter` on a doc hit calls `ctx.docSearchSession.revealFromPalette(q, matchId)` — the provider's
published `DocSearchSession` capability. It adopts the palette's query into the live find session,
paints all matches, and reveals the clicked one (*n of m* at its index), leaving focus in the
document. (Earlier it revealed in place; the bar-handoff replaced that on 2026-07-06.)

## Comment-Thread Search (server-backed)

Card comment threads are embedded `.eigenchat` containers the client never bulk-loads, so they are
searched server-side through a **separate capability**, `DocCommentSearch` (`ctx.docCommentSearch`),
published alongside the controller by docs and stickies.

```typescript
type DocCommentSearch = {
    docKey: string;                                   // `${ownerId}:${mountId}:${pathId}` of the OPEN doc
    search(query: string): Promise<DocCommentMatch[]>;
    reveal(matchId: string): void;                    // open the card / thread; tolerates stale ids
} | null;

type DocCommentMatch = { id: string; label: string; context?: string };  // id = the thread's chatName
```

- **Index:** `comments.db` v3 (`apps/api/src/lib/chat/comment-db-config.ts`) adds a `recentText` column
  (the newest ~8 KB of each thread, recomputed on every comment write) and a `comments_fts`
  external-content FTS5 table over it, with the standard 3 triggers + backfill.
- **Query:** `CommentIndex.searchComments(q)` (`apps/api/src/lib/chat/comment-index.ts`) runs
  `comments_fts MATCH … ORDER BY bm25()` with a `snippet()`, exposed at
  `GET /collab/:ownerId/:mountId/:pathId/comments/search` (`apps/api/src/routes/collab.ts`).
- **Palette:** `providers/doc-comment-search.ts` wraps the capability in TanStack Query (keyed by
  `docKey`, since a shared doc's owner can differ from `ctx.ownerId`) and renders `doc-comment-hit`
  results under an **In Comments** section — `doc:` scope only, never the global blend. The app pairs
  the document-bound `{ docKey, search }` with its own `reveal` (stickies: chatName → cardId → open the
  card; docs: open the comments panel + scroll).

Standalone chat history (an `.eigenchat` file opened on its own) is **not** covered here — a per-room
`messages_fts` over full chat history is future work, tracked as Phase 3 in
[PROPOSAL_SEARCH.md](PROPOSAL_SEARCH.md).

## Shared Utilities

`packages/lib/src/doc-search/` holds the DOM-free helpers every controller reuses:

- `build-search-regex.ts` — `buildSearchRegex(query, opts)` builds the matcher from
  `matchCase` / `wholeWord` / `regex`.
- `preserve-case.ts` — `applyPreserveCase(...)` reapplies the source token's case to a literal
  replacement (a replace-only concern `search()` never reads).

## File Reference

| File | Purpose |
|---|---|
| `packages/lib/src/types/doc-search.ts` | `DocSearchController` / `DocSearchMatch` / `DocSearchOptions` / `DocSearchSession` / `DocCommentSearch` / `DocCommentMatch` |
| `packages/lib/src/doc-search/` | `buildSearchRegex`, `applyPreserveCase` (shared DOM-free helpers) |
| `packages/ui/src/components/layout/search/doc-search-provider.tsx` | find session, keybinds, palette publication (`usePaletteDocSearch`) |
| `packages/ui/src/components/layout/search/find-replace-bar.tsx` | the floating bar UI |
| `packages/ui/src/components/layout/search/find-in-document-button.tsx` | toolbar `⌕` trigger |
| `packages/ui/src/hooks/use-eigen-doc-editor-route.ts` | `useLatchedDocSearchTerm` (`?q=` landing) |
| `packages/ui/src/styles/globals.css` | `.eigen-search-*` highlight classes |
| `packages/lib/src/core/command-palette/providers/doc-search.ts` | `doc:` scope → `doc-hit` results |
| `packages/lib/src/core/command-palette/providers/doc-comment-search.ts` | In Comments → `doc-comment-hit` results |
| `packages/lib/src/core/command-palette/hooks/use-palette-doc-search.ts` | app publishes its controller/capability |
| `apps/{docs,sheets,slides,stickies}/…` | per-app `DocSearchController` implementations (see table) |
| `apps/api/src/lib/chat/comment-db-config.ts` | `comments.db` v3 — `recentText` + `comments_fts` |
| `apps/api/src/lib/chat/comment-index.ts` | `CommentIndex.searchComments` |
| `apps/api/src/routes/collab.ts` | `GET …/comments/search` |
