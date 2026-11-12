# Proposal: what a document keeps, and what a restore brings back

This proposal settles what happens over a document's life to the parts it holds besides its content: the media it embeds, its comment threads, and the documents it will soon embed, such as a chart's sheet. It covers docs, sheets, slides, vector and stickies.

**Status:** phases 1, 2, 3, 5 and 6 are built, on the `document-lifecycle` branch, as the owner's rulings of 2026-11-05 reshaped them: no sweep runs on its own, only Delete history and a copy remove parts. Phase 4, version sets, is not built: it waits for its first embedded document, phase 1 of [PROPOSAL_CHART_SHEETS.md](PROPOSAL_CHART_SHEETS.md), and [ROADMAP.md](../ROADMAP.md) has its row. The domain docs describe what is built, and win where this proposal and the code disagree: the sweep in [MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md#a-file-stays-until-delete-history-or-a-copy-and-then-only-while-the-state-names-it), the comment rules in [COMMENTS.md](../COMMENTS.md#a-delete-strips-the-anchor-and-keeps-the-card), Delete history, the guard and the copy in [STORAGE.md](../STORAGE.md#delete-history-deletes-the-versions-and-then-sweeps-at-once) and the reader in [DOCUMENT-CONTENT-LAYER.md](../DOCUMENT-CONTENT-LAYER.md#the-references-reader-names-the-parts-a-state-uses). This proposal keeps the design, the owner's rulings and the plan for phase 4. Treat every claim it makes about phase 4 as a pointer, and verify it in the code before building on it.

## Goals

1. A part of a document that nothing can bring back is removed when its owner deletes its history, and from a copy: a media file, a comment thread, the files under a thread, and later an embedded document.
2. Undo and version restore keep working for every part they could bring back.
3. A restore treats comments the same way in every host: the anchors go back, the conversation does not.
4. A document embedded in another one goes back with it on a restore (phase 4).
5. A copy keeps only the parts the document shows.
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

One rule covers them all: **a part stays while the current state or a retained version names it.** So nothing goes while a version exists. Delete history removes the versions and then sweeps the rest at once, sparing parts younger than three days (`SWEEP_GRACE_DAYS` in `@workspace/lib/constants/sweep`), and a copy sweeps with no grace, but only the parts it wrote itself. The grace exists because an upload lands before the edit that names it reaches the server, and a tab that was offline over a weekend may still hold that edit. A thread and an embedded document are containers of their own, so the rule runs again inside them, over their own `media/`: a thread's file stays while a message names it, a deleted message included.

### A thread is named by a card in use

A card stays in the card map after its comment is deleted, so the map alone would keep every thread for good. A thread is named when its card is in use:

| Host | In use |
|---|---|
| Docs, sheets | anchored in the content: the `comment` mark, a node's `commentCardId`, a cell's `commentCardIds` |
| Slides, vector | anchored on an element, or a document-level card not marked deleted |
| Stickies | on the board: in a column's `taskIds`, with its card in `tasks` |

A restore brings back a version's anchors but keeps today's card map, except in stickies, whose `tasks` map is a restored root. So a comment a restore brings back is today's card, with today's thread and attachments. The sweep runs only when no version is left, so the current state's cards in use are all it reads.

### Every host keeps a deleted card in its map

The canvas follows the docs rule: a delete strips the anchor and leaves the card, so a restore that brings back the anchor brings back the comment. The canvas cannot read "anchored" as "in use", because a document-level card has no anchor by design. So a delete marks the card with `deletedAt` (`CommentCard`, `packages/lib/src/types/comments.ts`) instead of removing it, and the canvas' active set is: anchored, or not marked. A marked card whose element comes back with a restore has an anchor again and shows. Both writes stay untracked, for the reason COMMENTS.md gives. Docs and sheets need no mark, because their active set already comes from the anchors.

### One reader per type names a document's parts

`documentReferences(type, doc)` (`apps/api/src/lib/document/references.ts`) reads a document's current state and returns its names: `{ media, chat }`, the files in `media/` and the threads in `chat/`. It runs in the transform process, as a `references` job, so a large document never loads on the API's event loop.

A name it misses deletes a part in use, so it errs toward more names. It reads each type's content as its editor does, reads every card strictly, and throws on a shape it cannot trust: the sweep then deletes nothing.

The exports keep their own walks over their part of the document, and share with the reader only the helpers that find a media name, `mediaNamesIn` and `sceneMediaNames` (`apps/api/src/lib/document/media.ts`). Phase 4 adds the embedded documents to the result, such as a `sheets` list. Run on an embedded document, the reader then returns no embedded documents, so a chart pasted into a chart's sheet can never start a second level.

