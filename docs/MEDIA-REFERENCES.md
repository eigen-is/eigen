# Media References

> **TLDR:** An Eigen document refers to its embedded files (images, backgrounds, comment threads, chat attachments) by **file name**, never by path id or URL. Names are unique per folder, and the folders are fixed (`{doc}/media/`, `{doc}/chat/`, `{chat}/media/`), so a name resolves to a path id at render time through `MediaResolverProvider` (`packages/lib/src/core/drive/media-resolver.tsx`). A copied container therefore needs no rewriting, and no stored reference bakes in the API host. Not obvious from the code: a new upload renders from a `pending:` name before it lands, a container document attached to a chat or card is the one reference by id, and a download never goes through the preview URL the image renders from.

Every Eigen document is a container, a Drive folder named like a file that holds the document's own files ([STORAGE.md](STORAGE.md#containers-name-users-by-email-never-by-id)). Its content is a Yjs document ([COLLAB.md](COLLAB.md)), or for a chat room a SQLite database ([CHAT.md](CHAT.md)), and a reference is a field in that content that names one of those files. Inserting an image, starting a comment thread and attaching a file to a message all write such a name. The sections cover why names beat ids, the fields per document kind, the one reference by id, how a name becomes an image on screen, and the sweep that deletes a file nothing names any more once the document's last tab closed.

## A name survives a copy, a path id does not

