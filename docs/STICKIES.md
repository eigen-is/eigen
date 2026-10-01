# Stickies (Kanban Board)

> **TLDR:** A collaborative Kanban board in `apps/stickies/src/components/stickies/`, stored as an `.eigenstickies` Drive folder whose Yjs doc is the source of truth. The board owns only columns and their order: a card is the shared `CommentCard` with its own chat, so most of the board is the comment machinery. Three things are not obvious. Stickies data stays readable in every shape that ever shipped. A concurrent merge can put a card in two columns or none, so a shared repair ranks columns by `columnOrder`. A drag writes to Yjs once, on drop.

## The Yjs doc is the source of truth

Every change goes into the Yjs doc first. Observers then rebuild the React state (`hooks/use-board.ts` for columns, the shared comment hooks for cards), so a local edit and a peer's edit take the same path to the screen. Peers sync through the shared `useCollabDoc` ([COLLAB.md](COLLAB.md)). The doc has three roots:

```
Y.Map            "tasks"        cardId → Y.Map { id, title, description, color?, chatName?, creator?, createdAt?, attachments? }
Y.Map            "columns"      columnId → Y.Map { id, title, taskIds: Y.Array<string>, creator, createdAt }
Y.Array<string>  "columnOrder"  ordered column ids
```

The undo manager tracks all three roots. So a card and its column reference undo as one step, and so does a column and its place in `columnOrder`.

## Stickies data stays readable in every shape that shipped

Real boards live on eigen.is, so stickies are the exception to the pre-1.0 format policy in [ROADMAP.md](ROADMAP.md): the readers keep handling every stickies shape that ever shipped. They default a field an older board lacks rather than assume it. The root name `tasks` stays for the same reason, although its entries are cards.

What a reader tolerates is the contract:

- A card is read by `readCards` (`packages/lib/src/core/comments/hooks/use-comment-cards.ts`). `title` and `description` default to '', and the description is sanitized. `color`, `chatName`, `creator`, `createdAt` and `attachments` are optional, and a value of the wrong type reads as absent. An `attachments` list drops its null and number elements.
- A column is read in `hooks/use-board.ts`. A missing `title` or `creator` reads as '', a missing `createdAt` as 0, and a missing `taskIds` as an empty list. The add-card dialog creates the list before it inserts.
- A card's id and a column's id are their keys in `tasks` and `columns`. The stored `id` field is written but never read.

## A card is a shared CommentCard

The `tasks` entries are not a stickies type. They are written with the shared `writeCardToDoc(doc, 'tasks', card)` and read through `useCommentLifecycle({ mapName: 'tasks' })`, so the board and the comment layer agree on one card shape ([COMMENTS.md](COMMENTS.md)). `types.ts` holds only what the board owns: `ColumnItem` and `BoardData`.

A card is on the board when some column's `taskIds` lists it. That set is also what the lifecycle hook treats as the active cards. `createCard` creates the card's `.eigenchat` room first, stores its name as `chatName`, and writes the card and its column reference in one transaction; clicking the card opens that thread in the shared card dialog. Deleting a card removes it from its column and from `tasks` in one transaction, so there is no orphan reference and ⌘Z restores both. The chat and its `comments.db` row stay, so undo and a version revert bring the thread back with the card.

## A concurrent merge can leave a card in two columns, or none

Two peers moving the same card at once can leave it in two columns' `taskIds`, or in none. `normalizeBoard` repairs that with the shared `normalizeParentChildRefs` (`packages/lib/src/core/collab/normalize-refs.ts`). It runs on the first sync and inside the transaction of every drop on a target that is not an Alt duplicate, a drop that moves nothing included. A card in several columns keeps the last one. A card in no column joins the first.

**First and last come from `columnOrder`, not from Y.Map key order.** Key order is each peer's local integration order, so peers would disagree and could delete each other's survivor. A column missing from `columnOrder` ranks before every listed one, so it never receives a re-homed card: the board doesn't render it. Only when `columnOrder` lists no existing column does the repair fall back to key order. `packages/lib/src/test/core/collab/normalize-refs.test.ts` pins these cases.

The repair is idempotent. Run on sync it writes under `NORMALIZE_ORIGIN`, which no undo manager tracks, so it syncs to peers but ⌘Z can't restore the corruption. Inside a drag it joins the drag's undo step. Stickies is its only caller. The canvas needs no such repair, because an element names its own `frameId` and a frame holds no id list ([CANVAS.md](CANVAS.md#the-reader-is-the-trust-boundary)).

## Roots are read through typed accessors

The board reads its roots and id lists through `getItemMapRoot`, `getIdArrayRoot` and `getIdArray` (`packages/lib/src/core/collab/yjs-utils.ts`) instead of casting. A root needs no runtime check: `doc.get` upgrades the `AbstractType` root that `Y.applyUpdate` leaves on the server, and throws only on a real mismatch. A nested list is checked with `instanceof Y.Array`, which is sound because nested types always decode with their real constructors. `getIdArray` returns undefined for a missing list, which is how an older column without `taskIds` stays readable.

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

## See also

- [COMMENTS.md](COMMENTS.md): the card model, lifecycle hooks and shared components
- [COLLAB.md](COLLAB.md): the Yjs server, `useCollabDoc` and version restore
- [CANVAS.md](CANVAS.md): how the canvas repairs a merge in its reader instead
