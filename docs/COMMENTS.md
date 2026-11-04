# Comments

> **TLDR:** A comment is a card pinned to a piece of a document, with a chat thread under it for the replies. Docs, sheets, stickies, slides and vector share one comment model, and each app only decides how a card anchors to its content. Hooks live in `packages/lib/src/core/comments/`, components in `packages/ui/src/components/comments/` and `cards/`, the server side in `apps/api/src/lib/chat/`.

A user selects something in a document, such as a run of text, a cell, a shape or an image, and adds a comment. They see a card with a title, a description, a color and optional attachments, and under it a chat thread for the replies. A comment can be resolved and reopened, and assigned to a member of the document. The comments pane beside the editor lists them. On a stickies board every card is a comment card.

Each app that shows comments is called a host. A host decides only where a card anchors, such as a mark on text in a doc or a list of card ids on a sheet cell. The shared hooks and components do the rest, so a change to comments lands in every app at once.

A comment is spread over three stores in the document's container, the Drive folder that holds one document, such as `Notes.eigendoc` ([STORAGE.md](STORAGE.md)). The card lives in the document's Y.Doc, the shared Yjs state every editor holds a copy of ([COLLAB.md](COLLAB.md)). The thread is a chat in the container's `chat/` folder ([CHAT.md](CHAT.md)). And `comments.db` keeps one index row per thread ([A comment lives in three stores](#a-comment-lives-in-three-stores)).

Three things surprise people:

