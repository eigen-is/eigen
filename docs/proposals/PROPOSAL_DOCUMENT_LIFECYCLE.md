# Proposal: what a document keeps, and what a restore brings back

This proposal settles what happens over a document's life to the parts it holds besides its content: the media it embeds, its comment threads, and the documents it will soon embed, such as a chart's sheet. It covers docs, sheets, slides, vector and stickies.

**Status:** phases 1, 2, 3, 5 and 6 are built, on the `document-lifecycle` branch. Phase 4, version sets, is not: it waits for its first embedded document, phase 1 of [PROPOSAL_CHART_SHEETS.md](PROPOSAL_CHART_SHEETS.md), and [ROADMAP.md](../ROADMAP.md) has its row. The domain docs describe what is built, and win where this proposal and the code disagree: the sweep in [MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md#a-file-stays-while-a-state-names-it-and-a-sweep-deletes-the-rest), the comment rules in [COMMENTS.md](../COMMENTS.md#a-delete-strips-the-anchor-and-keeps-the-card), the copy and Delete history in [STORAGE.md](../STORAGE.md#copy-goes-anywhere-a-move-stays-in-its-mount) and its [version section](../STORAGE.md#version-snapshots-live-inside-the-container), the version rows in [DATABASE.md](../DATABASE.md#a-versions-names-are-a-row-the-sweep-fills) and the reader in [DOCUMENT-CONTENT-LAYER.md](../DOCUMENT-CONTENT-LAYER.md#the-references-reader-names-the-parts-a-state-uses). This proposal keeps the design, the owner's rulings and the plan for phase 4. Treat every claim it makes about phase 4 as a pointer, and verify it in the code before building on it.

> **TLDR**: A document's container holds parts beside its content: images in `media/`, comment threads in `chat/`, and later embedded sheets and drawings. The content names them, and a delete drops only the name, so an undo or a version restore finds the part again. One rule decides what stays: **a part stays while the current state or a saved version names it**, or while it is younger than three days. A sweep after the document's last tab closed deletes the rest. A restore brings back a comment's anchor and never its conversation. An owner of the drive can delete a document's history to make it small now, and a copy takes only the parts the current state names. Each version's names are one row in the mount's `metadata.db`, which the sweep fills once and refills when the reader changes. Phase 4 lets an embedded document go back with its parent, through a version that holds both.

## Goals

1. A part of a document that nothing can bring back is removed by the server, without any user action: a media file, a comment thread, the files under a thread, and later an embedded document.
2. Undo and version restore keep working for every part they could bring back.
3. A restore treats comments the same way in every host: the anchors go back, the conversation does not.
4. A document embedded in another one goes back with it on a restore (phase 4).
5. An export and a copy carry only the parts the document shows.
6. The owner of a document can make it small now, by deleting its history.

## Non-goals

- Rewinding a comment thread with its document. A thread holds replies other people posted after the version, and their notifications and activity rows already went out (§ Decisions).
- Changing the retention policy. It decides how long a deleted part stays (§ Risks).
- A linked embed, a sheet that lives elsewhere in Drive. It has a timeline of its own by definition, and stays the "linked data" part of the ROADMAP-POST-1 row.
- Reaching into other homes when a thread goes. A notification about it sits in each recipient's own `notifications.db` and keeps its link, which lands on the deleted-comment state (§ A swept thread leaves pointers behind).
- An embedded document inside an embedded document. Nesting stops at one level.

## Design

### A container keeps a part while something names it

| Part | Folder | Named by | On a restore |
|---|---|---|---|
| Media file | `media/` | a figure's or an image's `mediaName`, a slide's image background, a card's `attachments` | nothing: it never changes, so it only has to exist |
| Comment thread | `chat/` | a card in use (§ below) | nothing, on purpose: conversation is never rewound |
| Embedded sheet (phase 4) | `sheets/` | a chart's `data.workbook` | the version set holds its `data.db`, and it goes back with the parent |
| Embedded drawing (later) | `drawings/` | its node | as an embedded sheet |

One rule covers them all: **a part stays while the current state or a retained version names it.** Everything else goes in the sweep, once it is older than the grace period, three days (`SWEEP_GRACE_DAYS` in `@workspace/lib/constants/sweep`). The grace exists because an upload lands before the edit that names it reaches the server, and a tab that was offline over a weekend may still hold that edit. A thread and an embedded document are containers of their own, so the rule runs again inside them, over their own `media/`: a thread's file stays while a message names it, a deleted message included.

### A thread is named by a card in use

A card stays in the card map after its comment is deleted, so the map alone would keep every thread for good. A thread is named when its card is in use:

| Host | In use |
|---|---|
| Docs, sheets | anchored in the content: the `comment` mark, a node's `commentCardId`, a cell's `commentCardIds` |
| Slides, vector | anchored on an element, or a document-level card not marked deleted |
| Stickies | on the board: in a column's `taskIds`, with its card in `tasks` |

A restore brings back a version's anchors but keeps today's card map, except in stickies, whose `tasks` map is a restored root. So a comment a restore brings back is today's card, with today's thread and attachments. That is why a version remembers the cards it has in use, and why the sweep keeps what today's card holds for every card any kept state uses, not only what the version's own card held.

### Every host keeps a deleted card in its map

The canvas follows the docs rule: a delete strips the anchor and leaves the card, so a restore that brings back the anchor brings back the comment. The canvas cannot read "anchored" as "in use", because a document-level card has no anchor by design. So a delete marks the card with `deletedAt` (`CommentCard`, `packages/lib/src/types/comments.ts`) instead of removing it, and the canvas' active set is: anchored, or not marked. A marked card whose element comes back with a restore has an anchor again and shows. Both writes stay untracked, for the reason COMMENTS.md gives. Docs and sheets need no mark, because their active set already comes from the anchors.

### One reader per type names a document's parts

`documentReferences(type, doc)` (`apps/api/src/lib/document/references.ts`) reads one state of a document and returns its names: `{ media, chat, cards }`, the files in `media/`, the threads in `chat/` and the cards it has in use. It runs in the transform process, as a `references` job of its own per state, so a large document never loads on the API's event loop. A read of the current state can be given the cards the versions use, and then names today's thread and attachments for each.

A name it misses deletes a part in use, so it errs toward more names. It reads each type's content as its editor does, reads every card strictly, and throws on a shape it cannot trust: the sweep then deletes nothing, and a copy takes the document whole. A change to what any reader finds bumps `REFERENCE_READER_VERSION`, now 2, and every stored row from an older reader is read again.

The exports keep their own walks over their part of the document, and share with the reader only the helpers that find a media name, `mediaNamesIn` and `sceneMediaNames` (`apps/api/src/lib/document/media.ts`). Phase 4 adds the embedded documents to the result, such as a `sheets` list, and says whose folder a name in a set's copy lives in. Run on an embedded document, the reader then returns no embedded documents, so a chart pasted into a chart's sheet can never start a second level.

### A version's names are a row in `metadata.db`

The table `version_references` in the mount's `metadata.db` (`apps/api/src/lib/mount/db-config.ts`, schema v9) holds one row per version: `versionPathId`, the version file's `paths` id as primary key and as a foreign key with `ON DELETE CASCADE`, then `readerVersion` and `names`, the reader's result as JSON. It follows `path_content`'s pattern: the document layer computes the names, and the mount stores and returns them and never parses Yjs.

So the names go where the version goes:

- A prune or Delete history deletes the version's row, and the cascade deletes its names in the same step.
- A restore writes only `data.db`, so newer versions stay known and pruned ones stay gone.
- A copy gets no versions, so it gets no names.
- A backup copies the rows and their versions together, in the one copy of `metadata.db`.

**The rows heal themselves.** A version without a row, or with a row from an older reader, is unknown, never empty: the sweep reads it and writes its row as soon as the read returns. A version never changes, so that happens once per reader version. Taking a version stays as it was, because the close-time version is staged inside `ManagedDatabase.close`, which has no handle on the open document. A crash, a backup taken between a version and its row, or a reader bug once fixed can each only keep a part too long. The current state's names are never stored: every sweep and every copy reads them fresh.

### The sweep runs after the last tab closed

After a document's linger close, at most once a day, the server sweeps it in the background, one document at a time (`sweepDocument`, `apps/api/src/lib/drive/sweep.ts`). It lists first, and stops when no file is past the grace period and no thread is idle or holds an old file, so most sweeps cost no download. Otherwise it reads each unknown version, then the current state from the closed `data.db`, all outside any lock. Then, under the container's path lock, it deletes only if the document is still closed, not on its way to the trash and not being restored, and its `data.db` row and version list are as they were. It deletes the unnamed media, the threads no card in use names that nobody wrote in for the grace period, and in each kept thread the files no message names, all through `Mount.deletePath`, so the folder sizes and the quota follow. [MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md#the-sweep-runs-after-the-last-tab-closed-and-deletes-only-if-nothing-changed) has the reads, the fence and every case that leaves a document due.

A document closes only when no socket is left ([COLLAB.md](../COLLAB.md#a-document-lingers-after-the-last-unsubscribe)), so no connected tab holds an undo step that needs a swept part. Any failure keeps the parts and waits a day, a busy transform process or a change while it read waits for the next close, so a sweep can keep a part too long but never deletes one in use.

**A thread goes before its row.** A swept thread's `comments.db` row and its `comment_mentions` rows go after the thread: an orphan row is harmless, but a thread without a row heals as open and unassigned and would lose its status. The same delete drops every row whose thread is gone and not in the trash. `comments.db` is opened only when a thread went, because on S3 an open of a closed document's `comments.db` is a whole-object download.

### A swept thread leaves pointers behind

The card stays in the map as dead bytes, because removing it would mean opening the document again for one write (§ Decisions). Two things can still reach it: an offline tab that undoes past a sweep, and a link to the thread, such as a `?chat=` link, a notification in another home, an activity row or a search hit. `findCardIdByChatName` still finds the card, and the thread is gone.

So one rule marks a comment deleted: its thread is gone from `chat/`, or its host no longer uses its card (`useIsCardDeleted`). It shows as **This comment was deleted**, with its title grayed, in the pane, in the card dialog and wherever a link lands, with no thread, no reply, resolve or assign ([COMMENTS.md](../COMMENTS.md#a-deleted-comment-shows-as-deleted-wherever-it-is-reached)). Activity rows keep their entries, because history is conversation too.

### A copy carries the current state's parts

The Office exports already pack only the media the document names. A Drive copy does the same: it reads each document's flushed `data.db` once into a temp copy, runs one `references` job on it, and copies only the media, the threads whose card is in use and, inside each thread, the files its messages name (`withNamedPartsOnly`, `apps/api/src/lib/drive/copy-parts.ts`). The temp copy goes as soon as the read ends. The copy writes the document's `data.db` first and compares its hash with that of the bytes the filter read, and a document edited since copies whole, so a copy never names a part it lacks. A copy across drives takes the same filtered tree, and the copy's `comments.db` drops the rows of the threads it left as soon as the document landed. A document whose names can't be read copies whole. The current state's names are not cached: a copy is rare, and a cache keyed by the `data.db` hash waits until a copy of a large document is measured slow. [STORAGE.md](../STORAGE.md#copy-goes-anywhere-a-move-stays-in-its-mount) has the rest. A portable package ([PROPOSAL_PORTABLE_DOCUMENTS.md](PROPOSAL_PORTABLE_DOCUMENTS.md)) would pack the same names when it is built.

### A version of a document is a set

Phase 4, not built. A document embedded in another one is part of its content. It changes, so the parent's version has to hold its state at the same moment.

**The layout.** A version stays `versions/<iso-ts>.db`, the parent's `data.db`. Its folder `versions/<iso-ts>/` holds one copy per embedded document: `sheets/<name>.db`, later `drawings/<name>.db`. A document with no embedded documents has no folder, so the format needs no flag, and every version taken before phase 4 is a set with no embedded documents. `listVersions` and `selectSnapshotsToPrune` see only names that match `SNAPSHOT_NAME_FORMAT`, so neither sees the folder, and the prune learns to remove a version's folder with its `.db`.

**Taking one.** `takeSnapshot` flushes and copies the parent's `data.db` and, under the same container lock, each embedded document's `data.db`. An embedded document keeps no `versions/` of its own. `buildDocumentDb` wires its `onSnapshot` to take the parent's set instead, through the same try-lock, so a session that only edits a chart's sheet still makes versions. The version list and restore routes refuse an embedded document, because restoring it alone would break the set.

**Restoring one.** The pre-restore version is a whole set, as is every version. The parent then takes the old state through `applySnapshotState`, and so does each embedded document in the set, open or not, through the path `restoreYjsContainer` uses. An embedded document in the set that is gone since is created again from its copy. One the set lacks is left alone: the restored parent no longer names it, and it goes once no retained version names it either. A set restore is not atomic across documents: a failure halfway leaves the parent restored and some embedded documents not, the pre-restore set is the way back, and the error says the restore did not finish.

**Sweeping one.** An embedded document's media names come from its current `data.db` and from its copies in the parent's sets, since it keeps no versions of its own. Its version row is the set's row, the union of its parts' names.

### Delete history frees the versions and what only they named

The sweep removes only what no restore could bring back, so it loses nothing. Delete history removes the restore points themselves, on purpose, for an owner who wants the document small now.

**Where.** **Delete history…** is the last row of the File menu's Version history submenu, where the versions it deletes are listed: red, below a separator and outside the list's scroll area, so 47 versions never push it out of view, and disabled while there is no version. Its confirm dialog uses the delete preset: "Delete version history?", then "Frees 120 MB. Earlier versions of this document and its comments can't be restored after this. Images and comments you deleted are removed once everyone has closed it, except those added or replied to in the last 3 days.", with a **Delete history** button. The size is the sum the version list already returns, and the days come from `SWEEP_GRACE_DAYS`. What the sweep then frees comes on top and is not counted in advance.

**Who.** An owner of the drive only (`requireDriveOwner`, as for a delete forever in the trash), because nothing brings a deleted version back: the user on their own drive, every member on a team drive, every member of the organization on its default team. A writer who is no owner gets 403.

**What.** Every version of the document goes at once, and so do its comment threads' own versions: no screen restores a thread, so to a user they are part of the document's history. A thread in the trash keeps its versions. Each `versions/` folder goes under the path lock of its container, the lock a version takes (`deleteVersions`, `apps/api/src/lib/versioning/delete.ts`). The document is then due for the sweep without its day's wait, so the rest goes once its last tab closed, and the grace period still holds. Delete history records a file event, so the document's activity and its watchers see it. A peer with the editor open who then undoes a delete gets the missing image or the deleted-comment state.

**The route.** `DELETE /drive/:ownerId/:mountId/file/:pathId/versions`, beside the version routes that list, save and restore, through `SharedDrive.deleteVersions`, which checks ownership. The way to a document without history that needs no route is Copy, which leaves the versions behind, but a copy is a new document with new links and new sharing.

## Phasing

| Phase | Work | State |
|---|---|---|
| 1. Comments | The canvas keeps a deleted card, marked; its active set; COMMENTS.md's one rule plus the stickies exception | Built. `packages/lib/src/test/vector/comments.test.ts`, `packages/ui/src/test/components/vector/hooks/element-writes.test.ts` |
| 2. Media sweep | `documentReferences` per type in the `references` job; the `version_references` table and its lazy fill; the sweep of `media/` after close | Built. `apps/api/src/test/document/references.test.ts`, `mount/version-references.test.ts`, `drive/sweep.test.ts` |
| 3. Thread sweep | The in-use rule per host; the sweep of `chat/`, its `comments.db` rows and mentions, and of each thread's `media/`; the deleted-comment state in the pane, the dialog and every landing | Built. `drive/sweep.test.ts`, `comments/comment-index.test.ts`, `packages/lib/src/test/core/comments/hooks/use-is-card-deleted.test.tsx`, `packages/ui/src/test/components/comments/deleted-comment.test.tsx` |
| 4. Version sets | The set layout, taking, pruning and restoring it, the redirected `onSnapshot`, the refused routes, the reader's one level, the sweep inside an embedded document. Built in the same branch as phase 1 of the chart-sheets proposal. Tests: a restore brings a chart's sheet back to the version; a sheet deleted since comes back; one added since goes after the sweep; an image in a sheet stays while a set's copy names it | Not built, about 2.5 days |
| 5. Delete history | The route, its `SharedDrive` ownership check and the `Drive` method, the hook, the row and the confirm dialog, the file event | Built. `versioning/delete-versions.test.ts`, `packages/ui/src/test/components/layout/toolbar/version-history-menu.test.tsx` |
| 6. Fresh copy | The copy filter over the listed tree, for a copy in one mount and across drives; the rows of left threads dropped at copy time; the copy writes the `data.db` its filter read | Built. `drive/copy-parts.test.ts`, `drive/drive-copy-import.test.ts` |

The API tests sit under `apps/api/src/test/`. Phase 4 also updates STORAGE.md's version section, MEDIA-REFERENCES.md's sweep and COLLAB.md's restore, and the help center's version articles, `docs/doc-versions.md` and `drive/file-versions.md`.

## Risks

- **A deleted part can stay for a year.** A monthly version keeps every part it names for up to 12 months. That is the price of restoring it. A document that is mostly zombies and edited every day still shrinks only as its versions prune, or with Delete history.
- **An offline tab can undo past a sweep.** A tab that went offline with a delete in its undo history, and undoes it after the document closed and swept, brings back a name with nothing behind it. The image draws as missing (`isMediaMissing`), and the comment as deleted. The grace period does not cover an update that stays offline longer.
- **A reader that misses a field deletes a part still in use.** A new field that names media, or a new kind of comment anchor, missed in `documentReferences`, loses that part at the next sweep, and for a thread that is conversation, not an image. `apps/api/src/test/document/references.test.ts` builds each type with every kind of reference, and a reader that throws stops the sweep for that document.
- **A version that never reads keeps its document unswept.** Its read fails at every sweep, once a day, until retention prunes it.
- **A reply can land in the instant before its thread goes.** A chat post does not take the container's lock, so a reply between the sweep's last check of an idle thread and its delete is lost with the thread. The window is one delete, after three idle days.
- **A document nobody opens again keeps its zombies.** The sweep runs after a close, so such a document shrinks at its next close, or when its owner deletes its history (§ Decisions).
- **Delete history cannot be undone.** A misclick loses every restore point. The confirm dialog names the loss, and only an owner of the drive sees the row.
- **A set costs as much as its parts** (phase 4). A version of a doc with five charts copies six databases. A chart's sheet is a few tens of KB.

## Decisions

The owner made these on 2026-11-04.

1. **A restore never rewinds conversation.** Comment threads, their index and the comment cards stay as they are; the anchors go back. Every host but stickies follows this. The restore dialog says: "Comments go back with the text they're on. Their replies stay as they are now."
2. **A document embedded in another one goes back with it, through version sets.** A version of the parent holds the parent's `data.db` and each embedded document's, taken and restored together. Chosen over putting the embedded content in the parent's Y.Doc, which would have changed the Workbook's own roots and compaction.
3. **A copy carries only the current state's parts**, with no cache of those names until one is measured to be needed. It writes the exact `data.db` bytes its filter read.
4. **Delete history is the last row of the Version history submenu**, red, below a separator, outside the scroll area, and disabled with no versions; not a button at the bottom of a Version history panel. It is for an owner of the drive only, as a delete forever in the trash, which on the default team is every member of the organization. It deletes the comment threads' versions too. Its versions go at once and the rest at the document's next close, and it clears the once-a-day mark. It records a file event. The new route needed its own yes, and has it.
5. **No one-off sweep of documents nobody opens again.** Their zombies go at their next close, or with Delete history.
6. **One rule for every part, comment threads included.** A media file, an embedded document and a comment thread each stay while the current state or a retained version names them, and the sweep removes the rest.
7. **A swept thread's card stays in the map.** It is a few hundred bytes and never shows, and removing it would mean opening the document again after its close for one write.
8. **The sweep spares parts younger than three days**, so an upload or a new thread from a tab that went offline over a weekend survives. The Delete history dialog says so: "except those added or replied to in the last 3 days".
9. **A version's names are a row in `metadata.db` that heals itself.** A version without a row, or with a row from an older reader, is read once and its row written again. The table was a migration of `metadata.db`, approved and built.
10. **Versions remember the comments they use.** A version's row holds the cards it has in use, and the sweep keeps today's thread and attachments of every card any kept state uses, because a restore brings back the anchor with today's card.
11. **One deleted-comment state.** A comment whose thread is gone, or whose card its host no longer uses, shows as "This comment was deleted" with its title grayed, its messages hidden and no reply, resolve or assign, in the pane, the card dialog, a `?chat=` landing, a link, a notification and a search hit.
12. **Sheets comments live on every tab.** The pane lists them all, and a comment on another tab reads that tab's name first, such as "Sheet2 · B2", while the open tab keeps "Cell B2". A duplicated tab starts without comment anchors, so one card never sits on two tabs.
13. **No hash in the sweep's fence.** The sweep compares the `data.db` row's size and time. A hash on a managed database's row is its own ROADMAP row.

## Alternatives weighed

Where a version's names are stored, before the owner chose the `metadata.db` table (Decision 9):

- **A file per version, `versions/<iso-ts>/references.json`.** Up to 47 object reads per sweep. On S3 a plain file written during a close is a direct PUT the close waits for, while a version goes through the upload queue.
- **A table in the live `data.db`.** The close-time version is staged after the final sync, so a row written then never reaches S3. Every version copy and every Drive copy carries the table, and a restore that writes a version's bytes over `data.db` brings back an old table that forgets newer versions. Every row also makes the next sync upload the whole `data.db`.
- **A database of its own per container**, such as a `media.db`, or one `versions/index.db`. Each is one more container database: on S3 a whole-object download on open, a staged copy, a queued upload and a `pending_uploads` row per change, and more open files per container ([PROPOSAL_FD_BUDGET.md](PROPOSAL_FD_BUDGET.md)). None can cascade with the version rows, so every prune becomes two writes with a crash between.
- **One mutable index file for the document.** One read, but a lost or late rewrite forgets a live version.
- **The names in the version row's `details` JSON.** The table's properties without a migration, but `details` is a loose bag, and `Drive.updatePathDetails` replaces it whole.
- **One row per name, `(scope, kind, name)`, and a reader-version column on `paths`.** Two places to keep in step, and a version that names nothing needs a marker row. One row per version is its own record that the version was read.

The cost of the table: the mount's `metadata.db` holds names that come from document content. `path_content` already does the same for search text, so the layer rule holds as long as the mount only stores the rows.

For the rest of the design:

- **The canvas' deleted cards as a list in its `meta`**, not a mark on the card. A list resurrects a deleted card on a restore to before the card existed, grows for good, and is one string that two peers overwrite.
- **The sweep reading the live Y.Doc of an open document.** It never sweeps an open document, so it reads the closed `data.db`: one read path, and a restore after the close either lands in what it reads or moves the fence.
- **Rewinding comment threads with their document.** Other people's replies and the notifications about them already went out (Decision 1).

## Related

- [MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md): names, fixed folders, the missing-image draw and the sweep
- [COMMENTS.md](../COMMENTS.md): the three stores, the in-use rule and the deleted state
- [STORAGE.md](../STORAGE.md#version-snapshots-live-inside-the-container): versions, retention, Delete history and copy
- [DATABASE.md](../DATABASE.md#a-versions-names-are-a-row-the-sweep-fills): the version rows
- [COLLAB.md](../COLLAB.md#a-version-restore-rewrites-an-open-document-in-one-transaction): the in-place restore
- [SYNC.md](../SYNC.md): how a container database reaches S3
- [PROPOSAL_CHART_SHEETS.md](PROPOSAL_CHART_SHEETS.md), [PROPOSAL_PORTABLE_DOCUMENTS.md](PROPOSAL_PORTABLE_DOCUMENTS.md): the two designs this one changes
