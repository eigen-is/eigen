# In-Document Search & the "Current Document" Palette Scope

> **Status — SHIPPED 2026-07-06** (v1 search + navigation in docs/sheets/slides/stickies via a
> shared find bar, v1.5 replace on docs + sheets, phase-2 comment-thread search). The built design
> deviates from this sketch in four ways: the **native find bar** (`DocSearchProvider` +
> `FindReplaceBar`, `packages/ui/.../layout/search/`) is the primary surface and the palette `doc:`
> scope reuses its controller; matches are **plain data with id-based `reveal`** (not per-hit
> closures); the "doc actions" half was **already done** (`FileMenu` publishes them under the
> Selection section — re-homing them under a Document heading was deliberately dropped); chat
> in-document search stays deferred. Current locations: AGENTS.md §Frontend "In-document search"
> and "Command palette" rows. The rest of this file is the original design sketch, kept for
> background. Sibling: the drive-wide content index ([PROPOSAL_SEARCH.md](PROPOSAL_SEARCH.md)).
> Nothing here changed the `/search/:ownerId` endpoint.
>
> **What this adds:** a way to search **inside the document you currently have open** — jump to a
> sticky, a cell, a heading, a chat message — surfaced through a new **"current document" scope**
> (`doc:`) in the command palette, which doubles as the home for that document's **actions**
> (Rename, Share, Mail to…, Export, Move to trash, …).
>
> **Two halves, both mostly scaffolded already:**
> 1. **Actions for the open doc** — the palette already has a `selection` channel, a "Selection"
>    section, and a full catalog of selection-aware drive commands. The only gap is that the four
>    eigendoc viewers publish the open doc's *identity* but not its *action handlers*. A small fix.
> 2. **Content search inside the open doc** — needs a new per-domain searcher injected into the
>    palette as a **capability** (the same pattern the palette proposal already reserves for
>    "act inside the current app"), because the searcher is DOM-coupled and lives in the app while
>    the palette lives in shared lib.

