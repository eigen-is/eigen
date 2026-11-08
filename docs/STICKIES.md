# Stickies (Kanban Board)

> **TLDR:** A collaborative Kanban board in `apps/stickies/src/components/stickies/`, stored as an `.eigenstickies` Drive folder whose Yjs doc is the source of truth. The board owns only columns and their order: a card is the shared `CommentCard` with its own chat, so most of the board is the comment machinery. Two things are not obvious. A concurrent merge can put a card in two columns or none, so a shared repair ranks columns by `columnOrder`. A drag writes to Yjs once, on drop.

A Stickies board is a file in Drive with columns of cards, which people drag from column to column as work moves along. Everyone the file is shared with can open it at the same time and sees the others' changes live, with an outline on the card someone is editing or dragging.

A board is a collab document, like a doc, a sheet or a slide deck, so it runs on the same Yjs backend ([COLLAB.md](COLLAB.md)). Yjs is a library for shared data that merges concurrent edits. The `.eigenstickies` file is a container, a Drive folder named like a file. Its `data.db` keeps the board's Yjs updates and snapshots, and one WebSocket per open board relays every change to the other peers. Saving, live sync, presence, access checks and version history all come from that shared code through `useCollabDoc`. Stickies only decides what goes into the doc.

A card is a comment, the same record the comments pane shows in a doc or a sheet ([COMMENTS.md](COMMENTS.md)). It has the same title, description, color, attachments and creator, and the same hooks and dialogs open, edit, resolve and assign it. Two things differ. The cards live in a Yjs map called `tasks`, where the other apps use `comments`. And a card is anchored by a column that lists its id, where a doc comment hangs on a run of text.

Each comment, and so each card, gets its own chat for its replies. That chat is an `.eigenchat` room in the board's `chat/` folder, with its own database of messages, served by the chat routes like any other room ([CHAT.md](CHAT.md#a-chat-inside-a-document-is-a-comment-thread)). The card holds only the room's name. A card's status and assignee are not in Yjs. The server keeps them in the board's `comments.db`.

## The Yjs doc is the source of truth

Every change goes into the Yjs doc first. Observers then rebuild the React state (`hooks/use-board.ts` for columns, the shared comment hooks for cards), so a local edit and a peer's edit take the same path to the screen. The doc has three roots:

```
Y.Map            "tasks"        cardId → Y.Map { id, title, description, color?, chatName?, creator?, createdAt?, attachments? }
Y.Map            "columns"      columnId → Y.Map { id, title, taskIds: Y.Array<string>, creator }
Y.Array<string>  "columnOrder"  ordered column ids
```

The undo manager tracks all three roots. So a card and its column reference undo as one step, and so does a column and its place in `columnOrder`.

## A reader checks a collaborator's edit, not an older board

Stickies follow the format policy in [ROADMAP.md](ROADMAP.md) like every other document. The `tasks` root holds the cards. Any collaborator can write any value into the Yjs doc, so a reader's checks are the boundary for that edit, and each one stops a crash or an injection:

- A card is read by `readCards` (`packages/lib/src/core/comments/hooks/use-comment-cards.ts`). The description is sanitized, because every viewer renders it as HTML. A field of the wrong type reads as '' or absent, because the renderers call string and date methods on it. `chatName`, `creator` and `createdAt` are optional. An `attachments` list keeps only its string and object elements.
- A column is read by `readBoard` (`hooks/use-board.ts`). A `title` that isn't a string reads as '', and a `taskIds` that isn't a list as an empty one. A new card has no list to land in on such a column, so it stays off the board until the ref repair places it.
- A card's id and a column's id are their keys in `tasks` and `columns`. The stored `id` field is written but never read.
- An entry of `tasks` or `columns` that isn't a map is skipped by every reader and by the ref repair (`normalizeParentChildRefs`).
- `readBoard` drops an id from `columnOrder` or a column's `taskIds` when it names no readable entry, because the board looks up every id it lists. A peer's concurrent delete leaves such an id normally.

The server's search reader keeps the map check and takes each field as stored. A wrong type can't crash it: at worst the board's search text stops early.

## A card is a shared CommentCard

The `tasks` entries are not a stickies type. They are written with the shared `writeCardToDoc(doc, 'tasks', card)` and read through `useCommentLifecycle({ mapName: 'tasks' })`, so the board and the comment layer agree on one card shape ([COMMENTS.md](COMMENTS.md)). `types.ts` holds only what the board owns: `ColumnItem` and `BoardData`.

A card is on the board when some column's `taskIds` lists it. That set is also what the lifecycle hook treats as the active cards. `createCard` creates the card's `.eigenchat` room first, stores its name as `chatName`, and writes the card and its column reference in one transaction; clicking the card opens that thread in the shared card dialog. Deleting a card removes it from its column and from `tasks` in one transaction, so there is no orphan reference and ⌘Z restores both. The chat and its `comments.db` row stay, so undo and a version revert bring the thread back with the card.

## A concurrent merge can leave a card in two columns, or none

Two peers moving the same card at once can leave it in two columns' `taskIds`, or in none. `normalizeBoard` repairs that with the shared `normalizeParentChildRefs` (`packages/lib/src/core/collab/normalize-refs.ts`). It runs on the first sync and inside the transaction of every drop on a target that is not an Alt duplicate, a drop that moves nothing included. A card in several columns keeps the last one. A card in no column joins the first.

