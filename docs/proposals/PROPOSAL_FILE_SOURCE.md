# Proposal: one preview and one action list for every file-ish thing

> **TLDR**: Four surfaces hold files a user can act on: Drive items, mail attachments (MIME parts inside a Maildir `.eml`), chat attachments and comment-card attachments (both Drive files in a container's media folder). Three of the four are already `DrivePath`s, so quick-look works there. Mail attachments have no quick-look at all, because the only mail byte route forces `application/octet-stream` and an attachment disposition, and the preview overlay only accepts a `DrivePath`. Which actions a file offers is decided separately in every menu: Drive's menu gates "Convert to Sheet" on an `.xlsx` name, chat's chip menu has one row, mail's chip has none. This proposal adds three small seams and one route. A `FileSubject` (name, mime, size, URLs, optional `DrivePath`) that the overlay consumes instead of `DrivePath`. A `FILE_ACTIONS` registry in `packages/lib` that answers "what can be done with this file" once, rendered by one `FileActionMenuItems` in Drive's menu, the chat and mail chip menus, the card dialog and the overlay footer. One `SaveToDrivePicker` replacing three hand-wired ones. On the backend, one inline mail byte route that serves a part with its real content type. No route is removed, no hook changes shape, Drive-to-Drive copy is untouched. An action that needs bytes from a non-Drive source fetches them in the browser, because every byte-accepting route already exists. Contacts import, already two routes, becomes one registry entry that dispatches on the subject, so Drive, mail, chat and the cards all offer it.

**Status (2026-09-14): implemented on branch `file-subject`, in four units. This file is the record of what shipped; [Decisions](#decisions) carries every ruling — D1–D12 from the design, D13 onward from the build.**

## Goals

1. **One quick-look for four surfaces.** Clicking an attachment chip in mail, chat or a card opens the same overlay Drive uses, with the same modes. Drive-only pieces (Open in app, server text preview, the exiftool transcode, thumbnails, eigendoc handling) gate on the subject having a `DrivePath`.
2. **One answer to "what can be done with this file".** Quick Look, Download, Save to Drive, Convert to Sheet, Convert to Document and Import to Contacts are declared once, with their mime and name predicates, and every menu and the overlay footer render from that list. Each menu decides where the rows go; none decides whether a row applies.
3. **No new backend seam.** One inline mail route. Every action reaches its bytes through routes that exist today.
4. **Nothing existing loses its meaning.** Hooks keep their names and shapes. `/copy`, the mail save-to-drive route and the convert route stay as they are.

## Non-goals

- **Route consolidation.** No `FileSource` union, no byte resolver, no batch route, no `/copy` removal. If the four "write X from a file" routes ever need unifying, that is its own proposal with its own justification.
- **A virtual read-only mail mount** so attachments become `DrivePath`s. A mount is a `metadata.db` plus a storage backend (`apps/api/src/lib/mount/mount.ts`); a mail mount would need path rows synced with the Maildir and a refusal in every mutating Drive method. Far heavier than the two-field gap it closes.
- **Moving mail attachments out of the `.eml`**, **streaming mail parts**, **server text preview or thumbnails for mail attachments** (no version key, no cache). A `text/csv` mail part gets the fallback card.
- **Mail compose chips.** Their state is `AttachmentMeta[]`, a different shape, and a compose chip needs a remove affordance, not an action list.
- **The chat composer's attach button** and **forwarding a mail attachment into a draft.** No caller today.
- **Sharing a contact in chat.** A contacts feature, not a file action.

## Current state

**Drive's menu decides its own rows.** `DriveItemMenuItems` (`packages/ui/src/components/drive/drive-item-menu.tsx`) computes five booleans — `canQuickLook`, `canDownloadFile`, `canConvertXlsx`, `canConvertDocx` and `canImportContacts` — from `item.type`, the lower-cased name and `isVCardFile`, then renders Quick preview, Download, Convert to Sheet, Convert to Document and Import to Contacts as a contiguous group before the download-formats submenu. The rows call host callbacks `onQuickLook`, `onDownload`, `onConvert`, `onImportContacts`. Convert posts to `POST /drive/:ownerId/:mountId/file/:pathId/convert/:targetType` (`apps/api/src/routes/drive.ts:213`, `eigensheets` or `eigendoc` only) via `useConvertDocument`. Import-into-document has two routes, raw bytes (`:236`, `useImportDocument` posts a `File` body) and `import-from-drive` (`:260`), and contacts import mirrors that pair: `POST /contacts/:ownerId/import` takes raw vCard bytes and `POST /contacts/:ownerId/import-from-drive` reads a Drive path server-side through `getSharedDrive`.

**No mime-to-action registry exists.** The facts are spread over `EIGEN_DOC_TYPE_INFO` + `exportFormatsFor` (`packages/lib/src/types/drive.ts`), `getFilePresentation` (`packages/lib/src/core/file-presentation.ts`, mime to icon and label), the preview constants (`packages/lib/src/constants/preview.ts`, text and exiftool sets) and `DOCX_MIME`/`XLSX_MIME` (`packages/lib/src/constants/mime.ts`). The closest thing to a registry is the command palette's provider list.

**The overlay is bound to `DrivePath`.** `openPreview(path, siblings?, { downloadMode? })` and `updatePreview(path)` (`packages/ui/src/components/preview-provider/preview-context.ts:16-17`). One memo (`preview-provider.tsx:71-106`) derives `previewUrl`, `embedUrl`, `downloadUrl`, `thumbnailUrl` and `aspectRatio` from `ownerId`, `mountId`, `id`, `updatedAt`, `name`, `type`, `thumbnail` and `details.width/height`. `getPreviewMode` (`:31`, local to the provider) branches on the mime prefix, `application/pdf`, `isExiftoolExtension(name)` and `getTextPreviewMode(mime, name)`. `file-preview.tsx` (`packages/ui/src/components/drive/`) reads `path.type` in three places, `path.updatedAt` as the text-preview query key, and `getDriveItemUrl(path)` for Open. Its header carries an Import to Contacts button for a `.vcf` under `IMPORT_MAX_BYTES`, which posts to `import-from-drive`, and its footer has Open, Download, Save to Drive and "Download all (n)", the last gated on `downloadMode === 'save-to-drive'`, which only chat and the card dialog pass. Siblings match by `s.id === path.id`. Seven `openPreview` call sites, two of them palette providers, one provider in `app-shell.tsx`.

**Chat and cards are Drive files.** `AttachmentChip` (`packages/ui/src/components/attachment/attachment-chip.tsx:28-48`) looks the file up by name in the media folder and calls `openPreview(fileInfo, siblings, { downloadMode: 'save-to-drive' })`. Chat's context menu is the singleton `useContextMenu` (`chat-message-list.tsx:77`), bails out on `e.target.closest('a')` (`:274`) and offers one attachment row, Save attachments (`:470`), backed by a hand-wired `DriveLocationPicker` (`:498`).

**Mail attachments have one route and no quick-look.** `GET /mail/:ownerId/message/:id/attachment/:index/:fileName` (`apps/api/src/routes/mail.ts:295`) sets `application/octet-stream`, `Content-Disposition: attachment` from the user-controlled `:fileName` segment, and `private, max-age=86400`. The reader chip (`apps/mail/src/components/mail/read-attachments.tsx`) renders a `SimpleAttachmentChip` whose click calls `preventDefault()` and opens a third hand-wired `DriveLocationPicker`. `text/calendar` parts are filtered out of the chip list. `Attachment` (`packages/lib/src/types/mail.ts`) is `{ contentType, filename?, content, size }` plus the two calendar fields the invite widget reads, `calendarMethod?` and `calendarInvite?`; the parser yields a bare content type with parameters split off, and upgrades a part declared `application/octet-stream` to `libmime.detectMimeType(filename)` when it has a filename — so a part that stays generic has no filename, and therefore no extension either. `filename === undefined` is load-bearing: `lib/mail/sender.ts` drops filename-less parts from outbound SMTP, which is how inline cid images stay out of the attachment list. Postfix caps a delivered message at 25 MiB (`message_size_limit`, `docker/postfix/main.cf.template`), and the parser decodes every part on parse.

**The fallback name is spelled two ways.** `attachment-${index}` (0-based) in `lib/mail/mail.ts:107` (the saved file) and `Attachment ${index + 1}` (1-based) in `read-attachments.tsx` (the chip label). A user sees `Attachment 3` on the chip and `attachment-2` in Drive.

**Every byte-accepting route already exists.** Multipart upload into a folder (`useUploadFile`, `writes.ts:45`), raw body into a document (`useImportDocument`), the draft attachment upload (`mail.ts:202`). Mail's `save-to-drive` route (`mail.ts:271`) validates every selected part before the first write. `file-preview.tsx:84` sets `a.download = ''` so the server names a downloaded file; production is same-origin (`scripts/generate-env.sh` sets `VITE_API_HOST=/eigen`), where the attribute would otherwise override `Content-Disposition`.

**Helpers the new route reuses.** `contentDisposition`, `parseByteRange` and `scriptableInlineHeaders` in `apps/api/src/lib/core/http.ts:84-116`; `serveFile` (`lib/drive/serve-file.ts`) shows the header, ETag and 206 pattern.

## Alternatives considered

- **`FileSource` union + byte resolver + route consolidation.** Rejected: it removes `/copy` (eight test files), migrates four hooks, and adds a schema module and a resolver for one non-Drive kind, none of which serves goals 1 or 2. Keeping Drive's own action rules beside a registry, as that design did, also splits the source of truth goal 2 asks for.
- **A virtual mail mount.** Rejected, see Non-goals.
- **Client re-post for every cross-surface write.** Rejected as a blanket rule: mail's `save-to-drive` route exists, keeps validate-before-write, and moves no bytes through the browser. Client re-post is used only where no route exists today — a vCard with no Drive path going into contacts — and those bytes are capped at `IMPORT_MAX_BYTES`.
- **Per-menu action lists, as today, plus a chip menu for chat and mail.** Rejected: two lists of one fact drift, which is the "one source of truth per fact" rule in AGENTS.md.
- **Storing the actions' handlers in the registry.** Rejected: running an action needs hooks (the preview context, a picker's open state, mutations), so the registry in `packages/lib` stays declarative and one hook in `packages/ui` supplies the handlers.

## Design

### `FileSubject`

`packages/lib/src/types/file-subject.ts`:

```ts
export type FileSubject = {
    key: string;              // identity for sibling matching: drive:{ownerId}:{mountId}:{id} or mail:{ownerId}:{messageId}:{index}
    name: string;             // for a Drive subject, path.name, so the overlay header is unchanged
    mimeType: string;
    size: number;
    embedUrl: string;
    downloadUrl?: string;     // absent when there are no raw bytes: a folder, an Eigen container
    thumbnailUrl?: string;
    drive?: DrivePath;        // present: Open, text preview, exiftool transcode, aspect ratio, eigendoc handling
    mail?: { ownerId: string; messageId: string; index: number };  // what a mail write route needs
};
```

Two builders in `packages/lib/src/core/file-subject.ts`, beside `file-presentation.ts`; a third, `subjectFromBlob`, waits on D12 and is described under [Exports](#exports). `subjectFromPath(path)` builds exactly the URLs the provider's memo builds today, cache-busted by `updatedAt`, thumbnail from `getDriveItemThumbnail`; `subjectFromMailAttachment(ownerId, messageId, index, att)` uses the new embed URL for `embedUrl`, the existing download URL for `downloadUrl`, no thumbnail, and `mailAttachmentName(att, index)` for `name`. URLs are stored on the subject because only these two functions build them. Nothing else in the codebase constructs a subject by hand.

`previewUrl` (the server transcode) is not on the subject: it is `getDrivePreviewUrl(subject.drive)` inside the provider, because only a Drive subject has it and only the exiftool branch reads it.

### The overlay

`openPreview(subject, siblings?, options?)`, `updatePreview(subject)`, `closePreview()`. `downloadMode` is deleted; the one option left is `attachment` (D33). `getPreviewMode(subject)` gates the whole text branch on `subject.drive`, because `CODE_MIMES` opens with the bare `text/` prefix and `TextPreviewContent` needs a mount, a path and an `updatedAt`; without the gate a `text/plain` mail part renders an empty panel. The image branch changes shape: a Drive subject is `image` for any `image/*` mime or exiftool extension, as today, because its `<img>` points at the `/preview` route, which serves a sharp-resized WebP with an exiftool fallback for HEIC, RAW and PSD. A subject without `drive` has no such route and its `<img>` points at the original bytes, so it is `image` only when the mime is in a new `BROWSER_IMAGE_MIMES` set in `packages/lib/src/constants/preview.ts` (JPEG, PNG, GIF, WebP, AVIF, BMP, SVG). A HEIC mail part with an `image/heic` mime therefore gets the fallback card rather than a broken image element in Chrome and Firefox. The three `type` reads become `subject.drive?.type ?? 'file'`. Siblings match by `key`. Aspect ratio comes from `subject.drive?.details` as today.

The footer renders from the registry: Open (when `subject.drive`), then every applicable file action except Quick Look, then "Save all (n)" when the siblings are an attachment set with at least two downloadable members. A Drive quick look passes no option, so its footer ends at the action rows.

The UI call sites wrap with `subjectFromPath`. The two palette providers keep their `DrivePath` contract, and `app-shell.tsx` wraps once.

### The registry

`packages/lib/src/core/file-actions.ts`:

```ts
export type FileActionId =
    | 'quick-look' | 'download' | 'save-to-drive'
    | 'convert-to-sheet' | 'convert-to-document' | 'import-contacts';

export type FileAction = {
    id: FileActionId;
    label: string;
    icon: LucideIcon;
    applies: (subject: FileSubject) => boolean;
};

export const FILE_ACTIONS: readonly FileAction[];
export function fileActionsFor(subject: FileSubject, exclude?: readonly FileActionId[]): FileAction[];
```

`lucide-react` is already imported in `packages/lib/src/core/eigendoc-icons.ts`, so an icon on the entry follows precedent. Predicates: Quick Look applies to any non-folder; Download and Save to Drive to anything with a `downloadUrl` (on a Drive subject Save to Drive says what Copy to… says, so Drive's menu excludes it); Convert to Sheet to a name ending in `.xlsx` and Convert to Document to one ending in `.docx`, extension only, the gate the server itself applies (D34); Import to Contacts on `isVCardFile(mime, name)` under `IMPORT_MAX_BYTES`.

Order is the registry's order. `exclude` lets a menu drop a row that would say what one of its own rows says; it does not let a menu add a row the registry did not approve.

### The runner and the menu

`useFileActionRunner(subject, siblings?, options?)` in `packages/ui/src/components/file-actions/` returns `run(action)`, `openPicker(subjects)`, the `dialogs` node its host mounts, `isDialogOpen` and `isPending`. The subject is nullable, for a host whose subject is state — the right-clicked chip, the right-clicked row. Per action:

- **Quick Look**: `openPreview(subject, siblings, options)`.
- **Download**: `triggerDownload(downloadUrl)`, an anchor with `download = ''`, so the server names the file on every surface.
- **Save to Drive**: opens `SaveToDrivePicker` on the one subject.
- **Convert to Sheet / Document**: a Drive subject that is not an attachment converts in place through `useConvertDocument`. Anything else — a mail part, a chat or card chip whose Drive copy sits in a hidden media folder — opens `SaveToDrivePicker` first under the row's own label with **Save and convert** as the confirm button, and converts the paths the save reports through `onSaved`, one call per file, with the picked folder as the parent.
- **Import to Contacts**: a Drive subject through `useImportContactsFromDrive`; without one, the bytes come from `downloadUrl` with credentials and go to `useImportContacts`.

`FileActionMenuItems({ runner, exclude? })` renders `fileActionsFor(runner.subject, exclude)` as `DropdownMenuItem` rows through that runner. It takes the runner rather than building one: a menu's content unmounts when it closes, so the picker a row opens has to be mounted by the host above it, and the rows come from `runner.subject` so a host cannot pair one menu with another's subject. It is the one place a file action row is drawn.

`SaveToDrivePicker({ subjects, open, onClose, onSaved?, title?, confirmLabel? })` in `packages/ui/src/components/drive/` wraps `DriveLocationPicker`. Drive subjects go through `useCopyFiles`, mail subjects through `useSaveMailAttachmentsToDrive`, both unchanged; each toasts with an "Open folder" action and reports the created paths through `onSaved`. The first subject picks the branch — siblings always come from one surface, so a batch is all Drive items or all mail parts — and a subject carrying neither identity draws nothing. It is the one picker behind the three hand-wired flows in `file-preview.tsx`, `chat-message-list.tsx` and `read-attachments.tsx`, with "Download instead" as its escape hatch.

### Consumers

- **Drive's menu**: the five rows become one `FileActionMenuItems` call with `exclude: ['save-to-drive']`, in the same position (D35). The five booleans and the `onQuickLook`, `onDownload`, `onConvert` and `onImportContacts` props go; the host builds the runner from `subjectFromPath(item)` with the listing, in its display order, as siblings, so Quick preview pages through the folder. Open, the download-formats submenu, Rename, Move to…, Copy to…, Duplicate, Watch, Share and Move to trash stay Drive rows.
- **Chat**: the chip's rows join the message's own in the singleton menu, through `useAttachmentChipMenu`. The `closest('a')` bail-out is skipped when `attachmentKeyAt` finds the `data-attachment-chip` attribute `SimpleAttachmentChip` sets, so a right-click on a chip reaches the menu, and the message row's long-press opens the same one. Click stays quick-look.
- **Mail reader**: a chip click opens quick-look with the message's other non-calendar parts as siblings. Right-click and long-press open the singleton context menu with `FileActionMenuItems`. The toolbar's down-arrow opens `SaveToDrivePicker` on every visible part. The chip label uses `mailAttachmentName`.
- **Cards**: the card dialog's chips get the same click and the same menu, on the same `useAttachmentChipMenu`.
- **The overlay footer**: as above.

### Backend

One new route beside `mail.ts:295`: `GET /mail/:ownerId/message/:id/attachment/:index/embed/:fileName`. Both mail byte routes hand their part to one `serveMailPart(mail, messageId, index, disposition, request)` (`apps/api/src/lib/mail/serve-mail-part.ts`): `Content-Type` from `att.contentType`, `Content-Disposition` from `contentDisposition(disposition, mailAttachmentName(att, index))`, `X-Content-Type-Options: nosniff` always, `scriptableInlineHeaders(att.contentType)` spread in for inline, `private, max-age=86400` as today, an ETag of the message id, the part index and the summary row's date and size, and `Accept-Ranges: bytes` with a 206 over `att.content.slice` on a range request. A matching `If-None-Match` is answered 304 off the summary row before the message is parsed (D19). Ranges are two lines because the part is already in memory, and they are not optional: a mail `video/mp4` or `audio/mpeg` part reaches a media element whose seeking needs them, and Safari refuses a source that advertises none. `messageGetAttachment` stays.

The download route serves the part's own content type rather than `application/octet-stream`, and names the file from the part: the `:fileName` segment is decoration.

`mailAttachmentName(att, index)` in `packages/lib/src/types/mail.ts` (a BE-safe subpath that already holds `isEmailDraft`) returns `att.filename || 'attachment-' + (index + 1)`. Consumers: `serveMailPart`, `subjectFromMailAttachment`, the reader chip label and `saveAttachmentsToDrive`, so a message's third part with no filename is `attachment-3` on the chip, in the disposition and in Drive. `Attachment.filename` stays optional. No extension is added; mapping a content type to an extension is a separate decision with no helper in the repo.

### Contacts import

Both routes stay. `POST /contacts/:ownerId/import` takes vCard text in the request body, the way the raw document import takes bytes; `POST /contacts/:ownerId/import-from-drive` reads a Drive path server-side through `getSharedDrive`, ACL check included. The registry's `import-contacts` row dispatches on the subject rather than on the caller: a Drive subject goes through `useImportContactsFromDrive` and its bytes never leave the server, and a subject without one — a mail part today, any later non-Drive source — is fetched from `downloadUrl` with credentials and posted through `useImportContacts`. The predicate is `isVCardFile(mime, name)` plus `size <= IMPORT_MAX_BYTES` (20 MiB), so a file the import would refuse with a 413 draws no row at all. One entry, and Drive, mail, chat and the cards all offer it.

### Exports

Every export is a direct download: Docs, Sheets and Slides export to docx, xlsx and pdf through `useExportDocument`, Contacts exports vCards through `useExportContacts`, and both fetch the bytes with credentials and hand the blob to `downloadBlob` (`packages/lib/src/core/download.ts`). The user never gets to choose Drive. Giving an export the same choice is D12, and it is not part of this program (D20): it is one row in `ROADMAP.md`. The shape it takes when it lands — a third builder, `subjectFromBlob(blob, name)`, wraps the response in an object URL (`embedUrl` and `downloadUrl` both `blob:`), takes the mime from the response and the name from `Content-Disposition` through `filenameFromDisposition`, and has no `drive`. The export hooks then run the registry's `download` and `save-to-drive` through `useFileActionRunner` instead of calling `downloadBlob`, so every export menu offers Save to Drive… beside Download; the upload goes through the existing multipart route (`useUploadFile`), since the bytes are already in the browser. The object URL is revoked when the picker closes or the download starts.

## Performance invariants

- The overlay makes the same requests for a Drive subject as today. A mail subject makes one embed request and shows the original bytes: no resize, no thumbnail, no transcode. A 20 MB JPEG part loads at full size.
- Drive-to-Drive writes keep the same-storage fast path and cross-mount bridge through `/copy`, untouched.
- A mail part into Drive goes through the existing server-side route, never through the browser.
- The only bytes that pass through the browser are a vCard with no Drive path going into contacts, bounded by `IMPORT_MAX_BYTES` (20 MiB). A mail part being converted is written by the server-side mail route first and converted where it landed, so its bytes never travel either.

## Rollout

Four unit branches onto one integration branch, merged `--no-ff` in order. No pixel gate (D21): one screenshot round per UI unit, plus a behavioural probe each.

1. **The mail byte routes.** `mailAttachmentName`, `serveMailPart`, the `/embed/` route, both mail byte routes and the saved file on the helper, `getMailAttachmentEmbedUrl`. Tests: a part on another user's message → 403, a guest → 403, the real content type on both routes, the filename from the part, a 206 range, a 304 off the ETag. No Eden surface changes.
2. **`FileSubject` and the overlay.** The type, `subjectFromPath`, `getPreviewMode`, `BROWSER_IMAGE_MIMES`, the registry, `useFileActionRunner`, `SaveToDrivePicker` on Drive subjects, the provider and overlay switch, the call sites, the palette wrap, `downloadMode` deleted, the footer rendered from the registry and the header's Import to Contacts button replaced by its footer row. The registry and the runner ship here because the footer needs them, with Drive's menu still on its own rows.
3. **Menus and chips.** `FileActionMenuItems`, Drive's menu on the registry, the chat and card chip menus on `useAttachmentChipMenu`, the card dialog's menu anchor portaled to `document.body` (D36).
4. **The mail reader.** `subjectFromMailAttachment`, the chip's click, menu and long-press, the toolbar's save on the picker, the picker's mail branch and the save-then-convert path. The three hand-wired `DriveLocationPicker` flows go here. Browser probe: a mail image, a PDF, a video part seeked past its first chunk, a `text/csv` part showing the fallback card; Convert to Sheet from an `.xlsx` mail part; save from every menu and footer on local and MinIO mounts; Drive Quick preview, Download, Convert and Copy to… unchanged.

## Risks and caveats

- **Inline serving of mail parts is a new exposure.** Handled by `scriptableInlineHeaders`, nosniff unconditionally, and the filename from the part rather than the URL. `text/calendar` parts stay filtered out of the chip list. A mail part is the caller's own, so no ACL question arises.
- **The registry predicates are now the only gate.** A wrong predicate shows a row on every surface at once. That is the point, and it is also why each predicate gets a unit test in `packages/lib/src/test/`.
- **The download route serves a real content type.** A browser that visits the URL directly can render a PDF inline where `application/octet-stream` always downloaded. The disposition is `attachment`, so a click downloads.
- **Docs that carry this**: `MAIL.md`, `PREVIEWS.md`, `CHAT.md`, `LAYOUT.md`, `ARCHITECTURE.md`, `SHARED-PRIMITIVES.md` (`bun run primitives`), and the help-center articles for the mail attachment chip, the chat and card chips, and the `.vcf` quick look.

## Open questions

1. **`subject.name` for a Drive file with an `originalName`.** The chip shows `details.originalName || name`, the overlay header shows `name`. The subject keeps `name`, so the overlay header reads the same on every surface; unifying the two is a separate one-line decision.
2. **Quick Look siblings in Drive's menu.** Each host maps the visible listing into subjects to build its runner. Whether the row should instead read that list from context is a later question.

## Decisions

| # | Ruling | Why |
|---|---|---|
| D1 | No route consolidation, no resolver, no `/copy` removal. Hooks keep their names, shapes and request patterns. | Orthogonal to both goals. `/copy` is exercised by eight test files, and a four-hook migration is the riskiest part of that design. |
| D2 | `FileSubject` stores its URLs and has exactly three builders: a Drive path, a mail attachment, an export blob. | Only three functions build a subject, so "derived data at nine call sites" no longer applies. Nine consumers reading four fields beats nine consumers calling a helper. |
| D3 | The registry lives in `packages/lib` and is declarative; handlers live in one `packages/ui` hook. | Predicates are React-free and unit-testable; running an action needs the preview context, picker state and mutations. |
| D4 | Drive's menu consumes the registry instead of its own rules. | Goal 2. A menu picks and places rows; it cannot add one. Save to Drive on a Drive item is Copy to…, which stays Drive's row. |
| D5 | Client re-post only where no route exists: a vCard with no Drive path going into contacts. Mail into Drive, and a mail part on its way to a convert, keep the server-side route. | The bytes are capped at `IMPORT_MAX_BYTES`, and the alternative is a new backend seam for one action. Mail's route keeps validate-before-write for free. |
| D6 | One `serveMailPart` for both mail byte routes; `serveFile` untouched. | One home for the inline-header fact is `scriptableInlineHeaders`; the mail helper only spreads it. |
| D7 | `mailAttachmentName` is the one fallback name, on the chip, in the disposition and in Drive. `Attachment.filename` stays optional. | A missing filename is how outbound mail recognises inline cid parts. The chip, the header and the saved file must read alike. |
| D8 | `downloadMode` is deleted; the footer renders from the registry, with "Save all (n)" on its own gate (D28). | One footer everywhere, and one fact deciding whether a set can be saved as a set. |
| D9 | Every server-rendered preview mode gates on `subject.drive`; a subject without `drive` is `image` only for a browser-decodable mime (`BROWSER_IMAGE_MIMES`). | Drive's `<img>` never shows original bytes: `/preview` serves a resized WebP, with exiftool for HEIC, RAW and PSD. A mail part's `<img>` shows the original, which the browser must decode itself. The text renderer needs a mount, a path and a version key. |
| D10 | Mail compose chips are out of scope. | `AttachmentMeta[]` is a different shape and a compose chip is a remove affordance, not an action list. |
| D12 | Exports get Save to Drive through `subjectFromBlob` and the same runner, as their own unit (D20); until then every export is a direct download. | One choice on every surface, the bytes are already in the browser, and the upload route exists. |
| D11 | The `use-draft.ts` off-by-N (raw index at one site, calendar-filtered index at another, both fed to `keepAttachmentIndexes`) is a separate cheap-win commit, listed in `ROADMAP.md`. | Real bug, unrelated to preview or actions. |
| D13 | Both contacts import routes stay, and `import-contacts` dispatches on `subject.drive`: Drive through `import-from-drive`, anything else by posting the bytes from `downloadUrl`. | The Drive route is ACL-tested and keeps a 20 MiB vCard out of the browser; the raw route is the only way in for a source that has no Drive path. |
| D14 | Predicates read type and size, never the presence of a URL alone; `subjectFromPath` sets `downloadUrl` only when `path.type === 'file'`. | One fact answers "has raw bytes", so an eigendoc cannot grow a Download row on a surface that forgot to check. |
| D15 | `fileActionsFor(subject, exclude?)`, not `include`. | A new registry row then appears on every surface without editing a menu; Drive excludes `save-to-drive`, the overlay footer excludes `quick-look`. |
| D16 | The runner takes its subject at hook time; `useConvertDocument()` takes its arguments per call. | A hook cannot be called from an event handler, and a mail part's convert target is only known after the picker. |
| D17 | `getPreviewMode` gates both `text` and `vcard` on `subject.drive`, and the overlay's Import to Contacts is the footer's registry row. | Both renderers query a mount the subject may not have; one list of footer actions beats a header button only Drive can use. |
| D18 | `mailAttachmentName(att, index)` is `att.filename \|\| 'attachment-' + (index + 1)`: hyphenated, 1-based, no extension. | One name on the chip, in the disposition and in Drive; a space in an extensionless name is what shells and DAV clients trip over. |
| D19 | Ranges stay; the ETag is the message id, the part index and the summary row's date and size, and a matching `If-None-Match` is answered before the message is parsed. | Safari refuses a media source that advertises no ranges, and reading a part re-parses the whole `.eml` — a miss still pays it, which is the `ROADMAP.md` row. |
| D20 | D12 is out of this program: exports stay direct downloads. | The exports half needs the blob builder and five export menus of its own; it is a backlog row, not a unit here. |
| D21 | No pixel gate: one screenshot round per UI unit plus behavioural probes. | A byte-identical gate belongs to a render-path refactor, and the footer is a deliberate design change. |
| D22 | A click on a mail attachment chip is Quick Look; saving moves to the footer and the chip menu. | The chip behaves like every other attachment chip, and one click no longer opens a dialog nobody asked for. |
| D23 | A mail subject's siblings are the calendar-filtered chip list, in chip order. | ← → then pages exactly what the reader shows and never lands on a hidden invite. |
| D24 | The mail chip gets a long-press onto the same menu; chat's chip rides the message long-press. | A right-click affordance needs its `pointer-coarse` equivalent, or the actions do not exist on a phone. |
| D25 | A read-only (watched) item still offers Convert; not fixed here, a `ROADMAP.md` row instead. | The missing gate is a capability the registry cannot see, and adding it is a menu-host change with its own product call. |
| D26 | `app-shell.tsx` wraps `openPreview` with `subjectFromPath` inside a `useCallback`. | The two palette providers keep their `DrivePath` contract, so exactly one adapter exists. |
| D27 | The subject and the registry ship behind new exports-map subpaths `./file-subject` and `./file-actions`; only `mailAttachmentName`, in `types/mail.ts`, is backend-facing. | The backend must not reach a module that imports React, and a primitive is shared only once a barrel exports it. |
| D28 | "Save all (n)" is gated on the `attachment` flag plus two downloadable siblings, and the footer's save row reads "Save to Drive…" on every surface, Drive included. | A Drive listing's siblings are the whole folder: the sibling-count gate alone offered "Download all (500)" and copied a folder onto itself. |
| D29 | A batch is homogeneous: the first subject picks the picker's branch and the rest ride it. | Siblings always come from one surface, so a mixed Drive + mail batch is a branch nothing can reach. |
| D30 | `getPreviewMode` lives in `core/file-subject.ts`; `BROWSER_IMAGE_MIMES` stays in `constants/preview.ts`. | The overlay's dispatch belongs beside the subject it reads; the mime tables stay in the module the backend shares. |
| D31 | `FileSubject` carries `mail?: { ownerId, messageId, index }` beside `drive?`, and nothing parses the `key`. | The mail save route needs a message id and part indexes; the key is for sibling matching alone, and a parsed key is a second encoding of the same fact. |
| D32 | The menus and the mail reader are separate units. | Each gets its own screenshot round, and the reader needs the menu component the other unit lands. |
| D33 | The preview option is `attachment`, not `batch`, and it does two things: it draws "Save all (n)" and it sends a convert through the picker. | A chat or card chip's Drive path sits in a hidden media folder — converting in place writes the new sheet there and navigates into it. |
| D34 | Convert predicates are extension-only, matching the server. | `import-document.ts` refuses on the name, and the parser has already upgraded a named part's `application/octet-stream`, so a mime disjunction would only ever offer a row that 400s. |
| D35 | Drive's menu keeps the registry group between the Open group and the download-formats submenu. | The item menu reads as it did, and `LAYOUT.md`'s description of it stays true. |
| D36 | `ContextMenuAnchor` portals its zero-size trigger into `document.body`. | Inside a translated dialog (the card dialog) the transform becomes the containing block for the trigger's fixed coordinates, and the menu opens somewhere else. |
