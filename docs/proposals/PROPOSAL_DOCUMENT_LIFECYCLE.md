# Proposal: what a document keeps, and what a restore brings back

This proposal settles what happens over a document's life to the parts it holds besides its content: the media it embeds, the documents it will soon embed, such as a chart's sheet, and its comment threads. It covers docs, sheets, slides, vector and stickies.

**Status:** phases 1 and 2 and the backend of phase 3 are built on the `document-lifecycle` branch: the canvas keeps a deleted card marked, and a sweep after close deletes the media nothing names, with each version's names in `metadata.db`'s `version_references`. The same sweep deletes a comment thread nothing names with its `comments.db` rows, and the files in a thread's media no message names. The deleted-comment state of phase 3 and the other phases are not built. [ROADMAP.md](../ROADMAP.md) has its row. The owner made the rulings in § Decisions on 2026-11-04, and two independent reviews checked the design against the code the same day. What this proposal says about the code was true on 2026-11-04, as far as a read of the repository could tell. Treat every such claim as a pointer and verify it in the code before building on it.

> **TLDR**: A version is a copy of `data.db` and nothing else. Nothing is ever removed from a document's `media/` or `chat/`, so undo and restore keep working and a document only grows. A restore rewinds the content but not the comment threads, and the hosts disagree about the cards. This proposal treats every part of a container the same way: a media file, an embedded sheet or drawing, and a comment thread each sit in a fixed folder, and the content names them. **A part stays while the current state or a retained version names it**, and a server sweep after a document closes removes the rest. The parts differ only in what a restore does with them. A media file never changes, so it only has to exist. An embedded document changes, so a version of its parent becomes a **version set** that holds its state too. A thread is conversation, so a restore never rewinds it, as in Google Docs. Each version's names are rows in the mount's `metadata.db`, beside the search text it already holds. The owner can also delete a document's history from the Version history panel. One new API route and one new `metadata.db` table, each needing the owner's yes right before it is built. A copy and a download take only the current state's parts. About 12.5 working days in six phases.

## Goals

1. A part of a document that nothing can bring back is removed by the server, without any user action: a media file, an embedded document, a comment thread and the files under them.
2. Undo and version restore keep working for every part they could bring back.
3. A restore treats comments the same way in every host: the anchors go back, the conversation does not.
4. A document embedded in another one goes back with it on a restore.
5. An export, a download and a copy carry only the parts the document shows.
6. The owner of a document can make it small now, by deleting its history.

## Non-goals

- Rewinding a comment thread with its document. A thread holds replies other people posted after the version, and their notifications and activity rows already went out (§ Decisions).
- Changing the retention policy. It decides how long a deleted part stays (§ Risks).
- A linked embed, a sheet that lives elsewhere in Drive. It has a timeline of its own by definition, and stays the "linked data" part of the ROADMAP-POST-1 row.
- Reaching into other homes when a thread goes. A notification about it sits in each recipient's own `notifications.db` and keeps its link, which lands on the deleted-comment state (§ A swept thread leaves pointers behind).
- An embedded document inside an embedded document. Nesting stops at one level.

## Current state

**A version is `data.db` only.** `snapshotContainerDataDb` (`apps/api/src/lib/versioning/snapshot.ts`) copies the container's `data.db` to `versions/<iso-ts>.db`, every 100 writes and on close, and prunes by `DEFAULT_RETENTION` (`retention.ts`): at most 47 versions, hourly, daily, weekly and monthly, up to a year back. `listVersions` (`list.ts`) and `selectSnapshotsToPrune` see only names that match `SNAPSHOT_NAME_FORMAT`, so anything else in `versions/` is invisible to both. `restoreContainer` (`restore.ts`) saves a version first, then rewrites the declared `yjsRoots` of the open document in one transaction. When a document's `data.db` is gone, and for a chat, it writes the version's bytes over `data.db` instead (`replaceContainerDataDb`). On S3 a version goes through the upload queue (`enqueueStaged`), so a close never waits on the bucket ([SYNC.md](../SYNC.md#version-snapshots-are-queued-too)).

