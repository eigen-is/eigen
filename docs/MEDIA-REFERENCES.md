# Media References

> **TLDR:** An Eigen document refers to its embedded files (images, backgrounds, comment threads, chat attachments) by **file name**, never by path id or URL. Names are unique per folder, and the folders are fixed (`{doc}/media/`, `{doc}/chat/`, `{chat}/media/`), so a name resolves to a path id at render time through `MediaResolverProvider` (`packages/lib/src/core/drive/media-resolver.tsx`). A copied container therefore needs no rewriting, and no stored reference bakes in the API host. Not obvious from the code: a new upload renders from a `pending:` name before it lands, a container document attached to a chat or card is the one reference by id, and a download never goes through the preview URL the image renders from.

## A name survives a copy, a path id does not

A copy gives every file a new id but keeps its name. A reference by name therefore resolves against the copy's own files, and a copy is a plain byte copy of the tree with no Yjs or SQLite rewriting ([STORAGE.md](STORAGE.md#copy-goes-anywhere-a-move-stays-in-its-mount)). A URL would also bake in the API host, which differs per deployment.

Two things keep it safe. `Mount.assertUniqueName` refuses a second live item with the same name in a folder, case-insensitively. And the folders are fixed: media in `{doc}/media/`, comment threads in `{doc}/chat/`, a chat's attachments in `{chat}/media/`. An upload that collides is renamed (`getUniqueFileName`, `apps/api/src/lib/drive/naming.ts`), so a caller always stores the name the upload returned, not the one it sent.

## Each document kind keeps its names in fixed fields

| Document | Field | Names |
|---|---|---|
| eigendoc | `figure` node's `mediaName` | an image in `media/` |
| eigensheets | a floating image's `mediaName` (`SheetImage`) | an image in `media/` |
| eigenslides, eigenvector | `image` element's `mediaName` | an image in `media/` |
| eigenslides | a frame's `background`, image variant only | an image in `media/` |
| docs, sheets, slides, vector | `comments` card's `chatName` | a thread in `chat/` |
| eigenstickies | `tasks` card's `chatName` | a thread in `chat/` |
| eigenchat | a message's `attachments` | files in the room's `media/` |

The docs `figure` (`packages/lib/src/docs/eigendoc/nodes/figure.ts`) keeps `mediaName` as its only durable reference; `src` is filled in at render. A comment anchor is not a name: the docs `comment` mark and a canvas element's `commentCardIds` hold a card id, and the card holds the `chatName`. The infinite canvas' own `meta.background` is a color token and never names media.

## A container document is attached by id

A chat message's or a comment card's attachment (`ChatAttachment`) is either a name or an `AttachmentReference` (`packages/lib/src/types/drive-reference.ts`), which carries the owner, mount and id. A plain drive file is copied into `media/` and stored by name, because the container's ACL has to cover it for every member (`useChatRoom`, `useResolveCardAttachments`). A container document stays a reference to the original, so the thread opens the live document rather than a copy of it. A mail draft's linked documents are the same `AttachmentReference` ([MAIL.md](MAIL.md)).

## A name resolves at render, and a miss refetches once

`MediaResolverProvider` wraps the docs, sheets, slides, vector and stickies editors. It resolves a name to a preview URL (`resolveMediaUrl`), a path (`resolveMediaPath`) or a thread id (`resolveChatId`) through `useFolderLookup`, the folder listing plus a refetch on a miss. A collaborator's upload reaches this tab through Yjs before the listing does, so an unknown name triggers one refetch, and only one per name, so a name that never appears can't loop.

For a file a mutation just returned, use `resolveMediaUrlByPath`: the listing still predates that write, so the by-name lookup would miss. A chat resolves its attachments the same way, through `useAttachmentSubjects` on the room's `media/` folder.

## A new upload renders from a `pending:` name

`startUpload(file)` returns a synthetic `pending:<uuid>` name (`isPendingMediaName`) and registers a local blob URL for it. The caller writes that name into Yjs at once, so the image renders on the next frame and insert and paste feel instant. When the upload settles, the caller swaps every node still holding the pending name to the real one: `swapFigureMediaName` in docs, the canvas' untracked element update, `replaceImageMediaName` in sheets. A failed upload settles to `null`, and the caller removes the node.

The provider decodes the server preview before it revokes the blob, and it revokes on the next macrotask, so the `<img>` swap doesn't flash. Pending entries live in a ref, not state, so the context value stays stable and an upload doesn't re-render every image in the document.

A tab closed mid-upload leaves its `pending:` name in the document, and no one can resolve it. Docs, sheets and the canvas sweep these on open with `useZombieMediaSweep`, which waits 60 s so an upload still in flight at open can settle first.

## A download bypasses the preview

`resolveMediaUrl` serves `/preview`, which re-encodes a raster image as WebP of at most 2560 px. So every embedded image's context menu carries `DownloadImageMenuItem` (`packages/ui/src/components/context-menu/object-menu-items.tsx`), which resolves the path and calls `downloadDriveFile` for the original bytes and name. A pending upload or a deleted file has no path, so the row hides. Downloading is a read, so viewers get it too: the canvas object menu shrinks to that row, a sheets image opens its own menu instead of the cell's, and a docs figure opens Download plus the comment rows ([COMMENTS.md](COMMENTS.md#a-docs-image-opens-its-own-menu-and-paints-its-own-mark)).

## The clipboard carries ids, the document stores names

The clipboard is transient, so its image item carries the source's path ids to find and download the file. On paste into another container the image re-uploads, and the document stores the name the upload returned ([CLIPBOARD.md](CLIPBOARD.md#a-pasted-image-re-uploads-as-the-pasting-user)).

## See also

- [STORAGE.md](STORAGE.md): container layout and copy
- [CLIPBOARD.md](CLIPBOARD.md): the image item and re-upload
- [COMMENTS.md](COMMENTS.md) and [CHAT.md](CHAT.md): cards, threads and attachments