### The sweep runs after Delete history and after a copy

One function (`sweepDocument`, `apps/api/src/lib/drive/sweep.ts`) removes what a document's current state does not name, and `sweepCopy` runs it on each document a copy made, over only the parts that copy wrote. It reads the state through the same `data.db` read an export makes, so an open and a closed document read alike. It deletes the unnamed media and the threads no card in use names that nobody wrote in for the grace, through `Mount.deletePath`, so the folder sizes and the quota follow, then their `comments.db` rows and mentions. It runs again inside each thread it keeps, with the thread's messages as the state, so a file no message names goes too. Later it runs inside an embedded sheet or drawing, with that type's reader. Any failure logs and deletes nothing more. [MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md#the-sweep-reads-the-state-once-and-deletes-nothing-more-after-a-failure) has the reads.

**A thread goes before its row.** A swept thread's `comments.db` row and its `comment_mentions` rows go after the thread: an orphan row is harmless, but a thread without a row heals as open and unassigned and would lose its status. No person trashes, renames or moves a part of a document on its own ([STORAGE.md](../STORAGE.md#a-person-only-adds-new-files-and-threads-inside-a-document)), so a thread that is not in `chat/` is gone, and its row goes too.

### A swept thread leaves pointers behind

The card stays in the map as dead bytes, because the sweep never writes the document (§ Decisions). Two things can still reach it: another tab that undoes past a sweep, and a link to the thread, such as a `?chat=` link, a notification in another home, an activity row or a search hit. `findCardIdByChatName` still finds the card, and the thread is gone.

