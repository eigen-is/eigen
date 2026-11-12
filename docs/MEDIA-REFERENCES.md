# Media References

> **TLDR:** An Eigen document refers to its embedded files (images, backgrounds, comment threads, chat attachments) by **file name**, never by path id or URL. Names are unique per folder, and the folders are fixed (`{doc}/media/`, `{doc}/chat/`, `{chat}/media/`), so a name resolves to a path id at render time through `MediaResolverProvider` (`packages/lib/src/core/drive/media-resolver.tsx`). A copied container therefore needs no rewriting, and no stored reference bakes in the API host. Not obvious from the code: a new upload renders from a `pending:` name before it lands, a container document attached to a chat or card is the one reference by id, and a download never goes through the preview URL the image renders from.

Every Eigen document is a container, a Drive folder named like a file that holds the document's own files ([STORAGE.md](STORAGE.md#containers-name-users-by-email-never-by-id)). Its content is a Yjs document ([COLLAB.md](COLLAB.md)), or for a chat room a SQLite database ([CHAT.md](CHAT.md)), and a reference is a field in that content that names one of those files. Inserting an image, starting a comment thread and attaching a file to a message all write such a name. The sections cover why names beat ids, the fields per document kind, the one reference by id, how a name becomes an image on screen, and the sweep that deletes a file nothing names any more, which runs after Delete history and after a copy.

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

## A file stays until Delete history or a copy, and then only while the state names it

A delete in a document drops only the name, so an undo or a version restore brings the image back. Nothing removes a file on its own: a document only shrinks when its owner deletes its history. Two moments run the sweep (`sweepDocument` and `sweepCopy`, `apps/api/src/lib/drive/sweep.ts`): Delete history, once the versions are gone ([STORAGE.md](STORAGE.md#delete-history-deletes-the-versions-and-then-sweeps-at-once)), and a Drive copy, on each document it made ([STORAGE.md](STORAGE.md#copy-goes-anywhere-a-move-stays-in-its-mount)). With no version left, or none copied, only the current state can bring a file back, so the sweep keeps a file in `media/` while that state names it, through any field in the table, a card's fields only while the card is in use, such as anchored in the content ([COMMENTS.md](COMMENTS.md#each-app-anchors-a-card-in-its-own-content)). Delete history also keeps a file younger than 72 hours by its `createdAt` (`SWEEP_GRACE_DAYS` in `@workspace/lib/constants/sweep`, which its dialog names too), because an upload lands before the edit that names it reaches the server, and a tab that was offline may still hold that edit. A copy keeps no young file, but deletes only a file it wrote itself, matched by name against the listing it wrote from. A listing of the target folder shows a copy while it lands, so an image someone adds to it before the sweep runs stays. A file whose `createdAt` is null reads as now (`Mount.toDrivePath`), so it never ages. The same sweep removes a comment thread in `chat/` that no card in use names and nobody wrote in for 72 hours ([COMMENTS.md](COMMENTS.md#delete-history-and-a-copy-remove-a-thread-nothing-names)), and runs again inside each thread it keeps, where a file no message names goes.

An SVG in `media/`, such as a pasted canvas selection, names its sibling images through `eigen-media:` hrefs, which the preview inliner resolves at serve time ([CLIPBOARD.md](CLIPBOARD.md#the-svg-names-its-images-never-their-bytes)). A kept SVG keeps those siblings too, to the depth the inliner reads (`withSvgSiblings`, `apps/api/src/lib/preview/svg-media-inline.ts`), or the drawing would show blank images. The walk starts from every file the sweep keeps, so an SVG that only the grace keeps, such as one pasted a moment ago, keeps the old images it draws. Each name is matched by its folded form against the `media/` listing, because a lookup by name on a bucket or a `local-key` mount folds only ASCII case.

## The sweep reads the state once and deletes nothing more after a failure

The sweep lists `media/` and `chat/` first and stops when no file is old enough and no thread is there. Otherwise it reads the current state in a `references` transform job ([DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md#the-references-reader-names-the-parts-a-state-uses)) from the same `data.db` read an export makes (`captureCollabSource`). That read sees every edit an open document has saved, because each Yjs update is a row as it happens, so an open and a closed document read the same way. It deletes the unnamed files and idle threads through `Mount.deletePath`, so the folder sizes and the quota follow, then the `comments.db` rows of the threads that are gone, then sweeps each kept thread.

It takes no lock and checks no fence. An edit that names an old file again between the read and the delete, such as another tab's undo of an image delete, finds the file gone. The Delete history dialog says what you deleted is removed now. Any failure, such as a reader that throws, an SVG it can't read or a busy transform process, logs and deletes nothing more, so a sweep can keep a file but never deletes one the state names.

## See also

- [STORAGE.md](STORAGE.md): container layout and copy
- [CLIPBOARD.md](CLIPBOARD.md): the image item and re-upload
- [COMMENTS.md](COMMENTS.md) and [CHAT.md](CHAT.md): cards, threads and attachments