- Text and color are collaborative Yjs state, but status and assignee are written by the server, which records the activity row and sends the notification ([A comment lives in three stores](#a-comment-lives-in-three-stores)).
- A delete strips the anchor and keeps the card, so whatever brings the anchor back, such as an undo or a version restore, brings the whole comment back ([A delete strips the anchor and keeps the card](#a-delete-strips-the-anchor-and-keeps-the-card)).
- On a phone the pane hides the editor instead of unmounting it ([The pane hides the editor, never unmounts it](#the-pane-hides-the-editor-never-unmounts-it)).

## A comment lives in three stores

The card (`CommentCard`, `packages/lib/src/types/comments.ts`) is an entry in a Y.Map on the document's Y.Doc: title, description, color, attachments, creator, and the name of its chat. Stickies keeps its cards in the `tasks` map and every other app in `comments`. Stickies data stays readable in every shape that shipped, so the name stays ([STICKIES.md](STICKIES.md)). The thread is an `.eigenchat` in the container's `chat/` folder, linked from the card by `chatName`. The index is `comments.db` beside `data.db`, one row per thread keyed by that chat name. So a container holds child items by design: its `chat/` threads, its `media/` folder, and each thread's own `media/`. A guard that refuses to create or copy under a container breaks comments and inline media.

Each fact lives where its writer is. Text, color and creator change in the editor, so they ride y-websocket like any other edit, reach peers live and need no REST route. Status and assignee go through the API, because a resolve or an assignment records an activity row and an assignment notifies someone, and the server has to do both. Reply count, last author and the search text are derived from the thread by the server on every message. So `comments.db` is not a cache: losing it loses every status and assignee.

## The card is sanitized where it is read

`readCards` (`hooks/use-comment-cards.ts`) is the one function every consumer of a card reads through. It sanitizes the description with `sanitizeCommentCardHtml`, the LightEditor allowlist plus task lists, and drops malformed attachments. Any peer can write raw values into the Y.Doc, and the description reaches `dangerouslySetInnerHTML` in every viewer.

`useCommentCards` reads the map synchronously on mount. A host that mounts after sync must see its cards on the first render, or a `?chat=` deep link resolves against an empty map and gives up. It also keeps a card object's identity while its fields are unchanged, so memoized card components skip the re-render.

## Each app anchors a card in its own content

| App | Anchor |
|---|---|
| Docs | The `comment` mark on text (`cardId`, `data-comment-id` in HTML); an image's or an equation's `commentCardId` attribute |
| Sheets | `Cell.commentCardIds`, an array of card ids |
| Stickies | The card id in a column's `taskIds` |
| Slides, vector | `VectorElementBase.commentCardIds`, a JSON id string, because every stored canvas field is a scalar ([CANVAS.md](CANVAS.md#every-stored-field-is-a-scalar)) |

`useCreateCommentCard` creates the chat, then writes the card and runs the host's anchor callback inside one Y.Doc transaction, so in docs and stickies the card and its anchor are one undo step. The callback must be synchronous: anything it defers escapes the transaction. The canvas is the exception: it anchors once the card exists, as an untracked write, because its `comments` map is outside the undo scope ([CANVAS.md § One discrete op is one undo step](CANVAS.md#one-discrete-op-is-one-undo-step)).

A docs image, chart or equation anchors through an attribute, not the mark, because the Yjs binding persists marks only on text: a mark on the node would vanish on reload and never reach a peer. `nodeCommentCardId` (`apps/docs/src/components/docs/extensions/comment-mark.ts`) reads either form, and everything outside the figure's node view goes through it: the active set, the decorations, scroll-to and delete. A text selection that spans a figure, a chart or an equation marks only the text. The figure reads as "Image" and the chart as "Chart" in a card's anchor text, so a comment on either alone has something to quote, and an equation reads as its linear form (`x/2`), or "Equation" when empty.

A cut image keeps its card, because the cut serializes the figure's `data-comment-id` like the mark and the card stays in the document's `comments` map. A paste keeps only the anchors that map holds: `cleanPastedHTML` (`apps/docs/src/components/docs/paste.ts`) strips every other `data-comment-id`, so content copied from another document arrives without anchors to cards this one lacks. A docs-to-docs paste of an image goes through the copy's HTML too, so in its own document a copied image keeps its card like copied text does. Pasted into a slide or a sheet, it arrives as an image item, which carries no card. A canvas paste clears `commentCardIds`, so a canvas copy starts without comments.

## A docs image opens its own menu and paints its own mark

ProseMirror never sees a right-click inside a node view, so the figure's node view hands it to the `Figure` extension's `onContextMenu`. The editor node-selects the figure and opens the image menu (**Download original image**, then the card's rows or **Add comment**) only when a row will render; otherwise the browser's menu shows. A commented figure or equation paints the canvas' `CommentIndicator` in its top-right corner, in the color a node decoration carries, resolved cards included, and only that mark opens the card: a click on the atom itself selects it. The node view re-renders on every update, because TipTap skips a decoration-only change and the color arrives as one. A chart's node view draws in the same frame (`FigureFrame`), so a chart does all of this too, with Download image in place of the original ([EXPORT.md](EXPORT.md#a-drawing-downloads-its-own-svg-and-prints-as-layers)). A table cell's and an equation's menus draw a card's rows the same way ([DOCS.md](DOCS.md#a-table-cell-and-an-equation-have-right-click-menus-of-their-own)).

## A delete strips the anchor and keeps the card

A delete takes the card's id out of the content and leaves the card, its thread and its index row where they are, until a sweep after the document closed removes a thread nothing names ([A sweep removes a thread nothing names](#a-sweep-removes-a-thread-nothing-names)). The panel shows only active cards, the ones the host finds in use, so the deleted comment disappears from view. An undo or a version restore that brings the anchor back brings the whole comment back, thread included. A restore moves only the anchors and leaves the cards alone, because the `comments` map is not one of the document's declared `yjsRoots` ([COLLAB.md](COLLAB.md#a-version-restore-rewrites-an-open-document-in-one-transaction)).

The canvas also marks the card deleted with `deletedAt`, because on the canvas a card that no element anchors is a document-level comment, not an orphan: stripping the anchor alone would leave it in the panel. Its active set, `activeCommentCardIds` (`packages/lib/src/vector/comments.ts`), counts a card that an element anchors or that is not marked. So a card whose element was deleted stays in the panel as a document-level comment, and a deleted card whose element comes back, through an undo of the element's delete or a restore, shows again. It keeps its `deletedAt`, so it shows only while an element anchors it: once that element is deleted again, the card hides, as a comment on deleted text hides in docs. A card raised from the pane is document-level from the start.

The canvas writes the mark and strips the id from every element that holds it in one untracked transaction (`deleteCommentCardInDoc`), and appends the id to its element after `createCard` resolves, untracked too. The comment map is outside the canvas undo scope, so a ⌘Z that moved only the anchor would bring back a card the user deleted, or turn a new comment into a document-level one. The append is idempotent, so a double submit lists the card once.

Stickies is the exception. Its `tasks` map is a declared root and in its undo scope. A delete removes the card from its column and from `tasks` in one transaction (`deleteCardFromBoard`), so one ⌘Z brings back the card and its place. A restore rewrites the cards too: a card added after the version drops off the board while its thread and row stay, and an edit made since to a card's text or color reverts.

## A sweep removes a thread nothing names

A deleted comment's thread stays while something could bring its card back. Once the document's last tab closed, the sweep that deletes unnamed media ([MEDIA-REFERENCES.md](MEDIA-REFERENCES.md#the-sweep-runs-after-the-last-tab-closed-and-deletes-only-if-nothing-changed)) also deletes a thread in `chat/` when no card in use names it, in the current state or in a kept version, and nobody created or wrote in it for 72 hours. A card is in use when its host's active set holds it: anchored in docs and sheets, on the board in stickies, anchored or not marked deleted on the canvas. The server reads that rule through `documentReferences` (`apps/api/src/lib/document/references.ts`).

The thread goes first, through `Mount.deletePath`, and only then its row in `comments.db` and its `comment_mentions` rows (`CommentIndex.deleteRowsWithoutThread`). The mentions have no foreign key, so they go by name, and the search hit follows the row through the `comments_ad` trigger. The order matters: a thread that stays without its row heals as open and unassigned and loses its status, while a row whose thread went is harmless. The same delete drops every row whose thread is no longer in `chat/`, so a leftover row goes with the next swept thread. `comments.db` is opened only when a thread went.

The card stays in the document's card map as dead bytes, because the sweep reads the closed document and never writes it. The activity rows that name the thread keep their entries ([FILE-HISTORY.md](FILE-HISTORY.md)).

A thread's last activity is the newer of its own `createdAt` and the `updatedAt` of its `data.db` row. A write stamps that row when the database syncs, within 30 s, so a reply through a notification while the document is closed keeps the thread for another 72 hours. On a disk mount a close stamps the row too, a close after a read included, so a thread someone opened counts as active. The sweep reads a thread's `data.db` from a temp copy, which stamps nothing.

## A thread's own media go when no message names them

Inside each thread that stays, a file in the thread's `media/` goes once it is 72 hours old and no message row names it, a deleted message's row included. The sweep lists the folder first and reads the thread's `data.db` only when a file is old enough to go, because on a bucket that read is a whole download. Only the current messages count: a thread's versions get no row of names. `ChatRoom.deleteMessage` trashes a deleted message's files itself ([CHAT.md](CHAT.md)), so a version of a thread can name an attachment that is gone. No screen restores a thread version.

## Card attachments are staged until Save

Attachments reuse chat's wire type, `ChatAttachment`: a string names a file in the container's `media/` folder, a reference points at a drive item. The form stages drafts locally and `useResolveCardAttachments` settles them on Save, so Cancel leaves nothing behind. A device file uploads into `media/`. A regular drive file is copied there, because the container's ACL must cover it for every collaborator, the same rule as chat ([CHAT.md § Attachments live in the room's media folder](CHAT.md#attachments-live-in-the-rooms-media-folder)). A container stays a reference. A failed upload aborts the save, so no card is half-attached. A container without a media folder hides the attachment controls.

Removing an attachment leaves its file in `media/` on purpose, like an inline image in a document: undo and version restore then bring the attachment back intact. Attachments on the thread's messages are the chat's own and live in the chat's `media/`.

## A thread's index row is seeded at creation and healed on write

`Drive.create` seeds the row when a chat is created inside a container's `chat/` folder (`seedCommentRow`). A standalone chat has no container and gets no row. `ensureComment` is an upsert that fills `createdBy` only while it is null, so any writer may call it. Posting a message, an assignment and a status write all call it, so a thread with no row heals on its first message, assignment, resolve or reopen. A resolve on such a thread creates the row before it writes the status, so the activity row and the index event never report a change the index lacks. The frontend treats a missing row as open and unassigned (`matchesCommentFilter`), so a card is usable before its row exists.

A status or assignee write first checks that the name resolves to a real `.eigenchat` under the container's `chat/` folder (`assertCommentChatExists`), and answers 404 otherwise. Without it a writer could mint a row, an activity row and a dead-link notification for a thread that does not exist. Both writes need write access, through the `SharedDrive` wrappers of `Drive.setCommentStatus` and `Drive.assignComment`.

## Every index write reaches the other clients

`ChatRoom.updateCommentIndex` wraps every write a message causes: it opens the index, runs the change, recomputes the search text and sends `CHAT_COMMENT_INDEX_UPDATED` to the owner's home and every effective member. The status and assignee routes send the same event through `broadcastCommentIndexUpdated` (`apps/api/src/lib/chat/sse-events.ts`), so a resolve or an assignment shows up live in every open tab. The seed at creation sends nothing; the creating client refetches the list itself in `useCreateCommentCard`. Cross-home delivery goes through the home relay ([SCALABILITY.md](SCALABILITY.md)).

## Search reads a recomputed tail of each thread

`recentText` holds the newest 8192 characters (`RECENT_TEXT_CAP`) of a thread's messages, and the FTS5 table `comments_fts` indexes it for the in-document find bar ([IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md#comment-threads-are-searched-on-the-server)). It is rebuilt from the live messages on every indexed write, not appended to, so a deleted message stops matching and an edit never matches twice. The chat reads the text right before it writes it, inside the comment index call, after the member lookup and the broadcast. So a post that waits on those never writes a text from before a later post. Two writes that both fall in the short read-and-write itself can still leave the older text, until the thread's next write. Whispers stay out of it and out of the index entirely. A built-in emote goes in as the third-person sentence a bystander reads (`searchableMessageText`), not its stored key, so a search for its words finds it. The people an emote names go in by name and email, looked up when the text is rebuilt, because a search finds a person by either ([CHAT.md](CHAT.md#emotes-are-stored-as-keys-and-phrased-per-viewer)). So a rename, or a thread whose text was built while the index held only emails, shows the new form only after the thread's next message, edit or delete. A failed lookup leaves the email alone and still writes the text and sends the update event. Text past the cap is not searchable; the full history lives in the thread's own `data.db`, out of reach of a query on `comments.db`. The FTS update trigger fires only when `recentText` changes, so status, count and assignee writes never re-index the body. The migrations are pinned in `apps/api/src/test/comments/`.

## Assignment is a member's email, set by the server

The assignee is a lowercased email that must belong to an effective member of the document, or the route answers 400. A real change records an `assigned` activity row. The assignee is left out of the watcher fan-out and gets a direct notification instead, unless they assigned themselves or have no account ([NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md), [ACTIVITY-ROWS.md](ACTIVITY-ROWS.md)). Picking the current assignee again, and unassigning, record no row and notify nobody.

The client posts the card title with every status and assignee write, and the server caches it in `title` for activity labels. It trusts the client the way the stickies card events do ([FILE-HISTORY.md](FILE-HISTORY.md)), and it lags a rename until the next action, so the UI never reads it and reads the card instead.

The toolbar badge counts the open, anchored comments assigned to you (`useAssignedCommentCount`). It is personal because a document-wide unresolved count would show every viewer the same red number, for threads that belong to someone else.

Mentions are recorded in `comment_mentions` on every message, and nothing reads them ([ROADMAP.md](ROADMAP.md)).

## One lifecycle bundle drives every host

`useCommentLifecycle` bundles the card read, the server entries, create, update, resolve, assign, the open card and `?chat=` resolution. `mapName` picks `comments` or `tasks`. A host that mounts before Yjs sync passes `ready`, so a deep link waits for the cards instead of resolving against an empty map.

`CommentLifecycleMenuItems` binds the shared rows (view, edit, color, assign, resolve or reopen, delete) to that bundle. It gates every write on `canWrite` in one place, and the host supplies only what its anchor decides: the item under the cursor, add and delete. So a new row lands in every app at once. It renders in `CommentContextMenu` (through `CommentLifecycleDialogs`, which every editor mounts), in the sheet's cell menu and in docs' image menu. Every row is a real menu item, so selecting one closes the host menu.

Adding a comment opens the form client-side; the server is touched only on Save. `CardForm` creates with concrete values (a trimmed title, a seeded color) and edits with a patch of the changed fields only, so an unchanged save writes nothing to the Y.Doc. Editing happens in place inside `CardDialog`, never in a stacked dialog. Edit mode is pinned to a card id in the bundle, so opening another card lands in view mode with no reset effect.

## The pane hides the editor, never unmounts it

`PanelColumn` is the comments and activity pane on every viewport: one `Column` with id `panel` whose toolbar carries the title, the filter and the close control. `useDocumentPanels` holds the open panel in one slot, so comments and activity are never both open. A pane row shows the comment's anchor text, and the card's title when it has none; the card dialog shows the title. Mount the pane outside any `<ColumnLayout mobileColumn="…">`. A `Column` whose id does not match hides itself, so a wrapped pane never shows, silently.

Below the breakpoint the pane takes the whole screen. Docs, sheets and the canvas hide the editor with a `hidden` wrapper instead of unmounting it, so node views, thumbnails, scroll position, selection and undo history survive a pane visit. Two things follow:

- Anything that measures the editor skips a 0×0 box, since `display: none` measures zero. Docs' resize observer and figure view, the sheet engine and the canvas viewport all do.
- The find bar floats inside the hidden wrapper. Each host passes `onSearchOpenChange` from `useDocumentPanels` to `DocSearchProvider`, which closes the pane when a search opens on mobile (⌘F, a palette hit).

On mobile every host opens a card with plain `setOpenCardId`. Scrolling to a mark or revealing an element would move a view nobody can see. On desktop docs and the canvas reveal the anchor first; slides activates the element's slide, then selects it.

Stickies mounts the pane for activity only and only on desktop; the mobile pane is open work in [ROADMAP.md](ROADMAP.md). The canvas passes `onAddComment`, which puts a **New comment** button in the pane for a document-level card.

## The filter lives on the surface it filters

The filter is session state, never persisted: `useCommentFilter` holds it in the host, so it survives closing the pane, and `matchesCommentFilter` (`packages/lib/src/core/comments/filter.ts`) applies it. In docs, sheets and the canvas it narrows only the pane, so the pane's `CommentFilterButton` is its only control. A toolbar menu would change state nobody can see while the pane is closed. Stickies filters the board itself, so its toolbar Filter menu (`CommentFilterMenuItems`) and its color-dot row drive one filter instance, and the board shows resolved cards by default.

## See also

- [CHAT.md](CHAT.md): the thread behind every card
- [STICKIES.md](STICKIES.md): the board's use of the card model
- [CANVAS.md](CANVAS.md) and [SLIDES.md](SLIDES.md): element anchors on the canvas
- [SHEETS.md](SHEETS.md): cell anchors and the corner triangle
- [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md): comment search in the find bar
- [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md), [ACTIVITY-ROWS.md](ACTIVITY-ROWS.md), [FILE-HISTORY.md](FILE-HISTORY.md): the assigned, resolved and reopened rows
- [LAYOUT.md](LAYOUT.md) and [MOBILE.md](MOBILE.md): the column layout and how it behaves on phones
