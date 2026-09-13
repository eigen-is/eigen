# Proposal: one preview and one action list for every file-ish thing

> **TLDR**: Four surfaces hold files a user can act on: Drive items, mail attachments (MIME parts inside a Maildir `.eml`), chat attachments and comment-card attachments (both Drive files in a container's media folder). Three of the four are already `DrivePath`s, so quick-look works there. Mail attachments have no quick-look at all, because the only mail byte route forces `application/octet-stream` and an attachment disposition, and the preview overlay only accepts a `DrivePath`. Which actions a file offers is decided separately in every menu: Drive's menu gates "Convert to sheet" on an `.xlsx` name, chat's chip menu has one row, mail's chip has none. This proposal adds three small seams and one route. A `FileSubject` (name, mime, size, URLs, optional `DrivePath`) that the overlay consumes instead of `DrivePath`. A `FILE_ACTIONS` registry in `packages/lib` that answers "what can be done with this file" once, rendered by one `FileActionMenuItems` in Drive's menu, the chat and mail chip menus, the card dialog and the overlay footer. One `SaveToDrivePicker` replacing three hand-wired ones. On the backend, one inline mail byte route that serves a part with its real content type. No route is removed, no hook changes shape, Drive-to-Drive copy is untouched. An action that needs bytes from a non-Drive source fetches them in the browser, because every byte-accepting route already exists. The coming contacts vCard import lands as one registry entry and one route that takes vCard bytes, and every surface gets it at once.

**Status (2026-09-13): rewritten from scratch. The previous version (2026-09-12, six reviews) built a `FileSource` union, a byte resolver, a batch `items-from` route and removed `/copy`. A design review found about half of it orthogonal to the two goals below, and one ruling (Drive's menu untouched) contradicting goal 2. Rulings in [Decisions](#decisions-2026-09-13).**

## Goals

1. **One quick-look for four surfaces.** Clicking an attachment chip in mail, chat or a card opens the same overlay Drive uses, with the same modes. Drive-only pieces (Open in app, server text preview, the exiftool transcode, thumbnails, eigendoc handling) gate on the subject having a `DrivePath`.
2. **One answer to "what can be done with this file".** Quick Look, Download, Save to Drive, Convert to sheet, Convert to document and later Import to Contacts are declared once, with their mime and name predicates, and every menu and the overlay footer render from that list. Each menu decides where the rows go; none decides whether a row applies.
3. **No new backend seam.** One inline mail route. Every action reaches its bytes through routes that exist today.
4. **Nothing existing loses its meaning.** Hooks keep their names and shapes. `/copy`, the mail save-to-drive route and the convert route stay as they are.

## Non-goals

- **Route consolidation.** No `FileSource` union, no byte resolver, no batch route, no `/copy` removal. If the four "write X from a file" routes ever need unifying, that is its own proposal with its own justification.
- **A virtual read-only mail mount** so attachments become `DrivePath`s. A mount is a `metadata.db` plus a storage backend (`apps/api/src/lib/mount/mount.ts`); a mail mount would need path rows synced with the Maildir and a refusal in every mutating Drive method. Far heavier than the two-field gap it closes.
- **Moving mail attachments out of the `.eml`**, **streaming mail parts**, **server text preview or thumbnails for mail attachments** (no version key, no cache). A `text/csv` mail part gets the fallback card.
- **Mail compose chips.** Their state is `AttachmentMeta[]`, a different shape, and a compose chip needs a remove affordance, not an action list.
- **The chat composer's attach button** and **forwarding a mail attachment into a draft.** No caller today.
- **Sharing a contact in chat.** Belongs to the vCard plan.

## Current state

**Drive's menu decides its own rows.** `DriveItemMenuItems` (`packages/ui/src/components/drive/drive-item-menu.tsx:77-81`) computes `canQuickLook`, `canDownloadFile`, `canConvertXlsx` and `canConvertDocx` from `item.type` and `item.name.endsWith('.xlsx' | '.docx')`, then renders Quick Look (`:108`), Download (`:124`), Convert to sheet (`:130`), Convert to document (`:136`) as a contiguous group before the Export submenu. The rows call host callbacks `onQuickLook`, `onDownload`, `onConvert`. Convert posts to `POST /drive/:ownerId/:mountId/file/:pathId/convert/:targetType` (`apps/api/src/routes/drive.ts:213`, `eigensheets` or `eigendoc` only) via `useConvertDocument`. Import-into-document has two routes, raw bytes (`:236`, `useImportDocument` posts a `File` body) and `import-from-drive` (`:260`).

**No mime-to-action registry exists.** The facts are spread over `EIGEN_DOC_TYPE_INFO` + `exportFormatsFor` (`packages/lib/src/types/drive.ts`), `getFilePresentation` (`packages/lib/src/core/file-presentation.ts`, mime to icon and label), the preview constants (`packages/lib/src/constants/preview.ts`, text and exiftool sets) and `DOCX_MIME`/`XLSX_MIME` (`packages/lib/src/constants/mime.ts`). The closest thing to a registry is the command palette's provider list.

**The overlay is bound to `DrivePath`.** `openPreview(path, siblings?, { downloadMode? })` and `updatePreview(path)` (`packages/ui/src/components/preview-provider/preview-context.ts:16-17`). One memo (`preview-provider.tsx:71-106`) derives `previewUrl`, `embedUrl`, `downloadUrl`, `thumbnailUrl` and `aspectRatio` from `ownerId`, `mountId`, `id`, `updatedAt`, `name`, `type`, `thumbnail` and `details.width/height`. `getPreviewMode` (`:31`, local to the provider) branches on the mime prefix, `application/pdf`, `isExiftoolExtension(name)` and `getTextPreviewMode(mime, name)`. `file-preview.tsx` (`packages/ui/src/components/drive/`) reads `path.type` in three places, `path.updatedAt` as the text-preview query key, and `getDriveItemUrl(path)` for Open. Its footer has Open, Download, Save to Drive and "Download all (n)", the last gated on `downloadMode === 'save-to-drive'`, which only chat and the card dialog pass. Siblings match by `s.id === path.id`. Seven `openPreview` call sites, two of them palette providers, one provider in `app-shell.tsx`.

**Chat and cards are Drive files.** `AttachmentChip` (`packages/ui/src/components/attachment/attachment-chip.tsx:28-48`) looks the file up by name in the media folder and calls `openPreview(fileInfo, siblings, { downloadMode: 'save-to-drive' })`. Chat's context menu is the singleton `useContextMenu` (`chat-message-list.tsx:77`), bails out on `e.target.closest('a')` (`:274`) and offers one attachment row, Save attachments (`:470`), backed by a hand-wired `DriveLocationPicker` (`:498`).

**Mail attachments have one route and no quick-look.** `GET /mail/:ownerId/message/:id/attachment/:index/:fileName` (`apps/api/src/routes/mail.ts:295`) sets `application/octet-stream`, `Content-Disposition: attachment` from the user-controlled `:fileName` segment, and `private, max-age=86400`. The reader chip (`apps/mail/src/components/mail/read-attachments.tsx`) renders a `SimpleAttachmentChip` whose click calls `preventDefault()` and opens a third hand-wired `DriveLocationPicker`. `text/calendar` parts are filtered out of the chip list. `Attachment` (`packages/lib/src/types/mail.ts:29`) is `{ contentType, filename?, content, size }`; the parser already yields a bare content type with parameters split off. `filename === undefined` is load-bearing: `lib/mail/sender.ts` drops filename-less parts from outbound SMTP, which is how inline cid images stay out of the attachment list. Messages are capped at 25 MiB and the parser decodes every part on parse.

**The fallback name is spelled two ways.** `attachment-${index}` (0-based) in `lib/mail/mail.ts:107` (the saved file) and `Attachment ${index + 1}` (1-based) in `read-attachments.tsx` (the chip label). A user sees `Attachment 3` on the chip and `attachment-2` in Drive.

**Every byte-accepting route already exists.** Multipart upload into a folder (`useUploadFile`, `writes.ts:45`), raw body into a document (`useImportDocument`), the draft attachment upload (`mail.ts:202`). Mail's `save-to-drive` route (`mail.ts:271`) validates every selected part before the first write. `file-preview.tsx:84` sets `a.download = ''` so the server names a downloaded file; production is same-origin (`scripts/generate-env.sh` sets `VITE_API_HOST=/eigen`), where the attribute would otherwise override `Content-Disposition`.

**Helpers the new route reuses.** `contentDisposition`, `parseByteRange` and `scriptableInlineHeaders` in `apps/api/src/lib/core/http.ts:84-116`; `serveFile` (`lib/drive/serve-file.ts`) shows the header, ETag and 206 pattern.

## Alternatives considered

- **`FileSource` union + byte resolver + route consolidation** (the previous version of this proposal). Rejected: it removes `/copy` (eight test files), migrates four hooks, adds a schema module and a resolver for one non-Drive kind, and none of that serves goals 1 or 2. Its D15 kept Drive's own action rules, which splits the source of truth goal 2 asks for.
- **A virtual mail mount.** Rejected, see Non-goals.
- **Client re-post for every cross-surface write.** Rejected as a blanket rule: mail's `save-to-drive` route exists, keeps validate-before-write, and moves no bytes through the browser. Client re-post is used only where no route exists today (a mail part into contacts, a mail part converted to a document), and those bytes are small or already capped.
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
    downloadUrl?: string;     // undefined for folders
    thumbnailUrl?: string;
    drive?: DrivePath;        // present: Open, text preview, exiftool transcode, aspect ratio, eigendoc handling
};
```

Two builders in `packages/lib/src/core/file-subject.ts`, beside `file-presentation.ts`: `subjectFromPath(path)` builds exactly the URLs the provider's memo builds today, cache-busted by `updatedAt`, thumbnail from `getDriveItemThumbnail`; `subjectFromMailAttachment(ownerId, messageId, index, att)` uses the new embed URL for `embedUrl`, the existing download URL for `downloadUrl`, no thumbnail, and `mailAttachmentName(att, index)` for `name`. URLs are stored on the subject because only these two functions build them. Nothing else in the codebase constructs a subject by hand.

`previewUrl` (the server transcode) is not on the subject: it is `getDrivePreviewUrl(subject.drive)` inside the provider, because only a Drive subject has it and only the exiftool branch reads it.

### The overlay

`openPreview(subject, siblings?)`, `updatePreview(subject)`. `downloadMode` is deleted. `getPreviewMode(subject)` gates the whole text branch on `subject.drive`, because `CODE_MIMES` opens with the bare `text/` prefix and `TextPreviewContent` needs a mount, a path and an `updatedAt`; without the gate a `text/plain` mail part renders an empty panel. The image branch changes shape: a Drive subject is `image` for any `image/*` mime or exiftool extension, as today, because its `<img>` points at the `/preview` route, which serves a sharp-resized WebP with an exiftool fallback for HEIC, RAW and PSD. A subject without `drive` has no such route and its `<img>` points at the original bytes, so it is `image` only when the mime is in a new `BROWSER_IMAGE_MIMES` set in `packages/lib/src/constants/preview.ts` (JPEG, PNG, GIF, WebP, AVIF, BMP, SVG). A HEIC mail part with an `image/heic` mime therefore gets the fallback card rather than a broken image element in Chrome and Firefox. The three `type` reads become `subject.drive?.type ?? 'file'`. Siblings match by `key`. Aspect ratio comes from `subject.drive?.details` as today.

The footer renders from the registry: Open (when `subject.drive`), then every applicable file action except Quick Look, then the batch "Save all (n)", gated as today on at least two downloadable siblings with folders and eigendocs filtered out. It appears on Drive previews too, which never had it; that is a new affordance and goes to the screenshot round.

The five UI call sites wrap with `subjectFromPath`. The two palette providers keep their `DrivePath` contract, and `app-shell.tsx` wraps once.

### The registry

`packages/lib/src/core/file-actions.ts`:

```ts
export type FileActionId = 'quick-look' | 'download' | 'save-to-drive' | 'convert-to-sheet' | 'convert-to-document';

export type FileAction = {
    id: FileActionId;
    label: string;
    icon: LucideIcon;
    applies: (subject: FileSubject) => boolean;
};

export const FILE_ACTIONS: readonly FileAction[];
export function fileActionsFor(subject: FileSubject, include?: readonly FileActionId[]): FileAction[];
```

`lucide-react` is already imported in `packages/lib/src/core/eigendoc-icons.ts`, so an icon on the entry follows precedent. Predicates: Quick Look applies to any non-folder; Download to anything with a `downloadUrl`; Save to Drive to anything with a `downloadUrl` (for a Drive subject it is Copy to…, so Drive's menu does not include it); Convert to sheet when the mime is `XLSX_MIME` or the name ends in `.xlsx`; Convert to document likewise for `DOCX_MIME` and `.docx`. Mail parts often arrive as `application/octet-stream`, which is why the name check stays beside the mime check. `import-contacts` joins the list with the vCard plan, on `isVCardFile(mime, name)`.

Order is the registry's order. `include` lets a menu pick a subset; it does not let a menu add a row the registry did not approve.

### The runner and the menu

`useFileActionRunner()` in `packages/ui/src/components/file-actions/` returns `run(action, subject, siblings?)`. Per action:

- **Quick Look**: `openPreview(subject, siblings)`.
- **Download**: an anchor to `downloadUrl` with `download = ''`, the `file-preview.tsx:84` pattern, so the server names the file on every surface.
- **Save to Drive**: opens `SaveToDrivePicker`.
- **Convert to sheet / document**: a Drive subject posts to the existing convert route through `useConvertDocument`. A mail subject first goes through `SaveToDrivePicker`, then converts the resulting `DrivePath`. Two existing requests, and the picker step is the folder choice a converted document needs anyway.

`FileActionMenuItems({ subject, siblings?, include? })` renders `fileActionsFor(subject, include)` as `DropdownMenuItem` rows through the runner. It is the one place a file action row is drawn.

`SaveToDrivePicker({ subjects, open, onClose })` in `packages/ui/src/components/drive/` wraps `DriveLocationPicker`. Drive subjects go through `useCopyFiles`, mail subjects through `useSaveMailAttachmentsToDrive`, both unchanged; one toast with an "Open folder" action. It replaces the three hand-wired flows in `file-preview.tsx`, `chat-message-list.tsx` and `read-attachments.tsx`. Hosts keep the `open` state outside their menus, as chat does today.

### Consumers

- **Drive's menu**: the four rows at `drive-item-menu.tsx:108-136` become one `FileActionMenuItems` call with `include: ['quick-look', 'download', 'convert-to-sheet', 'convert-to-document']` in the same position. `canQuickLook`, `canDownloadFile`, `canConvertXlsx`, `canConvertDocx` and the `onQuickLook`, `onDownload`, `onConvert` props go. Open, Export, Rename, Move to, Copy to, Duplicate, Share and Delete stay Drive rows. Quick Look keeps its sibling list, so the menu receives `siblings` where the host passed them before.
- **Chat**: the chip's context menu adds `FileActionMenuItems` for the right-clicked attachment. The `closest('a')` bail-out exempts a `data-attachment-chip` attribute that `SimpleAttachmentChip` sets, so a right-click on a chip reaches the menu. Click stays quick-look.
- **Mail reader**: a chip click opens quick-look with the message's other parts as siblings. Right-click opens the singleton context menu with `FileActionMenuItems`. The toolbar's Save all uses `SaveToDrivePicker` with every part. The chip label uses `mailAttachmentName`.
- **Cards**: the card dialog's chips get the same click and the same menu.
- **The overlay footer**: as above.

### Backend

One new route beside `mail.ts:295`: `GET /mail/:ownerId/message/:id/attachment/:index/embed/:fileName`. Both mail byte routes hand their part to one `serveMailPart(att, index, disposition, range)`: `Content-Type` from `att.contentType`, `Content-Disposition` from `contentDisposition(disposition, mailAttachmentName(att, index))`, `X-Content-Type-Options: nosniff` always, `scriptableInlineHeaders(att.contentType)` spread in for inline, `private, max-age=86400` as today, an ETag, and `Accept-Ranges: bytes` with a 206 over `att.content.subarray` on a range request. Ranges are two lines because the part is already in memory, and they are not optional: a mail `video/mp4` or `audio/mpeg` part reaches a media element whose seeking needs them, and Safari refuses a source that advertises none. `messageGetAttachment` stays.

Two observable changes on the existing download route, both deliberate: the real content type instead of `application/octet-stream`, and the filename from the part instead of the URL segment.

`mailAttachmentName(att, index)` in `packages/lib/src/types/mail.ts` (a BE-safe subpath that already holds `isEmailDraft`) returns `att.filename || 'Attachment ' + (index + 1)`. Consumers: `serveMailPart`, `subjectFromMailAttachment`, the reader chip label, and `lib/mail/mail.ts:107`, so the saved file for a filename-less part changes from `attachment-2` to `Attachment 3` and matches the chip. `Attachment.filename` stays optional. No extension is added; mapping a content type to an extension is a separate decision with no helper in the repo.

### Contacts import, with the vCard plan

`POST /contacts/:ownerId/import` takes vCard text in the request body, like the raw document import route takes bytes. The registry gains `import-contacts`; the runner fetches `subject.downloadUrl`, posts the text, and toasts the count. This works from Drive, mail, chat and cards on day one, with no source-kind branch anywhere. A vCard is kilobytes, which is why the browser round-trip is the right trade here. The vCard branch (`vcard-transfer`) also carries a `POST /contacts/:ownerId/import-from-drive` route for Drive's context menu, read server-side through `getSharedDrive`; it is deleted when the registry entry lands, so contacts import has one route.

## Performance invariants

- The overlay makes the same requests for a Drive subject as today. A mail subject makes one embed request and shows the original bytes: no resize, no thumbnail, no transcode. A 20 MB JPEG part loads at full size.
- Drive-to-Drive writes keep the same-storage fast path and cross-mount bridge through `/copy`, untouched.
- A mail part into Drive goes through the existing server-side route, never through the browser.
- The only bytes that pass through the browser are a vCard into contacts (kilobytes) and a mail part being converted (capped at 25 MiB by the message limit, one extra round-trip).

## Phased rollout

Three branches, merged in order to an integration branch.

1. **Backend.** `mailAttachmentName`, `serveMailPart`, the embed route, both mail routes on the helper, `mail.ts:107` on the helper. Tests: a part on another user's message → 403, a guest → 403, real content type on both routes, filename from the part, a 206 range. No Eden surface changes.
2. **`FileSubject` and the overlay.** Type, both builders, provider and overlay switch, the five call sites, the palette wrap, `downloadMode` deleted, the footer rendered from the registry. The registry and runner ship here because the footer needs them, with Drive's menu still on its own rows. **The pixel gate lives here**: Drive and chat quick-look content area byte-identical; the footer is a design change with one screenshot round.
3. **Menus, chips, picker.** `FileActionMenuItems`, `SaveToDrivePicker`, Drive's menu on the registry, the chat and card chip menus, the mail chip click and menu, the mail toolbar on the picker, the three hand-wired pickers deleted. Browser probe: a mail image, a PDF, a video part seeked past its first chunk, a `text/csv` part showing the fallback card; Convert to sheet from an `.xlsx` mail part; save from every menu and footer on local and MinIO mounts; Drive Quick Look, Download, Convert, Copy to… unchanged.

Then the vCard plan (`docs/superpowers/plans/2026-09-11-vcard-import-export.md`) adds `isVCardFile`, the contacts import route and the `import-contacts` entry.

## Risks and caveats

- **Inline serving of mail parts is a new exposure.** Handled by `scriptableInlineHeaders`, nosniff unconditionally, and the filename from the part rather than the URL. `text/calendar` parts stay filtered out of the chip list. A mail part is the caller's own, so no ACL question arises.
- **The registry predicates are now the only gate.** A wrong predicate shows a row on every surface at once. That is the point, and it is also why each predicate gets a unit test in `packages/lib/src/test/`.
- **The download route's content type changes.** A browser that opened `application/octet-stream` as a download may now render a PDF inline when the URL is visited directly. The disposition is still `attachment`, so a click still downloads.
- **Docs to change**: `MAIL.md`, `PREVIEWS.md`, `CHAT.md`, `SHARED-PRIMITIVES.md` via `bun run primitives`, and the help-center articles that describe the mail attachment chip and Drive's context menu.

## Open questions

1. **`subject.name` for a Drive file with an `originalName`.** The chip shows `details.originalName || name`, the overlay header shows `name`. The subject keeps `name` so the pixel gate holds; unifying it is a separate one-line decision.
2. **Quick Look siblings in Drive's menu.** The host passes siblings to `onQuickLook` today through its own closure. With the registry the menu takes a `siblings` prop. Whether the row should instead read the visible list from context is a later question.

## Decisions (2026-09-13)

| # | Ruling | Why |
|---|---|---|
| D1 | No route consolidation, no resolver, no `/copy` removal. Hooks keep their names, shapes and request patterns. | Orthogonal to both goals. `/copy` is exercised by eight test files, and the hook migration was the riskiest phase of the old plan. |
| D2 | `FileSubject` stores its URLs and has exactly two builders. | Only two functions build a subject, so "derived data at nine call sites" no longer applies. Nine consumers reading four fields beats nine consumers calling a helper. |
| D3 | The registry lives in `packages/lib` and is declarative; handlers live in one `packages/ui` hook. | Predicates are React-free and unit-testable; running an action needs the preview context, picker state and mutations. |
| D4 | Drive's menu consumes the registry with an `include` list. | Goal 2. `include` picks and places rows; it cannot add one. Save to Drive on a Drive item is Copy to…, which stays Drive's row. |
| D5 | Client re-post only where no route exists: contacts import (any source) and a mail part being converted. Mail into Drive keeps the server-side route. | The bytes are small or already capped, and the alternative is a new backend seam for two actions. Mail's route keeps validate-before-write for free. |
| D6 | One `serveMailPart` for both mail byte routes; `serveFile` untouched. | One home for the inline-header fact is `scriptableInlineHeaders`; the mail helper only spreads it. |
| D7 | `mailAttachmentName` is the one fallback name; the saved file changes from `attachment-2` to `Attachment 3`. `Attachment.filename` stays optional. | A missing filename is how outbound mail recognises inline cid parts. The chip, the header and the saved file must read alike. |
| D8 | `downloadMode` is deleted; the footer renders from the registry and the batch "Save all (n)" keeps both of today's gates. | One footer everywhere. Its appearance on Drive previews is new and goes to the screenshot round. |
| D9 | Every server-rendered preview mode gates on `subject.drive`; a subject without `drive` is `image` only for a browser-decodable mime (`BROWSER_IMAGE_MIMES`). | Drive's `<img>` never shows original bytes: `/preview` serves a resized WebP, with exiftool for HEIC, RAW and PSD. A mail part's `<img>` shows the original, which the browser must decode itself. The text renderer needs a mount, a path and a version key. |
| D10 | Mail compose chips are out of scope. | `AttachmentMeta[]` is a different shape and a compose chip is a remove affordance, not an action list. |
| D11 | The `use-draft.ts` off-by-N (raw index at one site, calendar-filtered index at another, both fed to `keepAttachmentIndexes`) is a separate cheap-win commit, listed in `ROADMAP.md`. | Real bug, unrelated to preview or actions. |