So one rule marks a comment deleted: its thread is gone from `chat/`, or its host no longer uses its card (`useIsCardDeleted`). It shows as **This comment was deleted**, with its title grayed, in the pane, in the card dialog and wherever a link lands, with no thread, no reply, resolve or assign ([COMMENTS.md](../COMMENTS.md#a-deleted-comment-shows-as-deleted-wherever-it-is-reached)). Activity rows keep their entries, because history is conversation too.

### A copy keeps only what its state names

A Drive copy writes every part's bytes and leaves the versions behind, then sweeps each document it made with no grace (`sweepCopy`). The sweep only considers the parts the copy wrote, known by the ids the copy returns. A copy to another drive shows in the target's tabs as each piece lands, so a part someone adds to it meanwhile is never a candidate. So the copy holds what the source's state names, plus whatever someone added since, and the source keeps everything. [STORAGE.md](../STORAGE.md#copy-goes-anywhere-a-move-stays-in-its-mount) has the rest. A portable package ([PROPOSAL_PORTABLE_DOCUMENTS.md](PROPOSAL_PORTABLE_DOCUMENTS.md)) packs only the names a state uses when it is built.

### A version of a document is a set

Phase 4, not built. A document embedded in another one is part of its content. It changes, so the parent's version has to hold its state at the same moment.

**The layout.** A version stays `versions/<iso-ts>.db`, the parent's `data.db`. Its folder `versions/<iso-ts>/` holds one copy per embedded document: `sheets/<name>.db`, later `drawings/<name>.db`. A document with no embedded documents has no folder, so the format needs no flag, and every version taken before phase 4 is a set with no embedded documents. `listVersions` and `selectSnapshotsToPrune` see only names that match `SNAPSHOT_NAME_FORMAT`, so neither sees the folder, and the prune learns to remove a version's folder with its `.db`.

**Taking one.** `takeSnapshot` flushes and copies the parent's `data.db` and, under the same container lock, each embedded document's `data.db`. An embedded document keeps no `versions/` of its own. `buildDocumentDb` wires its `onSnapshot` to take the parent's set instead, through the same try-lock, so a session that only edits a chart's sheet still makes versions. The version list and restore routes refuse an embedded document, because restoring it alone would break the set.

**Restoring one.** The pre-restore version is a whole set, as is every version. The parent then takes the old state through `applySnapshotState`, and so does each embedded document in the set, open or not, through the path `restoreYjsContainer` uses. An embedded document in the set that is gone since is created again from its copy. One the set lacks is left alone: the restored parent no longer names it, and it goes once no retained version names it either. A set restore is not atomic across documents: a failure halfway leaves the parent restored and some embedded documents not, the pre-restore set is the way back, and the error says the restore did not finish.

**Sweeping one.** The sweep runs inside an embedded document as inside a thread, after the parent's Delete history or copy, with its type's reader over its current `data.db`.

### Delete history frees the versions and what only they named

Nothing removes a part while a version could bring it back. Delete history removes the restore points themselves, on purpose, for an owner who wants the document small now, and then frees what only they named.

**Where.** **Delete history…** is the last row of the File menu's Version history submenu, where the versions it deletes are listed: red, below a separator and outside the list's scroll area, so 47 versions never push it out of view, and disabled while there is no version. Its confirm dialog uses the delete preset: "Delete version history?", then "Frees 120 MB. Earlier versions of this document and its comments can't be restored after this. Images and comments you deleted are removed now, except those added or replied to in the last 3 days.", with a **Delete history** button. The size is the sum the version list already returns, and the days come from `SWEEP_GRACE_DAYS`. What the sweep then frees comes on top and is not counted in advance.

**Who.** An owner of the drive only (`requireDriveOwner`, as for a delete forever in the trash), because nothing brings a deleted version back: the user on their own drive, every member on a team drive, every member of the organization on its default team. A writer who is no owner gets 403.

**What.** Every version of the document goes, and so do its comment threads' own versions: no screen restores a thread, so to a user they are part of the document's history. Each `versions/` folder goes under the path lock of its container, the lock a version takes (`deleteVersions`, `apps/api/src/lib/versioning/delete.ts`). Then the sweep runs at once on the document, which is open: what only the versions named goes in the same request, and the grace still holds. Another tab's undo of a delete may then bring back a missing image or a deleted comment. Delete history records a file event, so the document's activity and its watchers see it.

**The route.** `DELETE /drive/:ownerId/:mountId/file/:pathId/versions`, beside the version routes that list, save and restore, through `SharedDrive.deleteVersions`, which checks ownership. The way to a document without history that needs no route is Copy, which leaves the versions behind, but a copy is a new document with new links and new sharing.

## Phasing

| Phase | Work | State |
|---|---|---|
| 1. Comments | The canvas keeps a deleted card, marked; its active set; COMMENTS.md's one rule plus the stickies exception | Built. `packages/lib/src/test/vector/comments.test.ts`, `packages/ui/src/test/components/vector/hooks/element-writes.test.ts` |
| 2. Media sweep | `documentReferences` per type in the `references` job; the sweep of `media/`, run by Delete history and a copy | Built. `apps/api/src/test/document/references.test.ts`, `drive/sweep.test.ts` |
| 3. Thread sweep | The in-use rule per host; the sweep of `chat/`, its `comments.db` rows and mentions, and of each kept thread's `media/`; the guard that keeps a person from trashing, renaming or moving a part of a document; the deleted-comment state in the pane, the dialog and every landing | Built. `drive/container-write-guard.test.ts`, `drive/sweep.test.ts`, `comments/comment-index.test.ts`, `packages/lib/src/test/core/comments/hooks/use-is-card-deleted.test.tsx`, `packages/ui/src/test/components/comments/deleted-comment.test.tsx` |
| 4. Version sets | The set layout, taking, pruning and restoring it, the redirected `onSnapshot`, the refused routes, the reader's one level, the sweep inside an embedded document. Built in the same branch as phase 1 of the chart-sheets proposal. Tests: a restore brings a chart's sheet back to the version; a sheet deleted since comes back; one added since goes after the sweep; an image in a sheet stays while a set's copy names it | Not built, about 2.5 days |
| 5. Delete history | The route, its `SharedDrive` ownership check and the `Drive` method that deletes the versions and sweeps at once, the hook, the row and the confirm dialog, the file event | Built. `versioning/delete-versions.test.ts`, `packages/ui/src/test/components/layout/toolbar/version-history-menu.test.tsx` |
| 6. Copy | A copy writes every part's bytes, then sweeps each document it made with no grace, over only the parts it wrote (Decision 3) | Built. `drive/sweep.test.ts`, `drive/drive-copy-import.test.ts` |

The API tests sit under `apps/api/src/test/`. Phase 4 also updates STORAGE.md's version section, MEDIA-REFERENCES.md's sweep and COLLAB.md's restore, and the help center's version articles, `docs/doc-versions.md` and `drive/file-versions.md`.

## Risks

- **A document only shrinks when its owner deletes its history.** A deleted image stays while any version could bring it back, and after the last version prunes it stays until Delete history or a copy. The owner accepted this (Decision 5).
- **Another tab can undo past a sweep.** Delete history sweeps an open document, so a tab that undoes an image or comment delete afterwards brings back a name with nothing behind it. The image draws as missing (`isMediaMissing`), and the comment as deleted. The grace spares only the last three days.
- **A reader that misses a field deletes a part still in use.** A new field that names media, or a new kind of comment anchor, missed in `documentReferences`, loses that part at the next Delete history or copy, and for a thread that is conversation, not an image. `apps/api/src/test/document/references.test.ts` builds each type with every kind of reference, and a reader that throws stops the sweep for that document.
- **A reply can land in the instant before its thread goes.** A reply reaches the thread's `data.db` row only when the database syncs, within 30 s, so a reply to a deleted comment's thread right before a Delete history can go with the thread.
- **Delete history cannot be undone.** A misclick loses every restore point. The confirm dialog names the loss, and only an owner of the drive sees the row.
- **A set costs as much as its parts** (phase 4). A version of a doc with five charts copies six databases. A chart's sheet is a few tens of KB.

## Decisions

The owner made these on 2026-11-04, and replaced the automatic sweep with the rulings of 2026-11-05 (Decisions 3, 4, 5, 9 and 10).

1. **A restore never rewinds conversation.** Comment threads, their index and the comment cards stay as they are; the anchors go back. Every host but stickies follows this. The restore dialog says: "Comments go back with the text they're on. Their replies stay as they are now."
2. **A document embedded in another one goes back with it, through version sets.** A version of the parent holds the parent's `data.db` and each embedded document's, taken and restored together. Chosen over putting the embedded content in the parent's Y.Doc, which would have changed the Workbook's own roots and compaction.
3. **A copy copies bytes, then sweeps with no grace** (2026-11-05). The sweep only considers the parts the copy wrote, so a part someone adds to the copy meanwhile, such as in a target drive's open tab, is never a candidate.
4. **Delete history is the last row of the Version history submenu**, red, below a separator, outside the scroll area, and disabled with no versions. It is for an owner of the drive only, as a delete forever in the trash, which on the default team is every member of the organization. It deletes the comment threads' versions too, then sweeps the open document at once (2026-11-05), reading its stored state. It records a file event. The new route needed its own yes, and has it.
5. **No automatic cleanup** (2026-11-05). Unused parts are removed only by Delete history and right after a copy. A document only shrinks when its owner deletes its history.
6. **One function, one rule** (2026-11-05): remove what a document's current state does not name, on the document and again inside each part it keeps that is a document itself, a comment thread now, an embedded sheet or drawing later. Any failure logs and deletes nothing more.
7. **A swept thread's card stays in the map.** It is a few hundred bytes and never shows, and removing it would mean writing the document.
8. **The sweep spares parts younger than three days** after Delete history, so an upload or a new thread from a tab that went offline over a weekend survives. The Delete history dialog says so: "except those added or replied to in the last 3 days".
9. **No person trashes, renames or moves a part of a document** (2026-11-05). So no thread is in the trash on its own, and the sweep needs no case for one. `ChatRoom.deleteMessage` still trashes a deleted message's attachments.
10. **No record of what a version names** (2026-11-05). With the sweep running only when no version is left, the `version_references` table, its migration and the cards each version used are gone.
11. **One deleted-comment state.** A comment whose thread is gone, or whose card its host no longer uses, shows as "This comment was deleted" with its title grayed, its messages hidden and no reply, resolve or assign, in the pane, the card dialog, a `?chat=` landing, a link, a notification and a search hit.
12. **Sheets comments live on every tab.** The pane lists them all, and a comment on another tab reads that tab's name first, such as "Sheet2 · B2", while the open tab keeps "Cell B2". A duplicated tab starts without comment anchors, so one card never sits on two tabs.

## Alternatives weighed

- **A sweep after every close, with a table of what each version names** (built first, replaced on 2026-11-05). It freed parts without any user action, but needed a fence against changes while it read, busy checks for a trash and a restore, a `metadata.db` table and its migration, and a record of the cards each version used. The owner chose fewer moving parts and a document that shrinks only on Delete history.
- **The canvas' deleted cards as a list in its `meta`**, not a mark on the card. A list resurrects a deleted card on a restore to before the card existed, grows for good, and is one string that two peers overwrite.
- **Rewinding comment threads with their document.** Other people's replies and the notifications about them already went out (Decision 1).

## Related

- [MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md): names, fixed folders, the missing-image draw and the sweep
- [COMMENTS.md](../COMMENTS.md): the three stores, the in-use rule and the deleted state
- [STORAGE.md](../STORAGE.md#version-snapshots-live-inside-the-container): versions, retention, Delete history, the guard and copy
- [COLLAB.md](../COLLAB.md#a-version-restore-rewrites-an-open-document-in-one-transaction): the in-place restore
- [SYNC.md](../SYNC.md): how a container database reaches S3
- [PROPOSAL_CHART_SHEETS.md](PROPOSAL_CHART_SHEETS.md), [PROPOSAL_PORTABLE_DOCUMENTS.md](PROPOSAL_PORTABLE_DOCUMENTS.md): the two designs this one changes
