# Proposal: what a document keeps, and what a restore brings back

This proposal settles what happens over a document's life to the files it holds besides its content: the media it embeds, its comment threads, and the documents it will soon embed, such as a chart's sheet. It covers docs, sheets, slides, vector and stickies.

**Status:** not built. [ROADMAP.md](../ROADMAP.md) has its row. The owner made the rulings in § Decisions on 2026-11-04. What this proposal says about the code was true on 2026-11-04, as far as a read of the repository could tell. Treat every such claim as a pointer and verify it in the code before building on it.

> **TLDR**: A version is a copy of `data.db` and nothing else. Media is never deleted, so undo and restore keep working, and `media/` only grows. And a restore rewinds the content but not the comment threads, and the three hosts disagree about the cards. This proposal splits what a container holds in two. **Conversation** (comment threads and their index) is never rewound, as in Google Docs, and every host follows the docs rule for its cards. **Content** goes back with the document. A media file never changes, so it only has to live as long as something names it: the current state or a retained version. A server sweep after a document closes removes the rest. A document embedded in another one, such as a chart's sheet, does change, so a version of the parent becomes a **version set**: the parent's `data.db` plus each embedded document's `data.db`, taken and restored together. And the owner of a document can delete its history from the Version history panel, which frees the versions and the media only they named. One new API route, for that delete, which needs the owner's yes right before it is built. No database migration. About 9.5 working days in five phases.

## Goals

1. A file in `media/` that nothing can bring back is removed by the server, without any user action.
2. Undo and version restore keep working for every file they could bring back.
3. A restore treats comments the same way in every host: the anchors go back, the conversation does not.
4. A document embedded in another one goes back with it on a restore.
5. An export or a download carries only the media the document shows.
6. The owner of a document can make it small now, by deleting its history.

## Non-goals

- Rewinding a comment thread with its document. A thread holds replies other people posted after the version, and their notifications and activity rows already went out (§ Decisions).
- Sweeping comment threads that no card names. A thread is conversation, and losing one loses its status and assignee from `comments.db`. A later row, once measured.
- Changing the retention policy. It decides how long a deleted image stays (§ Risks).
- A linked embed, a sheet that lives elsewhere in Drive. It has a timeline of its own by definition, and stays the "linked data" part of the ROADMAP-POST-1 row.
- Stickies cards. On a board a card is the content, so it keeps going back with a restore.

## Current state

**A version is `data.db` only.** `snapshotContainerDataDb` (`apps/api/src/lib/versioning/snapshot.ts`) copies the container's `data.db` to `versions/<iso-ts>.db`, every 100 writes and on close, and prunes by `DEFAULT_RETENTION` (`retention.ts`): at most 47 versions, hourly, daily, weekly and monthly, up to a year back. `listVersions` (`list.ts`) shows only names that match `SNAPSHOT_NAME_FORMAT`, so anything else in `versions/` is invisible to the version list. `restoreContainer` (`restore.ts`) saves a version first, then rewrites the declared `yjsRoots` of the open document in one transaction.