**Nothing is ever removed from `media/` or `chat/`.** A delete removes the reference, never the file, so an undo or a restore finds it again ([MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md), [COMMENTS.md](../COMMENTS.md#a-delete-strips-the-anchor-and-keeps-the-card)). The one sweep, `useZombieMediaSweep`, removes `pending:` placeholders from the content, not files.

**The readers of a document's media names live in the exports.** `mediaNamesIn` (`apps/api/src/lib/document/media.ts`) walks a tree for `mediaName`. The doc transform, the canvas render (which parses a frame's JSON-string background through `parseBackgroundFill` first) and the sheets transform each call it on their own part of the document. None of them reads a card's `attachments`, which name files in the same `media/`.

**A comment is three stores, and a restore rewinds none of them.** The card is in the Y.Doc's `comments` map (`tasks` in stickies), the thread is an `.eigenchat` in `chat/` with its own `media/` and `versions/`, and `comments.db` holds one row per thread: status, resolver, assignee and title, which live nowhere else, plus the reply count, snippet and search text (`comments_fts`) derived from the thread, and `comment_mentions` ([COMMENTS.md](../COMMENTS.md#a-comment-lives-in-three-stores)). `comments.db` has no `snapshot` key in `COMMENT_INDEX_DB_CONFIG`, so it has no versions. A thread's versions are restorable through the version routes, which take any container, but no screen offers it. The hosts differ on the card:

| Host | Delete | A restore from before the delete |
|---|---|---|
| Docs, sheets | strips the anchor, the card stays in the map | brings the anchor back, and with it the whole comment |
| Slides, vector | `deleteCard` in `use-canvas-comment-host.ts` removes the card from the map and strips the anchor | brings the element's card id back without its card, so no flag draws |
| Stickies | `deleteCardFromBoard` removes the card from its column and from `tasks`, a declared root | brings the card back; a card added since drops off; the threads stay as they are |

The canvas counts every card in its map as active: a card whose element was deleted becomes a document-level comment.

**Embedded documents are coming.** [PROPOSAL_CHART_SHEETS.md](PROPOSAL_CHART_SHEETS.md) puts one `.eigensheets` per chart in the container's `sheets/` folder, and CANVAS-TODO's embedding row plans `drawings/` by the same pattern. `CollabDocument.create` gives every collab container its own `media/`, `chat/` and `comments.db`, and `buildDocumentDb` wires `onSnapshot` for every collab database, so an embedded sheet would today keep versions of its own, and a restore of the parent would leave it as it is.

**`metadata.db` already holds facts from document content.** `path_content` (`apps/api/src/lib/mount/search-index.ts`) holds each document's body text for search. The document layer extracts it and `ContentReindexQueue` fills it, it is keyed by path id, and the trigger `path_content_cleanup` removes it with its `paths` row. The mount stores the text and never reads it.

**Exports already pack only what is named.** `collectExportMedia` (`apps/api/src/lib/export/media.ts`) takes the names the transform read.

## Design

### A container keeps a part while something names it

| Part | Folder | Named by | On a restore |
|---|---|---|---|
| Media file | `media/` | a figure's or an image's `mediaName`, a slide's image background, a card's `attachments` | nothing: it never changes, so it only has to exist |
| Embedded sheet | `sheets/` | a chart's `data.workbook` | the version set holds its `data.db`, and it goes back with the parent |
| Embedded drawing | `drawings/` (later) | its node | as an embedded sheet |
| Comment thread | `chat/` | a card in use (§ below) | nothing, on purpose: conversation is never rewound |

One rule covers them all: **a part stays while the current state or a retained version names it.** Everything else is a zombie, and the sweep removes it. An embedded document and a thread are containers of their own, so the rule runs again inside them, over their own `media/`.

### A thread is named by a card in use

A card stays in the `comments` map after its comment is deleted, so the map alone would keep every thread for good. A thread is named when its card is in use:

| Host | In use |
|---|---|
| Docs, sheets | anchored in the content: the `comment` mark, an image's or an equation's `commentCardId`, a cell's `commentCardIds` |
| Slides, vector | anchored on an element, or a document-level card not marked deleted |
| Stickies | on the board: in a column's `taskIds` |

A version's names come from that version's own map and anchors. So a card anchored in a retained version keeps its thread, even when the current map no longer holds the card.

### Every host keeps a deleted card in its map

The canvas follows the docs rule: a delete strips the anchor and leaves the card, so a restore that brings back the anchor brings back its comment. The canvas cannot read "anchored" as "in use", because a document-level card has no anchor by design. So `deleteCard` marks the card deleted instead of removing it, and the canvas' active set becomes: anchored, or not deleted. A deleted card whose element comes back with a restore has an anchor again and shows. A card whose element was deleted, and the card itself not, stays a document-level comment, as today. Both writes stay untracked, for the reason COMMENTS.md gives.

The mark is a field on `CommentCard` (`packages/lib/src/types/comments.ts`), set only by the canvas. Docs and sheets need no mark, because their active set already comes from the anchors. This lands before the thread sweep: while the canvas still removes cards, a thread whose card is gone from the current map is named only by the versions.

### One reader per type names a document's parts

`documentReferences(type, doc)` reads a materialized Y.Doc and returns its names as `(scope, kind, name)`. The kind is `media`, `sheet`, `drawing` or `chat`. The scope says whose folder the name lives in: empty for the document itself, or the embedded document's name, since a version set's copy of a sheet names files in `sheets/<name>/media/`, not the parent's `media/`. It lives beside the content readers of [DOCUMENT-CONTENT-LAYER.md](../DOCUMENT-CONTENT-LAYER.md), and the export transforms read their media names through it, so the list of fields that name a part is spelled once.

Run on an embedded document, the reader returns no `sheet` or `drawing` names, so an imported or pasted chart inside a chart's sheet can never start a second level.

### A version's names are rows in `metadata.db`

A `version_references` table in the mount's `metadata.db` (`apps/api/src/lib/mount/db-config.ts`) holds, per version, the names it uses: `versionPathId`, a foreign key to the version file's `paths` row with `ON DELETE CASCADE` as `file_events` and `path_watchers` have, then `scope`, `kind`, `name` and `readerVersion`. It follows `path_content`'s pattern: the document layer computes the names, and the mount stores them as plain strings and never parses Yjs. A version set's names are the union of its parts' and sit on its `.db`'s row.

So the names go where the version goes:

- A prune or Delete history deletes the version's row, and the cascade deletes its names in the same step.
- A restore, either path, writes only `data.db`, so newer versions stay known and pruned ones stay gone.
- A copy gets no versions, so it gets no names.
- A backup copies the rows and their names together, in the one copy of `metadata.db`.

**The rows heal themselves.** The sweep treats a version without rows as unknown, never as empty. It loads the version's own copy, and for a set the copies of its embedded documents, runs the type's `documentReferences` on each, and writes the rows. A version never changes, so that happens once in its life, and taking a version stays as it is: the close-time version is staged inside `ManagedDatabase.close`, which has no handle on the open document. A load that fails skips the document until its next sweep. The current state's names are never stored; every sweep reads them fresh.

**A fixed reader refills its old rows.** Each row carries the `readerVersion` of the reader that wrote it, one constant beside `documentReferences`. A change to what any reader finds, such as a new field that names media or a new kind of comment anchor, bumps it, and every row with an older number counts as unknown again and is refilled at the next sweep. So a crash, a backup taken between a version and its rows, and a reader bug once fixed can each only keep a part too long.

### The sweep runs after a close

After a document's close-time version, in the background, at most once a day per document, the server lists `media/`, `sheets/`, `drawings/` and `chat/`, and permanently deletes each part that is:

- named by neither the current state nor any retained version's rows, and
- older than 72 hours, by its `createdAt`. An upload whose name swap has not reached the server yet, and a thread `useCreateCommentCard` created over REST before its card's update landed, are never taken, even from a laptop closed over a weekend.

It then runs inside each surviving embedded document and thread, over its own `media/`. An embedded document's media names come from its current `data.db` and from its copies in the parent's version sets, since it keeps no versions of its own. A thread's come from its messages that are not deleted, now and in its own retained versions, through rows of the same table on the thread's version files.

A document closes only when no socket is left ([COLLAB.md](../COLLAB.md#a-document-lingers-after-the-last-unsubscribe)), so no connected tab holds an undo step that needs a swept part. A delete goes through `Mount.deletePath`, which closes the databases cached under the part first, so the quota and the search index follow. The sweep logs the count and the bytes. The once-a-day mark is in memory: a restart forgets it and costs one extra sweep.

**A thread goes before its row.** A swept thread's `comments.db` row goes after the thread: an orphan row is harmless, but a thread without a row heals as open and unassigned and would lose its status. Its `comment_mentions` rows need a delete of their own, since they have no foreign key; `comments_fts` follows the row through its `comments_ad` trigger. The sweep also drops rows whose thread is gone. It opens `comments.db` only when there is a row to delete, because on S3 an open of a closed document's `comments.db` is a whole-object download, and its close a staged copy and a queued upload. Nothing is broadcast: the document is closed.

### A swept thread leaves pointers behind

The card stays in the map as dead bytes, because removing it would mean opening the document again for one write (§ Decisions). Two things can still reach it:

- **An offline tab that undoes past a sweep**, or a card whose update landed late, re-anchors a card whose thread is gone.
- **A link to the thread:** a `?chat=` deep link, a notification in another home, an activity row. `useCardIdFromChatName` finds the card, so `onChatNotFound` never fires, and the thread then answers 404. `matchesCommentFilter` shows the comment as open and unassigned, because its row is gone.

So a card whose thread is gone shows a **This comment was deleted** state, in the pane, in the card dialog and where a link lands. It offers no reply, resolve or assign. Activity rows keep their entries, because history is conversation too.

### A copy and a download carry the current state's parts

The Office exports already pack only the media the document names. The portable package packs the parts `documentReferences` reads from the current state, threads included: it leaves versions behind, so nothing else in it could ever name the rest.

A Drive copy does the same. Today `listCopy` (`apps/api/src/lib/mount/copy.ts`) copies the container's tree as bytes and leaves `versions/` behind, so everything only a version names comes along and can never be used. Instead it runs `documentReferences` on the current state and copies only what that names: the media, the embedded documents and the threads whose card is in use, with `data.db` and `comments.db` as today. An open document's Y.Doc is in memory; a closed one is loaded once, the same load an export pays. The copy's `comments.db` keeps rows for threads it left behind, and its first sweep drops them. A copy across drives (`copyPathAcross`) takes the same list. The current state's names are not cached: a copy is rare, and a cache keyed by the `data.db` hash waits until a copy of a large sheet is measured slow.

### A version of a document is a set

A document embedded in another one is part of its content. It changes, so the parent's version has to hold its state at the same moment.

**The layout.** A version stays `versions/<iso-ts>.db`, the parent's `data.db`. Its folder `versions/<iso-ts>/` holds one copy per embedded document: `sheets/<name>.db`, later `drawings/<name>.db`. A document with no embedded documents has no folder, so the format needs no flag, and a version from before this is a set with no embedded documents. `listVersions` never shows the folder, because the name does not end in `.db`. `selectSnapshotsToPrune` skips it for the same reason, so the prune learns to remove a version's folder with its `.db`.

**Taking one.** `takeSnapshot` flushes and copies the parent's `data.db` as today and, under the same container lock, each embedded document's `data.db`. An embedded document keeps no `versions/` of its own. `buildDocumentDb` wires its `onSnapshot` to take the parent's set instead, through the same try-lock, so a session that only edits a chart's sheet still makes versions. The version list and restore routes refuse an embedded document, because restoring it alone would break the set.

**Restoring one.** The pre-restore version is a whole set, as is every version. The parent then takes the old state through `applySnapshotState`, as today, and so does each embedded document in the set, open or not, through the same path `restoreYjsContainer` uses. An embedded document in the set that is gone since is created again from its copy. One the set lacks is left alone: the restored parent no longer names it, and it goes once no retained version names it either.

A set restore is not atomic across documents. A failure halfway leaves the parent restored and some embedded documents not. The pre-restore set is the way back, as for any restore, and the error says the restore did not finish.

### Delete history frees the versions and what only they named

The sweep removes only what no restore could bring back, so it loses nothing. Delete history removes the restore points themselves, on purpose, for an owner who wants the document small now.

**Where.** A **Delete history** button at the bottom of the Version history panel, where the versions it deletes are listed, not a new row in the File menu. A confirm dialog says what it frees and that it cannot be undone: "Frees 120 MB. Earlier versions can't be restored after this." The size is the sum the version list already returns; what the sweep then frees comes on top and is not counted in advance.

**Who.** The document's owner only, because nothing brings a deleted version back, unlike a trash. Verify against [ACL.md](../ACL.md) who that is on a team mount before building.

**What.** Every version of the document goes, `versions/<iso-ts>/` folders and their embedded documents' copies included, and so do the comment threads' own versions: no screen restores a thread, so to a user they are part of the document's history, and the threads take new versions afterwards as before. Then the sweep runs at once instead of after the next close, and the document is left with its current state. The 72-hour rule still holds, so a part uploaded and deleted in the last three days survives a Delete history, and the confirm dialog says so. A peer with the editor open who then undoes a delete gets the missing image or the deleted-comment state, and the confirm dialog says so.

**The route.** No route deletes a version today; the version routes list, save and restore. Delete history needs one, `DELETE /drive/:ownerId/:mountId/file/:pathId/versions`, with a `SharedDrive` wrapper that checks ownership. The way to a document without history that needs no route is Copy, which leaves the versions behind, but a copy is a new document with new links and new sharing.

## Phasing and effort

| Phase | Work | Days |
|---|---|---|
| 1. Comments | The canvas keeps a deleted card, marked; its active set; COMMENTS.md's table becomes one rule plus the stickies exception. Tests: a canvas restore from before a card delete shows the card and its flag; a deleted card is not document-level | 1 |
| 2. Media sweep | `documentReferences` per type and the exports on it; the `version_references` table and its lazy fill; the sweep of `media/` after close; the portable package's parts. Tests: a document with every kind of reference, read whole; an image deleted before every retained version goes after close; one a retained version names stays until that version prunes, then goes; a file under 72 h stays; a card attachment stays; an open document is never swept; a reader that throws sweeps nothing; the quota drops by the bytes | 3.5 |
| 3. Thread sweep | The in-use rule per host; the sweep of `chat/`, its `comments.db` rows and mentions, and of each thread's `media/`; the deleted-comment state in the pane, the dialog and a `?chat=` link. Tests: a thread whose card is anchored in no retained version goes, with its row, mentions and search hit; one anchored in a retained version stays; a new thread under 72 h stays; a re-anchored card of a swept thread shows the deleted state; a deleted message's attachment stays while a thread version names it | 2.5 |
| 4. Version sets | The set layout, taking, pruning and restoring it, the redirected `onSnapshot`, the refused routes, the reader's one level, the sweep inside an embedded document. Built in the same branch as phase 1 of [PROPOSAL_CHART_SHEETS.md](PROPOSAL_CHART_SHEETS.md), which gives it its first embedded document. Tests: a restore brings a chart's sheet back to the version; a sheet deleted since comes back; one added since goes after the sweep; an image in a sheet stays while a set's copy names it | 2.5 |
| 5. Delete history | The route, its `SharedDrive` ownership check and the `Drive` method, the hook, the button and confirm dialog in the Version history panel. Tests: the owner's delete leaves no version, the threads' included, and sweeps what only versions named; a writer who is not the owner gets 403 | 1.5 |
| 6. Fresh copy | `listCopy` and `copyPathAcross` take the current state's parts from `documentReferences`. Tests: a copy holds no media, sheet or thread that only a version names; it holds every part the current state names; its first sweep drops the rows of the threads it left behind; a copy of an open document reads the live Y.Doc | 1.5 |

Docs: MEDIA-REFERENCES.md gets the rule and the sweep, STORAGE.md's version section the set and the names table, COMMENTS.md the in-use rule, the swept thread and its deleted state, COLLAB.md the set restore. The help center's version article (`docs/doc-versions.md` and its siblings) says that comments stay as they are on a restore, and how the owner deletes a document's history, through the support-article skill.

## Risks

- **A deleted part can stay for a year.** A monthly version keeps every part it names for up to 12 months. That is the price of restoring it. A document that is mostly zombies and edited every day still shrinks only as its versions prune.
- **An offline tab can undo past a sweep.** A tab that went offline with a delete in its undo history, and undoes it after the document closed and swept, brings back a name with nothing behind it. The image draws as missing (`isMediaMissing`), and the comment as deleted. The 72-hour rule does not cover an update that stays offline longer.
- **A reader that misses a field deletes a part still in use.** A new field that names media, or a new kind of comment anchor, missed in `documentReferences`, loses that part at the next sweep, and for a thread that is conversation, not an image. Each type gets a test that builds a document with every kind of reference and checks that the reader finds them all, and the sweep refuses to run on a document whose reader throws.
- **A document nobody opens again keeps its zombies.** The sweep runs after a close, so such a document shrinks at its next close, or when its owner deletes its history. The owner chose no one-off pass over every container (§ Decisions).
- **Delete history cannot be undone.** A misclick loses every restore point. The confirm dialog names the loss, and only the owner sees the button.
- **A set costs as much as its parts.** A version of a doc with five charts copies six databases. A chart's sheet is a few tens of KB.
- **`metadata.db` grows with every version's names.** A version of a document with a thousand images holds a thousand rows, and every backup copies them with `VACUUM INTO`. The rows are short strings, and they go when their version goes.

## Decisions

1. **A restore never rewinds conversation.** Comment threads, their index and the comment cards stay as they are; the anchors go back. Every host but stickies follows this. (Owner, 2026-11-04.)
2. **A document embedded in another one goes back with it, through version sets.** A version of the parent holds the parent's `data.db` and each embedded document's, taken and restored together. Chosen over putting the embedded content in the parent's Y.Doc, which would have changed the Workbook's own roots and compaction. (Owner, 2026-11-04.)
3. **A copy carries only the current state's parts.** It reads the current state's names and copies only what they name, with no cache of those names until one is measured to be needed (§ A copy and a download carry the current state's parts). Phase 6, after the rest. (Owner, 2026-11-04.)
4. **Delete history is a button at the bottom of the Version history panel, for the owner only, and it deletes the comment threads' versions too.** No screen in Eigen restores a thread, so their versions are part of the history a user sees as the document's. (Owner, 2026-11-04.) The route it needs still waits for its own yes.
5. **No one-off sweep of documents nobody opens again.** Their zombies go at their next close, or with Delete history. (Owner, 2026-11-04.)
6. **One rule for every part, comment threads included.** A media file, an embedded document and a comment thread each stay while the current state or a retained version names them, and the sweep removes the rest. (Owner, 2026-11-04.)
7. **A swept thread's card stays in the map.** It is a few hundred bytes and never shows, and removing it would mean opening the document again after its close for one write. (Owner, 2026-11-04.)
8. **The sweep spares parts younger than 72 hours**, so an upload or a new thread from a tab that went offline over a weekend survives. (Owner, 2026-11-04.)
9. **A version's names are rows in `metadata.db` that heal themselves.** A version without rows, or with rows from an older reader, is loaded once and its rows written again. (Owner, 2026-11-04.) The table is a migration of `metadata.db`, which still waits for its own yes right before it is built.

## Alternatives weighed

The owner chose the `metadata.db` table (§ Decisions, 9). What else was weighed for where a version's names are stored, with the reviews of 2026-11-04:

- **A file per version, `versions/<iso-ts>/references.json`.** Up to 47 object reads per sweep. On S3 a plain file written during a close is a direct PUT the close waits for, while a version goes through the upload queue. The prune skips it today.
- **A table in the live `data.db`.** The close-time version is staged after the final sync, so a row written then never reaches S3. Every version copy and every Drive copy carries the table, and a restore that writes a version's bytes over `data.db` brings back an old table that forgets newer versions. Every row also makes the next sync upload the whole `data.db`.
- **A database of its own per container**, such as a `media.db`, `sheets.db` and `drawings.db`, or one `versions/index.db`. Each is one more container database: on S3 a whole-object download on open, a staged copy, a queued upload and a `pending_uploads` row per change, and more open files per container ([PROPOSAL_FD_BUDGET.md](PROPOSAL_FD_BUDGET.md)). None can cascade with the version rows, so every prune becomes two writes with a crash between. One at the container's root also travels with a copy and with a restore that writes bytes, as the table in `data.db` does; `versions/index.db` does not, but a backup copies it at another moment than `metadata.db`. A kind column does what one database per kind would.
- **One mutable index file for the document.** One read, but a lost or late rewrite forgets a live version.
- **The names in the version row's `details` JSON.** The table's properties without a migration, but `details` is a loose bag, and `Drive.updatePathDetails` replaces it whole.

The cost of the table: the mount's `metadata.db` holds names that come from document content. `path_content` already does the same for search text, so the layer rule holds as long as the mount only stores the rows. It is a migration of `metadata.db`.

## Related

- [MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md): names, fixed folders, the missing-image draw
- [COMMENTS.md](../COMMENTS.md): the three stores and the orphan rule
- [STORAGE.md](../STORAGE.md#version-snapshots-live-inside-the-container): versions and retention
- [COLLAB.md](../COLLAB.md#a-version-restore-rewrites-an-open-document-in-one-transaction): the in-place restore
- [SYNC.md](../SYNC.md): how a container database reaches S3
- [PROPOSAL_CHART_SHEETS.md](PROPOSAL_CHART_SHEETS.md), [PROPOSAL_PORTABLE_DOCUMENTS.md](PROPOSAL_PORTABLE_DOCUMENTS.md): the two designs this one changes