A copy gives every file a new id but keeps its name. A reference by name therefore resolves against the copy's own files, and a copy writes each file's bytes as they are, with no Yjs rewriting ([STORAGE.md](STORAGE.md#copy-goes-anywhere-a-move-stays-in-its-mount)). A URL would also bake in the API host, which differs per deployment.

Two things keep it safe. `Mount.assertUniqueName` refuses a second live item with the same name in a folder, case-insensitively. And the folders are fixed: media in `{doc}/media/`, comment threads in `{doc}/chat/`, a chat's attachments in `{chat}/media/`. An upload that collides is renamed (`getUniqueFileName`, `apps/api/src/lib/drive/naming.ts`), so a caller always stores the name the upload returned, not the one it sent.

An Office import writes its pictures without that rename, so it picks names no folder holds: the docx, pptx and xlsx readers prefix every picture with the format and a uuid of the import's own (`xlsx-<uuid>-image-1.png`, `importMedia` in `import/image-types.ts`). An import into an open document therefore lands beside its media and overwrites none, and a version restored after a replace still finds its own pictures ([EXPORT.md](EXPORT.md#a-replace-saves-a-version-first)).

## Each document kind keeps its names in fixed fields

| Document | Field | Names |
|---|---|---|
| eigendoc | `figure` node's `mediaName` | an image in `media/` |
| eigensheets | a floating image's `mediaName` (`SheetImage`) | an image in `media/` |
| eigenslides, eigenvector | `image` element's `mediaName` | an image in `media/` |
| eigenslides | a frame's `background`, image variant only | an image in `media/` |
| docs, sheets, slides, vector | `comments` card's `chatName` | a thread in `chat/` |
| eigenstickies | `tasks` card's `chatName` | a thread in `chat/` |
| docs, sheets, slides, vector, stickies | a card's `attachments` that are plain names | files in `media/` |
| eigenchat | a message's `attachments` | files in the room's `media/` |

The docs `figure` (`packages/lib/src/docs/eigendoc/nodes/figure.ts`) keeps `mediaName` as its only durable reference; `src` is filled in at render. A comment anchor is not a name: the docs `comment` mark and a canvas element's `commentCardIds` hold a card id, and the card holds the `chatName`. The infinite canvas' own `meta.background` is a color token and never names media.

## A container document is attached by id

A chat message's or a comment card's attachment (`ChatAttachment`) is either a name or an `AttachmentReference` (`packages/lib/src/types/drive-reference.ts`), which carries the owner, mount and id. A plain drive file is copied into `media/` and stored by name, because the container's ACL has to cover it for every member (`useChatRoom`, `useResolveCardAttachments`). A container document stays a reference to the original, so the thread opens the live document rather than a copy of it. A mail draft's linked documents are the same `AttachmentReference` ([MAIL.md](MAIL.md)).

## A name resolves at render, and a miss refetches once

`MediaResolverProvider` wraps every editor, provided once by `EigenDocEditorRoute`, the route body the docs, sheets, slides, vector and stickies routes share, which also remounts the editor for another document. It resolves a name to a preview URL (`resolveMediaUrl`), a path (`resolveMediaPath`) or a thread id (`resolveChatId`) through `useFolderLookup`, the folder listing plus a refetch on a miss. A collaborator's upload reaches this tab through Yjs before the listing does, so an unknown name triggers one refetch, and only one per name, so a name that never appears can't loop.

A name still absent once its own refetch settled reads as missing (`isMediaMissing`), and the docs figure and the sheets image draw it as a muted `ImageOff` instead of the loader, so a deleted file stops looking like it is still on its way. Until then they show the loader. Missing needs a known folder id: the editor routes mount the provider only after the document's listing loaded, so a null `mediaFolderId` means the document has no media folder, and every name in it is missing at once. A `pending:` name is never missing, and a name that shows up later in the listing clears.

For a file a mutation just returned, use `resolveMediaUrlByPath`: the listing still predates that write, so the by-name lookup would miss. A chat resolves its attachments the same way, through `useAttachmentSubjects` on the room's `media/` folder.

## A new upload renders from a `pending:` name

`startUpload(file)` returns a synthetic `pending:<uuid>` name (`isPendingMediaName`) and registers a local blob URL for it. The caller writes that name into Yjs at once, so the image renders on the next frame and insert and paste feel instant. When the upload settles, the caller swaps every node still holding the pending name to the real one: `swapFigureMediaName` in docs, the canvas' untracked element update, `replaceImageMediaName` in sheets. A failed upload settles to `null`, and the caller removes the node.

The provider decodes the server preview before it revokes the blob, and it revokes on the next macrotask, so the `<img>` swap doesn't flash. Pending entries live in a ref, not state, so the context value stays stable and an upload doesn't re-render every image in the document.

A tab closed mid-upload leaves its `pending:` name in the document, and no one can resolve it. Docs, sheets and the canvas sweep these on open with `useZombieMediaSweep`, which waits 60 s so an upload still in flight at open can settle first.

## A download bypasses the preview

`resolveMediaUrl` serves `/preview`, which re-encodes a raster image as WebP of at most 2560 px. So every embedded image's context menu carries `DownloadOriginalImageMenuItem` (`packages/ui/src/components/context-menu/object-menu-items.tsx`), which resolves the path and calls `downloadDriveFile` for the original bytes and name. A pending upload or a deleted file has no path, so the row hides. Downloading is a read, so viewers get it too: the canvas object menu shrinks to the download rows, a sheets image opens its own menu instead of the cell's, and a docs figure opens Download plus the comment rows ([COMMENTS.md](COMMENTS.md#a-docs-image-opens-its-own-menu-and-paints-its-own-mark)).

## The clipboard carries ids, the document stores names

The clipboard is transient, so its image item carries the source's path ids to find and download the file. On paste into another container the image re-uploads, and the document stores the name the upload returned ([CLIPBOARD.md](CLIPBOARD.md#a-pasted-image-re-uploads-as-the-pasting-user)).

## A file stays while a state names it, and a sweep deletes the rest

A delete in a document drops only the name, so an undo or a version restore brings the image back. A file in `media/` therefore stays while the current state or a saved version names it, through any field in the table, a card's fields only while the card is in use, such as anchored in the content ([COMMENTS.md](COMMENTS.md#each-app-anchors-a-card-in-its-own-content)), or while it is younger than 72 hours by its `createdAt` (`SWEEP_GRACE_DAYS` in `@workspace/lib/constants/sweep`, which the Delete history dialog names too). The grace exists because an upload lands before the edit that names it reaches the server, and a tab that was offline may still hold that edit. Everything else goes in a sweep (`sweepDocument`, `apps/api/src/lib/drive/sweep.ts`). A file whose `createdAt` is null reads as now (`Mount.toDrivePath`), so it never ages and no sweep deletes it. The same sweep removes a comment thread in `chat/` that no card in use names and nobody wrote in for 72 hours ([COMMENTS.md](COMMENTS.md#a-sweep-removes-a-thread-nothing-names)). It never looks inside a thread's own `media/`: deleting a message trashes its files.

An SVG in `media/`, such as a pasted canvas selection, names its sibling images through `eigen-media:` hrefs, which the preview inliner resolves at serve time ([CLIPBOARD.md](CLIPBOARD.md#the-svg-names-its-images-never-their-bytes)). A kept SVG keeps those siblings too, to the depth the inliner reads (`withSvgSiblings`, `apps/api/src/lib/preview/svg-media-inline.ts`), or the drawing would show blank images. The sweep reads the SVGs only when an old file is not among the names, one at a time. An SVG it can't read keeps every file in `media/` for that sweep, because what it draws is unknown.

## The sweep runs after the last tab closed and deletes only if nothing changed

Every close a minute after the last socket left (`CollabDocument.closeAfterLinger`) starts a sweep of that document (`sweepAfterClose`, `sweepDocument`). A close for a trash or a restore starts none. The sweep takes its hold on the Home before it calls the close, because the close lets go of the lingering document's hold and an idle Home would close first. Running at every close is cheap because the sweep stops at the first step that finds nothing to delete. Delete history needs no step of its own: what only the deleted versions named goes at the next close.

Each version's names are read when the version is taken. `Mount` calls `nameVersion` after every snapshot (`onVersionTaken`), and a `references` transform job reads the version from a temp copy of its local bytes (`Mount.downloadToTemp`, which on a bucket takes the staged copy whose upload is pending) and writes its row in `version_references` ([DATABASE.md](DATABASE.md#a-versions-names-are-a-row-written-when-it-is-taken)). That read runs in the background and only logs a failure, such as a busy transform process. A version with no current row, from before the rows, a failed read or an older reader, is read by the sweep itself, the same way, so the rows heal.

The sweep works in this order, outside any lock until the delete:

1. It lists the files in `media/` past the grace period and the threads in `chat/` nobody wrote in for it. With none, it stops.
2. It reads the fence: the `data.db` row (size and `updatedAt`) and the list of `versions/`.
3. It drops every candidate a version's row names. With none left, it stops, with no download and no job.
4. It reads the current state from the closed document's `data.db`, the same way a version is read. The read is given the cards the versions have in use, because a restore brings back a version's anchors but keeps today's cards, so today's card for each keeps its thread and its files ([COMMENTS.md](COMMENTS.md#card-attachments-are-staged-until-save)).
5. It reads the kept SVGs if an old file is still unnamed, and deletes under the lock.

It never opens the document, so it reads what the close wrote, and a change such as a restore that lands after the close is either in what it reads or moves the fence. Under the container's path lock it deletes only if nothing changed: the document is not open again, not on its way to the trash or in it, no version restore is putting it back (`CollabRegistry.whileRestoring`, because a restore writes in steps with no lock held between them), its mount is not closing, and the fence did not move. It deletes the unnamed media and the unnamed threads through `Mount.deletePath`, so the folder sizes and the quota follow. Each thread is read again under the lock first, and one that someone trashed, moved or wrote in since the read stays ([COMMENTS.md](COMMENTS.md#a-sweep-removes-a-thread-nothing-names)). The `comments.db` rows of the deleted threads go after them, in the same lock. A close-time version try-locks the container, so one that lands during the deletes is skipped. Two sweeps of one document can overlap after a quick reopen and close, and each checks for itself under the lock, so the second finds less to delete.

Any failure, such as a version that does not read, a reader that throws or a busy transform process, logs and deletes nothing, and the next close tries again. A sweep can keep a file too long but never deletes one in use. Two cases cost work at every close: a version that can never be read fails each sweep until retention prunes it, and an old file that only a kept SVG draws makes each sweep read the current state and the SVGs.

## See also

- [STORAGE.md](STORAGE.md): container layout and copy
- [CLIPBOARD.md](CLIPBOARD.md): the image item and re-upload
- [COMMENTS.md](COMMENTS.md) and [CHAT.md](CHAT.md): cards, threads and attachments
