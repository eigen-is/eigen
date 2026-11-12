# Comments

> **TLDR:** A comment is a card pinned to a piece of a document, with a chat thread under it for the replies. Docs, sheets, stickies, slides and vector share one comment model, and each app only decides how a card anchors to its content. Hooks live in `packages/lib/src/core/comments/`, components in `packages/ui/src/components/comments/` and `cards/`, the server side in `apps/api/src/lib/chat/`.

A user selects something in a document, such as a run of text, a cell, a shape or an image, and adds a comment. They see a card with a title, a description, a color and optional attachments, and under it a chat thread for the replies. A comment can be resolved and reopened, and assigned to a member of the document. The comments pane beside the editor lists them, and a mouse resting on one shows its card. On a stickies board every card is a comment card.

Each app that shows comments is called a host. A host decides only where a card anchors, such as a mark on text in a doc or a list of card ids on a sheet cell. The shared hooks and components do the rest, so a change to comments lands in every app at once.

A comment is spread over three stores in the document's container, the Drive folder that holds one document, such as `Notes.eigendoc` ([STORAGE.md](STORAGE.md)). The card lives in the document's Y.Doc, the shared Yjs state every editor holds a copy of ([COLLAB.md](COLLAB.md)). The thread is a chat in the container's `chat/` folder ([CHAT.md](CHAT.md)). And `comments.db` keeps one index row per thread ([A comment lives in three stores](#a-comment-lives-in-three-stores)).

Four things surprise people:

