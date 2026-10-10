# Proposal: a document you can download and upload again

This proposal lets a user download an Eigen document from Drive as one file and upload that file again, on the same server or another one, where it becomes a document again. It covers docs, sheets, slides, stickies and vector drawings, with their media and comment threads.

**Status:** not built. [ROADMAP.md](../ROADMAP.md) has its row. The decisions below were made by the owner on 2026-10-09. What this proposal says about the code was true on 2026-10-09, as far as a read of the repository could tell. Treat every such claim as a pointer and verify it in the code before building on it.

> **TLDR**: A document is a Drive folder (`Report.eigendoc/` with `data.db`, `comments.db`, `media/`, `chat/`, `versions/`), and Drive offers no download for it. This proposal packs a document into one zip file, `Report.eigendoc`, whose first entry is `mimetype`, stored uncompressed, holding the type's MIME string, the way ODF and EPUB mark their type. Inside are the document's Yjs state, its media and its comment threads as JSON. No SQLite file goes in, so the server never opens a database a stranger wrote, and the internal storage layout stays free to change. Each type's Yjs shape does become public. So each type has its own package format number: before 1.0 a package of an older format is refused, and from 1.0 every break of a type's shape ships a converter for its packages. Download is a new format in the type's `exportFormats`, served by the existing export route. Drive's upload and Save to Drive recognize a package and unpack it into a new document. WebDAV and attachments keep the file as it is, and a file action unpacks it later. Comments travel, because a document names people by email only. Whispers stay behind, and so do versions. No new API route, no database migration. About 7 working days.

## Goals

1. Download any document but a chat from Drive or from its editor as one file.
2. Upload that file to Drive, on any Eigen server, and get the document back: its content, media and comment threads.
3. Download and upload feel like one round trip. The file a user downloads is the file they upload.
4. A package is safe to upload from a stranger. Nothing in it is trusted before it is checked.
5. The same unchanged document always packs to the same bytes.

## Non-goals

- Chat rooms. A room is its membership, not a document to hand to someone else.
- Version history. A package starts the document with a clean history, as Copy does.
- The document's sharing. The ACL lives in Drive's rows, not in the container, and an upload is shared like any new file.
- Downloading a folder as a zip. That is a separate feature, though this format would be its building block.
- Replacing an existing document from a package. An upload always creates a new document.
- A desktop app that opens packages. The format is plain enough that one could, later.
- Archiving before 1.0. A package is for moving a document, and before 1.0 a package can stop importing (§ The format policy).

## Current state