**First and last come from `columnOrder`, not from Y.Map key order.** Key order is each peer's local integration order, so peers would disagree and could delete each other's survivor. A column missing from `columnOrder` ranks before every listed one, so it never receives a re-homed card: the board doesn't render it. Only when `columnOrder` lists no existing column does the repair fall back to key order. `packages/lib/src/test/core/collab/normalize-refs.test.ts` pins these cases.

The repair is idempotent. Run on sync it writes under `NORMALIZE_ORIGIN`, which no undo manager tracks, so it syncs to peers but ⌘Z can't restore the corruption. Inside a drag it joins the drag's undo step. Stickies is its only caller. The canvas needs no such repair, because an element names its own `frameId` and a frame holds no id list ([CANVAS.md](CANVAS.md#the-reader-is-the-trust-boundary)).

## Roots are read through typed accessors

The board reads its roots and id lists through `getItemMapRoot`, `getIdArrayRoot` and `getIdArray` (`packages/lib/src/core/collab/yjs-utils.ts`) instead of casting. `getItemMapRoot` types its entries `unknown`, because a peer can write a scalar where a map belongs, so the compiler makes every reader check for a `Y.Map` first. A root needs no runtime check: `doc.get` upgrades the `AbstractType` root that `Y.applyUpdate` leaves on the server, and throws only on a real mismatch. A nested list is checked with `instanceof Y.Array`, which is sound because nested types always decode with their real constructors. `getIdArray` returns undefined for a missing list.

The server reads a board for search indexing in `apps/api/src/lib/document/stickies.ts`. It imports `getItemMapRoot` through the React-free `@workspace/lib/collab/yjs-utils` subpath, because the backend never imports a `core/` domain barrel.

## A drag writes to Yjs once, on drop

`hooks/use-drag-and-drop.ts` (on @dnd-kit) writes nothing while a card or column is in flight. On drop it commits the move and runs `normalizeBoard` in one transaction, bracketed by `stopCapturing`. So peers see one move, not every hover, and the move is one undo step that can't merge into the previous edit.

Holding Alt at the drop duplicates the card instead of moving it. The copy goes through `createCard`, so it gets a fresh `chatName`: a chat room belongs to one card, so a copy never shares the original's thread. dnd-kit reports no modifier keys on drop, so the hook tracks Alt itself and resets it when the window loses focus. Otherwise an Alt+Tab would swallow the keyup and make the next plain drag a duplicate.

## The board reuses the comment UI

Most of `board.tsx` wires shared comment modules rather than board code:

- `CommentLifecycleDialogs` for the card dialog, edit form, resolve and delete flows.
- `useCommentFilter({ status: 'all' })` drives column contents, so resolved cards stay on the board. The toolbar adds the filter menu, a color row and a summary chip.
- `PanelColumn` shows the activity panel on desktop only. On mobile the toolbar hides its toggle, because the panel has nowhere to render.
- One `useContextMenu` opens on right-click and on long-press. Cards are `touch-none` for the drag sensor, which suppresses the native context menu on touch.
- `DocSearchProvider` with `useStickiesDocSearch` highlights matching cards and columns. The palette's comment search reveals a card by its `chatName`.

## Ticking the last box of a checklist celebrates now and then

A card's description can hold a task list, and the card shows how far it is done. `countTaskItems` (`packages/lib/src/core/html.ts`) is the one count, for the card's progress bar and for the dialog. When a click in `NoteCardDialog` ticks the last open box of a list with at least two items, it calls `celebrate` from `useCelebrate` (`packages/ui/src/components/celebrate/`), and confetti sprays from the box. Because `CardDialog` renders `NoteCardDialog`, a comment card in a doc or a sheet gets the same.

The reward should stay a surprise and never turn into a chore, so the rules are strict. Only the user's own click fires it: a peer's edit or a refetch changes the description without a click. The hook rolls a one-in-three chance, and the dialog calls it once per opening, so unticking and re-ticking the last box can't farm it. A list of one item is a toggle, not a list. Under `prefers-reduced-motion` the ticked box glows instead of the burst. The click saves the description, and the parent draws it again a moment later, which replaces every box in the page; a glow on the clicked box would play on a node that is gone. So the dialog keeps the box's place in the list and celebrates from the box at that place once the new description is drawn. The personal setting `UserSettings.celebrations` turns it off, and missing means on, because a delight that's off by default is never found. Ticking a box in the card's edit form doesn't celebrate. The design and the later triggers are in [PROPOSAL_CELEBRATIONS.md](proposals/PROPOSAL_CELEBRATIONS.md).

The burst is our own code, one canvas over the page that clicks pass through, rather than a package. It takes its colors from the theme's chart tokens, so it follows dark mode, and a second burst while one runs is dropped.

## See also

- [COMMENTS.md](COMMENTS.md): the card model, lifecycle hooks and shared components
- [COLLAB.md](COLLAB.md): the Yjs server, `useCollabDoc` and version restore
- [CANVAS.md](CANVAS.md): how the canvas repairs a merge in its reader instead