- Text and color are collaborative Yjs state, but status and assignee are written by the server, which records the activity row and sends the notification ([A comment lives in three stores](#a-comment-lives-in-three-stores)).
- A delete strips the anchor and keeps the card, so whatever brings the anchor back, such as an undo or a version restore, brings the whole comment back ([A delete strips the anchor and keeps the card](#a-delete-strips-the-anchor-and-keeps-the-card)).
- A link to a deleted comment still opens it, as "This comment was deleted" with nothing that acts ([A deleted comment shows as deleted wherever it is reached](#a-deleted-comment-shows-as-deleted-wherever-it-is-reached)).
- On a phone the pane hides the editor instead of unmounting it ([The pane hides the editor, never unmounts it](#the-pane-hides-the-editor-never-unmounts-it)).

## A comment lives in three stores

The card (`CommentCard`, `packages/lib/src/types/comments.ts`) is an entry in a Y.Map on the document's Y.Doc: title, description, color, attachments, creator, and the name of its chat. Stickies keeps its cards in the `tasks` map and every other app in `comments`. The thread is an `.eigenchat` in the container's `chat/` folder, linked from the card by `chatName`. The index is `comments.db` beside `data.db`, one row per thread keyed by that chat name. So a container holds child items by design: its `chat/` threads, its `media/` folder, and each thread's own `media/`. A guard that refuses to create or copy under a container breaks comments and inline media.

Each fact lives where its writer is. Text, color and creator change in the editor, so they ride y-websocket like any other edit, reach peers live and need no REST route. Status and assignee go through the API, because a resolve or an assignment records an activity row and an assignment notifies someone, and the server has to do both. Reply count, last author and the search text are derived from the thread by the server on every message. So `comments.db` is not a cache: losing it loses every status and assignee.

## The card is sanitized where it is read

`readCards` (`hooks/use-comment-cards.ts`) is the one function every consumer of a card reads through. It sanitizes the description with `sanitizeCommentCardHtml`, the LightEditor allowlist plus task lists, and drops malformed attachments. Any peer can write raw values into the Y.Doc, and the description reaches `dangerouslySetInnerHTML` in every viewer.

`useCommentCards` reads the map synchronously on mount. A host that mounts after sync must see its cards on the first render, or a `?chat=` deep link resolves against an empty map and gives up. It also keeps a card object's identity while its fields are unchanged, so memoized card components skip the re-render.

## Each app anchors a card in its own content

| App | Anchor |
|---|---|
| Docs | The `comment` mark on text (`cardId`, `data-comment-id` in HTML); an image's, a chart's, a text box's or an equation's `commentCardId` attribute |
| Sheets | `Cell.commentCardIds`, an array of card ids |
| Stickies | The card id in a column's `taskIds` |
| Slides, vector | `VectorElementBase.commentCardIds`, a JSON id string, because every stored canvas field is a scalar ([CANVAS.md](CANVAS.md#every-stored-field-is-a-scalar)) |

`useCreateCommentCard` creates the chat, then writes the card and runs the host's anchor callback inside one Y.Doc transaction, so in docs and stickies the card and its anchor are one undo step. The callback must be synchronous: anything it defers escapes the transaction. The canvas is the exception: it anchors once the card exists, as an untracked write, because its `comments` map is outside the undo scope ([CANVAS.md § One discrete op is one undo step](CANVAS.md#one-discrete-op-is-one-undo-step)).

A docs image, chart, text box or equation anchors through an attribute, not the mark, because the Yjs binding persists marks only on text: a mark on the node would vanish on reload and never reach a peer. `nodeCommentCardId` (`apps/docs/src/components/docs/extensions/comment-mark.ts`) reads either form, and everything outside the figure's node view goes through it: the active set, the decorations, scroll-to and delete. A text selection that spans a figure, a chart or an equation marks only the text. A new card's title starts as the selection's text (`commentAnchorText`). A figure reads as "Image", a chart as "Chart" and a text box as "Text box", so a comment on one alone has something to quote. An equation reads as its linear form (`x/2`), or "Equation" when empty, and a page number as `#`.

A cut image keeps its card, because the cut serializes the figure's `data-comment-id` like the mark and the card stays in the document's `comments` map. A paste keeps only the anchors that map holds: `cleanPastedHTML` (`apps/docs/src/components/docs/paste.ts`) strips every other `data-comment-id`, so content copied from another document arrives without anchors to cards this one lacks. A docs-to-docs paste of an image goes through the copy's HTML too, so in its own document a copied image keeps its card like copied text does. Pasted into a slide or a sheet, it arrives as an image item, which carries no card. A canvas paste clears `commentCardIds`, so a canvas copy starts without comments.

## A docs image opens its own menu and paints its own mark

ProseMirror never sees a right-click inside a node view, so the figure's node view hands it to the `Figure` extension's `onContextMenu`. The editor node-selects the figure and opens the image menu (**Download original image**, then the card's rows or **Add comment**) only when a row will render; otherwise the browser's menu shows. A commented figure or equation paints the canvas' `CommentIndicator` in its top-right corner, in the color a node decoration carries, resolved cards included, and only that mark opens the card: a click on the atom itself selects it. The node view re-renders on every update, because TipTap skips a decoration-only change and the color arrives as one. A chart's node view draws in the same frame (`FigureFrame`), so a chart does all of this too, with Download image in place of the original ([EXPORT.md](EXPORT.md#a-drawing-downloads-its-own-svg-and-prints-as-layers)). A table cell's and an equation's menus draw a card's rows the same way ([DOCS.md](DOCS.md#a-table-cell-and-an-equation-have-right-click-menus-of-their-own)).

## A delete strips the anchor and keeps the card

A delete takes the card's id out of the content and leaves the card, its thread and its index row where they are, until Delete history or a copy removes a thread nothing names ([Delete history and a copy remove a thread nothing names](#delete-history-and-a-copy-remove-a-thread-nothing-names)). The panel shows only active cards, the ones the host finds in use, so the deleted comment disappears from view. An undo or a version restore that brings the anchor back brings the whole comment back, thread included. A restore moves only the anchors and leaves the cards alone, because the `comments` map is not one of the document's declared `yjsRoots` ([COLLAB.md](COLLAB.md#a-version-restore-rewrites-an-open-document-in-one-transaction)).

The canvas also marks the card deleted with `deletedAt`, because on the canvas a card that no element anchors is a document-level comment, not an orphan: stripping the anchor alone would leave it in the panel. Its active set, `activeCommentCardIds` (`packages/lib/src/vector/comments.ts`), counts a card that an element anchors or that is not marked. So a card whose element was deleted stays in the panel as a document-level comment, and a deleted card whose element comes back, through an undo of the element's delete or a restore, shows again. It keeps its `deletedAt`, so it shows only while an element anchors it: once that element is deleted again, the card hides, as a comment on deleted text hides in docs. A card raised from the pane is document-level from the start.

The canvas writes the mark and strips the id from every element that holds it in one untracked transaction (`deleteCommentCardInDoc`), and appends the id to its element after `createCard` resolves, untracked too. The comment map is outside the canvas undo scope, so a ⌘Z that moved only the anchor would bring back a card the user deleted, or turn a new comment into a document-level one. The append is idempotent, so a double submit lists the card once.

Stickies is the exception. Its `tasks` map is a declared root and in its undo scope. A delete removes the card from its column and from `tasks` in one transaction (`deleteCardFromBoard`), so one ⌘Z brings back the card and its place. A restore rewrites the cards too: a card added after the version drops off the board while its thread and row stay, and an edit made since to a card's text or color reverts. A link to such a card's thread still opens it as deleted, through its index row ([A deleted comment shows as deleted wherever it is reached](#a-deleted-comment-shows-as-deleted-wherever-it-is-reached)).

## A deleted comment shows as deleted wherever it is reached

A card is deleted when its host no longer uses it, or when its thread is gone from `chat/`, which the sweep does ([Delete history and a copy remove a thread nothing names](#delete-history-and-a-copy-remove-a-thread-nothing-names)). One rule says so, `useIsCardDeleted`, and the lifecycle hands it out as `isCardDeleted`. The card dialog, the pane and the comment menus read it, so a `?chat=` or `?card=` landing, a notification's link, an activity row and a comment search hit all open the same deleted state (`DeletedComment`): the title grayed and "This comment was deleted", with no thread, no description and nothing that acts. The menus keep only View and Delete. A resolve or an assignment on a gone thread would only get a 404, a reply has no thread to go to, and a card nothing anchors would otherwise open through a link as if it were live.

A comment whose card is gone from the map, such as a sticky deleted from its board, is deleted too. Its chat name still reaches it while `comments.db` holds its row, and it shows the row's `title`. The server writes that title only with a resolve or an assignment, so a sticky nobody resolved or assigned reads "Comment" ([ROADMAP.md](ROADMAP.md)). The lifecycle's `openChat` opens a chat name whether a card holds it or only a row does. A name a card holds opens that card by its id, so a card deleted while it is open closes the dialog however it was opened. Every host's landing and activity row goes through it, and so does a search hit in docs and in stickies. A host that shows a card's anchor before it opens the card, such as docs, sheets or a canvas, passes its own `openCard`, and `openChat` hands it a card the name finds. A name with neither a card nor a row opens nothing, and stickies drops the `?chat=` parameter. A `?card=` link and a `sticky-added` or `sticky-moved` activity row carry only the card id, so for a sticky deleted from its board they open nothing ([ROADMAP.md](ROADMAP.md)).

Neither half decides early. The active set counts only once the host's `ready` is true, or every landing in docs would show the deleted state for the 200 ms before its first walk of the body. A `?chat=` landing also waits for the index rows, or a sticky deleted from its board would read as not found. A `?card=` landing names only a card, so it waits for the cards alone. A thread counts as gone only once the chat folder's refetch settled (`isChatMissing` on the media resolver, the twin of `isMediaMissing`), so a new comment whose thread the listing doesn't hold yet never flashes deleted. While it waits, the thread shows the loading line. The lifecycle reads the resolver, so the resolver has to sit above the editor that calls `useCommentLifecycle`. Every editor route renders `EigenDocEditorRoute`, which provides `MediaResolverProvider` around the editor, so no host provides its own.

The pane lists only active cards, so it shows the deleted state only for a card whose thread went while the card stayed anchored, such as one another tab anchored again after the sweep, through an undo.

## Delete history and a copy remove a thread nothing names

A deleted comment's thread stays while something could bring its card back, which is any saved version. So nothing removes it on its own. Delete history, once the versions are gone, and a copy, on the copy, run the sweep that deletes unnamed media ([MEDIA-REFERENCES.md](MEDIA-REFERENCES.md#a-file-stays-until-delete-history-or-a-copy-and-then-only-while-the-state-names-it)), which also deletes a thread in `chat/` when no card in use names it and nobody created or wrote in it for 72 hours. A copy has no grace, but deletes only a thread it wrote itself, so a comment someone starts in it before its sweep runs stays. A card is in use when its host's active set holds it: anchored in docs and sheets, on the board in stickies, anchored or not marked deleted on the canvas. The server reads that rule through `documentReferences` (`apps/api/src/lib/document/references.ts`).

The thread goes first, through `Mount.deletePath`, and only then its row in `comments.db` and its `comment_mentions` rows (`CommentIndex.deleteRowsWithoutThread`), for every thread no longer in `chat/`. The mentions have no foreign key, so they go by name, and the search hit follows the row through the `comments_ad` trigger. The order matters: a thread that stays without its row heals as open and unassigned and loses its status, while a row whose thread went is harmless. No person can trash a thread on its own ([STORAGE.md](STORAGE.md#a-person-only-adds-new-files-and-threads-inside-a-document)), so a thread missing from `chat/` is gone for good, or in the trash with its whole document.

The card stays in the document's card map as dead bytes, because the sweep never writes the document. The activity rows that name the thread keep their entries ([FILE-HISTORY.md](FILE-HISTORY.md)).

A thread's last write is the newer of its own `createdAt` and the `updatedAt` of its `data.db` row. A write stamps that row when the database syncs, within 30 s, so a reply through a notification keeps the thread for another 72 hours, and a reply in the last seconds before a sweep may not. That is accepted: it takes a reply to a deleted comment's thread, untouched for 72 hours, within 30 s of Delete history. A database stays open for five idle minutes after any use, and on a disk mount its close stamps the row too, so a thread someone just read counts as written.

## A thread's own media go when no message names them

Inside each thread it keeps, the sweep runs again with the thread as the document: a file in the thread's `media/` goes when no message names it, a deleted message's included, and it is past the grace. `ChatRoom.deleteMessage` also deletes a deleted message's files itself ([CHAT.md](CHAT.md)), so a version of a thread can name an attachment that is gone. No screen restores a thread version.

## Card attachments are staged until Save

Attachments reuse chat's wire type, `ChatAttachment`: a string names a file in the container's `media/` folder, a reference points at a drive item. The form stages drafts locally and `useResolveCardAttachments` settles them on Save, so Cancel leaves nothing behind. A device file uploads into `media/`. A regular drive file is copied there, because the container's ACL must cover it for every collaborator, the same rule as chat ([CHAT.md § Attachments live in the room's media folder](CHAT.md#attachments-live-in-the-rooms-media-folder)). A container stays a reference. A failed upload aborts the save, so no card is half-attached. A container without a media folder hides the attachment controls.

Removing an attachment leaves its file in `media/` on purpose, like an inline image in a document, so an undo that puts the attachment back finds its file. A version restore does not bring a removed attachment back, because it keeps today's cards, except in stickies, whose cards are part of the board it restores. What a restore brings back is a card's anchor, and with it the card as it is today, attachments included. The sweep runs only once no version is left, or on a copy that has none, so it keeps the files the current state's cards in use hold. Attachments on the thread's messages are the chat's own and live in the chat's `media/`.

## A thread's index row is seeded at creation

`Drive.create` seeds the row when a chat is created inside a container's `chat/` folder (`seedCommentRow`). A standalone chat has no container and gets no row. `ensureComment` leaves a row that exists alone. Posting a message calls it too, so a thread that lost its row gets a new one on its first message. The frontend treats a missing row as open and unassigned (`matchesCommentFilter`), so a card shows before its row exists.

A status or assignee write answers 404 when the name has no row. Without that it would write an activity row and a notification while the card stayed open and unassigned. Both writes need write access, through the `SharedDrive` wrappers of `Drive.setCommentStatus` and `Drive.assignComment`.

## Every index write reaches the other clients

`ChatRoom.updateCommentIndex` wraps every write a message causes: it opens the index, runs the change, recomputes the search text and sends `CHAT_COMMENT_INDEX_UPDATED` to the owner's home and every effective member. `Drive.setCommentStatus` and `Drive.assignComment` send the same event through `broadcastCommentIndexUpdated` (`apps/api/src/lib/chat/sse-events.ts`), so a resolve or an assignment shows up live in every open tab. The seed at creation sends nothing; the creating client refetches the list itself in `useCreateCommentCard`. Cross-home delivery goes through the home relay ([SCALABILITY.md](SCALABILITY.md)).

## Search reads a recomputed tail of each thread

`recentText` holds the newest 8192 characters (`RECENT_TEXT_CAP`) of a thread's messages, and the FTS5 table `comments_fts` indexes it for the in-document find bar ([IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md#comment-threads-are-searched-on-the-server)). It is rebuilt from the live messages on every indexed write, not appended to, so a deleted message stops matching and an edit never matches twice. The chat reads the text right before it writes it, inside the comment index call, after the member lookup and the broadcast. So a post that waits on those never writes a text from before a later post. Two writes that both fall in the short read-and-write itself can still leave the older text, until the thread's next write. Whispers stay out of it and out of the index entirely. A built-in emote goes in as the third-person sentence a bystander reads (`searchableMessageText`), not its stored key, so a search for its words finds it. The people an emote names go in by name and email, looked up when the text is rebuilt, because a search finds a person by either ([CHAT.md](CHAT.md#emotes-are-stored-as-keys-and-phrased-per-viewer)). So a rename, or a thread whose text was built while the index held only emails, shows the new form only after the thread's next message, edit or delete. A failed lookup leaves the email alone and still writes the text and sends the update event. Text past the cap is not searchable; the full history lives in the thread's own `data.db`, out of reach of a query on `comments.db`. The FTS update trigger fires only when `recentText` changes, so status, count and assignee writes never re-index the body. The migrations are pinned in `apps/api/src/test/comments/`.

## Assignment is a member's email, set by the server

The assignee is a lowercased email that must belong to an effective member of the document, or the route answers 400. A real change records an `assigned` activity row. The assignee is left out of the watcher fan-out and gets a direct notification instead, unless they assigned themselves or have no account ([NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md), [ACTIVITY-ROWS.md](ACTIVITY-ROWS.md)). Picking the current assignee again, and unassigning, record no row and notify nobody.

The same assignments send a mail, under two server-wide flags ([SERVER-SETTINGS.md](SERVER-SETTINGS.md#the-notification-flags-gate-the-email-only)), because a guest rarely has Eigen open and one who never signed in has no bell. An address with no account counts as a guest: it gets the mail and no notification, as it has no home to hold one. The mail names the card title and links to the card with `?chat=`. A recipient off the mail domain goes through the guest login and returns to the card, because `buildAttachmentUrl` adds `?email=`, so a password user off the domain lands on the Guest tab, as with a share mail. The send is detached, so a slow mail relay does not hold the assign route.

The limit is one mail per person and document an hour (`assignMailWindow` in `apps/api/src/lib/drive/assignment-propagation.ts`). A notification folds a repeat on its tag, but a mail cannot, so working through a board would otherwise send a mail per card. Later cards in that document inside the hour reach the assignee only in the app: the bell, the toolbar badge in docs, sheets, slides and vector, and on a board the ring on their avatar (`NoteCard`). An address with no account hears of them only when it signs in. The window lives in the API process, so a restart forgets it, and a `false` from `sendMail` frees it, so the next assignment retries.

The client posts the card title with every status and assignee write, and the server caches it in `title` for activity labels. It trusts the client the way the stickies card events do ([FILE-HISTORY.md](FILE-HISTORY.md)), and it lags a rename until the next action, so the UI never reads it and reads the card instead.

The toolbar badge counts the open, anchored comments assigned to you (`useAssignedCommentCount`). It is personal because a document-wide unresolved count would show every viewer the same red number, for threads that belong to someone else. `NoteCard` marks the same thing on the card: its footer is muted, but the avatar of an open card assigned to you is not, and it has a ring in the app's color.

Mentions are recorded in `comment_mentions` on every message, and nothing reads them ([ROADMAP.md](ROADMAP.md)).

## One lifecycle bundle drives every host

`useCommentLifecycle` bundles the card read, the server entries, create, update, resolve, assign, the open card, `?chat=` and `?card=` resolution and the deleted rule. `mapName` picks `comments` or `tasks`, as `commentMapName` decides for a document type, the rule the server's reader uses too. Every host passes `ready` once its cards have synced and its active set is computed: docs after the first walk of the body, sheets once its workbook loaded and names its sheets, the canvas and stickies on sync. A landing waits for it instead of resolving against an empty map, and opens the card in the state the host shows it in.

A delete from the edit form or `CommentContextMenu` asks first, in the `DeleteCommentDialog` that `CommentLifecycleDialogs` mounts, which then runs the host's delete and closes the card, since a host that keeps a deleted card would otherwise leave the dialog open on its deleted state. The sheet's cell menu asks with the same `DeleteCommentDialog`, mounted in the sheet's dialog slot, which outlives the menu and passes `onCloseAutoFocus` so the focus goes back to the grid. Docs' image menu deletes through `part="delete"` without asking.

`CommentLifecycleMenuItems` binds the shared rows (view, edit, color, assign, resolve or reopen, delete) to that bundle. It gates every write on `canWrite` in one place, and the host supplies only what its anchor decides: the item under the cursor, add and delete. So a new row lands in every app at once. It renders in `CommentContextMenu` (through `CommentLifecycleDialogs`, which every editor mounts), in the sheet's cell menu and in docs' image menu. Every row is a real menu item, so selecting one closes the host menu.

Adding a comment opens the form client-side; the server is touched only on Save. `CardForm` creates with concrete values (a trimmed title, a seeded color) and edits with a patch of the changed fields only, so an unchanged save writes nothing to the Y.Doc. Editing happens in place inside `CardDialog`, never in a stacked dialog. Edit mode is pinned to a card id in the bundle, so opening another card lands in view mode with no reset effect.

## The pane hides the editor, never unmounts it

`PanelColumn` is the comments and activity pane on every viewport: one `Column` with id `panel` whose toolbar carries the title, the filter and the close control. `useDocumentPanels` holds the open panel in one slot, so comments and activity are never both open. A pane row is a `CommentNoteCard`, as the hover card and a board's drag overlay are, and shows the card's title. A host may add a prefix (`titlePrefixes`), which sheets uses for another sheet's name, as the only location left in the row. A card on several sheets counts as being on its first cell in tab order, so the prefix names where a click goes, even when the card is also on the open sheet. A title seeded from an anchor, such as `Cell B2`, stays as written when the anchor moves. `SortableNoteCard` in stickies maps a card onto `NoteCard` itself, because it takes flat props it can memoize. Mount the pane outside any `<ColumnLayout mobileColumn="…">`. A `Column` whose id does not match hides itself, so a wrapped pane never shows, silently.

Below the breakpoint the pane takes the whole screen. Docs, sheets and the canvas hide the editor with a `hidden` wrapper instead of unmounting it, so node views, thumbnails, scroll position, selection and undo history survive a pane visit. Two things follow:

- Anything that measures the editor skips a 0×0 box, since `display: none` measures zero. Docs' resize observer and figure view, the sheet engine and the canvas viewport all do.
- The find bar floats inside the hidden wrapper. Each host passes `onSearchOpenChange` from `useDocumentPanels` to `DocSearchProvider`, which closes the pane when a search opens on mobile (⌘F, a palette hit).

On mobile every host opens a card with plain `setOpenCardId`. Scrolling to a mark or revealing an element would move a view nobody can see. On desktop docs, sheets and the canvas reveal the anchor first; slides activates the element's slide, then selects it. Sheets goes to the cell's tab, selects the cell and centers it through `revealSearchMatch`, so with the find bar open a jump can move its ring, and a hidden tab refuses the switch, so that card opens without a jump. The pane row took the focus from the grid, so the jump then hands it to the grid's cell input (`focusGrid`), where the thread gives it back as it closes, and the arrows move the cursor again.

Stickies mounts the pane for activity only and only on desktop; the mobile pane is open work in [ROADMAP.md](ROADMAP.md). The canvas passes `onAddComment`, which puts a **New comment** button in the pane for a document-level card.

## A hover shows a comment's card, and the host draws it

Resting a mouse on a comment shows its card beside it, after a 300 ms pause that lets a quick pass go by. A click on the card opens the comment. An editor reports only "pointer over this card at this rect" or "pointer left", as `report(target)` or `report(null)`. A press reads as left, and so does a sheet's cell editor opening or a canvas mark unmounting, since no move or pointer leave comes then. The host, which already holds the cards and their entries, keeps that in `useCommentHover` and renders `CommentHoverCard`, so the hover hands no engine a thread list. Each host's state re-renders its editor twice per hover, which is accepted. The close waits a 150 ms grace after the pointer leaves, which a quick hand needs to reach the card. A slow one takes longer over the gap, or over the cell below a short anchor, so `CommentHoverCard` also holds the card while the pointer is between where it last was on the anchor and the card, as `enterCard` does on the card itself. Off that way, the grace runs as before, and back on the anchor the host's report takes over, which is why any report of a card releases the hold.

| App | What shows a card | Where the card opens |
|---|---|---|
| Docs | Highlighted text, and the corner mark of an image, a chart, a text box or an equation | Under it |
| Sheets | The whole cell, with its first card, unless the cell's link card is open, which the comment card would cover | Right of it |
| Slides, vector | An element's corner mark, with its first card | Right of it |

Stickies has no target, as its board draws the cards already. Resolved text gets no card, because its highlight is gone and nothing on the page says a comment sits there. A corner mark or a commented cell keeps its triangle when resolved, so it keeps its card. Docs reports from a React handler on a parent of `EditorContent` (`reportCommentHover`), because node views stop ProseMirror's events and draw their portals beside the editor's own div. A span that wraps reports the line under the pointer.

The card is a Radix `Popover` with a virtual anchor, because `HoverCard` has no Anchor part. It carries `role="tooltip"`, because `useDialogOpen` reads Radix's `role="dialog"` as a modal and stands down the document's keymaps. It takes no focus, so the editor keeps its caret: its content has Radix's `tabIndex` of -1, so a press on it is cancelled, or the thread its click opens would give the focus back to the card, gone by then. Radix still closes it on an outside press, a focus change and Escape, and the card stops that Escape, so it cancels no cell edit and closes no find bar. A deleted comment shows as deleted here too.

The rect is measured once. floating-ui tracks no scroll for a virtual anchor, so a wheel or a scroll anywhere closes the card rather than leaving it behind. A new anchor ref per target is what moves it, since Radix repositions only when the anchor's identity changes.

`enterCard` is a latch, not a cancel. The sheet's `document` mousemove reports "left" on every frame while the pointer is over the portaled card, so a cancel would last one frame and the 150 ms close would start again. While the latch holds, a report of "left" does nothing, and `leaveCard` clears it. A coarse pointer gets no card, because a tap emulates mouse events: a report of a card does nothing under `useIsCoarsePointer`.

Accepted edges:

- Sheets reports on every move, so after Escape or a wheel the next move over the same cell opens the card again after the pause. Docs and the canvas report only on entry, so they wait for the pointer to enter the target again.
- In sheets, a pane jump with a cell editor open acts as a tab click does: to another tab it discards the uncommitted typing, and on the same tab the selection moves under the editor, which still commits to its own cell. `revealSearchMatch` is shared with the find bar, and the workbook's API tells a host nothing about an open editor.
- A pointer resting on the card keeps it open while a sheet's cell editor opens, as the latch holds.

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