> **TLDR**: When a document is open, `⌘K` gains a **current-document** scope. With no query it lists
> that document's actions; as you type it ranks **locations inside the document** (cards, cells,
> headings, messages) and jumps to them. Stickies and docs search the live in-memory state
> (client-side, instant); sheets reuse the find engine they already have (extended across tabs);
> chat queries the server (its history is paginated, so the client can't see all of it). The app
> registers a typed `{ search, reveal }` capability with the palette; the palette stays generic and
> never imports app code. This is **not** the drive-wide content index — that one finds *which
> file* matches; this one finds *where inside the open file* it matches.

## Problem statement

[PROPOSAL_SEARCH.md](PROPOSAL_SEARCH.md) makes documents findable by their content: type `budget`
and the matching `.eigendoc` / `.eigensheets` / `.eigenchat` files surface in the Files section.
That answers **"which document?"**. It does **not** answer **"where in *this* document?"**:

- In a 200-card Stickies board, find the card that mentions "Q3 launch" and scroll to it.
- In a long doc, jump to the heading or paragraph containing a term.
- In a multi-tab spreadsheet, find every cell with "VAT" across all sheets.
- In a busy chat, find the message where someone posted a link three months ago.

Today only **Sheets** can do any of this (it has a native Find & Replace). Docs, Stickies, and Chat
have no in-document find at all. And there is no consistent, keyboard-first entry point across the
suite.

The user-facing idea: **when you're in a document and open the command palette, you also get a
"current document" scope** that searches inside it — and, since the palette already knows which
document you're in, the same scope is the natural home for that document's actions.

## Relationship to the other two proposals

| Concern | Owner | Index / mechanism | Answers |
|---|---|---|---|
| Find documents by body | [PROPOSAL_SEARCH.md](PROPOSAL_SEARCH.md) | `paths_content_fts` in mount `metadata.db`; `/search/:ownerId` | "which file contains X" |
| The palette itself (scopes, providers, engine) | [PROPOSAL_COMMAND_PALETTE.md](PROPOSAL_COMMAND_PALETTE.md) | `packages/lib/src/core/command-palette/` | the UI shell |
| **Find a location inside the open doc + its actions** | **this doc** | **per-domain live search / per-room `messages_fts`; palette capability** | **"where in this file is X"** |

The three share **per-type text extraction** but write different indexes and render in different
places. In particular, chat appears in **both** search proposals but with different indexes:

- **Drive-wide** (PROPOSAL_SEARCH Phase 2): the latest ~100 KB of a chat's messages → `paths_content_fts`,
  so the chat *file* is findable globally.
- **In-document** (this doc, Phase 4): a per-room `messages_fts` that **indexes the chat's full
  history server-side** (only ranked, capped hits cross the wire — the client never loads it all),
  so you can find any message *within* the open chat, however old.

## UX — the `doc:` scope

The palette already supports scopes two ways (a typed prefix and a `Tab` chip — see
[PROPOSAL_COMMAND_PALETTE.md §Prefix modes](PROPOSAL_COMMAND_PALETTE.md#prefix-modes)). This adds one
more, available **only while a document is open**:

| Prefix | Scope | Availability |
|---|---|---|
| `doc:` | the current document — content hits + this document's actions | only when an eigendoc viewer is open (a `selection` is published) |

The chip label is **"In document"**. The `Tab` cycle gains a `doc` stop, present only when a document
is open.

The scope has **two faces**, falling naturally out of the existing engine (selection commands already
show with an empty query and rank once you type):

- **Idle (no query)** → the document's **actions**: Open, Quick preview, Rename, Share, Mail to…,
  Copy link, Move to trash, Export, Version history. A keyboard-driven file menu for the open doc.
- **Typing** → **content hits inside the document**, ranked, each jumping to its location on `↵`;
  the document's actions still match by name (`doc: rename`).

```
┌─ ❯ doc: q3 ──────────────────────────────── In document · esc ┐
│ IN DOCUMENT                                                    │
│   ▭  "Q3 launch checklist"            Card · To do             │
│   ▭  "ship Q3 notes to design"        Card · Doing            │
│   §  "Q3 results"                     Heading                  │
│                                                                │
│ ACTIONS FOR THIS DOCUMENT                                      │
│   ✏  Rename Q3-plan                                            │
│   ⚏  Share Q3-plan                                             │
│   ✉  Mail Q3-plan                                              │
└────────────────────────────────────────────────────────────────┘
```

Note this is *focusing*, not *enabling*: the document's actions already surface in the global blend
(the "Selection" section shows whenever a doc is open). The `doc:` scope adds the **content search**
and hides the global mail/file/contact noise so the result list is about this document only.

## Architecture

### The package-boundary problem

In-document search must run over the **live** document — the ProseMirror tree, the Stickies Y.Doc,
the sheet `WorkbookInstance`. Those live in the **app packages** (`apps/docs`, `apps/stickies`,
`apps/sheets`) and are DOM-coupled. The command palette lives in **`packages/lib`**, which is shared
with the backend and **must not import app packages** (the one-way `sheet → lib` rule;
`packages/lib` stays React-/DOM-light). So a lib-side palette provider **cannot** `import` a
domain searcher.

Two ways across the boundary:

1. **Backend round-trip** — add a `sources=['doc']` mode to `/search` keyed by `pathId`. Rejected as
   the primary path: it returns stale-by-seconds results (the live edit isn't flushed yet), it can't
   natively *reveal* a location in the editor, and for client-resident docs it's a network call for
   data already in memory. (It is, however, exactly right for **chat** — see Phase 4.)
2. **Capability injection** — the open app registers an imperative `{ search, reveal }` handler with
   the palette; the palette calls it without knowing the implementation. **This is the primary
   mechanism.** It keeps domain logic in the app, gives instant results over live state, and lets the
   app handle scroll/highlight natively.

Capability injection is **not a new idea** here: PROPOSAL_COMMAND_PALETTE already reserves it for
"act inside the current app"
([§Two seams these need](PROPOSAL_COMMAND_PALETTE.md#two-seams-these-need): *"an app with a focused
editor registers an imperative handler that the palette can invoke… keep it separate from the
selection hook — the selection stays pure data, capabilities are its imperative complement"*). In-document
search is the first concrete user of that seam.

### The capability shape

Mirrors `usePaletteSelectionActions` exactly (publish on mount, clear on unmount, identity-stable):

```ts
// packages/lib/src/types/command-palette.ts
export type DocSearchHit = {
    id: string;
    label: string;        // the matched text (card title, cell value, heading, message)
    context?: string;     // where it is, human-readable ("To do", "B12", "Slide 3", "from Alice")
    reveal: () => void;   // app closure: scroll to + highlight the location in the live view
};

export type DocSearchCapability = {
    // sync for client-resident docs (docs/stickies/sheets); async for chat (server query)
    search: (query: string) => DocSearchHit[] | Promise<DocSearchHit[]>;
} | null;
```

The key move: **each hit carries its own `reveal` closure**, capturing the app's live editor/board/
workbook. The palette never sees a location token, never interprets domain data, and needs no
`location: unknown` bag in shared types — it just calls `hit.reveal()`. Domain logic stays wholly in
the app; the shared type is two strings and a thunk.

A new hook publishes it, stabilising identity the same way `usePaletteSelectionActions` does:

```ts
// in each viewer
usePaletteDocSearch({ search: searchThisDocument });
```

`CommandContext` gains `docSearch: DocSearchCapability` alongside the existing `selection` /
`selectionActions`.

### The provider and result kind

A new provider `providers/doc-search.ts` follows the existing convention
(`(ctx, input, scope) => { results, isPending }`):

1. Bail unless a document is open (`ctx.selection?.items[0]`) and `ctx.docSearch` is published.
2. Gate on scope: run only when `scope === undefined || scope === 'doc'`.
3. Call `ctx.docSearch.search(parsed.q)`. If it returns a Promise (chat), debounce + reuse the
   `useStableWhilePending` machinery the mail/file providers already use; if it returns an array
   (client-side), resolve synchronously — no debounce, instant.
4. Map each `DocSearchHit` to a new `doc-hit` `PaletteResult` whose `run` calls `hit.reveal()` then
   closes the palette.

`PaletteResult` gains one variant (the union is exhaustive-checked, so the new row is compiler-enforced):

```ts
| {
      kind: 'doc-hit';
      id: string;
      title: string;       // hit.label
      subtitle?: string;   // hit.context
      icon: LucideIcon;
      group: ResultGroup;  // 'doc'
      rank: number;
      run: (ctx: CommandContext) => void;   // calls the hit's reveal()
  }
```

`ResultGroup` gains `'doc'`; `buildSections` renders an **"In document"** group at the top (above
Files) when populated, and suppresses the global async sections under the `doc:` scope. A
`command-row-doc-hit.tsx` renders label + context, styled like the existing two-line rows.

### Adding the scope — the small, known touch points

Per PROPOSAL_COMMAND_PALETTE's scope mechanism: add `'doc'` to `PaletteScope`, a `{ prefix: 'doc:',
scope: 'doc' }` entry to `SCOPE_PREFIXES` (`parse-query.ts`), and a chip to `NEXT_SCOPE` / `SCOPE_CHIPS`
(`command-palette.tsx`) **gated on a document being open**. Add `scope === 'doc'` to the
`scopeBlocks` guard in the mail/file/help providers so only the doc searcher fires under `doc:`.

## Per-domain in-document search

The capability's `search` is implemented once per app. Feasibility differs by how the document lives
in the client.

### Stickies — client-side, trivial

The whole board is in memory after sync: `columns`, `tasks`, `columnOrder` Y.Doc roots, and
`useBoard` already exposes the `yjsDoc` ref (`apps/stickies/src/components/stickies/hooks/use-board.ts`).
`search` walks `yjsDoc.getMap('tasks')` matching each card's `title` / `description` (and
`getMap('columns')` for column titles), returns hits whose `reveal` scrolls to and flashes the card.
Boards are small (tens to low hundreds of cards) — a synchronous scan per keystroke is nothing.

### Docs — client-side via the editor

The Tiptap `editor.state.doc` is the full ProseMirror tree in memory
(`apps/docs/src/components/docs/editor.tsx`). `search` walks it (the codebase already uses
`editor.state.doc.descendants()` for comment marks at `editor.tsx:54,170`), collecting text matches
with their positions; `reveal` sets a selection at the position, `scrollIntoView`, and paints a
temporary `Decoration` highlight (the comment-mark `DecorationSet` pattern already in the editor).
Either build this directly or adopt the official `@tiptap/extension-search-and-replace` (not
currently installed) for match decoration + navigation — decide in Phase 3.

### Sheets — reuse the engine that already exists, extend across tabs

Sheets already has a full **Find & Replace** (`Ctrl+F` / `Ctrl+H`, regex / case / whole-word, Find-All
→ click-to-scroll): `packages/sheet/src/components/SearchReplace/` + `state/modules/searchReplace.ts`
(`searchAll` / `searchNext` / `replace` / `replaceAll`). The capability's `search` wraps `searchAll`
and maps each `SearchResult` (which already carries `sheetName`, `sheetId`, `cellPosition`) to a
`DocSearchHit` whose `reveal` reuses the existing scroll-and-select.

One real gap: `searchAll` calls `getFlowdata(ctx)` — the **active sheet only**. For a true
in-document search it must iterate `ctx.sheets` and call `getFlowdata(ctx, sheet.id)` per tab
(`context.ts` already accepts the optional id). The result shape is already multi-sheet-ready, so this
is a contained change. The native `Ctrl+F` dialog stays for full Find & **Replace**; the palette
`doc:` scope is the quick keyboard jump.

### Chat — server-side (history is paginated)

Chat is the exception: it is **not** Yjs, and the client only holds the loaded pages
(`MESSAGE_PAGE_SIZE = 50`, `useInfiniteQuery` — `packages/lib/src/core/chat/hooks/use-chat.ts`). A
client-side scan would silently miss everything the user hasn't scrolled to. So chat's `search` is
**async** and hits the server.

- **Index:** a per-room `messages_fts` FTS5 virtual table inside each `.eigenchat`'s `data.db` (the
  same external-content + 3-trigger pattern as mail/drive), added in a `CHAT_ROOM_DB_CONFIG` v2
  migration. `ChatRoom` gains `searchMessages(q)` (two-pass JOIN + hydrate), exposed as a new
  `GET /chat/:ownerId/:mountId/:chatId/messages/search` route (none exists today).
- **Nothing loads the full history to the browser.** Same model as mail search: the FTS index lives
  server-side in `data.db`, the query runs there, and only the **top-N ranked hits** (with snippets)
  cross the wire — a room with thousands of messages returns the same small capped set as a short
  one. FTS5 `MATCH` + `bm25()` is sub-millisecond at that scale. "Full history" means the index
  *covers* every message, not that any bulk of messages is transferred.
- `reveal` must **load the page containing the hit, then scroll** — the one extra wrinkle vs. the
  fully-resident types. v1 can navigate to the message via a `?message=<id>` param the chat view
  consumes on mount (jumping into history at that message), deferring smooth in-place scroll.
- A `LIKE '%q%'` query is an acceptable **interim** before the FTS migration (small self-hosted
  rooms), but the FTS table is the real answer and is cheap to add.
- **Comment threads are searched elsewhere:** `comment-index.ts`'s metadata (status, last-author,
  100-char snippet) can't serve message search, but its `comments.db` gains a `comments_fts` over a
  capped per-thread message tail (v3) that does — for **comment** threads (see
  [Comments](#comments--search-across-a-boards-cards)). This per-room `messages_fts` is for
  **standalone** chat history.

### Comments — search across a board's cards

Stickies and docs carry per-card **comment threads** — embedded `.eigenchat` containers the client
never bulk-loads. Searching them is server-side like chat, but it does **not** fan out across thread
DBs: the parent's `comments.db` (one per container) gains a `comments_fts` over a capped per-thread
message tail (`COMMENT_INDEX_DB_CONFIG` v3 — see [PROPOSAL_SEARCH.md](PROPOSAL_SEARCH.md)), so the
capability's `search` is a **single `MATCH` on one already-open in-memory DB**, returning `chatName` →
card; `reveal` scrolls to the card and opens its comment panel. That same `recentText` is what
PROPOSAL_SEARCH folds into the board's drive-wide entry, so both comment surfaces share one artifact
and one write seam (`postMessage` → `updateCommentIndex`). Deep history of a single thread, if ever
needed, falls back to that thread's own per-room `messages_fts`.

| Domain | Where content lives client-side | `search` | Cross-cutting note |
|---|---|---|---|
| Stickies | full board in Y.Doc (`tasks`/`columns`) | client-side scan | trivial; boards are small |
| Docs | full ProseMirror tree (`editor.state.doc`) | client-side walk | reuse comment-mark decoration pattern |
| Sheets | live `WorkbookInstance` | wrap existing `searchAll` | extend active-sheet → all tabs |
| Chat | only loaded pages (paginated) | **async** server query | needs per-room `messages_fts` + route |
| Comments | embedded threads, not resident | **async** single `MATCH` on `comments.db` | shares the artifact PROPOSAL_SEARCH folds drive-wide |

## The actions half — close the one wiring gap

The palette already has everything for per-document actions **except** the doc viewers publishing
their action handlers:

- The catalog of selection-aware commands exists — `commands/drive.ts`: Open, Open in new tab, Quick
  preview, **Mail to…**, Copy link, Download, **Rename**, **Share**, Email collaborators, **Move to
  trash** (all `group: 'selection'`, with `dynamicTitle` so labels read "Share Q4-budget").
- The four eigendoc viewers publish the open doc as a `selection` via
  `usePaletteDocSelection(path)` (`packages/ui/src/hooks/use-eigen-doc-editor-route.ts:38`).
- **But** they do **not** call `usePaletteSelectionActions(...)`. Only `DriveLayout` publishes the
  dialog-backed handlers (`onRename` / `onShare` / `onDelete` / `onDownload` / `onEmailCollaborators`).

Consequence today, inside an open doc: **Open / Quick preview / Mail to… / Copy link** appear (they
resolve via direct imports, gated only on `selection`), but **Rename / Share / Move to trash /
Download / Email collaborators** do **not** (gated on `ctx.selectionActions?.onX`, which is `null`
there).

**Fix:** each eigendoc viewer (or the shared `useEigenDocEditorRoute`) calls
`usePaletteSelectionActions` with its rename/share/delete/download handlers. The viewer already owns
an access (share) dialog; rename/delete/download reuse the same drive hooks `DriveLayout` uses. This
is small and **independent of the search half** — it can ship first and immediately lights up the
"actions for the open document" experience.

Optionally extend the action set for the doc context with **Export** and **Version history**
(both already exist as features) so the `doc:` idle state is a complete file menu.

## Phased implementation

| Phase | Scope | Effort | Depends on |
|---|---|---|---|
| 1 | **Actions half** — publish `usePaletteSelectionActions` from the eigendoc viewers (Rename / Share / Delete / Download / Email collaborators; optionally Export / Version history). Lights up doc actions in the global blend immediately. | S | — |
| 2 | **Palette plumbing** — `doc:` scope + chip (gated on open doc), `doc-hit` result kind + row, `DocSearchCapability` type + `usePaletteDocSearch` hook + `doc-search` provider, "In document" section in `buildSections`. | S–M | command palette (shipped) |
| 3 | **Client-side searchers** — Stickies (Y.Doc scan) and Docs (ProseMirror walk + reveal decoration); Sheets (wrap `searchAll`, extend to all tabs). | M | 2 |
| 4 | **Chat & comment in-document search** — per-room `messages_fts` (`CHAT_ROOM_DB_CONFIG` v2) + `ChatRoom.searchMessages` + `GET …/messages/search` for standalone chats; **comment-thread search** across a board via `comments.db` `comments_fts` (`COMMENT_INDEX_DB_CONFIG` v3); async capability with jump-to-message / jump-to-card reveal. | M | 2; mirrors PROPOSAL_SEARCH Phase 3 |

Phase 1 ships value alone. Phases 3 and 4 light up domains independently behind the same scope — a
domain with no published capability simply contributes no "In document" section.

### Recommended build order (across both search proposals)

This doc, [PROPOSAL_SEARCH.md](PROPOSAL_SEARCH.md), and the shipped command palette interleave into
one sensible sequence — lowest-risk first:

0. **Actions / cleanup (this doc, Phase 1)** — publish `usePaletteSelectionActions` from the four
   eigendoc viewers. Tiny, independent, immediate: ⌘K gains Rename / Share / Move-to-trash / … for
   the open document. Ship on its own, before either big track.
1. **Drive-wide content FTS ([PROPOSAL_SEARCH.md](PROPOSAL_SEARCH.md) Phase 2)** — extract docs /
   slides / sheets / stickies / chat bodies into `paths_content_fts`, surfaced through the palette's
   existing Files section with no UI change. Builds on the shipped drive-name FTS; verifiable as a
   closed backend round-trip.
2. **In-document search (this doc, Phases 2–4)** — the `doc:` scope, the capability bridge, and the
   per-domain searchers; do the client-side domains (stickies, docs) and sheets first, chat last.

Rationale: 0 is nearly free; 1 is the biggest capability jump for one contained backend chunk, with
the fewest open questions and lowest regret (additive, regenerable index); 2 is the most exploratory
and multi-package, best done once the search backend is mature and the capability-bridge pattern can
be designed deliberately. Counter-weight: in-doc's client-side domains need no backend, so they
*start* faster if a visible UX win is the priority — but step 0 already provides an in-doc win in the
meantime.

## Open questions

1. **Reveal affordance** — temporary highlight vs. persistent selection vs. both; how long a flash
   lasts. Per-domain (a sheet selects a cell; a doc flashes a range; a card pulses).
2. **Chat jump-to-message** — v1 navigates with `?message=<id>` and lands at that message; smooth
   in-place scroll-into-loaded-history is a later refinement. Decide the v1 bar.
3. **Sheets overlap** — does the `doc:` scope *replace* `Ctrl+F` for quick jumps, or only complement
   it? Recommendation: complement — keep native Find & Replace for replace operations.
4. **`@tiptap/extension-search-and-replace` vs. hand-rolled** for docs (decoration + navigation). The
   extension is less code but a new dependency; the hand-rolled path reuses an in-repo pattern.
5. **Result cap & ranking inside one document** — the global sections cap at 6; an in-document search
   may want more (all matches in a small board). Decide the cap and whether `↑/↓` cycles matches like
   a native find.
6. **Non-eigendoc files** — does `doc:` ever apply to a previewed PDF / text file? Out of scope for
   v1 (no live editor to reveal into); the drive-wide content index already makes them findable.
7. **Mobile** — the `doc:` scope is keyboard-first; whether it needs a visible affordance on mobile
   (a "search this document" button in the viewer toolbar) is a UX call.

## File structure

```
packages/lib/src/types/
  command-palette.ts             # + DocSearchHit, DocSearchCapability; + 'doc' to PaletteScope /
                                 #   ResultGroup; + 'doc-hit' to PaletteResult; + docSearch on CommandContext

packages/lib/src/core/command-palette/
  parse-query.ts                 # + { prefix: 'doc:', scope: 'doc' }
  engine.ts                      # + 'In document' group; suppress global sections under doc: scope
  providers/
    doc-search.ts                # calls ctx.docSearch.search(q); maps hits → doc-hit results
  hooks/
    use-palette-doc-search.ts    # apps publish their DocSearchCapability (mirrors use-palette-selection-actions)

packages/ui/src/components/layout/app/command-palette/
  command-row-doc-hit.tsx        # label + context row
  command-palette.tsx            # + doc chip in NEXT_SCOPE / SCOPE_CHIPS (gated on open doc)

packages/ui/src/hooks/
  use-eigen-doc-editor-route.ts  # + usePaletteSelectionActions(...) (actions half); wire usePaletteDocSearch

apps/stickies/…                  # searchThisDocument over the Y.Doc; reveal scrolls to card
apps/docs/…                      # searchThisDocument over editor.state.doc; reveal decorates + scrolls
apps/sheets/…                    # wrap searchAll across all tabs; reveal reuses scroll-and-select
apps/api/src/lib/chat/
  db-config.ts                   # CHAT_ROOM_DB_CONFIG v2 — messages_fts + 3 triggers + backfill
  chat.ts                        # ChatRoom.searchMessages (two-pass JOIN + hydrate)
apps/api/src/routes/chat.ts      # + GET …/messages/search
```

## Key decisions

- **Capability injection, not a lib-side import and not a backend round-trip** — the searcher is
  DOM-coupled and lives in the app; the palette stays generic and DOM-light. Reuses the
  capability-bridge seam the palette proposal already reserves.
- **Each hit carries its own `reveal` closure** — no `location` token in shared types, no domain data
  inspected by lib. The shared type is two strings and a thunk.
- **Client-side where the doc is resident, server-side only where it isn't** — stickies/docs/sheets
  search live memory (instant, accurate); chat queries the server because its history is paginated.
- **Reuse Sheets' existing Find engine** — wrap `searchAll` rather than re-implement; the only new
  work is extending it across tabs (the result shape is already multi-sheet).
- **The scope hosts actions too** — it fronts the already-built selection commands; the actions half
  is a small wiring fix (publish `selectionActions` from the viewers) and ships independently first.
- **Distinct from drive-wide search** — different index, different provider, different UI. The two
  share only the per-type text extractors. This never touches `/search/:ownerId`.
- **Chat content has three complementary server-side indexes** — drive-wide latest-100 KB in
  `paths_content_fts` (PROPOSAL_SEARCH) makes a chat **file** findable; a per-room `messages_fts`
  indexes a **standalone** chat's full history for in-document search (here); and the parent's
  `comments.db` `comments_fts` indexes a capped per-thread tail of **card comments** (v3) for
  board-level comment search plus the drive-wide fold. None ship the full message history to the
  client — each returns only ranked, capped hits.
```