**A document has no download.** `driveInfo` (`packages/lib/src/core/file-subject.ts`) gives a container no `downloadUrl`, so no Download row shows for it. Over WebDAV a document lists as a folder, and its `data.db` downloads byte for byte ([WEBDAV.md](../WEBDAV.md#a-document-container-is-a-folder-that-is-read-only-inside)).

**Export has one menu and one gate.** `exportFormats` in `EIGEN_DOC_TYPE_INFO` (`packages/lib/src/types/drive.ts`) lists a type's download formats. Every Download menu is built from it, and `GET /drive/:ownerId/:mountId/file/:pathId/export/:format` refuses anything else. `EXPORT_ENVELOPES` (`apps/api/src/lib/export/export-document.ts`) maps a format to its content type and extension. Stickies and chat have no export formats.

**Each type names its Yjs roots.** `yjsRoots` in the same registry: `{ default: 'xmlfragment' }` for a doc, `{ state: 'map', ops: 'array' }` for a sheet, `{ elements, frames, meta }` for slides and vector, `{ columns, tasks, columnOrder }` for stickies.

**A container names people by email.** Chat authors, whisper targets, comment creators, assignees and mentions are emails, never user ids, so a container stays valid on any server ([STORAGE.md](../STORAGE.md#containers-name-users-by-email-never-by-id)). A thread's `messages` table holds `id`, `authorEmail`, `type`, `content`, `attachments`, `whisperTo`, `replyTo`, `editedAt`, `deletedAt` and `createdAt` (`apps/api/src/lib/chat/db-config.ts`). `comments.db` holds per thread `status`, `resolvedBy`, `resolvedAt`, `createdBy`, `assignee`, the title cache and fields derived from the messages (`comment-db-config.ts`).

**A comment is spread over three stores.** The card is in the Y.Doc, the thread is an `.eigenchat` under the container's `chat/` folder with its own `media/`, and `comments.db` is the index ([COMMENTS.md](../COMMENTS.md#a-comment-lives-in-three-stores)).

**Whispers are hidden by the server, not by the file.** A whisper's text is in its thread's `data.db` in full. `getMessagesForUser` replaces it for anyone but its author and recipient ([CHAT.md](../CHAT.md)).

**Conversion already makes a document from a file.** `convertToDocument` (`apps/api/src/lib/import/import-document.ts`) turns an xlsx or docx into a new document next to it: the transform Worker parses, then the main thread runs `drive.create`, applies the update to the new collab document and writes the media. Nothing is created before the Worker succeeds.

**Eigen has its own zip.** `apps/api/src/lib/core/zip.ts` reads with `openZip`, bounded per entry and in total (`MAX_DECOMPRESSED_BYTES`, 200 MB; `MAX_ZIP_ENTRIES`, 10,000), and writes with `writeZip`, every entry dated the DOS epoch. The docx writer uses it.

**An upload trusts the client's MIME.** `streamFilesToTemp` (`apps/api/src/lib/drive/streaming.ts`) keeps the multipart part's media type, and `finalizeUpload` stores it. `Mount.getPathsByMimeType` lists by MIME alone. So a plain file uploaded as `application/eigendoc` shows up in the Docs app's list as if it were a document.

## Design

### The file

```
Report.eigendoc                      a zip
├── mimetype                         application/eigendoc, first, stored
├── manifest.json                    { "format": 1 }
├── content.yjs                      the document's whole Yjs state, one update
├── media/<name>                     byte for byte, stored
└── comments/<chatName>.json         one thread: its index row and its messages
    comments/<chatName>/media/<name> that thread's attachments, stored
```

The `mimetype` entry is the type. Its value is the type's `DRIVE_MIME_*` constant, so there is one list of type strings, not two. Because it comes first and is stored, its bytes sit at a fixed offset: a tool reads the type without unzipping, as with ODF and EPUB. The extension is the type's `extension` from the registry, the same name the container has in Drive.

`manifest.json` holds the package format and nothing that changes between two packs of the same document. No export date, no Eigen version: the same document gives the same bytes, and the format number is all an importer needs to refuse what it does not understand. The number is per type: `packageFormat` in `EIGEN_DOC_TYPE_INFO`, read by the pack and the unpack alike, so a break in sheets does not refuse a doc's package.

`content.yjs` is `Y.encodeStateAsUpdate` of the document. Not `data.db`. A package travels between strangers, so an upload is untrusted, and opening a crafted SQLite file is an attack surface Eigen does not have today: every database it opens is its own. And `data.db`'s layout (`doc_updates`, `doc_snapshots`, zstd blobs, [COLLAB.md](../COLLAB.md)) would become a public format too. A Yjs update is the document's own wire format, and the import already applies them. What the update holds, the type's roots and the shape of what is in them, does become public; § The format policy says what that costs.

A thread's JSON:

```json
{
    "status": "resolved",
    "resolvedBy": "ann@example.com",
    "resolvedAt": 1760000000,
    "createdBy": "ann@example.com",
    "createdAt": 1759990000,
    "assignee": "bob@example.com",
    "messages": [
        {
            "id": "…",
            "authorEmail": "ann@example.com",
            "type": "message",
            "content": "…",
            "attachments": [],
            "replyTo": null,
            "editedAt": null,
            "deletedAt": null,
            "createdAt": 1759990000
        }
    ]
}
```

The fields `comments.db` derives from the messages (count, last author, snippet, search text) and its title cache stay out. The importer recomputes them.

Media and thread media are stored, since images and videos are compressed already. The JSON and `content.yjs` are deflated. Entries go in sorted by name and every JSON key in a fixed order, so a pack is deterministic.

### What stays behind

- **Whispers.** A file has no server to hide them. Anyone who receives the package could read a whisper between two other people. So no whisper goes in (Open question 1).
- **What a deleted message carried.** A delete empties the row's `content` but keeps its `attachments`. The pack writes a deleted message as the tombstone it is, without attachments, so a reply to it still has its target.
- **`versions/`.** As with Copy.
- **The ACL, file history, activity rows and notifications.** They belong to the server, not the document.

### The format policy

The server stores documents in a layout it can migrate whenever it likes. A package is different: once it has left the server, nothing can migrate it. So a package freezes its type's Yjs shape, the roots and what is in them, for as long as that package is expected to import. Before 1.0 the shapes still move: sheets has a format break planned with no backward compatibility ([ROADMAP-POST-1.md](../ROADMAP-POST-1.md)), and `.eigenvector` is marked as free to change. Stickies is already frozen, so for stickies this costs nothing.

- **Each type has its own `packageFormat`.** A change to a type's Yjs shape that an older package would not satisfy bumps that type's number in `EIGEN_DOC_TYPE_INFO`, and only that type's.
- **Before 1.0, an older package is refused.** The message names what to do: "This Eigen document was made by an older version of Eigen. Open it there and download it again." No converter is written for a pre-1.0 format.
- **From 1.0, every break ships a converter for packages.** The server needs one for its own stored documents anyway, and the package's converter runs the same steps on the decoded Y.Doc before the root check.
- **A newer package is always refused**, before and after 1.0: "This Eigen document was made by a newer version of Eigen."
- **The help center says so.** Until 1.0, a package is for moving a document, not for keeping one. A home backup is for keeping.

The ROADMAP's Frozen-format column flags this row for the same reason.

### Download

`ExportFormat` gains `'eigen'`, and every type but chat lists it in `exportFormats`, last. So the editors' Download menus and Drive's show **Eigen document (.eigendoc)**, and the export route gates on it with no change. Stickies gets its first Download row.

`EXPORT_ENVELOPES` gains an `eigen` envelope. It is the one envelope whose extension depends on the type, so it takes it from `EIGEN_DOC_TYPE_INFO[type].extension`. The file name is the container's name as it is.

`driveInfo` gives a container a `downloadUrl`: the export URL with format `eigen`. Download in every Drive menu then works for a document as it does for a file.

The main thread gathers, the Worker packs, as with every export ([EXPORT.md](../EXPORT.md#the-worker-renders-and-the-main-thread-prepares)). The main thread reads the document's state the way the other exports read it, reads every media file, and reads each thread's messages through `ChatRoom` and its index row through `CommentIndex`, without the whispers. Root-relative links in a doc become absolute through `absoluteHref`, as the docx export does, so a link back to the source server still works from another one. The Worker builds the zip with `writeZip`.

A document whose package would exceed what `openZip` accepts is refused on export with a message that says so. No file goes out that cannot come back (Open question 3).

### Upload

`Drive.uploadFiles` looks at each streamed file before `finalizeUpload`. A file whose name ends in one of the document extensions (every `DRIVE_EXTENSIONS` value but chat's) is a package. It is unpacked into a new document and never stored as a file. A file with any other name is stored as today.

Unpacking is `importEigenPackage`, beside `convertToDocument` in `apps/api/src/lib/import/`. The Worker checks and decodes, and the main thread commits:

1. `openZip` the bytes. Its bounds and its refusal of crafted archives apply.
2. The first entry is `mimetype`, stored, and its value is the `DRIVE_MIME_*` of the type the file name's extension names. `manifest.json` has the type's current `packageFormat` (§ The format policy).
3. Apply `content.yjs` to an empty `Y.Doc`. Its root names must be the type's `yjsRoots`, nothing else.
4. Every media name and chat name is a single safe name: no `/`, no `..`, no control characters.
5. Every thread parses, and every message has a shape a stored row can have: a known type, an email as author, attachments of the `ChatAttachment` shape, a `replyTo` naming a message in the same thread. A whisper, or a deleted message with content or attachments, is refused, since Eigen never writes one.
6. Main thread: `drive.create` the document in the target folder under the file's name without its extension, deduplicated like any upload. Apply the update to its collab document. Write the media. For each thread, create its `.eigenchat` under `chat/`, insert its messages as they are (no notification, no activity row, no mention), and seed its index row through `CommentIndex`, which recomputes the derived fields.

A check that fails refuses the upload with one message: "This isn't a valid Eigen document", or one of the two format messages in § The format policy. The file is not stored as a plain file instead. A file named like a document that does not open as one is the worst result.

The upload records one `uploaded` event on the new document, as for any upload. The document starts with no versions and is shared like anything else in its folder.

People named in the comments get nothing: no account, no guest, no notification. Their emails show as authors. The uploader shares the document with them if they want them in, and the normal share flow makes guests of the ones without an account ([GUEST-ACCESS.md](../GUEST-ACCESS.md)).

An assignee who is not a member of the new document stays the assignee, as history. A new assignment follows the normal rule (Open question 2).

### Where a package unpacks

| Surface | What happens |
|---|---|
| Drive upload (button, drag and drop) | Unpacks |
| Save to Drive of a mail attachment | Unpacks: the mail save route calls `importEigenPackage` for a package part |
| Save to Drive of a chat or card attachment | Unpacks: the picker calls the convert route with the target folder instead of the copy route |
| WebDAV PUT | Stores the file. WebDAV shows documents as folders, and a PUT that turned into a folder would make rclone or Finder upload it again forever |
| An attachment in chat, a card or a mail draft | Stays a file |
| Drive's own Copy of a package file | Stays a file |

A package that stays a file gets a file action, **Open as document**, beside Convert to Document. It runs the convert route, whose job is exactly this: a new document from a file next to it. `CONVERT_TARGETS` and the convert route learn the package as a source, and the route takes an optional target folder for the Save to Drive picker. That changes an existing route; it adds none.

A package stored as a file is stored as `application/zip`, never as the container's MIME. That is the broken window above: `finalizeUpload` replaces any `DRIVE_MIME_*` the client sends for a plain file, for every upload, so no file wears a document's MIME and shows up in an app's list.

### Same server, other user

Sharing or Copy is still the better way between two users on one server. Copy keeps the threads live and every whisper hidden, and needs no download. The help center says when to use which.

## Phasing and effort

| Phase | Work | Days |
|---|---|---|
| 1. Pack | The format, the `eigen` export format and envelope, the main-thread gather, the Worker pack, `downloadUrl` for containers, the size refusal. Tests: a document of every type with media, threads, a whisper and a deleted message with an attachment packs without the whisper and without the attachment; two packs are the same bytes | 2.5 |
| 2. Unpack on upload | `importEigenPackage`, its checks, the commit, the hook in `uploadFiles`, the MIME fix in `finalizeUpload`. Tests: every type round-trips through pack and upload with its Yjs JSON, media bytes and thread rows equal; every refusal in the check list; a crafted package (extra root, `../` media name, older or newer format, wrong `mimetype`, oversize) is refused and creates nothing; a golden package per type imports and opens | 3 |
| 3. The other surfaces | Mail Save to Drive, the picker, **Open as document**, the convert route's package source. Help center and docs | 1.5 |

Docs: [EXPORT.md](../EXPORT.md) gets the format and the unpack, [STORAGE.md](../STORAGE.md) a line that a package is the portable form of a container, [PREVIEWS.md](../PREVIEWS.md) the file action. The help center's Drive section gets downloading and uploading a document and moving one to another server, with the format policy's "for moving, not for keeping" until 1.0, through the support-article skill.

## Risks

- **Safari can unzip a download.** With "Open safe files after downloading" on, Safari unpacks archives it considers safe. If it treats `Report.eigendoc` served as `application/zip` that way, the user gets a folder of internals. Check it in phase 1. If it does, the export serves `application/octet-stream`.
- **The 200 MB cap.** A document with a lot of video exceeds `MAX_DECOMPRESSED_BYTES` and cannot be packed. The export refusal makes that visible rather than leaving a file that will not come back.
- **A Yjs update is untrusted input.** A crafted one can declare huge lengths. It is decoded only in the transform Worker, under its memory and time limits.
- **A shape change that forgets to bump `packageFormat`.** The old packages then import into a shape the editor no longer expects. Each type gets a golden package checked into its tests, packed at its current format, that must import and open. A change that breaks it fails the test, and the fix is to bump the number and replace the fixture, or after 1.0 to add the converter.
- **Message rows written directly.** The importer inserts rows `postMessage` never saw, so its checks are the only ones. Where `postMessage` already checks something, such as an email, the importer calls the same validator, so one rule does not drift into two.

## Found along the way

- **A plain file can wear a document's MIME** (Current state). Phase 2 fixes it.
- **A byte copy carries whispers.** Copy is a byte copy of the container, `chat/` included, and WebDAV GET returns any file inside a container. So a reader who copies a document into their own drive can likely fetch a thread's `data.db` over WebDAV and read every whisper in it. Not verified. If it holds, it gets its own [ROADMAP](../ROADMAP.md) row.

## Related

- [EXPORT.md](../EXPORT.md): the export route, the Worker, the zip guards.
- [COMMENTS.md](../COMMENTS.md), [CHAT.md](../CHAT.md): the three stores of a comment, whispers.
- [STORAGE.md](../STORAGE.md): containers name users by email.
- [BACKUP.md](../BACKUP.md): a home archive is a tar.zst. A package is a zip because it is one small document a user handles, not a home an operator streams.

## Decisions

1. A downloaded document is one zip file, named and typed like its container, whose first entry is `mimetype`, stored, holding the type's MIME. (Owner, 2026-10-09.)
2. A package holds the Yjs state, the media and the threads as JSON, never a SQLite file. (Owner, 2026-10-09.)
3. Comments travel with their authors as emails. An upload creates no account and no guest; sharing does. (Owner, 2026-10-09.)
4. Drive upload and Save to Drive unpack automatically. WebDAV and attachments keep the file, and **Open as document** unpacks it later. (Owner, 2026-10-09.)
5. An upload that fails the check is refused, not stored as a file. (Owner, 2026-10-09.)
6. A name clash deduplicates. An upload never replaces a document. (Owner, 2026-10-09.)
7. Versions and chat rooms stay out. Whispers do not travel in clear text. (Owner, 2026-10-09.)
8. Each type has its own package format. Before 1.0 an older package is refused; from 1.0 every break of a type's shape ships a converter for its packages. A newer package is always refused. (Owner, 2026-10-09.)

## Open questions

1. **All whispers out, or only the ones the downloader is not part of?** Recommended: all. A whisper the downloader wrote is still the other person's too, and the file can be forwarded.
2. **An assignee who is not a member of the new document.** Recommended: keep them as history. The other choice is to drop the assignee on unpack.
3. **The size cap.** Recommended: refuse on export above `MAX_DECOMPRESSED_BYTES`. The other choice is a higher cap for packages, which `openZip` would take as a parameter.