**Media is never deleted.** A delete removes the reference, never the file, so an undo or a restore finds it again ([MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md), [COMMENTS.md](../COMMENTS.md#card-attachments-are-staged-until-save)). Nothing else ever removes a file from `media/` either. The one sweep, `useZombieMediaSweep`, removes `pending:` placeholders from the content, not files.

**The readers of a document's media names live in the exports.** `mediaNamesIn` (`apps/api/src/lib/document/media.ts`) walks a tree for `mediaName`. The doc transform, the canvas render (which parses a frame's JSON-string background through `parseBackgroundFill` first) and the sheets transform each call it on their own part of the document. None of them reads a card's `attachments`, which name files in the same `media/`.

**Comments are three stores, and a restore rewinds none of them.** The card is in the Y.Doc's `comments` map (`tasks` in stickies), the thread is an `.eigenchat` in `chat/` with its own `versions/`, and `comments.db` holds status and assignee with no versions at all ([COMMENTS.md](../COMMENTS.md#a-comment-lives-in-three-stores)). The hosts differ on the card:

| Host | Delete | A restore from before the delete |
|---|---|---|
| Docs, sheets | strips the anchor, the card stays in the map | brings the anchor back, and with it the whole comment |
| Slides, vector | `deleteCard` in `use-canvas-comment-host.ts` removes the card from the map and strips the anchor | brings the element's card id back without its card, so no flag draws |
| Stickies | removes the card from its column and from `tasks`, a declared root | brings the card back; a card added since drops off; the threads stay as they are |

The canvas counts every card in its map as active: a card whose element was deleted becomes a document-level comment.

**Embedded documents are coming.** [PROPOSAL_CHART_SHEETS.md](PROPOSAL_CHART_SHEETS.md) puts one `.eigensheets` per chart in the container's `sheets/` folder, and CANVAS-TODO's embedding row plans `drawings/` by the same pattern. Each would be a collab document with its own `versions/`, so a restore of the parent would leave it as it is. That proposal lists this as a non-goal; this one makes it a goal.

**Exports already pack only what is named.** `collectExportMedia` (`apps/api/src/lib/export/media.ts`) takes the names the transform read. The portable package of [PROPOSAL_PORTABLE_DOCUMENTS.md](PROPOSAL_PORTABLE_DOCUMENTS.md#download) packed every file in `media/` until this proposal changed it.

## Design

### A container holds conversation and content

| Kind | What | On a restore |
|---|---|---|
| Content | the Y.Doc's declared roots, `media/`, embedded documents (`sheets/`, later `drawings/`) | goes back with the document |
| Conversation | the `comments` map's cards, `chat/` threads, `comments.db` | stays as it is |

Stickies is the exception the table names in Non-goals: its `tasks` are content.

### Every host keeps a deleted card in its map

The canvas follows the docs rule: a delete strips the anchor and leaves the card, so a restore that brings back the anchor brings back its comment. The canvas cannot read "anchored" as "active", because a document-level card has no anchor by design. So `deleteCard` marks the card deleted instead of removing it, and the canvas' active set becomes: anchored, or not deleted. A deleted card whose element comes back with a restore has an anchor again and shows. A card whose element was deleted, and the card itself not, stays a document-level comment, as today. Both writes stay untracked, for the reason COMMENTS.md gives.

The mark is a field on `CommentCard` (`packages/lib/src/types/comments.ts`), set only by the canvas. Docs and sheets need no mark, because their active set already comes from the anchors.

### A media file lives as long as something names it

A media file never changes after upload, and the content names it. So it is in use exactly while the current state or a retained version names it. Everything else in `media/` is a zombie.

**One reader per type.** `documentReferences(type, doc)` reads a materialized Y.Doc and returns the names it holds: media, from the content's `mediaName` fields, a slide's background and the cards' `attachments`, and the embedded documents it names (a chart's `data.workbook`). It lives beside the content readers of [DOCUMENT-CONTENT-LAYER.md](../DOCUMENT-CONTENT-LAYER.md), and the export transforms read their media names through it, so the list of fields that name media is spelled once.

**A version records its names.** When a version is taken, its names go into `versions/<iso-ts>/references.json`, beside the `.db`. A version never changes, so the names are read once, from the live Y.Doc when the document is open and otherwise from the copy. A version taken before this ships has no file and gets one at the first sweep. The folder is the one the version set uses too (§ below), and `listVersions` never shows it, because the name does not end in `.db`. The retention prune removes the folder with its `.db`.

**The sweep runs after a close.** After a document's close-time version, in the background, at most once a day per document, the server lists `media/` and permanently deletes each file that is:

- named by neither the current state nor any retained version's `references.json`, and
- older than 24 hours, so an upload whose name swap has not reached the server yet is never taken.

A document closes only when no socket is left ([COLLAB.md](../COLLAB.md#a-document-lingers-after-the-last-unsubscribe)), so no connected tab holds an undo step that needs a swept file. The delete goes through the mount's permanent delete, so the quota and the search index follow, and it logs the count and the bytes. The once-a-day mark is in memory: a restart forgets it and costs one extra sweep.

**A thread's media sweeps the same way.** A deleted chat message keeps its attachments so that a restore of the thread brings them back. The same sweep, run inside an `.eigenchat`, keeps each attachment named by a message that is not deleted, now or in a retained version of the thread, and removes the rest of the thread's `media/`.

**A download carries the current state's media.** The Office exports already do. The portable package packs the names `documentReferences` reads from the current state: it leaves versions behind, so nothing else in it could ever name the rest.

### A version of a document is a set

A document embedded in another one is part of its content. It changes, so the parent's version has to hold its state at the same moment.

**The layout.** A version stays `versions/<iso-ts>.db`, the parent's `data.db`. Its folder `versions/<iso-ts>/` holds `references.json` and one copy per embedded document: `sheets/<name>.db`, later `drawings/<name>.db`. A document with no embedded documents has a folder with only `references.json`, so the format needs no flag, and a version from before this is a set with no embedded documents.

**Taking one.** `takeSnapshot` flushes and copies the parent's `data.db` as today and, under the same container lock, each embedded document's `data.db`. An embedded document keeps no `versions/` of its own. Its own snapshot triggers (100 writes, its close) take the parent's set instead, through the same try-lock, so a session that only edits a chart's sheet still makes versions. The version list and restore routes refuse an embedded document, because restoring it alone would break the set.

**Restoring one.** The pre-restore version is a whole set, as is every version. The parent then takes the old state through `applySnapshotState`, as today, and so does each embedded document in the set, open or not, through the same path `restoreYjsContainer` uses. An embedded document in the set that is gone since is created again from its copy. One the set lacks is left alone: the restored parent no longer names it, so the media sweep's reader leaves it out of the current names, and it goes once no retained version names it either. That makes the sweep cover `sheets/` and `drawings/` beside `media/`.

A set restore is not atomic across documents. A failure halfway leaves the parent restored and some embedded documents not. The pre-restore set is the way back, as for any restore, and the error says the restore did not finish.

### Delete history frees the versions and what only they named

The sweep removes only what no restore could bring back, so it loses nothing. Delete history removes the restore points themselves, on purpose, for an owner who wants the document small now.

**Where.** A **Delete history** button at the bottom of the Version history panel, where the versions it deletes are listed, not a new row in the File menu. A confirm dialog says what it frees and that it cannot be undone: "Frees 120 MB. Earlier versions can't be restored after this." The size is the sum the version list already returns; what the media sweep then frees comes on top and is not counted in advance.

**Who.** The document's owner only, because nothing brings a deleted version back, unlike a trash. Verify against [ACL.md](../ACL.md) who that is on a team mount before building.

**What.** Every version of the document goes, `versions/<iso-ts>/` folders and their embedded documents' copies included, and then the media sweep runs at once instead of after the next close. The document is left with its current state. The 24-hour rule for uploads still holds. A peer with the editor open who then undoes an image delete gets the missing-image draw, and the confirm dialog says so. A comment thread keeps its own versions: a thread is conversation (§ Decisions), and its versions are what protects it from a bad edit or delete.

**The route.** No route deletes a version today; the version routes list, save and restore. Delete history needs one, `DELETE /drive/:ownerId/:mountId/file/:pathId/versions`, with a `SharedDrive` wrapper that checks ownership. The way to a document without history that needs no route is Copy, which leaves the versions behind, but a copy is a new document with new links and new sharing.

## Phasing and effort

| Phase | Work | Days |
|---|---|---|
| 1. Comments | The canvas keeps a deleted card, marked; its active set; COMMENTS.md's table becomes one rule plus the stickies exception. Tests: a canvas restore from before a card delete shows the card and its flag; a deleted card is not document-level | 1 |
| 2. Media sweep | `documentReferences` per type and the exports on it; `references.json` per version and its backfill; the sweep after close; the portable package's media list. Tests: an image deleted before every retained version goes after close; one a retained version names stays until that version prunes, then goes; a file under 24 h stays; a card attachment stays; an open document is never swept; the quota drops by the bytes | 3.5 |
| 3. Thread media | The same sweep inside an `.eigenchat`. Tests: a deleted message's attachment stays while a thread version names it | 1 |
| 4. Version sets | The set layout, taking, pruning and restoring it, the embedded document's triggers and its refused routes. Built in the same branch as phase 1 of [PROPOSAL_CHART_SHEETS.md](PROPOSAL_CHART_SHEETS.md), which gives it its first embedded document. Tests: a restore brings a chart's sheet back to the version; a sheet deleted since comes back; one added since goes after the sweep | 2.5 |
| 5. Delete history | The route, its `SharedDrive` ownership check and the `Drive` method, the hook, the button and confirm dialog in the Version history panel. Tests: the owner's delete leaves no version and sweeps the media only versions named; a writer who is not the owner gets 403; a thread keeps its versions | 1.5 |

Docs: MEDIA-REFERENCES.md gets the sweep, STORAGE.md's version section the set and `references.json`, COMMENTS.md the one rule, COLLAB.md the set restore. The help center's version article (`docs/doc-versions.md` and its siblings) says that comments stay as they are on a restore, and how the owner deletes a document's history, through the support-article skill.

## Risks

- **A deleted image can stay for a year.** A monthly version keeps every image it names for up to 12 months. That is the price of restoring it. A document that is mostly zombies and edited every day still shrinks only as its versions prune.
- **An offline tab can undo past a sweep.** A tab that went offline with a delete in its undo history, and undoes it after the document closed and swept, brings back a name with no file. The image draws as missing (`isMediaMissing`), as a deleted file does today.
- **A reader that misses a field deletes a file still in use.** A new field that names media, missed in `documentReferences`, loses that media at the next sweep. Each type gets a test that builds a document with every kind of reference and checks that the reader finds them all, and the sweep refuses to run on a document whose reader throws.
- **A document nobody opens again keeps its zombies.** The sweep runs after a close, so such a document shrinks at its next close, or when its owner deletes its history. The owner chose no one-off pass over every container (§ Decisions).
- **Delete history cannot be undone.** A misclick loses every restore point. The confirm dialog names the loss, and only the owner sees the button.
- **A set costs as much as its parts.** A version of a doc with five charts copies six databases. A chart's sheet is a few tens of KB.

## Decisions

1. **A restore never rewinds conversation.** Comment threads, their index and the comment cards stay as they are; the anchors go back. Every host but stickies follows this. (Owner, 2026-11-04.)
2. **A document embedded in another one goes back with it, through version sets.** A version of the parent holds the parent's `data.db` and each embedded document's, taken and restored together. Chosen over putting the embedded content in the parent's Y.Doc, which would have changed the Workbook's own roots and compaction. (Owner, 2026-11-04.)
3. **A copy leaves zombies behind, in a later round.** A copy keeps no versions, so only the current state's names matter, as for the package. Not in this round: today's copy is a byte copy, and reading the names first adds a Yjs load to every copy. (Owner, 2026-11-04.)
4. **Delete history is a button at the bottom of the Version history panel, for the owner only, and it leaves the comment threads' own versions alone.** (Owner, 2026-11-04.) The route it needs still waits for its own yes.
5. **No one-off sweep of documents nobody opens again.** Their zombies go at their next close, or with Delete history. (Owner, 2026-11-04.)

## Open questions

1. **Where a version's names are stored.** Not in memory only: every sweep after a restart would load every version's Yjs state again, tens of MB each for a large sheet. And not in the version's own copy of `data.db`: reading it means fetching the whole version, the cost the stored names avoid. That leaves two:
    - **A. `versions/<iso-ts>/references.json`** (this proposal). No migration. The names live beside the version they describe, the prune that removes a version removes them, and no restore touches them. The same file works for a thread's versions. Costs one small object per version and up to 47 small reads per sweep.
    - **B. A table in the live `data.db`**, such as `version_references(version, kind, name)`. One query per sweep and no extra objects. A document's restore leaves it alone, since it rewrites the open Y.Doc and not the file. It is a migration, a schema version in `apps/api/src/lib/collab/db-config.ts`, so it needs the owner's yes. Every prune and Delete history deletes the rows of the versions it removes, rows written before the version, so a crash keeps a file too long rather than too short. For a thread's media (phase 3) it would sit in the thread's own `data.db`, which a thread restore overwrites with the version's bytes (`replaceContainerDataDb`), forgetting every version taken after it; that needs a rebuild after each thread restore, or phase 3 waits.

    Recommended: A, one mechanism for documents and threads with no migration. B is the closer call for documents alone.

## Related

- [MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md): names, fixed folders, the missing-image draw
- [COMMENTS.md](../COMMENTS.md): the three stores and the orphan rule
- [STORAGE.md](../STORAGE.md#version-snapshots-live-inside-the-container): versions and retention
- [COLLAB.md](../COLLAB.md#a-version-restore-rewrites-an-open-document-in-one-transaction): the in-place restore
- [PROPOSAL_CHART_SHEETS.md](PROPOSAL_CHART_SHEETS.md), [PROPOSAL_PORTABLE_DOCUMENTS.md](PROPOSAL_PORTABLE_DOCUMENTS.md): the two designs this one changes
